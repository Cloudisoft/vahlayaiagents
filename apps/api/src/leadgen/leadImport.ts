import { parse } from "csv-parse/sync";
import ExcelJS from "exceljs";

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
