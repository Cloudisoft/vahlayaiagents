import { Router } from "express";
import multer from "multer";
import crypto from "node:crypto";
import ExcelJS from "exceljs";
import { stringify } from "csv-stringify/sync";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { requireModuleAccess } from "../middleware/moduleAccess.js";
import { importLeads, readRows } from "../leadgen/leadImport.js";
import { INDUSTRIES, OPPORTUNITIES } from "../leadgen/engine/taxonomy.js";
import { SOURCES, sourceStatus } from "../leadgen/engine/sources/registry.js";
import { createDiscoveryJob } from "../leadgen/engine/jobs.js";
import { assertPublicUrl } from "../leadgen/engine/enrich.js";
import { nameKey, normalizeEmail, normalizePhone, normalizeWebsite } from "../leadgen/engine/normalize.js";

export const leadgenRouter = Router();
leadgenRouter.use(requireAuth);
leadgenRouter.use(requireModuleAccess("leadgen"));

const org = (req: AuthedRequest) => req.auth!.organizationId;
const uid = (req: AuthedRequest) => req.auth!.userId;
const bad = (res: any, e: z.ZodError) => res.status(400).json({ error: e.issues[0]?.message ?? "Invalid request." });

// ---------- reference data ----------

leadgenRouter.get("/meta", async (req: AuthedRequest, res) => {
  res.json({ industries: INDUSTRIES.map(({ key, label, group }) => ({ key, label, group })), opportunities: OPPORTUNITIES.map(({ key, label }) => ({ key, label })), sources: await sourceStatus(org(req)) });
});

leadgenRouter.get("/summary", async (req: AuthedRequest, res) => {
  const [t, jobs, lists] = await Promise.all([
    pool.query(
      `select count(*)::int as leads,
              count(*) filter (where first_discovered_at is not null)::int as discovered,
              count(*) filter (where business_email is not null)::int as with_email,
              count(*) filter (where main_phone_e164 is not null)::int as with_phone,
              count(*) filter (where website is not null)::int as with_website,
              count(*) filter (where qualification_status = 'qualified')::int as qualified,
              count(*) filter (where pipeline_status in ('discovered','enriching','enriched','qualifying'))::int as processing,
              round(avg(lead_score))::int as avg_score,
              count(*) filter (where created_at > now() - interval '7 days')::int as new_7d
       from leads where organization_id = $1`,
      [org(req)]
    ),
    pool.query("select count(*) filter (where status in ('queued','running','enriching'))::int as active, count(*)::int as total from discovery_jobs where organization_id = $1", [org(req)]),
    pool.query("select count(*)::int as n from lead_lists where organization_id = $1", [org(req)]),
  ]);
  res.json({ ...t.rows[0], activeJobs: jobs.rows[0].active, jobs: jobs.rows[0].total, lists: lists.rows[0].n });
});

// ---------- discovery jobs ----------

const locationSchema = z.object({ country: z.string().length(2).default("US"), state: z.string().max(60).optional(), city: z.string().max(80).optional(), zip: z.string().max(12).optional() });
const discoverSchema = z.object({
  name: z.string().max(120).optional(),
  sources: z.array(z.string()).min(1),
  maxResults: z.number().int().min(10).max(5000).default(300),
  criteria: z.object({
    industry: z.string().nullable().default(null),
    keywords: z.string().max(300).default(""),
    services: z.string().max(300).default(""),
    locations: z.array(locationSchema).min(1).max(25),
    website: z.enum(["any", "has", "missing"]).default("any"),
    requirePhone: z.boolean().default(false),
    requireEmail: z.boolean().default(false),
    size: z.enum(["any", "single", "multi"]).default("any"),
    opportunities: z.array(z.string()).max(12).default([]),
    idealCustomer: z.string().max(1000).default(""),
    qualifyThreshold: z.number().int().min(30).max(95).default(70),
  }),
});

leadgenRouter.post("/discover", async (req: AuthedRequest, res) => {
  const p = discoverSchema.safeParse(req.body);
  if (!p.success) return bad(res, p.error);
  const locs = p.data.criteria.locations.filter((l) => l.state || l.city || l.zip);
  if (!locs.length) return res.status(400).json({ error: "Each location needs a state, city or ZIP code." });
  try {
    const id = await createDiscoveryJob({ organizationId: org(req), userId: uid(req), name: p.data.name, sources: p.data.sources, maxResults: p.data.maxResults, criteria: { ...p.data.criteria, locations: locs } });
    res.status(201).json({ id });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

leadgenRouter.get("/jobs", async (req: AuthedRequest, res) => {
  const r = await pool.query(
    `select id, name, status, criteria, sources, max_results, counts, error, created_at, started_at, finished_at, lead_list_id
     from discovery_jobs where organization_id = $1 order by created_at desc limit 100`,
    [org(req)]
  );
  res.json({ jobs: r.rows });
});

leadgenRouter.get("/jobs/:id", async (req: AuthedRequest, res) => {
  const j = await pool.query("select * from discovery_jobs where id = $1 and organization_id = $2", [req.params.id, org(req)]);
  if (!j.rows[0]) return res.status(404).json({ error: "Discovery job not found." });
  const tasks = await pool.query("select id, source, query, page, status, attempts, found, error, next_attempt_at, finished_at from discovery_tasks where job_id = $1 order by created_at", [req.params.id]);
  res.json({ job: j.rows[0], tasks: tasks.rows, attribution: SOURCES.filter((s) => j.rows[0].sources.includes(s.key) && s.attribution).map((s) => s.attribution) });
});

leadgenRouter.post("/jobs/:id/cancel", async (req: AuthedRequest, res) => {
  const r = await pool.query("update discovery_jobs set status = 'cancelled', finished_at = now() where id = $1 and organization_id = $2 and status in ('queued','running','enriching') returning id", [req.params.id, org(req)]);
  if (!r.rows[0]) return res.status(409).json({ error: "This job has already finished." });
  await pool.query("update discovery_tasks set status = 'skipped', error = 'Job cancelled' where job_id = $1 and status = 'queued'", [req.params.id]);
  res.json({ ok: true });
});

// Retries every failed request and failed lead step; results so far are kept.
leadgenRouter.post("/jobs/:id/retry", async (req: AuthedRequest, res) => {
  const j = await pool.query("select id from discovery_jobs where id = $1 and organization_id = $2", [req.params.id, org(req)]);
  if (!j.rows[0]) return res.status(404).json({ error: "Discovery job not found." });
  const t = await pool.query("update discovery_tasks set status = 'queued', attempts = 0, error = null, next_attempt_at = now() where job_id = $1 and status = 'failed' returning id", [req.params.id]);
  const l = await pool.query(
    `update leads set pipeline_status = case pipeline_status when 'enrich_failed' then 'discovered' else 'enriched' end, pipeline_attempts = 0, pipeline_error = null, pipeline_next_at = now()
     where id in (select lead_id from discovery_job_leads where job_id = $1) and pipeline_status in ('enrich_failed','qualify_failed') returning id`,
    [req.params.id]
  );
  if (t.rowCount || l.rowCount) await pool.query("update discovery_jobs set status = 'running', finished_at = null, error = null where id = $1", [req.params.id]);
  res.json({ tasks: t.rowCount ?? 0, leads: l.rowCount ?? 0 });
});

// ---------- lead lists ----------

leadgenRouter.get("/lists", async (req: AuthedRequest, res) => {
  const r = await pool.query(
    `select l.*, (select count(*) from leads where lead_list_id = l.id) as lead_count from lead_lists l where organization_id = $1 order by created_at desc`,
    [org(req)]
  );
  res.json({ lists: r.rows });
});

leadgenRouter.post("/lists", async (req: AuthedRequest, res) => {
  const p = z.object({ name: z.string().min(1).max(120), description: z.string().max(500).optional() }).safeParse(req.body);
  if (!p.success) return bad(res, p.error);
  const r = await pool.query("insert into lead_lists (organization_id, name, description, created_by) values ($1,$2,$3,$4) returning *", [org(req), p.data.name, p.data.description ?? null, uid(req)]);
  res.status(201).json({ list: r.rows[0] });
});

leadgenRouter.delete("/lists/:id", async (req: AuthedRequest, res) => {
  await pool.query("delete from lead_lists where id = $1 and organization_id = $2", [req.params.id, org(req)]);
  res.status(204).end();
});

// ---------- leads: search, filter, sort ----------

const SORTS: Record<string, string> = {
  score: "lead_score desc nulls last, completeness desc nulls last",
  fit: "fit_score desc nulls last, lead_score desc nulls last",
  completeness: "completeness desc nulls last, lead_score desc nulls last",
  recent: "coalesce(last_discovered_at, created_at) desc",
  name: "business_name asc",
};

function leadFilter(req: AuthedRequest, q: Record<string, string | undefined>) {
  const where = ["l.organization_id = $1"];
  const params: unknown[] = [org(req)];
  const add = (sql: string, v: unknown) => {
    params.push(v);
    where.push(sql.replace(/\?/g, `$${params.length}`));
  };
  if (q.listId) add("l.lead_list_id = ?", q.listId);
  if (q.jobId) add("exists (select 1 from discovery_job_leads d where d.lead_id = l.id and d.job_id = ?)", q.jobId);
  if (q.industry) add("exists (select 1 from discovery_job_leads d join discovery_jobs j on j.id = d.job_id where d.lead_id = l.id and j.criteria->>'industry' = ?)", q.industry);
  if (q.search) add("(l.business_name ilike ? or l.website ilike ? or l.business_email ilike ? or l.main_phone_e164 like ? or l.category ilike ?)", `%${q.search}%`);
  if (q.country) add("l.country = ?", q.country.toUpperCase());
  if (q.state) add("lower(l.state) = lower(?)", q.state);
  if (q.city) add("lower(l.city) = lower(?)", q.city);
  if (q.minScore) add("l.lead_score >= ?", Number(q.minScore));
  if (q.maxScore) add("l.lead_score <= ?", Number(q.maxScore));
  if (q.website) add("l.website_status = ?", q.website);
  if (q.hasEmail === "true") where.push("l.business_email is not null");
  if (q.hasEmail === "false") where.push("l.business_email is null");
  if (q.validEmail === "true") where.push("(l.validation->'email'->>'valid')::boolean is true");
  if (q.hasPhone === "true") where.push("l.main_phone_e164 is not null");
  if (q.hasPhone === "false") where.push("l.main_phone_e164 is null");
  if (q.hasContact === "true") where.push("(l.main_phone_e164 is not null or l.business_email is not null)");
  if (q.hasContact === "false") where.push("(l.main_phone_e164 is null and l.business_email is null)");
  if (q.source) add("? = any(l.sources)", q.source);
  if (q.status) {
    if (q.status === "processing") where.push("l.pipeline_status in ('discovered','enriching','enriched','qualifying')");
    else if (q.status === "failed") where.push("l.pipeline_status in ('enrich_failed','qualify_failed')");
    else add("l.qualification_status = ?", q.status);
  }
  if (q.opportunity) add("? = any(l.opportunities)", q.opportunity);
  if (q.size === "multi") where.push("(l.qualification->>'multiLocation')::boolean is true");
  if (q.size === "single") where.push("(l.qualification->>'multiLocation')::boolean is false");
  if (q.tag) add("? = any(l.tags)", q.tag);
  if (q.discovered === "true") where.push("l.first_discovered_at is not null");
  return { where: where.join(" and "), params };
}

leadgenRouter.get("/leads", async (req: AuthedRequest, res) => {
  const q = req.query as Record<string, string | undefined>;
  const page = Math.max(1, Number(q.page ?? 1));
  const pageSize = Math.min(200, Math.max(1, Number(q.pageSize ?? 50)));
  const { where, params } = leadFilter(req, q);
  const sort = SORTS[q.sort ?? "score"] ?? SORTS.score;
  const [rows, count] = await Promise.all([
    pool.query(
      `select l.id, l.business_name, l.category, l.city, l.state, l.zip, l.country, l.website, l.website_status, l.main_phone, l.main_phone_e164, l.business_email,
              l.decision_maker_email, l.industry, l.quality_score, l.source, l.sources, l.completeness, l.lead_score, l.fit_score, l.qualification_status,
              l.primary_opportunity, l.opportunities, l.pipeline_status, l.pipeline_error, l.tags, l.notes_count, l.lead_list_id, l.created_at, l.last_discovered_at,
              (l.validation->'email'->>'valid')::boolean as email_valid, (l.validation->'phone'->>'valid')::boolean as phone_valid
       from leads l where ${where} order by ${sort} limit ${pageSize} offset ${(page - 1) * pageSize}`,
      params
    ),
    pool.query(`select count(*)::int as n from leads l where ${where}`, params),
  ]);
  res.json({ leads: rows.rows, total: count.rows[0].n, page, pageSize });
});

leadgenRouter.get("/leads/export", (req, res, next) => exportCsvRoute(req as AuthedRequest, res).catch(next));

leadgenRouter.get("/leads/:id", async (req: AuthedRequest, res) => {
  const l = await pool.query("select * from leads where id = $1 and organization_id = $2", [req.params.id, org(req)]);
  if (!l.rows[0]) return res.status(404).json({ error: "Lead not found." });
  const [raw, notes, jobs] = await Promise.all([
    pool.query("select id, source, source_ref, source_url, raw, fetched_at from lead_source_records where lead_id = $1 order by fetched_at desc", [req.params.id]),
    pool.query("select n.id, n.body, n.created_at, u.username as author from lead_notes n left join users u on u.id = n.author_id where n.lead_id = $1 order by n.created_at desc", [req.params.id]),
    pool.query("select j.id, j.name, d.was_new, d.created_at from discovery_job_leads d join discovery_jobs j on j.id = d.job_id where d.lead_id = $1 order by d.created_at desc", [req.params.id]),
  ]);
  res.json({ lead: l.rows[0], sourceRecords: raw.rows, notes: notes.rows, jobs: jobs.rows });
});

// Manual edits are recorded as source "manual" in the field history.
leadgenRouter.patch("/leads/:id", async (req: AuthedRequest, res) => {
  const p = z
    .object({
      tags: z.array(z.string().max(40)).max(30).optional(),
      leadListId: z.string().uuid().nullable().optional(),
      business_name: z.string().min(1).max(200).optional(),
      website: z.string().max(300).nullable().optional(),
      main_phone: z.string().max(40).nullable().optional(),
      business_email: z.string().max(200).nullable().optional(),
      decision_maker_name: z.string().max(120).nullable().optional(),
      decision_maker_email: z.string().max(200).nullable().optional(),
      company_size: z.string().max(60).nullable().optional(),
    })
    .safeParse(req.body);
  if (!p.success) return bad(res, p.error);
  const cur = (await pool.query("select * from leads where id = $1 and organization_id = $2", [req.params.id, org(req)])).rows[0];
  if (!cur) return res.status(404).json({ error: "Lead not found." });
  const d = p.data;
  const sets: Record<string, unknown> = {};
  const meta = cur.field_meta ?? {};
  const at = new Date().toISOString();
  const mark = (f: string) => (meta[f] = { source: "manual", at, by: uid(req) });
  if (d.tags) sets.tags = Array.from(new Set(d.tags.map((t) => t.trim()).filter(Boolean)));
  if (d.leadListId !== undefined) sets.lead_list_id = d.leadListId;
  if (d.business_name) (sets.business_name = d.business_name.trim()), (sets.name_key = nameKey(d.business_name)), mark("business_name");
  if (d.website !== undefined) {
    const w = normalizeWebsite(d.website);
    if (d.website && !w.website) return res.status(400).json({ error: "That isn't a valid website address." });
    sets.website = w.website;
    sets.website_domain = w.domain;
    mark("website");
  }
  if (d.main_phone !== undefined) {
    const ph = normalizePhone(d.main_phone, cur.country ?? "US");
    if (d.main_phone && !ph.e164) return res.status(400).json({ error: ph.reason ?? "That phone number isn't valid." });
    sets.main_phone = d.main_phone;
    sets.main_phone_e164 = ph.e164;
    mark("main_phone");
  }
  if (d.business_email !== undefined) {
    const e = d.business_email ? normalizeEmail(d.business_email) : null;
    if (d.business_email && !e) return res.status(400).json({ error: "That email address isn't valid." });
    sets.business_email = e;
    mark("business_email");
  }
  for (const f of ["decision_maker_name", "decision_maker_email", "company_size"] as const) if (d[f] !== undefined) (sets[f] = d[f]), mark(f);
  const contactChanged = ["website", "main_phone_e164", "business_email"].some((k) => k in sets);
  if (contactChanged && cur.pipeline_status) Object.assign(sets, { pipeline_status: "discovered", pipeline_attempts: 0, pipeline_next_at: new Date() });
  sets.field_meta = JSON.stringify(meta);
  const keys = Object.keys(sets);
  await pool.query(`update leads set ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")}, updated_at = now() where id = $1`, [cur.id, ...keys.map((k) => sets[k])]);
  res.json({ ok: true, revalidating: Boolean(contactChanged && cur.pipeline_status) });
});

leadgenRouter.post("/leads/:id/notes", async (req: AuthedRequest, res) => {
  const p = z.object({ body: z.string().min(1).max(4000) }).safeParse(req.body);
  if (!p.success) return bad(res, p.error);
  const own = await pool.query("select id from leads where id = $1 and organization_id = $2", [req.params.id, org(req)]);
  if (!own.rows[0]) return res.status(404).json({ error: "Lead not found." });
  const r = await pool.query("insert into lead_notes (organization_id, lead_id, author_id, body) values ($1,$2,$3,$4) returning id", [org(req), req.params.id, uid(req), p.data.body.trim()]);
  await pool.query("update leads set notes_count = notes_count + 1 where id = $1", [req.params.id]);
  res.status(201).json({ id: r.rows[0].id });
});

leadgenRouter.delete("/leads/:id/notes/:noteId", async (req: AuthedRequest, res) => {
  const r = await pool.query("delete from lead_notes where id = $1 and lead_id = $2 and organization_id = $3 returning id", [req.params.noteId, req.params.id, org(req)]);
  if (r.rows[0]) await pool.query("update leads set notes_count = greatest(0, notes_count - 1) where id = $1", [req.params.id]);
  res.status(204).end();
});

leadgenRouter.post("/leads", async (req: AuthedRequest, res) => {
  const p = z.object({ businessName: z.string().min(1), website: z.string().optional(), mainPhone: z.string().optional(), businessEmail: z.string().optional(), city: z.string().optional(), state: z.string().optional(), leadListId: z.string().uuid().optional() }).safeParse(req.body);
  if (!p.success) return bad(res, p.error);
  const d = p.data;
  const w = normalizeWebsite(d.website);
  const ph = normalizePhone(d.mainPhone);
  const at = new Date().toISOString();
  const meta = Object.fromEntries(["business_name", ...(w.website ? ["website"] : []), ...(ph.e164 ? ["main_phone"] : []), ...(d.businessEmail ? ["business_email"] : [])].map((f) => [f, { source: "manual", at }]));
  const r = await pool.query(
    `insert into leads (organization_id, lead_list_id, business_name, name_key, website, website_domain, main_phone, main_phone_e164, business_email, city, state, source, field_meta, sources, pipeline_status, pipeline_next_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'manual',$12,'{manual}','discovered',now()) returning id`,
    [org(req), d.leadListId ?? null, d.businessName, nameKey(d.businessName), w.website, w.domain, d.mainPhone ?? null, ph.e164, normalizeEmail(d.businessEmail), d.city ?? null, d.state ?? null, JSON.stringify(meta)]
  );
  res.status(201).json({ id: r.rows[0].id });
});

// ---------- bulk ----------

const bulkSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(5000),
  action: z.enum(["tag", "untag", "add_to_list", "remove_from_list", "reenrich", "requalify", "delete", "set_status"]),
  tag: z.string().max(40).optional(),
  listId: z.string().uuid().optional(),
  status: z.enum(["qualified", "needs_review", "disqualified"]).optional(),
});

leadgenRouter.post("/leads/bulk", async (req: AuthedRequest, res) => {
  const p = bulkSchema.safeParse(req.body);
  if (!p.success) return bad(res, p.error);
  const { ids, action } = p.data;
  const o = org(req);
  let r;
  switch (action) {
    case "tag":
      if (!p.data.tag) return res.status(400).json({ error: "Enter a tag." });
      r = await pool.query("update leads set tags = case when $3 = any(tags) then tags else array_append(tags, $3) end where organization_id = $1 and id = any($2::uuid[])", [o, ids, p.data.tag.trim()]);
      break;
    case "untag":
      r = await pool.query("update leads set tags = array_remove(tags, $3) where organization_id = $1 and id = any($2::uuid[])", [o, ids, p.data.tag ?? ""]);
      break;
    case "add_to_list": {
      if (!p.data.listId) return res.status(400).json({ error: "Choose a list." });
      const l = await pool.query("select id from lead_lists where id = $1 and organization_id = $2", [p.data.listId, o]);
      if (!l.rows[0]) return res.status(404).json({ error: "List not found." });
      r = await pool.query("update leads set lead_list_id = $3 where organization_id = $1 and id = any($2::uuid[])", [o, ids, p.data.listId]);
      break;
    }
    case "remove_from_list":
      r = await pool.query("update leads set lead_list_id = null where organization_id = $1 and id = any($2::uuid[])", [o, ids]);
      break;
    case "reenrich":
      r = await pool.query("update leads set pipeline_status = 'discovered', pipeline_attempts = 0, pipeline_error = null, pipeline_next_at = now() where organization_id = $1 and id = any($2::uuid[])", [o, ids]);
      break;
    case "requalify":
      r = await pool.query(
        "update leads set pipeline_status = case when enriched_at is null then 'discovered' else 'enriched' end, pipeline_attempts = 0, pipeline_error = null, pipeline_next_at = now() where organization_id = $1 and id = any($2::uuid[])",
        [o, ids]
      );
      break;
    case "set_status":
      if (!p.data.status) return res.status(400).json({ error: "Choose a status." });
      r = await pool.query(
        "update leads set qualification_status = $3, qualification = coalesce(qualification, '{}'::jsonb) || jsonb_build_object('manualStatus', $3::text, 'manualBy', $4::text, 'manualAt', now()) where organization_id = $1 and id = any($2::uuid[])",
        [o, ids, p.data.status, uid(req)]
      );
      break;
    case "delete":
      r = await pool.query("delete from leads where organization_id = $1 and id = any($2::uuid[])", [o, ids]);
      break;
  }
  res.json({ updated: r?.rowCount ?? 0 });
});

leadgenRouter.post("/leads/bulk-delete", async (req: AuthedRequest, res) => {
  const p = z.object({ ids: z.array(z.string().uuid()) }).safeParse(req.body);
  if (!p.success) return bad(res, p.error);
  await pool.query("delete from leads where organization_id = $1 and id = any($2::uuid[])", [org(req), p.data.ids]);
  res.status(204).end();
});

// Merges leads that share a phone number: the oldest keeps everything,
// blanks are filled from the duplicates, then duplicates are removed.
leadgenRouter.post("/leads/deduplicate", async (req: AuthedRequest, res) => {
  const groups = await pool.query(
    `select main_phone_e164, array_agg(id order by created_at) as ids from leads
     where organization_id = $1 and main_phone_e164 is not null group by main_phone_e164 having count(*) > 1`,
    [org(req)]
  );
  let removed = 0;
  for (const g of groups.rows) {
    const [keep, ...dupes] = g.ids as string[];
    await pool.query(
      `update leads k set business_email = coalesce(k.business_email, d.business_email), website = coalesce(k.website, d.website),
         address = coalesce(k.address, d.address), city = coalesce(k.city, d.city), state = coalesce(k.state, d.state)
       from (select max(business_email) as business_email, max(website) as website, max(address) as address, max(city) as city, max(state) as state from leads where id = any($2::uuid[])) d
       where k.id = $1`,
      [keep, dupes]
    );
    await pool.query("update lead_source_records set lead_id = $1 where lead_id = any($2::uuid[])", [keep, dupes]);
    await pool.query("insert into discovery_job_leads (job_id, lead_id, was_new) select job_id, $1, false from discovery_job_leads where lead_id = any($2::uuid[]) on conflict do nothing", [keep, dupes]);
    await pool.query("update campaign_leads set lead_id = $1 where lead_id = any($2::uuid[]) and not exists (select 1 from campaign_leads c2 where c2.lead_id = $1 and c2.campaign_id = campaign_leads.campaign_id)", [keep, dupes]).catch(() => undefined);
    const d = await pool.query("delete from leads where id = any($1::uuid[]) and organization_id = $2", [dupes, org(req)]);
    removed += d.rowCount ?? 0;
  }
  res.json({ removed });
});

// ---------- import / export ----------

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

leadgenRouter.post("/leads/import", upload.single("file"), async (req: AuthedRequest, res) => {
  if (!req.file) return res.status(400).json({ error: "No CSV or XLSX file provided." });
  let records: Record<string, unknown>[];
  try {
    records = await readRows(req.file.buffer, req.file.originalname);
  } catch (err) {
    return res.status(400).json({ error: `Could not read file: ${(err as Error).message}` });
  }
  res.json(await importLeads(org(req), records, { leadListId: (req.body.leadListId as string) || null, campaignId: (req.body.campaignId as string) || null }));
});

const yn = (v: unknown) => (v === true ? "Yes" : v === false ? "No" : "");
const EXPORT_COLS: Array<[string, (l: any) => unknown]> = [
  ["Business name", (l) => l.business_name],
  ["Category", (l) => l.category],
  ["Website", (l) => l.website],
  ["Website status", (l) => l.website_status],
  ["Phone", (l) => l.main_phone_e164 ?? l.main_phone],
  ["Phone valid", (l) => yn(l.validation?.phone?.valid)],
  ["Email", (l) => l.business_email],
  ["Email valid", (l) => yn(l.validation?.email?.valid)],
  ["Address", (l) => l.address],
  ["City", (l) => l.city],
  ["State", (l) => l.state],
  ["ZIP", (l) => l.zip],
  ["Country", (l) => l.country],
  ["Description", (l) => l.description],
  ["Social profiles", (l) => (l.social_urls ?? []).join(" ")],
  ["Lead score", (l) => l.lead_score],
  ["Fit score", (l) => l.fit_score],
  ["Qualification", (l) => l.qualification_status],
  ["Top opportunity", (l) => l.qualification?.opportunities?.[0]?.label ?? null],
  ["Opportunities", (l) => (l.qualification?.opportunities ?? []).map((o: any) => o.label).join("; ")],
  ["Qualification summary", (l) => l.qualification?.summary ?? null],
  ["Data completeness", (l) => l.completeness],
  ["Sources", (l) => (l.sources ?? []).join(", ")],
  ["Phone source", (l) => l.field_meta?.main_phone?.source ?? null],
  ["Email source", (l) => l.field_meta?.business_email?.source ?? null],
  ["Last verified", (l) => (l.last_verified_at ? new Date(l.last_verified_at).toISOString() : null)],
  ["Tags", (l) => (l.tags ?? []).join(", ")],
];

async function selectLeads(req: AuthedRequest, body: { ids?: string[]; filter?: Record<string, string> }) {
  if (body.ids?.length) return (await pool.query("select * from leads where organization_id = $1 and id = any($2::uuid[]) order by lead_score desc nulls last", [org(req), body.ids])).rows;
  const { where, params } = leadFilter(req, body.filter ?? {});
  return (await pool.query(`select l.* from leads l where ${where} order by ${SORTS.score} limit 50000`, params)).rows;
}

leadgenRouter.post("/export", async (req: AuthedRequest, res) => {
  const p = z.object({ format: z.enum(["csv", "xlsx"]), ids: z.array(z.string().uuid()).optional(), filter: z.record(z.string()).optional() }).safeParse(req.body);
  if (!p.success) return bad(res, p.error);
  const leads = await selectLeads(req, p.data);
  const stamp = new Date().toISOString().slice(0, 10);
  await pool.query("insert into lead_exports (organization_id, created_by, destination, lead_count) values ($1,$2,$3,$4)", [org(req), uid(req), p.data.format, leads.length]);
  if (p.data.format === "csv") {
    const csv = stringify([EXPORT_COLS.map((c) => c[0]), ...leads.map((l) => EXPORT_COLS.map((c) => c[1](l) ?? ""))]);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="leads-${stamp}.csv"`);
    return res.send(csv);
  }
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Leads");
  ws.columns = EXPORT_COLS.map(([h]) => ({ header: h, key: h, width: Math.min(40, Math.max(12, h.length + 4)) }));
  for (const l of leads) ws.addRow(Object.fromEntries(EXPORT_COLS.map(([h, f]) => [h, f(l) ?? ""])));
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: "frozen", ySplit: 1 }];
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="leads-${stamp}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
});

async function exportCsvRoute(req: AuthedRequest, res: any) {
  const leads = await selectLeads(req, { filter: req.query as Record<string, string> });
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="leads-export.csv"`);
  res.send(stringify([EXPORT_COLS.map((c) => c[0]), ...leads.map((l) => EXPORT_COLS.map((c) => c[1](l) ?? ""))]));
}

// ---------- CRM / outreach ----------

leadgenRouter.get("/crm", async (req: AuthedRequest, res) => {
  const [o, campaigns, exports] = await Promise.all([
    pool.query("select settings->'leadgen' as s from organizations where id = $1", [org(req)]),
    pool.query("select id, name, status from campaigns where organization_id = $1 and status <> 'archived' order by created_at desc", [org(req)]).catch(() => ({ rows: [] })),
    pool.query("select e.*, u.username as by from lead_exports e left join users u on u.id = e.created_by where e.organization_id = $1 order by e.created_at desc limit 30", [org(req)]),
  ]);
  const s = o.rows[0]?.s ?? {};
  res.json({ webhookUrl: s.webhookUrl ?? null, hasSecret: Boolean(s.webhookSecret), campaigns: campaigns.rows, exports: exports.rows });
});

leadgenRouter.put("/crm", async (req: AuthedRequest, res) => {
  const p = z.object({ webhookUrl: z.string().url().nullable(), rotateSecret: z.boolean().optional() }).safeParse(req.body);
  if (!p.success) return bad(res, p.error);
  if (p.data.webhookUrl) {
    if (!p.data.webhookUrl.startsWith("https://")) return res.status(400).json({ error: "The webhook must use https." });
    try {
      await assertPublicUrl(p.data.webhookUrl);
    } catch (e) {
      return res.status(400).json({ error: `That webhook address can't be used: ${(e as Error).message}` });
    }
  }
  const cur = (await pool.query("select settings->'leadgen' as s from organizations where id = $1", [org(req)])).rows[0]?.s ?? {};
  const secret = p.data.rotateSecret || !cur.webhookSecret ? crypto.randomBytes(24).toString("hex") : cur.webhookSecret;
  await pool.query("update organizations set settings = jsonb_set(coalesce(settings,'{}'::jsonb), '{leadgen}', $2::jsonb) where id = $1", [org(req), JSON.stringify({ ...cur, webhookUrl: p.data.webhookUrl, webhookSecret: secret })]);
  res.json({ ok: true, secret: p.data.rotateSecret || !cur.webhookSecret ? secret : undefined });
});

function crmPayload(l: any) {
  return {
    id: l.id,
    business_name: l.business_name,
    category: l.category,
    website: l.website,
    phone: l.main_phone_e164 ?? l.main_phone,
    email: l.business_email,
    address: { street: l.address, city: l.city, state: l.state, zip: l.zip, country: l.country },
    social_profiles: l.social_urls ?? [],
    lead_score: l.lead_score,
    fit_score: l.fit_score,
    qualification_status: l.qualification_status,
    opportunities: (l.qualification?.opportunities ?? []).map((o: any) => ({ key: o.key, label: o.label, strength: o.strength, reason: o.reason })),
    summary: l.qualification?.summary ?? null,
    validation: { phone: l.validation?.phone?.valid ?? null, email: l.validation?.email?.valid ?? null, website: l.website_status },
    sources: l.sources ?? [],
    field_sources: l.field_meta ?? {},
    tags: l.tags ?? [],
  };
}

leadgenRouter.post("/crm/push", async (req: AuthedRequest, res) => {
  const p = z.object({ destination: z.enum(["webhook", "voice_campaign"]), campaignId: z.string().uuid().optional(), ids: z.array(z.string().uuid()).min(1).max(5000) }).safeParse(req.body);
  if (!p.success) return bad(res, p.error);
  const leads = await selectLeads(req, { ids: p.data.ids });
  if (p.data.destination === "voice_campaign") {
    const c = await pool.query("select id, name from campaigns where id = $1 and organization_id = $2", [p.data.campaignId, org(req)]);
    if (!c.rows[0]) return res.status(404).json({ error: "Campaign not found." });
    const r = await pool.query(
      `insert into campaign_leads (campaign_id, lead_id) select $1, l.id from leads l where l.id = any($2::uuid[]) and l.organization_id = $3 and not l.is_dnc and l.main_phone_e164 is not null
       on conflict do nothing`,
      [c.rows[0].id, leads.map((l) => l.id), org(req)]
    );
    const skipped = leads.length - (r.rowCount ?? 0);
    await pool.query("insert into lead_exports (organization_id, created_by, destination, target, lead_count) values ($1,$2,'voice_campaign',$3,$4)", [org(req), uid(req), c.rows[0].name, r.rowCount ?? 0]);
    return res.json({ sent: r.rowCount ?? 0, skipped, note: skipped ? `${skipped} skipped (no phone, on Do Not Call, or already in the campaign).` : null });
  }
  const s = (await pool.query("select settings->'leadgen' as s from organizations where id = $1", [org(req)])).rows[0]?.s ?? {};
  if (!s.webhookUrl) return res.status(400).json({ error: "Set your CRM webhook address first." });
  let sent = 0;
  const errors: string[] = [];
  for (let i = 0; i < leads.length; i += 100) {
    const body = JSON.stringify({ event: "leads.export", sent_at: new Date().toISOString(), leads: leads.slice(i, i + 100).map(crmPayload) });
    const sig = crypto.createHmac("sha256", s.webhookSecret).update(body).digest("hex");
    let ok = false;
    for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
      try {
        await assertPublicUrl(s.webhookUrl);
        const r = await fetch(s.webhookUrl, { method: "POST", redirect: "manual", signal: AbortSignal.timeout(15_000), headers: { "Content-Type": "application/json", "X-Vahlay-Signature": `sha256=${sig}` }, body });
        if (r.ok) ok = true;
        else if (r.status < 500 && r.status !== 429) {
          errors.push(`CRM answered ${r.status}`);
          break;
        } else errors.push(`CRM answered ${r.status}`);
      } catch (e) {
        errors.push((e as Error).message);
      }
      if (!ok && attempt < 3) await new Promise((rs) => setTimeout(rs, 1000 * 2 ** attempt));
    }
    if (ok) sent += Math.min(100, leads.length - i);
  }
  const failed = leads.length - sent;
  await pool.query("insert into lead_exports (organization_id, created_by, destination, target, lead_count, status, error) values ($1,$2,'crm_webhook',$3,$4,$5,$6)", [
    org(req), uid(req), new URL(s.webhookUrl).host, sent, failed ? "failed" : "done", failed ? Array.from(new Set(errors)).join("; ").slice(0, 500) : null,
  ]);
  if (!sent) return res.status(502).json({ error: `The CRM didn't accept the leads: ${Array.from(new Set(errors)).join("; ")}` });
  res.json({ sent, failed, note: failed ? `${failed} couldn't be delivered: ${Array.from(new Set(errors)).join("; ")}` : null });
});

