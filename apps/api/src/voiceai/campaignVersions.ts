import { pool, withTransaction } from "../db/pool.js";
import type { CampaignSnapshot } from "./assistantBuilder.js";
import { cleanIntroName } from "./placeholders.js";

export class PublishError extends Error {}

export async function buildSnapshot(campaignId: string, organizationId: string): Promise<{ snapshot: CampaignSnapshot; agentUpdatedAt: Date }> {
  const c = await pool.query(
    `select c.*, a.id as agent_id, a.name as agent_name, a.system_prompt, a.personality, a.tone, a.greeting, a.ending_behavior,
            a.faqs, a.objection_handling, a.fallback_behavior, a.transfer_rules, a.temperature, a.llm_model as agent_llm_model, a.llm_provider as agent_llm_provider,
            a.max_call_duration_seconds as agent_max_duration, a.updated_at as agent_updated_at,
            v.provider as voice_provider, v.provider_voice_id, v.name as voice_name
     from campaigns c
     left join ai_agents a on a.id = c.ai_agent_id
     left join voices v on v.id = coalesce(c.voice_id, a.voice_id)
     where c.id = $1 and c.organization_id = $2`,
    [campaignId, organizationId]
  );
  if (c.rows.length === 0) throw new PublishError("Campaign not found.");
  const r = c.rows[0];
  if (!r.agent_id) throw new PublishError("Assign an AI agent before publishing.");

  const snapshot: CampaignSnapshot = {
    campaignId,
    version: 0,
    introName: cleanIntroName(r.intro_name || r.name),
    callbackNumber: r.callback_number,
    script: r.script ?? "",
    knowledgeText: r.knowledge_text ?? "",
    transferNumber: r.transfer_number,
    transferTargets: r.transfer_targets ?? {},
    recordingDisclosure: Boolean(r.recording_disclosure),
    backgroundSound: r.background_sound !== false,
    maxCallDurationSeconds: r.max_call_duration_seconds ?? r.agent_max_duration ?? 600,
    llmModel: r.agent_llm_model || r.llm_model || "gpt-4o-mini",
    llmProvider: r.agent_llm_model ? r.agent_llm_provider || "openai" : "openai",
    agent: {
      id: r.agent_id,
      name: r.agent_name,
      systemPrompt: r.system_prompt ?? "",
      personality: r.personality,
      tone: r.tone,
      greeting: r.greeting,
      endingMessage: r.ending_behavior,
      faqs: r.faqs ?? [],
      objectionHandling: r.objection_handling ?? [],
      fallbackBehavior: r.fallback_behavior,
      transferNumber: r.transfer_rules?.transferNumber ?? null,
      temperature: Number(r.temperature ?? 0.4),
      voice: r.provider_voice_id ? { provider: r.voice_provider, providerVoiceId: r.provider_voice_id, name: r.voice_name } : null,
    },
  };
  return { snapshot, agentUpdatedAt: r.agent_updated_at };
}

// Save & publish (playbook §4): freezes the campaign + its agent, voice,
// script, knowledge base, calling and voicemail rules into a version and
// makes it live.
export async function publishCampaign(campaignId: string, organizationId: string, userId: string) {
  const { snapshot, agentUpdatedAt } = await buildSnapshot(campaignId, organizationId);

  const pool_ = await pool.query(
    `select count(*) from campaign_phone_numbers cpn join phone_numbers p on p.id = cpn.phone_number_id
     where cpn.campaign_id = $1 and p.vapi_phone_number_id is not null`,
    [campaignId]
  );
  const warnings: string[] = [];
  if (Number(pool_.rows[0].count) === 0) {
    warnings.push("No VAPI-connected phone number in this campaign's pool yet — it can't dial until one is added.");
  }
  if (/REPLACE THE FIGURES/.test(snapshot.knowledgeText)) {
    warnings.push("The knowledge base still has the template's example offer figures. Replace them with your approved offers — the agent quotes only what's there.");
  }
  if (!snapshot.agent.voice) warnings.push("The agent has no voice assigned; VAPI's default voice will be used.");

  return withTransaction(async (client) => {
    const next = await client.query<{ v: number }>(
      "select coalesce(max(version), 0) + 1 as v from campaign_versions where campaign_id = $1",
      [campaignId]
    );
    snapshot.version = next.rows[0].v;
    const version = await client.query<{ id: string }>(
      `insert into campaign_versions (campaign_id, version, snapshot, agent_updated_at, published_by)
       values ($1,$2,$3,$4,$5) returning id`,
      [campaignId, snapshot.version, JSON.stringify(snapshot), agentUpdatedAt, userId]
    );
    await client.query(
      `update campaigns set published_version_id = $1, published_at = now(), has_unpublished_changes = false, updated_at = now()
       where id = $2`,
      [version.rows[0].id, campaignId]
    );
    return { versionId: version.rows[0].id, version: snapshot.version, warnings };
  });
}

// Warn before publishing if the linked agent changed since the last publish.
export async function agentChangedSincePublish(campaignId: string): Promise<boolean> {
  const r = await pool.query(
    `select cv.agent_updated_at, a.updated_at
     from campaigns c
     join campaign_versions cv on cv.id = c.published_version_id
     join ai_agents a on a.id = c.ai_agent_id
     where c.id = $1`,
    [campaignId]
  );
  if (r.rows.length === 0) return false;
  return new Date(r.rows[0].updated_at).getTime() > new Date(r.rows[0].agent_updated_at).getTime();
}

export async function loadPublishedSnapshot(versionId: string): Promise<CampaignSnapshot | null> {
  const r = await pool.query<{ snapshot: CampaignSnapshot }>("select snapshot from campaign_versions where id = $1", [versionId]);
  return r.rows[0]?.snapshot ?? null;
}
