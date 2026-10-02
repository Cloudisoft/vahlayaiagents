import { Router, type Request, type Response } from "express";
import crypto from "node:crypto";
import { pool } from "../../db/pool.js";
import { vapiWebhookSecret } from "../../voiceai/vapiClient.js";
import { finalizeCall, reportFromVapi } from "../../voiceai/callFinalizer.js";
import { loadPublishedSnapshot } from "../../voiceai/campaignVersions.js";
import { buildVapiCall } from "../../voiceai/assistantBuilder.js";
import { chunkKnowledge, searchKnowledge } from "../../voiceai/knowledgeBase.js";
import { parseWindow, resolveTimeZone, zonedLocalToUtc } from "../../voiceai/callingWindow.js";
import { spokenAgentName } from "../../voiceai/placeholders.js";
import { AI_OUTCOME_KEYS } from "../../services/dispositionsService.js";
import { publishEvent } from "../../services/events.js";

export const vapiWebhookRouter = Router();

function secretMatches(header: string | undefined): boolean {
  if (!header) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(vapiWebhookSecret());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function findCall(message: any) {
  const vapiId = message?.call?.id;
  const ourId = message?.call?.metadata?.vahlayCallId ?? message?.call?.assistantOverrides?.metadata?.vahlayCallId;
  const r = await pool.query(
    `select c.*, v.name as voice_name, cmp.calling_hours, cmp.time_zone as campaign_tz,
            l.time_zone as lead_tz, l.state as lead_state
     from calls c
     left join voices v on v.id = c.voice_id
     left join campaigns cmp on cmp.id = c.campaign_id
     left join leads l on l.id = c.lead_id
     where ($1::uuid is not null and c.id = $1::uuid) or ($2::text is not null and c.vapi_call_id = $2)
     limit 1`,
    [ourId && /^[0-9a-f-]{36}$/i.test(ourId) ? ourId : null, vapiId ?? null]
  );
  return r.rows[0] ?? null;
}

async function addEvent(callId: string, event: Record<string, unknown>) {
  await pool.query(`update calls set events = events || $2::jsonb, last_signal_at = now() where id = $1`, [
    callId,
    JSON.stringify([{ ...event, at: new Date().toISOString() }]),
  ]);
}

vapiWebhookRouter.post("/", async (req: Request, res: Response) => {
  if (!secretMatches(req.header("x-vapi-secret"))) return res.status(401).json({ error: "Invalid webhook secret." });
  const message = req.body?.message;
  if (!message?.type) return res.status(200).json({});

  try {
    switch (message.type) {
      case "assistant-request":
        return res.json(await handleInbound(message));
      case "tool-calls":
        return res.json({ results: await handleToolCalls(message) });
      case "end-of-call-report": {
        res.status(200).json({});
        const call = await findCall(message);
        if (call) await finalizeCall(call.id, reportFromVapi(message));
        return;
      }
      case "status-update":
        await handleStatus(message);
        return res.status(200).json({});
      case "transcript":
        await handleTranscript(message);
        return res.status(200).json({});
      case "transfer-update": {
        const call = await findCall(message);
        if (call) {
          await pool.query("update calls set transfer_status = 'initiated' where id = $1 and transfer_status is null", [call.id]);
          await addEvent(call.id, { type: "transfer", destination: message.destination?.number ?? null });
          await publishEvent(call.organization_id, { type: "call_status", callId: call.id, status: "transferring" });
        }
        return res.status(200).json({});
      }
      default:
        return res.status(200).json({});
    }
  } catch (err) {
    await pool.query(`insert into system_logs (level, source, message, metadata) values ('error','vapi.webhook',$1,$2)`, [
      (err as Error).message,
      JSON.stringify({ type: message.type, vapiCallId: message?.call?.id }),
    ]);
    if (!res.headersSent) res.status(500).json({ error: "Webhook processing failed." });
  }
});

async function handleStatus(message: any) {
  const call = await findCall(message);
  if (!call) return;
  const status: string = message.status;
  const monitor = message.call?.monitor;
  if (monitor?.listenUrl || monitor?.controlUrl) {
    await pool.query(
      "update calls set monitor_listen_url = coalesce(monitor_listen_url, $2), monitor_control_url = coalesce(monitor_control_url, $3) where id = $1",
      [call.id, monitor.listenUrl ?? null, monitor.controlUrl ?? null]
    );
  }
  if (status === "ringing") {
    await pool.query("update calls set status = 'ringing' where id = $1 and status = 'queued'", [call.id]);
  } else if (status === "in-progress") {
    await pool.query(
      "update calls set status = 'answered', answered = true, answered_at = coalesce(answered_at, now()) where id = $1 and status in ('queued','ringing')",
      [call.id]
    );
  } else if (status === "forwarding") {
    await pool.query("update calls set transfer_status = coalesce(transfer_status, 'initiated') where id = $1", [call.id]);
  } else if (status === "ended" && message.endedReason) {
    await pool.query("update calls set ended_reason = coalesce(ended_reason, $2) where id = $1", [call.id, message.endedReason]);
  }
  await addEvent(call.id, { type: "status", status, endedReason: message.endedReason ?? null });
  await publishEvent(call.organization_id, { type: "call_status", callId: call.id, status });
}

async function handleTranscript(message: any) {
  const call = await findCall(message);
  if (!call) return;
  const role = message.role === "user" ? "user" : "assistant";
  const final = message.transcriptType === "final";
  if (role === "user" && final && !call.customer_spoke && String(message.transcript ?? "").trim()) {
    await pool.query("update calls set customer_spoke = true, last_signal_at = now() where id = $1", [call.id]);
  }
  await publishEvent(call.organization_id, {
    type: "transcript",
    callId: call.id,
    role,
    speaker: role === "user" ? "Customer" : spokenAgentName(call.voice_name) || "Agent",
    text: message.transcript ?? "",
    partial: !final,
  });
}

function parseArgs(raw: unknown): Record<string, any> {
  if (raw && typeof raw === "object") return raw as Record<string, any>;
  try {
    return JSON.parse(String(raw ?? "{}"));
  } catch {
    return {};
  }
}

async function handleToolCalls(message: any): Promise<Array<{ toolCallId: string; result: string }>> {
  const call = await findCall(message);
  const list: any[] = message.toolCallList ?? message.toolCalls ?? [];
  const results: Array<{ toolCallId: string; result: string }> = [];
  for (const tc of list) {
    const name = tc.function?.name ?? tc.name;
    const args = parseArgs(tc.function?.arguments ?? tc.arguments);
    results.push({ toolCallId: tc.id, result: call ? await runTool(call, name, args) : "Call not found." });
  }
  return results;
}

async function runTool(call: any, name: string, args: Record<string, any>): Promise<string> {
  await addEvent(call.id, { type: "tool", name, args });
  switch (name) {
    case "mark_do_not_call": {
      await pool.query("update calls set dnc_requested = true where id = $1", [call.id]);
      if (call.to_number) {
        await pool.query(
          `insert into dnc_entries (organization_id, phone_e164, reason) values ($1,$2,'Requested during call')
           on conflict (organization_id, phone_e164) do nothing`,
          [call.organization_id, call.to_number]
        );
      }
      if (call.lead_id) await pool.query("update leads set is_dnc = true where id = $1", [call.lead_id]);
      return "Added to Do Not Call. Apologise, say goodbye and end the call now.";
    }
    case "set_call_outcome": {
      if (!AI_OUTCOME_KEYS.includes(args.outcome)) return `Unknown outcome. Use one of: ${AI_OUTCOME_KEYS.join(", ")}.`;
      await pool.query("update calls set ai_outcome = $2, call_category = coalesce($3, call_category) where id = $1", [
        call.id,
        args.outcome,
        typeof args.call_category === "string" ? args.call_category.slice(0, 40) : null,
      ]);
      if (call.lead_id) {
        const contractEnd = /^\d{4}-\d{2}-\d{2}$/.test(args.contract_end_date ?? "") ? args.contract_end_date : null;
        await pool.query(
          `update leads set current_provider = coalesce($2, current_provider),
             customer_type = coalesce($3, customer_type), contract_end_date = coalesce($4::date, contract_end_date)
           where id = $1`,
          [call.lead_id, args.current_provider || null, ["alc", "non_alc"].includes(args.customer_type) ? args.customer_type : null, contractEnd]
        );
      }
      return "Outcome recorded.";
    }
    case "book_callback": {
      const window = parseWindow(call.calling_hours);
      const tz = resolveTimeZone(window, call.campaign_tz ?? "America/New_York", { time_zone: call.lead_tz, state: call.lead_state });
      const at = zonedLocalToUtc(String(args.callback_local_datetime ?? ""), tz);
      if (!at || at.getTime() < Date.now()) return "That time couldn't be booked — confirm a future date and time with the caller.";
      await pool.query("update calls set callback_at = $2, ai_outcome = $3 where id = $1", [
        call.id,
        at,
        "CALLBK",
      ]);
      return `Callback booked for ${new Intl.DateTimeFormat("en-US", { timeZone: tz, dateStyle: "full", timeStyle: "short" }).format(at)}.`;
    }
    case "save_lead_details": {
      if (!call.lead_id) return "Saved.";
      const details: Record<string, unknown> = {};
      for (const k of [
        "current_services", "services_with_other_provider", "current_monthly_bill", "contract_months_left",
        "early_termination_fee", "decision_maker_name", "direct_number", "business_address_confirmed",
        "best_install_time", "bill_copy_requested", "notes",
      ]) {
        if (args[k] !== undefined && args[k] !== null && args[k] !== "") details[k] = args[k];
      }
      const email = typeof args.email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(args.email.trim()) ? args.email.trim().toLowerCase() : null;
      await pool.query(
        `update leads set business_email = coalesce($2, business_email), current_provider = coalesce($3, current_provider),
           custom_fields = coalesce(custom_fields, '{}'::jsonb)
             || jsonb_build_object('call_details', coalesce(custom_fields->'call_details', '{}'::jsonb) || $4::jsonb),
           updated_at = now()
         where id = $1`,
        [call.lead_id, email, args.current_provider || null, JSON.stringify(details)]
      );
      if (args.email && !email) return "That email doesn't look complete — read it back to the caller letter by letter and save it again.";
      return "Saved.";
    }
    case "record_survey": {
      const survey = {
        satisfaction: Number.isFinite(Number(args.satisfaction)) ? Math.min(5, Math.max(1, Math.round(Number(args.satisfaction)))) : null,
        would_recommend: typeof args.would_recommend === "boolean" ? args.would_recommend : null,
        improvement: typeof args.improvement === "string" ? args.improvement.slice(0, 1000) : null,
        at: new Date().toISOString(),
      };
      await pool.query(
        `update calls set call_category = coalesce(call_category, 'survey'),
           evaluation = coalesce(evaluation, '{}'::jsonb) || jsonb_build_object('survey', $2::jsonb) where id = $1`,
        [call.id, JSON.stringify(survey)]
      );
      return "Survey answers recorded. Thank the caller.";
    }
    case "search_knowledge_base": {
      const snapshot = call.campaign_version_id ? await loadPublishedSnapshot(call.campaign_version_id) : null;
      if (!snapshot) return "No knowledge base is available for this call.";
      const hits = searchKnowledge(chunkKnowledge(snapshot.knowledgeText, snapshot.agent.faqs), String(args.query ?? ""));
      return hits.length
        ? hits.join("\n---\n")
        : "Nothing in the knowledge base answers that. Don't guess — offer to have a specialist confirm.";
    }
    default:
      return "Unknown tool.";
  }
}

// Inbound (playbook §9): a caller ringing one of our numbers gets the
// assistant for that number's campaign, with its script, knowledge base
// and transfer number.
async function handleInbound(message: any) {
  const vapiNumberId = message.call?.phoneNumberId ?? message.phoneNumber?.id;
  const from = message.call?.customer?.number ?? message.customer?.number ?? null;
  const num = await pool.query(
    `select p.*, coalesce(p.assigned_campaign_id,
        (select campaign_id from campaign_phone_numbers where phone_number_id = p.id limit 1)) as campaign_id
     from phone_numbers p where p.vapi_phone_number_id = $1`,
    [vapiNumberId]
  );
  const number = num.rows[0];
  if (!number?.campaign_id) return { error: "This number isn't assigned to a campaign." };

  const c = await pool.query("select * from campaigns where id = $1", [number.campaign_id]);
  const campaign = c.rows[0];
  const snapshot = campaign?.published_version_id ? await loadPublishedSnapshot(campaign.published_version_id) : null;
  if (!snapshot) return { error: "This number's campaign has not been published." };

  const leadRow = from
    ? await pool.query("select * from leads where organization_id = $1 and main_phone_e164 = $2 order by updated_at desc limit 1", [
        campaign.organization_id,
        from,
      ])
    : { rows: [] as any[] };
  const lead = leadRow.rows[0] ?? { business_name: null, custom_fields: {} };

  const inserted = await pool.query<{ id: string }>(
    `insert into calls (organization_id, campaign_id, agent_id, voice_id, phone_number_id, lead_id, campaign_version_id,
       telephony_provider, direction, to_number, from_number, status, vapi_call_id, started_at, answered, answered_at, last_signal_at)
     values ($1,$2,$3,(select voice_id from ai_agents where id = $3),$4,$5,$6,'vapi','inbound',$7,$8,'answered',$9, now(), true, now(), now())
     on conflict (vapi_call_id) where vapi_call_id is not null do update set last_signal_at = now()
     returning id`,
    [
      campaign.organization_id,
      campaign.id,
      snapshot.agent.id,
      number.id,
      lead.id ?? null,
      campaign.published_version_id,
      number.phone_e164,
      from,
      message.call?.id ?? null,
    ]
  );
  const callId = inserted.rows[0].id;

  const tz = resolveTimeZone(parseWindow(campaign.calling_hours), campaign.time_zone, lead);
  const built = buildVapiCall({
    snapshot: {
      ...snapshot,
      agent: { ...snapshot.agent, greeting: "Thanks for calling {{intro_name}}, this is {{agent_name}}. How can I help you today?" },
    },
    lead,
    customerNumber: from ?? "",
    vapiPhoneNumberId: vapiNumberId,
    leadTimeZone: tz,
    metadata: { vahlayCallId: callId, organizationId: campaign.organization_id, campaignId: campaign.id, leadId: lead.id ?? "" },
  });
  const assistant = built.payload.assistant;
  delete assistant.voicemailDetection;
  delete assistant.voicemailMessage;
  await publishEvent(campaign.organization_id, { type: "call_status", callId, status: "in-progress", direction: "inbound" });
  return { assistant };
}
