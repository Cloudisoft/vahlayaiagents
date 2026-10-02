import os from "node:os";
import crypto from "node:crypto";
import { pool } from "../db/pool.js";
import { buildVapiCall } from "./assistantBuilder.js";
import { loadPublishedSnapshot } from "./campaignVersions.js";
import { createVapiCall, getVapiCall, controlVapiCall } from "./vapiClient.js";
import { finalizeCall, reportFromVapi } from "./callFinalizer.js";
import { isWithinWindow, parseWindow, resolveTimeZone } from "./callingWindow.js";
import { CALLBACK_CODES } from "../services/dispositionsService.js";
import { publishEvent, subscribe, DIALER_CHANNEL } from "../services/events.js";
import { getTelephonyProvider } from "../telephony/index.js";

const LEASE_NAME = "campaign-dialer";
const LEASE_TTL_SECONDS = 30;
const HOLDER = `${os.hostname()}-${process.pid}-${crypto.randomBytes(3).toString("hex")}`;
export const BREAKER_THRESHOLD = 10;
const TICK_MS = 5000;
const SWEEP_MS = 30_000;
const LOST_SIGNAL_SECONDS = 180;

const IN_FLIGHT = ["queued", "ringing", "answered"];

let leaseHeld = false;
const busyCampaigns = new Set<string>();

// One dialer at a time, even during a deploy (playbook §10): a DB lease the
// holder renews every tick; a second process sees it held and stays idle.
export async function acquireLease(holder = HOLDER): Promise<boolean> {
  const r = await pool.query(
    `insert into worker_leases (name, holder, expires_at) values ($1, $2, now() + make_interval(secs => $3))
     on conflict (name) do update set holder = excluded.holder, expires_at = excluded.expires_at
       where worker_leases.expires_at < now() or worker_leases.holder = excluded.holder
     returning holder`,
    [LEASE_NAME, holder, LEASE_TTL_SECONDS]
  );
  leaseHeld = r.rowCount === 1;
  return leaseHeld;
}

export async function releaseLease(holder = HOLDER): Promise<void> {
  await pool.query("delete from worker_leases where name = $1 and holder = $2", [LEASE_NAME, holder]);
  leaseHeld = false;
}

async function logError(organizationId: string | null, source: string, message: string, metadata: object = {}) {
  console.error(`[dialer] ${source}: ${message}`);
  await pool.query(
    `insert into system_logs (organization_id, level, source, message, metadata) values ($1,'error',$2,$3,$4)`,
    [organizationId, source, message, JSON.stringify(metadata)]
  );
}

async function notify(organizationId: string, type: string, title: string, body: string) {
  await pool.query(`insert into notifications (organization_id, type, title, body) values ($1,$2,$3,$4)`, [
    organizationId,
    type,
    title,
    body,
  ]);
}

async function pauseCampaign(campaign: any, reason: string) {
  await pool.query(
    "update campaigns set status = 'paused', paused_reason = $2, updated_at = now() where id = $1 and status = 'active'",
    [campaign.id, reason]
  );
  await notify(campaign.organization_id, "campaign_paused", `Campaign paused: ${campaign.name}`, reason);
  await publishEvent(campaign.organization_id, { type: "campaign_status", campaignId: campaign.id, status: "paused", reason });
}

// Stop dialing on repeated provider errors (playbook §10): N identical
// origination errors in a row pause the campaign instead of burning
// through the list.
async function recordOriginationError(campaign: any, message: string) {
  const same = campaign.breaker_last_error === message;
  const count = same ? campaign.breaker_error_count + 1 : 1;
  await pool.query("update campaigns set breaker_error_count = $2, breaker_last_error = $3 where id = $1", [
    campaign.id,
    count,
    message,
  ]);
  campaign.breaker_error_count = count;
  campaign.breaker_last_error = message;
  if (count >= BREAKER_THRESHOLD) {
    await pauseCampaign(campaign, `Paused after ${count} identical call failures: ${message.slice(0, 300)}`);
  }
}

async function pickNumber(campaignId: string, leadE164: string) {
  const npa = leadE164.replace(/^\+1/, "").slice(0, 3);
  const r = await pool.query(
    `select p.id, p.phone_e164, p.vapi_phone_number_id
     from campaign_phone_numbers cpn join phone_numbers p on p.id = cpn.phone_number_id
     where cpn.campaign_id = $1 and p.vapi_phone_number_id is not null and p.status = 'active'
     order by (substring(p.phone_e164 from 3 for 3) = $2) desc, cpn.last_used_at nulls first
     limit 1`,
    [campaignId, npa]
  );
  return r.rows[0] ?? null;
}

export async function dialCampaign(campaignId: string): Promise<number> {
  if (!leaseHeld || busyCampaigns.has(campaignId)) return 0;
  busyCampaigns.add(campaignId);
  try {
    return await dialCampaignInner(campaignId);
  } finally {
    busyCampaigns.delete(campaignId);
  }
}

async function dialCampaignInner(campaignId: string): Promise<number> {
  const c = await pool.query("select * from campaigns where id = $1", [campaignId]);
  const campaign = c.rows[0];
  if (!campaign || campaign.status !== "active" || !campaign.published_version_id) return 0;

  const snapshot = await loadPublishedSnapshot(campaign.published_version_id);
  if (!snapshot) return 0;

  const inflight = await pool.query("select count(*) from calls where campaign_id = $1 and status = any($2)", [
    campaignId,
    IN_FLIGHT,
  ]);
  let slots = campaign.concurrency - Number(inflight.rows[0].count);
  if (slots <= 0) return 0;

  const window = parseWindow(campaign.calling_hours);
  const candidates = await pool.query(
    `select cl.id as campaign_lead_id, cl.status as cl_status, cl.attempts as cl_attempts, cl.last_disposition, l.*
     from campaign_leads cl join leads l on l.id = cl.lead_id
     where cl.campaign_id = $1 and cl.status in ('queued','retry_scheduled')
       and (cl.next_attempt_at is null or cl.next_attempt_at <= now())
       and l.main_phone_e164 is not null
     order by cl.next_attempt_at nulls first, cl.created_at
     limit $2`,
    [campaignId, Math.max(slots * 10, 50)]
  );

  if (candidates.rows.length === 0 && Number(inflight.rows[0].count) === 0) {
    const remaining = await pool.query(
      "select count(*) from campaign_leads where campaign_id = $1 and status in ('queued','retry_scheduled','dialing')",
      [campaignId]
    );
    if (Number(remaining.rows[0].count) === 0) {
      await pool.query("update campaigns set status = 'completed', updated_at = now() where id = $1 and status = 'active'", [
        campaignId,
      ]);
      await notify(campaign.organization_id, "campaign_completed", `Campaign completed: ${campaign.name}`, "Every lead has a final outcome.");
      await publishEvent(campaign.organization_id, { type: "campaign_status", campaignId, status: "completed" });
    }
    return 0;
  }

  let dialed = 0;
  for (const lead of candidates.rows) {
    if (slots <= 0) break;

    // DNC is absolute: never dialed or retried, whatever else is set.
    const dnc = await pool.query("select 1 from dnc_entries where organization_id = $1 and phone_e164 = $2", [
      campaign.organization_id,
      lead.main_phone_e164,
    ]);
    if (lead.is_dnc || dnc.rows.length > 0) {
      await pool.query("update campaign_leads set status = 'dnc' where id = $1", [lead.campaign_lead_id]);
      await pool.query("update leads set call_status = 'DNC', is_dnc = true where id = $1", [lead.id]);
      continue;
    }

    const isCallback = CALLBACK_CODES.includes(lead.last_disposition);
    if (lead.cl_attempts >= campaign.max_attempts && !isCallback) {
      await pool.query("update campaign_leads set status = 'done' where id = $1", [lead.campaign_lead_id]);
      continue;
    }

    const tz = resolveTimeZone(window, campaign.time_zone, lead);
    if (!isWithinWindow(window, tz)) continue;

    // Lead cooldown: don't ring the same business again soon after another
    // campaign did (a booked callback overrides this).
    if (!isCallback && campaign.lead_cooldown_hours > 0) {
      const recent = await pool.query(
        `select 1 from calls where lead_id = $1 and campaign_id is distinct from $2
           and created_at > now() - make_interval(hours => $3) limit 1`,
        [lead.id, campaignId, campaign.lead_cooldown_hours]
      );
      if (recent.rows.length > 0) continue;
    }

    const claim = await pool.query(
      "update campaign_leads set status = 'dialing' where id = $1 and status in ('queued','retry_scheduled') returning id",
      [lead.campaign_lead_id]
    );
    if (claim.rowCount === 0) continue;

    const number = await pickNumber(campaignId, lead.main_phone_e164);
    if (!number) {
      await pool.query("update campaign_leads set status = $2 where id = $1", [lead.campaign_lead_id, lead.cl_status]);
      await pauseCampaign(campaign, "No VAPI-connected phone number in this campaign's number pool.");
      break;
    }

    const callRow = await pool.query<{ id: string }>(
      `insert into calls (organization_id, campaign_id, agent_id, voice_id, phone_number_id, lead_id, campaign_version_id,
         telephony_provider, direction, to_number, from_number, status, last_signal_at)
       values ($1,$2,$3,(select voice_id from ai_agents where id = $3),$4,$5,$6,'vapi','outbound',$7,$8,'queued', now())
       returning id`,
      [
        campaign.organization_id,
        campaignId,
        snapshot.agent.id,
        number.id,
        lead.id,
        campaign.published_version_id,
        lead.main_phone_e164,
        number.phone_e164,
      ]
    );
    const callId = callRow.rows[0].id;
    await pool.query("update campaign_leads set last_call_id = $2 where id = $1", [lead.campaign_lead_id, callId]);

    try {
      const built = buildVapiCall({
        snapshot,
        lead,
        customerNumber: lead.main_phone_e164,
        vapiPhoneNumberId: number.vapi_phone_number_id,
        leadTimeZone: tz,
        metadata: { vahlayCallId: callId, organizationId: campaign.organization_id, campaignId, leadId: lead.id },
      });
      const vapiCall = await createVapiCall({ organizationId: campaign.organization_id, ...built });

      await pool.query(
        `update calls set vapi_call_id = $2, provider_call_sid = $3, monitor_listen_url = $4, monitor_control_url = $5,
           started_at = now(), last_signal_at = now() where id = $1`,
        [callId, vapiCall.id, vapiCall.phoneCallProviderId ?? null, vapiCall.monitor?.listenUrl ?? null, vapiCall.monitor?.controlUrl ?? null]
      );
      await pool.query("update campaign_leads set attempts = attempts + 1 where id = $1", [lead.campaign_lead_id]);
      await pool.query("update leads set attempts = attempts + 1, last_called_at = now(), call_status = 'INCALL' where id = $1", [lead.id]);
      await pool.query("update campaign_phone_numbers set last_used_at = now() where campaign_id = $1 and phone_number_id = $2", [
        campaignId,
        number.id,
      ]);
      if (campaign.breaker_error_count > 0) {
        await pool.query("update campaigns set breaker_error_count = 0, breaker_last_error = null where id = $1", [campaignId]);
        campaign.breaker_error_count = 0;
      }
      await publishEvent(campaign.organization_id, {
        type: "call_status",
        callId,
        status: "queued",
        campaignId,
        leadName: [lead.first_name, lead.last_name].filter(Boolean).join(" ") || lead.business_name,
        toNumber: lead.main_phone_e164,
      });
      slots--;
      dialed++;
    } catch (err) {
      const message = (err as Error).message;
      // Origination failures don't burn the lead's attempt (playbook §10:
      // outages must not eat attempts); it goes back in the queue.
      await pool.query("update calls set status = 'failed', error = $2, ended_at = now() where id = $1", [callId, message]);
      await pool.query(
        "update campaign_leads set status = $2, next_attempt_at = now() + interval '5 minutes' where id = $1",
        [lead.campaign_lead_id, lead.cl_status]
      );
      await logError(campaign.organization_id, "vapi.origination", message, { callId, campaignId });
      await recordOriginationError(campaign, message);
      break;
    }
  }
  return dialed;
}

// Close calls from more than one signal (playbook §10): the status webhook
// and end-of-call report do it normally; these sweeps catch whatever slips
// through so a lost webhook never leaves a call — and a concurrency slot —
// stuck open.
export async function sweepCalls(): Promise<void> {
  if (!leaseHeld) return;

  // Dial timeout: never connected after ~80 s → No answer.
  const unanswered = await pool.query(
    `select c.* from calls c join campaigns cmp on cmp.id = c.campaign_id
     where c.status in ('queued','ringing') and c.answered = false and c.vapi_call_id is not null
       and c.started_at < now() - make_interval(secs => cmp.dial_timeout_seconds)`
  );
  for (const call of unanswered.rows) {
    await hangUp(call);
    await finalizeCall(call.id, null, { endedReasonOverride: "vahlay-dial-timeout" });
  }

  // Lost signals: ask VAPI what actually happened.
  const quiet = await pool.query(
    `select c.*, coalesce(cmp.max_call_duration_seconds, 600) as max_duration
     from calls c left join campaigns cmp on cmp.id = c.campaign_id
     where c.status = any($1) and c.vapi_call_id is not null
       and coalesce(c.last_signal_at, c.started_at) < now() - make_interval(secs => $2)`,
    [IN_FLIGHT, LOST_SIGNAL_SECONDS]
  );
  for (const call of quiet.rows) {
    try {
      const v = await getVapiCall(call.organization_id, call.vapi_call_id);
      if (v.status === "ended") {
        await finalizeCall(call.id, reportFromVapi(v));
        continue;
      }
      // Answered but no caller audio for 4+ minutes, or past max duration: end it.
      const stuckNoAudio = call.answered && !call.customer_spoke;
      const overMax =
        call.started_at && Date.now() - new Date(call.started_at).getTime() > (Number(call.max_duration) + 120) * 1000;
      if (stuckNoAudio || overMax) {
        await hangUp(call);
        await finalizeCall(call.id, reportFromVapi(v), { endedReasonOverride: "vahlay-stuck-call-sweep" });
      } else {
        await pool.query("update calls set last_signal_at = now() where id = $1", [call.id]);
      }
    } catch (err) {
      await logError(call.organization_id, "vapi.reconcile", (err as Error).message, { callId: call.id });
    }
  }

  // Origination never returned a VAPI id (process died mid-dial): release.
  const orphaned = await pool.query(
    "select id from calls where status = 'queued' and vapi_call_id is null and created_at < now() - interval '2 minutes'"
  );
  for (const call of orphaned.rows) {
    await pool.query("update calls set status = 'failed', error = 'Origination never completed', ended_at = now() where id = $1", [call.id]);
    await pool.query("update campaign_leads set status = 'queued' where last_call_id = $1 and status = 'dialing'", [call.id]);
  }
}

export async function hangUp(call: any) {
  try {
    if (call.monitor_control_url) {
      await controlVapiCall(call.monitor_control_url, { type: "end-call" });
      return;
    }
    if (call.provider_call_sid) {
      const twilio = await getTelephonyProvider(call.organization_id, "twilio");
      await twilio.endCall(call.provider_call_sid);
    }
  } catch (err) {
    await logError(call.organization_id, "dialer.hangup", (err as Error).message, { callId: call.id });
  }
}

async function tick() {
  if (!(await acquireLease())) return;
  await pool.query(
    "update campaigns set status = 'active', updated_at = now() where status = 'scheduled' and scheduled_start_at <= now()"
  );
  const active = await pool.query("select id from campaigns where status = 'active' and published_version_id is not null");
  for (const row of active.rows) {
    await dialCampaign(row.id).catch((err) => logError(null, "dialer.tick", (err as Error).message, { campaignId: row.id }));
  }
}

export function startDialer() {
  const run = (fn: () => Promise<void>, source: string) => () => {
    fn().catch((err) => logError(null, source, (err as Error).message));
  };
  const tickTimer = setInterval(run(tick, "dialer.tick"), TICK_MS);
  const sweepTimer = setInterval(run(sweepCalls, "dialer.sweep"), SWEEP_MS);
  // A freed slot is refilled at once, not on the next tick.
  const unsubscribe = subscribe(DIALER_CHANNEL, (campaignId) => {
    dialCampaign(campaignId).catch((err) => logError(null, "dialer.refill", (err as Error).message, { campaignId }));
  });
  run(tick, "dialer.tick")();

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(tickTimer);
    clearInterval(sweepTimer);
    unsubscribe();
    await releaseLease().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  console.log(`[dialer] started as ${HOLDER}`);
}
