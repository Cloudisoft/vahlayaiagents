import { Router } from "express";
import multer from "multer";
import { stringify } from "csv-stringify/sync";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { requireModuleAccess } from "../middleware/moduleAccess.js";
import { runLeadDiscovery } from "../leadgen/discoveryService.js";
import { computeQualityScore, normalizeLeadPhone } from "../leadgen/enrichment.js";
import { mapRow, normalizeCustomerType, parseCount, parseDate, readRows } from "../leadgen/leadImport.js";
import { enqueueJob, isQueueEnabled } from "../services/queue.js";

export const leadgenRouter = Router();
leadgenRouter.use(requireAuth);
leadgenRouter.use(requireModuleAccess("leadgen"));

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
  const { listId, search, state, industry, tag, callStatus, customerType, provider, dnc } = req.query as Record<string, string | undefined>;
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
    conditions.push(
      `(business_name ilike $${params.length} or website ilike $${params.length} or business_email ilike $${params.length}` +
        ` or first_name ilike $${params.length} or last_name ilike $${params.length} or main_phone_e164 like $${params.length})`
    );
  }
  if (state) {
    params.push(state);
    conditions.push(`state = $${params.length}`);
  }
  if (industry) {
    params.push(industry);
    conditions.push(`(industry = $${params.length} or category = $${params.length})`);
  }
  if (callStatus) {
    params.push(callStatus);
    conditions.push(`call_status = $${params.length}`);
  }
  if (customerType) {
    params.push(customerType);
    conditions.push(`customer_type = $${params.length}`);
  }
  if (provider) {
    params.push(`%${provider}%`);
    conditions.push(`current_provider ilike $${params.length}`);
  }
  if (dnc === "true" || dnc === "false") conditions.push(dnc === "true" ? "is_dnc" : "not is_dnc");
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
  if (!req.file) return res.status(400).json({ error: "No CSV or XLSX file provided." });
  let records: Record<string, unknown>[];
  try {
    records = await readRows(req.file.buffer, req.file.originalname);
  } catch (err) {
    return res.status(400).json({ error: `Could not read file: ${(err as Error).message}` });
  }

  const org = req.auth!.organizationId;
  const leadListId = (req.body.leadListId as string) || null;
  const campaignId = (req.body.campaignId as string) || null;
  let imported = 0;
  let duplicates = 0;
  const errors: string[] = [];
  const dnc = await pool.query<{ phone_e164: string }>("select phone_e164 from dnc_entries where organization_id = $1", [org]);
  const dncSet = new Set(dnc.rows.map((r) => r.phone_e164));
  let dncMarked = 0;

  for (const [i, raw] of records.entries()) {
    const { fields: f, custom } = mapRow(raw);
    const phoneE164 = normalizeLeadPhone(f.main_phone ?? null);
    const contactName = [f.first_name, f.last_name].filter(Boolean).join(" ");
    const businessName = f.business_name ?? (contactName || null);
    if (!businessName && !phoneE164) {
      errors.push(`Row ${i + 2}: no name or phone — skipped.`);
      continue;
    }
    if (f.main_phone && !phoneE164) errors.push(`Row ${i + 2}: "${f.main_phone}" isn't a valid US number — imported without a dialable phone.`);
    if (phoneE164 && leadListId) {
      const dup = await pool.query("select 1 from leads where organization_id = $1 and lead_list_id = $2 and main_phone_e164 = $3 limit 1", [org, leadListId, phoneE164]);
      if (dup.rows.length) {
        duplicates++;
        continue;
      }
    }
    const isDnc = phoneE164 ? dncSet.has(phoneE164) : false;
    if (isDnc) dncMarked++;
    const qualityScore = computeQualityScore({
      businessName: businessName ?? phoneE164!,
      address: f.address ?? null,
      website: f.website ?? null,
      mainPhoneE164: phoneE164,
      businessEmail: f.business_email ?? null,
      decisionMakerEmail: null,
      lastVerifiedAt: null,
    });
    const ins = await pool.query(
      `insert into leads (organization_id, lead_list_id, business_name, address, city, state, zip, website,
         main_phone, main_phone_e164, business_email, industry, source, quality_score,
         first_name, last_name, contact_title, service_address, current_provider, customer_type,
         lines_count, locations_count, contract_end_date, time_zone, custom_fields, is_dnc, call_status)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'csv_import',$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
       returning id`,
      [
        org, leadListId, businessName ?? phoneE164, f.address ?? null, f.city ?? null, f.state ?? null, f.zip ?? null,
        f.website ?? null, f.main_phone ?? null, phoneE164, f.business_email ?? null, f.industry ?? null, qualityScore,
        f.first_name ?? null, f.last_name ?? null, f.contact_title ?? null, f.service_address ?? null,
        f.current_provider ?? null, normalizeCustomerType(f.customer_type, f.current_provider),
        parseCount(f.lines_count), parseCount(f.locations_count), parseDate(f.contract_end_date), f.time_zone ?? null,
        JSON.stringify(custom), isDnc, isDnc ? "do_not_call" : "new",
      ]
    );
    if (campaignId && phoneE164 && !isDnc) {
      await pool.query(
        `insert into campaign_leads (campaign_id, lead_id)
         select $1, $2 where exists (select 1 from campaigns where id = $1 and organization_id = $3)
         on conflict do nothing`,
        [campaignId, ins.rows[0].id, org]
      );
    }
    imported++;
  }

  res.json({ imported, duplicates, dncMarked, errors: errors.slice(0, 50), totalErrors: errors.length });
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
