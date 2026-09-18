import { Router } from "express";
import { pool } from "../../db/pool.js";
import { env } from "../../config/env.js";
import { transcribeAudio } from "../../services/openaiService.js";
import { generateAgentTurn, type ConversationTurn } from "../../voiceai/conversationService.js";
import { broadcastToOrg } from "../../services/realtimeService.js";
import { detectsOptOut, addToDnc } from "../../services/dncService.js";
import { getStorageDriver, recordFile } from "../../services/storageService.js";
import { getTelephonyProvider } from "../../telephony/index.js";
import { Readable } from "node:stream";

// Mirrors plivoVoiceAgent.ts exactly in behavior — same turn-based flow,
// same DNC/opt-out handling, same recording pipeline — just TwiML syntax
// and Twilio's webhook field names (RecordingUrl vs RecordUrl, CallDuration
// vs Duration) instead of Plivo's. Twilio carries US Voice AI campaign
// calls; Plivo carries India HR interviews (see telephony/index.ts).
export const twilioVoiceAgentWebhookRouter = Router();

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function turnTwiml(speakText: string, recordActionUrl: string): string {
  return `<Response><Say voice="Polly.Joanna">${escapeXml(speakText)}</Say><Record action="${escapeXml(
    recordActionUrl
  )}" method="POST" maxLength="60" timeout="6" playBeep="false" trim="trim-silence"/></Response>`;
}

function endCallTwiml(speakText: string): string {
  return `<Response><Say voice="Polly.Joanna">${escapeXml(speakText)}</Say><Hangup/></Response>`;
}

async function loadCallContext(callId: string) {
  const result = await pool.query(
    `select c.id, c.organization_id, c.campaign_id, c.lead_id, c.to_number, c.provider_call_id, c.telephony_provider,
            a.name as agent_name, a.purpose, a.system_prompt, a.tone, a.greeting, a.faqs, a.objection_handling,
            l.business_name
     from calls c
     join ai_agents a on a.id = c.agent_id
     join leads l on l.id = c.lead_id
     where c.id = $1`,
    [callId]
  );
  return result.rows[0] ?? null;
}

twilioVoiceAgentWebhookRouter.all("/answer/:callId", async (req, res) => {
  const callId = req.params.callId;
  const call = await loadCallContext(callId);
  if (!call) {
    return res.status(404).type("text/xml").send("<Response><Say>Call not found.</Say><Hangup/></Response>");
  }

  await pool.query("update calls set status = 'answered', answered_at = now() where id = $1", [callId]);
  broadcastToOrg(call.organization_id, { type: "call_status", callId, status: "answered" });

  const greeting = call.greeting || `Hi, this is ${call.agent_name} calling regarding ${call.business_name}. Do you have a quick moment to chat?`;
  await pool.query(
    `insert into call_transcripts (call_id, turns) values ($1, $2)
     on conflict (call_id) do update set turns = $2`,
    [callId, JSON.stringify([{ speaker: "agent", text: greeting, ts: new Date().toISOString() }])]
  );
  broadcastToOrg(call.organization_id, { type: "transcript_turn", callId, speaker: "agent", text: greeting });

  const twiml = turnTwiml(greeting, `${env.apiUrl.replace(/\/$/, "")}/api/webhooks/twilio/voice-agent/turn/${callId}`);
  res.type("text/xml").send(twiml);
});

twilioVoiceAgentWebhookRouter.post("/turn/:callId", async (req, res) => {
  const callId = req.params.callId;
  const recordingUrl = req.body.RecordingUrl as string | undefined;
  const call = await loadCallContext(callId);
  if (!call) return res.status(404).type("text/xml").send("<Response><Hangup/></Response>");

  const transcriptRow = await pool.query("select turns from call_transcripts where call_id = $1", [callId]);
  const turns: ConversationTurn[] = (transcriptRow.rows[0]?.turns ?? []).map((t: any) => ({ speaker: t.speaker, text: t.text }));

  let customerText = "";
  if (recordingUrl) {
    try {
      // Twilio's RecordingUrl has no extension by default — .mp3 fetches the audio directly.
      const audioRes = await fetch(`${recordingUrl}.mp3`);
      if (audioRes.ok) {
        const buffer = Buffer.from(await audioRes.arrayBuffer());
        const { text } = await transcribeAudio({ organizationId: call.organization_id, audio: buffer, filename: "reply.mp3" });
        customerText = text;
      }
    } catch {
      customerText = "";
    }
  }

  turns.push({ speaker: "customer", text: customerText || "[no response captured]" });
  broadcastToOrg(call.organization_id, { type: "transcript_turn", callId, speaker: "customer", text: customerText });

  if (customerText && detectsOptOut(customerText)) {
    await addToDnc(call.organization_id, call.to_number, "Opt-out detected during call");
    const closing = "Understood — I'll make sure you're not contacted again. Have a good day.";
    turns.push({ speaker: "agent", text: closing });
    await pool.query("update call_transcripts set turns = $1 where call_id = $2", [JSON.stringify(turns), callId]);
    await setDisposition(call.organization_id, callId, "do_not_call");
    return res.type("text/xml").send(endCallTwiml(closing));
  }

  const dispositions = await pool.query("select key from call_dispositions where organization_id = $1", [
    call.organization_id,
  ]);

  let result;
  try {
    result = await generateAgentTurn({
      organizationId: call.organization_id,
      agent: {
        name: call.agent_name,
        purpose: call.purpose,
        systemPrompt: call.system_prompt,
        tone: call.tone,
        greeting: call.greeting,
        faqs: call.faqs ?? [],
        objectionHandling: call.objection_handling ?? [],
      },
      leadBusinessName: call.business_name,
      history: turns,
      availableDispositions: dispositions.rows.map((d) => d.key),
    });
  } catch (err) {
    const fallback = "I'm having a technical issue on my end — I'll follow up another time. Thanks for your patience.";
    turns.push({ speaker: "agent", text: fallback });
    await pool.query("update call_transcripts set turns = $1 where call_id = $2", [JSON.stringify(turns), callId]);
    await pool.query(
      `insert into system_logs (organization_id, level, source, message) values ($1,'error','voice_agent_turn',$2)`,
      [call.organization_id, (err as Error).message]
    );
    return res.type("text/xml").send(endCallTwiml(fallback));
  }

  turns.push({ speaker: "agent", text: result.agentReply });
  await pool.query("update call_transcripts set turns = $1 where call_id = $2", [JSON.stringify(turns), callId]);
  broadcastToOrg(call.organization_id, { type: "transcript_turn", callId, speaker: "agent", text: result.agentReply });

  if (result.disposition) {
    await setDisposition(call.organization_id, callId, result.disposition);
  }

  if (result.shouldEndCall || turns.length > 20) {
    return res.type("text/xml").send(endCallTwiml(result.agentReply));
  }

  const twiml = turnTwiml(result.agentReply, `${env.apiUrl.replace(/\/$/, "")}/api/webhooks/twilio/voice-agent/turn/${callId}`);
  res.type("text/xml").send(twiml);
});

twilioVoiceAgentWebhookRouter.post("/hangup/:callId", async (req, res) => {
  res.status(200).end();
  const callId = req.params.callId;
  const call = await loadCallContext(callId);
  if (!call) return;

  const duration = req.body.CallDuration ? Number(req.body.CallDuration) : null;
  await pool.query(
    "update calls set status = 'completed', ended_at = now(), duration_seconds = $1 where id = $2",
    [duration, callId]
  );
  await pool.query("update campaign_leads set status = 'called' where last_call_id = $1", [callId]);
  broadcastToOrg(call.organization_id, { type: "call_status", callId, status: "completed" });

  try {
    const provider = await getTelephonyProvider(call.organization_id, call.telephony_provider);
    const recording = call.provider_call_id ? await provider.getRecording(call.provider_call_id) : null;
    if (recording) {
      const audioRes = await fetch(recording.url);
      if (audioRes.ok) {
        const buffer = Buffer.from(await audioRes.arrayBuffer());
        const key = `${call.organization_id}/calls/${callId}.mp3`;
        const stored = await getStorageDriver().put(key, Readable.from(buffer), "audio/mpeg");
        const fileId = await recordFile({
          organizationId: call.organization_id,
          key: stored.key,
          fileName: `call-${callId}.mp3`,
          fileType: "mp3",
          mimeType: "audio/mpeg",
          size: stored.size,
        });
        await pool.query(
          `insert into call_recordings (call_id, file_id, provider_recording_url, duration_seconds, processing_status)
           values ($1,$2,$3,$4,'completed')
           on conflict (call_id) do update set file_id = excluded.file_id, processing_status = 'completed'`,
          [callId, fileId, recording.url, recording.durationSeconds ?? null]
        );
      }
    }
  } catch (err) {
    await pool.query(`insert into system_logs (organization_id, level, source, message) values ($1,'warn','voice_agent_recording',$2)`, [
      call.organization_id,
      (err as Error).message,
    ]);
  }
});

async function setDisposition(organizationId: string, callId: string, key: string) {
  const disposition = await pool.query("select id from call_dispositions where organization_id = $1 and key = $2", [
    organizationId,
    key,
  ]);
  if (disposition.rows.length > 0) {
    await pool.query("update calls set disposition_id = $1 where id = $2", [disposition.rows[0].id, callId]);
  }
}
