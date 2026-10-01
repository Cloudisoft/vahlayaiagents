import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { requireModuleAccess } from "../middleware/moduleAccess.js";
import { requireRole } from "../middleware/rbac.js";
import { listVapiAssistants } from "../voiceai/vapiClient.js";
import { AGENT_TEMPLATES } from "../voiceai/agentTemplates.js";

export const agentsRouter = Router();
agentsRouter.use(requireAuth);
agentsRouter.use(requireModuleAccess("voice_agents"));
agentsRouter.use(requireRole("agent_manager", "hr"));

const AGENT_TYPES = [
  "sales",
  "support",
  "front_desk",
  "appointment_setter",
  "lead_qualification",
  "recruitment_interviewer",
  "follow_up",
  "custom",
] as const;

const TONES = ["calm", "polite", "professional", "friendly", "conversational", "confident", "persuasive", "direct"] as const;

const agentSchema = z.object({
  name: z.string().min(1),
  agentType: z.enum(AGENT_TYPES),
  purpose: z.string().optional(),
  systemPrompt: z.string().optional(),
  personality: z.string().optional(),
  tone: z.enum(TONES).optional(),
  faqs: z.array(z.object({ question: z.string(), answer: z.string() })).optional(),
  objectionHandling: z.array(z.object({ objection: z.string(), response: z.string() })).optional(),
  transferRules: z.record(z.any()).optional(),
  workingHours: z.record(z.any()).optional(),
  maxCallDurationSeconds: z.number().optional(),
  voiceId: z.string().uuid().optional(),
  language: z.string().optional(),
  greeting: z.string().optional(),
  endingBehavior: z.string().optional(),
  llmModel: z.string().nullable().optional(),
  temperature: z.number().min(0).max(1.5).optional(),
  fallbackBehavior: z.string().nullable().optional(),
});

agentsRouter.get("/", async (req: AuthedRequest, res) => {
  const result = await pool.query(
    `select a.*, v.name as voice_name from ai_agents a left join voices v on v.id = a.voice_id
     where a.organization_id = $1 order by a.created_at desc`,
    [req.auth!.organizationId]
  );
  res.json({ agents: result.rows });
});

agentsRouter.get("/templates", (_req, res) => {
  res.json({ templates: AGENT_TEMPLATES });
});

agentsRouter.post("/templates/:key", async (req: AuthedRequest, res) => {
  const t = AGENT_TEMPLATES.find((x) => x.key === req.params.key);
  if (!t) return res.status(404).json({ error: "Template not found." });
  const result = await pool.query(
    `insert into ai_agents (organization_id, name, agent_type, purpose, system_prompt, tone, greeting, faqs,
       objection_handling, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
    [
      req.auth!.organizationId,
      t.name,
      t.agentType,
      t.purpose,
      t.systemPrompt,
      t.tone,
      t.greeting,
      JSON.stringify(t.faqs),
      JSON.stringify(t.objectionHandling),
      req.auth!.userId,
    ]
  );
  res.status(201).json({ agent: result.rows[0], suggestedCampaign: t.suggestedCampaign });
});

// Import assistants already built in the VAPI dashboard as local agents.
// Re-importing updates the prompt/greeting/model of the matching agent.
agentsRouter.post("/import-vapi", async (req: AuthedRequest, res) => {
  const org = req.auth!.organizationId;
  let assistants;
  try {
    assistants = await listVapiAssistants(org);
  } catch (err) {
    return res.status(502).json({ error: (err as Error).message });
  }
  let created = 0;
  let updated = 0;
  for (const a of assistants) {
    const systemPrompt = a.model?.messages?.find((m) => m.role === "system")?.content ?? null;
    let voiceId: string | null = null;
    if (a.voice?.provider && a.voice.voiceId) {
      const v = await pool.query(
        `insert into voices (provider, provider_voice_id, name) values ($1,$2,$3)
         on conflict (provider, provider_voice_id) do update set provider = excluded.provider returning id`,
        [a.voice.provider, a.voice.voiceId, `${a.voice.provider} ${a.voice.voiceId.slice(0, 8)}`]
      );
      voiceId = v.rows[0].id;
    }
    const existing = await pool.query("select id from ai_agents where organization_id = $1 and vapi_assistant_id = $2", [org, a.id]);
    if (existing.rows.length) {
      await pool.query(
        `update ai_agents set name = coalesce($1, name), system_prompt = coalesce($2, system_prompt),
           greeting = coalesce($3, greeting), llm_model = coalesce($4, llm_model),
           temperature = coalesce($5, temperature), voice_id = coalesce($6, voice_id),
           max_call_duration_seconds = coalesce($7, max_call_duration_seconds), updated_at = now()
         where id = $8`,
        [a.name ?? null, systemPrompt, a.firstMessage ?? null, a.model?.model ?? null, a.model?.temperature ?? null, voiceId, a.maxDurationSeconds ?? null, existing.rows[0].id]
      );
      updated++;
    } else {
      await pool.query(
        `insert into ai_agents (organization_id, name, agent_type, system_prompt, greeting, llm_model, temperature,
           voice_id, max_call_duration_seconds, vapi_assistant_id, created_by)
         values ($1,$2,'custom',$3,$4,$5,$6,$7,$8,$9,$10)`,
        [org, a.name || `VAPI assistant ${a.id.slice(0, 8)}`, systemPrompt, a.firstMessage ?? null, a.model?.model ?? null, a.model?.temperature ?? 0.4, voiceId, a.maxDurationSeconds ?? 600, a.id, req.auth!.userId]
      );
      created++;
    }
  }
  res.json({ message: `Imported ${created} new and updated ${updated} agent(s) from VAPI.` });
});

agentsRouter.get("/:id", async (req: AuthedRequest, res) => {
  const result = await pool.query("select * from ai_agents where id = $1 and organization_id = $2", [
    req.params.id,
    req.auth!.organizationId,
  ]);
  if (result.rows.length === 0) return res.status(404).json({ error: "Agent not found." });
  res.json({ agent: result.rows[0] });
});

agentsRouter.post("/", async (req: AuthedRequest, res) => {
  const parsed = agentSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const d = parsed.data;
  const result = await pool.query(
    `insert into ai_agents (organization_id, name, agent_type, purpose, system_prompt, personality, tone, faqs,
       objection_handling, transfer_rules, working_hours, max_call_duration_seconds, voice_id, language, greeting,
       ending_behavior, created_by, llm_model, temperature, fallback_behavior)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) returning *`,
    [
      req.auth!.organizationId,
      d.name,
      d.agentType,
      d.purpose ?? null,
      d.systemPrompt ?? null,
      d.personality ?? null,
      d.tone ?? "professional",
      JSON.stringify(d.faqs ?? []),
      JSON.stringify(d.objectionHandling ?? []),
      JSON.stringify(d.transferRules ?? {}),
      JSON.stringify(d.workingHours ?? {}),
      d.maxCallDurationSeconds ?? 600,
      d.voiceId ?? null,
      d.language ?? "en-US",
      d.greeting ?? null,
      d.endingBehavior ?? null,
      req.auth!.userId,
      d.llmModel ?? null,
      d.temperature ?? 0.4,
      d.fallbackBehavior ?? null,
    ]
  );
  res.status(201).json({ agent: result.rows[0] });
});

agentsRouter.patch("/:id", async (req: AuthedRequest, res) => {
  const parsed = agentSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const existing = await pool.query("select id from ai_agents where id = $1 and organization_id = $2", [
    req.params.id,
    req.auth!.organizationId,
  ]);
  if (existing.rows.length === 0) return res.status(404).json({ error: "Agent not found." });
  const d = parsed.data;
  const result = await pool.query(
    `update ai_agents set
       name = coalesce($1, name), agent_type = coalesce($2, agent_type), purpose = coalesce($3, purpose),
       system_prompt = coalesce($4, system_prompt), personality = coalesce($5, personality), tone = coalesce($6, tone),
       faqs = coalesce($7, faqs), objection_handling = coalesce($8, objection_handling),
       transfer_rules = coalesce($9, transfer_rules), working_hours = coalesce($10, working_hours),
       max_call_duration_seconds = coalesce($11, max_call_duration_seconds), voice_id = coalesce($12, voice_id),
       language = coalesce($13, language), greeting = coalesce($14, greeting), ending_behavior = coalesce($15, ending_behavior),
       llm_model = coalesce($17, llm_model), temperature = coalesce($18, temperature),
       fallback_behavior = coalesce($19, fallback_behavior),
       updated_at = now()
     where id = $16 returning *`,
    [
      d.name ?? null,
      d.agentType ?? null,
      d.purpose ?? null,
      d.systemPrompt ?? null,
      d.personality ?? null,
      d.tone ?? null,
      d.faqs ? JSON.stringify(d.faqs) : null,
      d.objectionHandling ? JSON.stringify(d.objectionHandling) : null,
      d.transferRules ? JSON.stringify(d.transferRules) : null,
      d.workingHours ? JSON.stringify(d.workingHours) : null,
      d.maxCallDurationSeconds ?? null,
      d.voiceId ?? null,
      d.language ?? null,
      d.greeting ?? null,
      d.endingBehavior ?? null,
      req.params.id,
      d.llmModel ?? null,
      d.temperature ?? null,
      d.fallbackBehavior ?? null,
    ]
  );
  res.json({ agent: result.rows[0] });
});

agentsRouter.delete("/:id", async (req: AuthedRequest, res) => {
  await pool.query("delete from ai_agents where id = $1 and organization_id = $2", [
    req.params.id,
    req.auth!.organizationId,
  ]);
  res.status(204).end();
});
