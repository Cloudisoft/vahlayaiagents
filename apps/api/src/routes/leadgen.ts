import { Router } from "express";
import multer from "multer";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { runLeadDiscovery } from "../leadgen/discoveryService.js";
import { computeQualityScore, normalizeLeadPhone } from "../leadgen/enrichment.js";
import { enqueueJob, isQueueEnabled } from "../services/queue.js";

export const leadgenRouter = Router();
leadgenRouter.use(requireAuth);

// --- Lead lists ---

leadgenRouter.get("/lists", async (req: AuthedRequest, res) => {
  const result = await pool.query(
    `select l.*, (select count(*) from leads where lead_list_id = l.id) as lead_count
     from lead_lists l where organization_id = $1 order by created_at desc`,
    [req.auth!.organizationId]
  );
  res.json({ lists: result.rows });
});

leadgenRouter.post("/lists", async (req: AuthedRequest, res) => {
  const parsed = z.object({ name: z.string().min(1), description: z.string().optional() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const result = await pool.query(
    "insert into lead_lists (organization_id, name, description, created_by) values ($1,$2,$3,$4) returning *",
    [req.auth!.organizationId, parsed.data.name, parsed.data.description ?? null, req.auth!.userId]
  );
  res.status(201).json({ list: result.rows[0] });
});

leadgenRouter.delete("/lists/:id", async (req: AuthedRequest, res) => {
  await pool.query("delete from lead_lists where id = $1 and organization_id = $2", [
    req.params.id,
    req.auth!.organizationId,
  ]);
  res.status(204).end();
});

// --- Discovery ---

const searchSchema = z.object({
  keywords: z.string().min(2),
  state: z.string().optional(),
  city: z.string().optional(),
  zip: z.string().optional(),
  leadListId: z.string().optional(),
  leadListName: z.string().optional(),
});

leadgenRouter.post("/search", async (req: AuthedRequest, res) => {
  const parsed = searchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const d = parsed.data;

  let leadListId = d.leadListId;
  if (!leadListId) {
    const name = d.leadListName ?? `${d.keywords} ${d.state ?? d.city ?? ""}`.trim();
    const list = await pool.query(
      "insert into lead_lists (organization_id, name, created_by) values ($1,$2,$3) returning id",
      [req.auth!.organizationId, name, req.auth!.userId]
    );
    leadListId = list.rows[0].id;
  }

  try {
    if (isQueueEnabled()) {
      const jobId = await enqueueJob({
        queueName: "leadgen-discovery",
        jobType: "discover",
        organizationId: req.auth!.organizationId,
        payload: { leadListId, query: { keywords: d.keywords, state: d.state, city: d.city, zip: d.zip } },
      });
      return res.status(202).json({ message: "Lead discovery queued.", backgroundJobId: jobId, leadListId });
    }
    const result = await runLeadDiscovery({
      organizationId: req.auth!.organizationId,
      leadListId: leadListId!,
      query: { keywords: d.keywords, state: d.state, city: d.city, zip: d.zip },
    });
    res.json({ message: "Lead discovery completed.", leadListId, ...result });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message, leadListId });
  }
});

// --- Leads ---

leadgenRouter.get("/leads", async (req: AuthedRequest, res) => {
  const { listId, search, state, industry, tag } = req.query as Record<string, string | undefined>;
  const page = Math.max(1, Number(req.query.page ?? 1));
  const pageSize = Math.min(200, Number(req.query.pageSize ?? 50));

  const conditions = ["organization_id = $1"];
  const params: unknown[] = [req.auth!.organizationId];
  if (listId) {
    params.push(listId);
    conditions.push(`lead_list_id = $${params.length}`);
  }
  if (search) {
    params.push(`%${search}%`);
    conditions.push(`(business_name ilike $${params.length} or website ilike $${params.length} or business_email ilike $${params.length})`);
  }
  if (state) {
    params.push(state);
    conditions.push(`state = $${params.length}`);
  }
  if (industry) {
    params.push(industry);
    conditions.push(`(industry = $${params.length} or category = $${params.length})`);
  }
  if (tag) {
    params.push(tag);
    conditions.push(`$${params.length} = any(tags)`);
  }

  params.push(pageSize, (page - 1) * pageSize);
  const result = await pool.query(
    `select * from leads where ${conditions.join(" and ")} order by created_at desc limit $${params.length - 1} offset $${params.length}`,
    params
  );
  const countResult = await pool.query(`select count(*) from leads where ${conditions.join(" and ")}`, params.slice(0, -2));
  res.json({ leads: result.rows, page, pageSize, total: Number(countResult.rows[0].count) });
});

const leadSchema = z.object({
  businessName: z.string().min(1),
  address: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  zip: z.string().optional(),
  website: z.string().optional(),
  mainPhone: z.string().optional(),
  businessEmail: z.string().optional(),
  industry: z.string().optional(),
  leadListId: z.string().optional(),
});

leadgenRouter.post("/leads", async (req: AuthedRequest, res) => {
  const parsed = leadSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const d = parsed.data;
  const phoneE164 = normalizeLeadPhone(d.mainPhone ?? null);
  const qualityScore = computeQualityScore({
    businessName: d.businessName,
    address: d.address ?? null,
    website: d.website ?? null,
    mainPhoneE164: phoneE164,
    businessEmail: d.businessEmail ?? null,
    decisionMakerEmail: null,
    lastVerifiedAt: null,
  });
  const result = await pool.query(
    `insert into leads (organization_id, lead_list_id, business_name, address, city, state, zip, website,
       main_phone, main_phone_e164, business_email, industry, source, quality_score)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'manual',$13) returning *`,
    [
      req.auth!.organizationId,
      d.leadListId ?? null,
      d.businessName,
      d.address ?? null,
      d.city ?? null,
      d.state ?? null,
      d.zip ?? null,
      d.website ?? null,
      d.mainPhone ?? null,
      phoneE164,
      d.businessEmail ?? null,
      d.industry ?? null,
      qualityScore,
    ]
  );
  res.status(201).json({ lead: result.rows[0] });
});

leadgenRouter.patch("/leads/:id", async (req: AuthedRequest, res) => {
  const parsed = z.object({ tags: z.array(z.string()).optional(), leadListId: z.string().nullable().optional() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const result = await pool.query(
    `update leads set tags = coalesce($1, tags), lead_list_id = coalesce($2, lead_list_id), updated_at = now()
     where id = $3 and organization_id = $4 returning *`,
    [parsed.data.tags ?? null, parsed.data.leadListId ?? null, req.params.id, req.auth!.organizationId]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: "Lead not found." });
  res.json({ lead: result.rows[0] });
});

leadgenRouter.delete("/leads/:id", async (req: AuthedRequest, res) => {
  await pool.query("delete from leads where id = $1 and organization_id = $2", [req.params.id, req.auth!.organizationId]);
  res.status(204).end();
});

leadgenRouter.post("/leads/bulk-delete", async (req: AuthedRequest, res) => {
  const parsed = z.object({ ids: z.array(z.string()) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  await pool.query("delete from leads where organization_id = $1 and id = any($2)", [
    req.auth!.organizationId,
    parsed.data.ids,
  ]);
  res.status(204).end();
});

leadgenRouter.post("/leads/deduplicate", async (req: AuthedRequest, res) => {
  const result = await pool.query(
    `delete from leads a using leads b
     where a.organization_id = $1 and b.organization_id = $1
       and a.id > b.id
       and a.main_phone_e164 is not null and a.main_phone_e164 = b.main_phone_e164
     returning a.id`,
    [req.auth!.organizationId]
  );
  res.json({ removed: result.rowCount });
});

// --- CSV import/export ---

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

leadgenRouter.post("/leads/import", upload.single("file"), async (req: AuthedRequest, res) => {
  if (!req.file) return res.status(400).json({ error: "No CSV file provided." });
  let records: Record<string, string>[];
  try {
    records = parse(req.file.buffer, { columns: (h: string[]) => h.map((c) => c.trim().toLowerCase()), skip_empty_lines: true });
  } catch (err) {
    return res.status(400).json({ error: `Invalid CSV: ${(err as Error).message}` });
  }

  const leadListId = (req.body.leadListId as string) || null;
  let imported = 0;
  const errors: string[] = [];
  const orNull = (v: string | undefined) => (v && v.trim().length > 0 ? v.trim() : null);

  for (const r of records) {
    const businessName = orNull(r.business_name ?? r.company ?? r.name);
    if (!businessName) {
      errors.push("Row missing business name — skipped.");
      continue;
    }
    const website = orNull(r.website);
    const businessEmail = orNull(r.email ?? r.business_email);
    const phoneE164 = normalizeLeadPhone(orNull(r.phone ?? r.main_phone));
    const qualityScore = computeQualityScore({
      businessName,
      address: orNull(r.address),
      website,
      mainPhoneE164: phoneE164,
      businessEmail,
      decisionMakerEmail: null,
      lastVerifiedAt: null,
    });
    await pool.query(
      `insert into leads (organization_id, lead_list_id, business_name, address, city, state, zip, website,
         main_phone, main_phone_e164, business_email, industry, source, quality_score)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'csv_import',$13)`,
      [
        req.auth!.organizationId,
        leadListId,
        businessName,
        orNull(r.address),
        orNull(r.city),
        orNull(r.state),
        orNull(r.zip),
        website,
        orNull(r.phone ?? r.main_phone),
        phoneE164,
        businessEmail,
        orNull(r.industry ?? r.category),
        qualityScore,
      ]
    );
    imported++;
  }

  res.json({ imported, errors });
});

leadgenRouter.get("/leads/export", async (req: AuthedRequest, res) => {
  const listId = req.query.listId as string | undefined;
  const conditions = ["organization_id = $1"];
  const params: unknown[] = [req.auth!.organizationId];
  if (listId) {
    params.push(listId);
    conditions.push(`lead_list_id = $${params.length}`);
  }
  const result = await pool.query(
    `select business_name, address, city, state, zip, website, main_phone, main_phone_e164, business_email,
            decision_maker_email, industry, quality_score, source from leads where ${conditions.join(" and ")}
     order by created_at desc`,
    params
  );
  const csv = stringify(result.rows, { header: true });
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="leads-export.csv"`);
  res.send(csv);
});
