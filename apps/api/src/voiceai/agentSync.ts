import { pool } from "../db/pool.js";
import { env } from "../config/env.js";
import { buildVapiCall, type CampaignSnapshot } from "./assistantBuilder.js";
import { createVapiAssistant, updateVapiAssistant, VapiApiError } from "./vapiClient.js";

// Every agent is mirrored to a VAPI assistant on save, so what's configured
// here is what VAPI holds. Live calls still get a per-call copy built from
// the campaign's published version, with the lead's details filled in.
export async function syncAgentToVapi(agentId: string, organizationId: string): Promise<{ assistantId: string | null; error: string | null }> {
  const r = await pool.query(
    `select a.*, v.provider as voice_provider, v.provider_voice_id, v.name as voice_name
     from ai_agents a left join voices v on v.id = a.voice_id
     where a.id = $1 and a.organization_id = $2`,
    [agentId, organizationId]
  );
  const a = r.rows[0];
  if (!a) return { assistantId: null, error: "Agent not found." };
  // A dev server's webhook URL isn't reachable by VAPI; don't push it there.
  if (/localhost|127\.0\.0\.1/.test(env.apiUrl)) {
    return { assistantId: a.vapi_assistant_id, error: "Not synced: this server's URL is local, so VAPI couldn't reach it." };
  }

  // The company the agent introduces itself as comes from its latest campaign.
  const cmp = await pool.query("select coalesce(intro_name, name) as intro from campaigns where ai_agent_id = $1 order by updated_at desc limit 1", [a.id]);
  const snapshot: CampaignSnapshot = {
    campaignId: "",
    version: 0,
    introName: cmp.rows[0]?.intro ?? a.name,
    callbackNumber: null,
    script: "",
    knowledgeText: "",
    transferNumber: a.transfer_rules?.transferNumber ?? null,
    transferTargets: {},
    maxCallDurationSeconds: a.max_call_duration_seconds ?? 600,
    llmModel: a.llm_model || "gpt-4o-mini",
    llmProvider: a.llm_provider || "openai",
    agent: {
      id: a.id,
      name: a.name,
      systemPrompt: a.system_prompt ?? "",
      personality: a.personality,
      tone: a.tone,
      greeting: a.greeting,
      endingMessage: a.ending_behavior,
      faqs: a.faqs ?? [],
      objectionHandling: a.objection_handling ?? [],
      fallbackBehavior: a.fallback_behavior,
      transferNumber: a.transfer_rules?.transferNumber ?? null,
      temperature: Number(a.temperature ?? 0.4),
      voice: a.provider_voice_id ? { provider: a.voice_provider, providerVoiceId: a.provider_voice_id, name: a.voice_name } : null,
    },
  };
  const built = buildVapiCall({
    snapshot,
    lead: { first_name: "there", custom_fields: {} },
    customerNumber: "",
    vapiPhoneNumberId: "",
    leadTimeZone: "America/New_York",
    metadata: { vahlayAgentId: a.id, organizationId },
  });
  const assistant = { ...built.payload.assistant, name: String(a.name).slice(0, 40) };

  let assistantId: string | null = a.vapi_assistant_id;
  let error: string | null = null;
  try {
    if (assistantId) {
      try {
        await updateVapiAssistant(organizationId, assistantId, assistant);
      } catch (err) {
        // Deleted in the VAPI dashboard: create a fresh one.
        if (!(err instanceof VapiApiError && err.status === 404)) throw err;
        assistantId = (await createVapiAssistant(organizationId, assistant)).id;
      }
    } else {
      assistantId = (await createVapiAssistant(organizationId, assistant)).id;
    }
  } catch (err) {
    error = err instanceof VapiApiError ? `VAPI rejected the update: ${err.body.slice(0, 300)}` : (err as Error).message;
  }
  await pool.query(
    `update ai_agents set vapi_assistant_id = $2, vapi_sync_error = $3, vapi_synced_at = case when $3::text is null then now() else vapi_synced_at end
     where id = $1`,
    [a.id, assistantId, error]
  );
  return { assistantId, error };
}
