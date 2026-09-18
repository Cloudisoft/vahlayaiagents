import { pool } from "../db/pool.js";
import { getTelephonyProvider } from "../telephony/index.js";
import { isOnDncList } from "../services/dncService.js";
import { env } from "../config/env.js";

const IN_FLIGHT_STATUSES = ["queued", "ringing", "answered"];

// LEAD LIST -> VALIDATE -> NORMALIZE -> DEDUPLICATE -> CHECK DNC -> CHECK
// PREVIOUS CALLS -> QUEUE -> CONCURRENCY CONTROLLER -> TELEPHONY -> AI CALL
// (spec §36). Runs on a timer from the worker process — concurrency is
// enforced here, server-side, never assumed from the frontend.
export async function tickCampaignDialer(): Promise<{ dialed: number; skipped: number }> {
  let dialed = 0;
  let skipped = 0;

  const campaigns = await pool.query(
    `select c.*, a.name as agent_name, pn.phone_e164 as from_number, pn.provider as telephony_provider
     from campaigns c
     left join ai_agents a on a.id = c.ai_agent_id
     left join phone_numbers pn on pn.id = c.phone_number_id
     where c.status = 'active'`
  );

  for (const campaign of campaigns.rows) {
    if (!campaign.ai_agent_id || !campaign.from_number) {
      continue; // not fully configured — nothing to dial yet
    }

    const inFlight = await pool.query(
      `select count(*) from calls where campaign_id = $1 and status = any($2)`,
      [campaign.id, IN_FLIGHT_STATUSES]
    );
    const available = campaign.concurrency - Number(inFlight.rows[0].count);
    if (available <= 0) continue;

    if (!isWithinCallingHours(campaign.calling_hours, campaign.time_zone)) {
      continue;
    }

    const queuedLeads = await pool.query(
      `select cl.id as campaign_lead_id, l.id as lead_id, l.business_name, l.main_phone_e164
       from campaign_leads cl
       join leads l on l.id = cl.lead_id
       where cl.campaign_id = $1 and cl.status = 'queued' and l.main_phone_e164 is not null
       and cl.attempts < $2
       order by cl.created_at
       limit $3`,
      [campaign.id, campaign.max_attempts, available]
    );

    for (const lead of queuedLeads.rows) {
      const onDnc = await isOnDncList(campaign.organization_id, lead.main_phone_e164);
      if (onDnc) {
        await pool.query("update campaign_leads set status = 'dnc_skipped' where id = $1", [lead.campaign_lead_id]);
        skipped++;
        continue;
      }

      try {
        const provider = await getTelephonyProvider(campaign.organization_id, campaign.telephony_provider);
        const webhookBase = `${env.apiUrl.replace(/\/$/, "")}/api/webhooks/${campaign.telephony_provider}/voice-agent`;

        const callResult = await pool.query<{ id: string }>(
          `insert into calls (organization_id, campaign_id, agent_id, voice_id, phone_number_id, lead_id,
             telephony_provider, direction, to_number, from_number, status)
           values ($1,$2,$3,$4,$5,$6,$7,'outbound',$8,$9,'queued') returning id`,
          [
            campaign.organization_id,
            campaign.id,
            campaign.ai_agent_id,
            campaign.voice_id,
            campaign.phone_number_id,
            lead.lead_id,
            campaign.telephony_provider,
            lead.main_phone_e164,
            campaign.from_number,
          ]
        );
        const callId = callResult.rows[0].id;

        const { providerCallId } = await provider.createCall({
          to: lead.main_phone_e164,
          from: campaign.from_number,
          answerUrl: `${webhookBase}/answer/${callId}`,
          webhookUrl: `${webhookBase}/hangup/${callId}`,
        });

        await pool.query("update calls set provider_call_id = $1, started_at = now() where id = $2", [
          providerCallId,
          callId,
        ]);
        await pool.query("update campaign_leads set status = 'calling', attempts = attempts + 1, last_call_id = $1 where id = $2", [
          callId,
          lead.campaign_lead_id,
        ]);
        dialed++;
      } catch (err) {
        await pool.query("update campaign_leads set status = 'failed' where id = $1", [lead.campaign_lead_id]);
        await pool.query(
          `insert into system_logs (organization_id, level, source, message) values ($1,'error','campaign_dialer',$2)`,
          [campaign.organization_id, (err as Error).message]
        );
      }
    }
  }

  return { dialed, skipped };
}

function isWithinCallingHours(callingHours: Record<string, unknown>, timeZone: string): boolean {
  if (!callingHours || Object.keys(callingHours).length === 0) return true; // no restriction configured
  try {
    const now = new Date();
    const dayName = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone }).format(now).toLowerCase();
    const dayConfig = (callingHours as any)[dayName];
    if (!dayConfig) return false; // day not configured = not allowed to call
    const hour = Number(new Intl.DateTimeFormat("en-US", { hour: "2-digit", hour12: false, timeZone }).format(now));
    return hour >= (dayConfig.startHour ?? 0) && hour < (dayConfig.endHour ?? 24);
  } catch {
    return true; // malformed config — don't block dialing over a config bug
  }
}
