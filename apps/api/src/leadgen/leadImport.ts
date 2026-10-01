import { parse } from "csv-parse/sync";
import ExcelJS from "exceljs";
import { pool } from "../db/pool.js";
import { computeQualityScore, normalizeLeadPhone } from "./enrichment.js";

// Header aliases -> lead column. Anything not listed becomes a custom field
// (usable in scripts as {{column_name}}).
const ALIASES: Record<string, string[]> = {
  business_name: ["business_name", "company", "company_name", "business", "account_name", "name"],
  first_name: ["first_name", "firstname", "contact_first_name", "fname"],
  last_name: ["last_name", "lastname", "contact_last_name", "lname"],
  contact_name: ["contact_name", "contact", "full_name"],
  contact_title: ["contact_title", "title", "job_title", "designation"],
  main_phone: ["phone", "main_phone", "phone_number", "mobile", "telephone", "number", "contact_phone"],
  business_email: ["email", "business_email", "email_address", "contact_email"],
  website: ["website", "url", "web"],
  address: ["address", "street", "street_address"],
  service_address: ["service_address", "install_address"],
  city: ["city", "town"],
  state: ["state", "st", "province", "region"],
  zip: ["zip", "zipcode", "zip_code", "postal_code"],
  industry: ["industry", "category", "vertical"],
  current_provider: ["current_provider", "provider", "carrier", "isp"],
  customer_type: ["customer_type", "alc", "alc_status", "customer_status"],
  lines_count: ["lines_count", "lines", "number_of_lines", "phone_lines"],
  locations_count: ["locations_count", "locations", "number_of_locations"],
  contract_end_date: ["contract_end_date", "contract_end", "contract_expiry", "contract_expiration"],
  time_zone: ["time_zone", "timezone", "tz"],
};

const LOOKUP = new Map<string, string>();
for (const [col, names] of Object.entries(ALIASES)) for (const n of names) LOOKUP.set(n, col);

export function normalizeHeader(h: string): string {
  return h.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

export interface ImportedLead {
  fields: Record<string, string>;
  custom: Record<string, string>;
}

export function mapRow(row: Record<string, unknown>): ImportedLead {
  const fields: Record<string, string> = {};
  const custom: Record<string, string> = {};
  for (const [rawKey, rawVal] of Object.entries(row)) {
    const value = rawVal == null ? "" : String(rawVal).trim();
    if (!value) continue;
    const key = normalizeHeader(rawKey);
    const col = LOOKUP.get(key);
    if (col && !fields[col]) fields[col] = value;
    else if (!col && key) custom[key] = value;
  }
  if (fields.contact_name && !fields.first_name) {
    const [first, ...rest] = fields.contact_name.split(/\s+/);
    fields.first_name = first;
    if (rest.length && !fields.last_name) fields.last_name = rest.join(" ");
  }
  delete fields.contact_name;
  return { fields, custom };
}

// "ALC", "existing", "yes" -> alc; "non-alc", "new", "no" -> non_alc.
export function normalizeCustomerType(v: string | undefined, currentProvider: string | undefined): string | null {
  const s = (v ?? "").toLowerCase().replace(/[^a-z]/g, "");
  if (["alc", "existing", "yes", "current", "existingcustomer"].includes(s)) return "alc";
  if (["nonalc", "new", "no", "prospect", "newcustomer"].includes(s)) return "non_alc";
  if (currentProvider) return /spectrum|charter/i.test(currentProvider) ? "alc" : "non_alc";
  return null;
}

export function parseCount(v: string | undefined): number | null {
  if (!v) return null;
  const n = parseInt(v.replace(/[^0-9]/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}

export function parseDate(v: string | undefined): string | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

export async function readRows(buffer: Buffer, filename: string): Promise<Record<string, unknown>[]> {
  if (/\.xlsx$/i.test(filename)) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
    const sheet = wb.worksheets[0];
    if (!sheet) return [];
    const headers: string[] = [];
    sheet.getRow(1).eachCell((cell, col) => (headers[col] = String(cell.text ?? "")));
    const rows: Record<string, unknown>[] = [];
    sheet.eachRow((row, idx) => {
      if (idx === 1) return;
      const obj: Record<string, unknown> = {};
      row.eachCell((cell, col) => {
        if (headers[col]) obj[headers[col]] = cell.value instanceof Date ? cell.value.toISOString() : cell.text;
      });
      rows.push(obj);
    });
    return rows;
  }
  return parse(buffer, { columns: true, skip_empty_lines: true, bom: true, relax_column_count: true });
}


export async function importLeads(
  org: string,
  records: Record<string, unknown>[],
  opts: { leadListId: string | null; campaignId: string | null }
) {
  const { leadListId, campaignId } = opts;
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
    if (phoneE164 && (leadListId || campaignId)) {
      const dup = await pool.query(
        leadListId
          ? "select 1 from leads where organization_id = $1 and lead_list_id = $2 and main_phone_e164 = $3 limit 1"
          : `select 1 from campaign_leads cl join leads l on l.id = cl.lead_id
             where l.organization_id = $1 and cl.campaign_id = $2 and l.main_phone_e164 = $3 limit 1`,
        [org, leadListId ?? campaignId, phoneE164]
      );
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

  return { imported, duplicates, dncMarked, errors: errors.slice(0, 50), totalErrors: errors.length };
}
