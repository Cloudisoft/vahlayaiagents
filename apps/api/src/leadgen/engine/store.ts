import type { PoolClient } from "pg";
import { pool } from "../../db/pool.js";
import { cleanName, nameKey, normalizeEmail, normalizePhone, normalizeState, normalizeWebsite, normalizeZip, titleCase } from "./normalize.js";
import type { SourceRecord } from "./sources/types.js";

// Lead columns the discovery engine fills, with the normalized value per record.
export interface Normalized {
  business_name: string;
  name_key: string;
  category: string | null;
  description: string | null;
  website: string | null;
  website_domain: string | null;
  main_phone: string | null;
  main_phone_e164: string | null;
  business_email: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  country: string | null;
  latitude: number | null;
  longitude: number | null;
  social_urls: string[];
  company_size: string | null;
}

export function normalizeRecord(rec: SourceRecord, defaultCountry = "US"): { n: Normalized; notes: Record<string, string> } {
  const f = rec.fields;
  const country = (f.country || defaultCountry || "US").toUpperCase().slice(0, 2);
  const site = normalizeWebsite(f.website);
  const phone = normalizePhone(f.phone, country);
  const notes: Record<string, string> = {};
  if (f.phone && !phone.e164) notes.main_phone = phone.reason ?? "Couldn't normalize";
  if (f.website && !site.website && !site.social) notes.website = "Not a valid web address";
  const social = Array.from(new Set([...(f.socialUrls ?? []), ...(site.social ? [site.social] : [])])).slice(0, 8);
  return {
    n: {
      business_name: cleanName(f.businessName),
      name_key: nameKey(f.businessName),
      category: f.category ?? null,
      description: f.description?.trim() || null,
      website: site.website,
      website_domain: site.domain,
      main_phone: f.phone?.trim() || null,
      main_phone_e164: phone.e164,
      business_email: normalizeEmail(f.email),
      address: f.address?.trim() || null,
      city: titleCase(f.city),
      state: normalizeState(f.state, country),
      zip: normalizeZip(f.zip, country),
      country,
      latitude: f.latitude ?? null,
      longitude: f.longitude ?? null,
      social_urls: social,
      company_size: f.companySize ?? null,
    },
    notes,
  };
}

const FIELDS: Array<keyof Normalized> = [
  "business_name", "category", "description", "website", "main_phone", "main_phone_e164", "business_email",
  "address", "city", "state", "zip", "country", "latitude", "longitude", "company_size",
];

async function findMatch(c: PoolClient, org: string, source: string, rec: SourceRecord, n: Normalized): Promise<{ id: string; how: string } | null> {
  const raw = await c.query("select lead_id from lead_source_records where organization_id = $1 and source = $2 and source_ref = $3", [org, source, rec.sourceRef]);
  if (raw.rows[0]) return { id: raw.rows[0].lead_id, how: "same source record" };
  if (n.main_phone_e164) {
    const r = await c.query("select id from leads where organization_id = $1 and main_phone_e164 = $2 order by created_at limit 1", [org, n.main_phone_e164]);
    if (r.rows[0]) return { id: r.rows[0].id, how: "same phone" };
  }
  if (n.name_key && n.city) {
    // Same name in the same city is the same business unless the phone or
    // street address says it's another branch.
    const r = await c.query(
      "select id, main_phone_e164, address from leads where organization_id = $1 and name_key = $2 and lower(coalesce(city,'')) = lower($3) order by created_at limit 5",
      [org, n.name_key, n.city]
    );
    const same = r.rows.find(
      (x) => !(x.main_phone_e164 && n.main_phone_e164 && x.main_phone_e164 !== n.main_phone_e164) && !(x.address && n.address && nameKey(x.address) !== nameKey(n.address))
    );
    if (same) return { id: same.id, how: "same name and city" };
  }
  if (n.website_domain && n.city) {
    const r = await c.query("select id from leads where organization_id = $1 and website_domain = $2 and lower(coalesce(city,'')) = lower($3) order by created_at limit 1", [org, n.website_domain, n.city]);
    if (r.rows[0]) return { id: r.rows[0].id, how: "same website and city" };
  }
  return null;
}

// SOURCE → RAW → NORMALIZED. Stores the raw record, then creates a lead or
// merges into the matching one. Merging only fills empty fields; a value that
// disagrees with what we have is recorded as a conflict, never overwritten.
export async function storeRecord(params: { organizationId: string; jobId: string; source: string; record: SourceRecord; leadListId: string | null; defaultCountry?: string }): Promise<{ leadId: string; isNew: boolean; matchedBy: string | null } | null> {
  const { organizationId: org, jobId, source, record } = params;
  const { n, notes } = normalizeRecord(record, params.defaultCountry);
  if (!n.business_name || !n.name_key) return null;
  const at = new Date().toISOString();
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("select pg_advisory_xact_lock(hashtext($1))", [`leads:${org}`]);
    const match = await findMatch(c, org, source, record, n);
    let leadId: string;
    let isNew = false;
    if (!match) {
      const meta: Record<string, unknown> = {};
      for (const f of FIELDS) if (n[f] != null && n[f] !== "") meta[f] = { source, at, ...(notes[f] ? { note: notes[f] } : {}) };
      if (n.social_urls.length) meta.social_urls = { source, at };
      for (const [f, note] of Object.entries(notes)) if (!meta[f]) meta[f] = { source, at, note };
      const r = await c.query(
        `insert into leads (organization_id, lead_list_id, business_name, name_key, category, description, website, website_domain, main_phone, main_phone_e164,
           business_email, address, city, state, zip, country, latitude, longitude, social_urls, company_size, source, source_url, field_meta,
           pipeline_status, pipeline_next_at, sources, first_discovered_at, last_discovered_at, last_verified_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,'discovered',now(),array[$21]::text[],now(),now(),now())
         returning id`,
        [org, params.leadListId, n.business_name, n.name_key, n.category, n.description, n.website, n.website_domain, n.main_phone, n.main_phone_e164,
          n.business_email, n.address, n.city, n.state, n.zip, n.country, n.latitude, n.longitude, n.social_urls, n.company_size, source, record.sourceUrl, JSON.stringify(meta)]
      );
      leadId = r.rows[0].id;
      isNew = true;
    } else {
      leadId = match.id;
      const cur = (await c.query("select * from leads where id = $1 for update", [leadId])).rows[0];
      const meta = cur.field_meta ?? {};
      const sets: string[] = [];
      const vals: unknown[] = [];
      let changed = false;
      for (const f of FIELDS) {
        const v = n[f];
        if (v == null || v === "") continue;
        const have = cur[f];
        if (have == null || have === "") {
          vals.push(v);
          sets.push(`${f} = $${vals.length}`);
          meta[f] = { source, at, ...(notes[f] ? { note: notes[f] } : {}) };
          changed = true;
        } else if (String(have).toLowerCase() !== String(v).toLowerCase() && !["latitude", "longitude"].includes(f)) {
          const m = (meta[f] ??= { source: cur.source ?? "unknown", at: cur.created_at });
          m.conflicts = [...(m.conflicts ?? []).filter((x: any) => x.source !== source), { value: v, source, at }].slice(-5);
        } else if (meta[f] && meta[f].source !== source) {
          meta[f].confirmedBy = Array.from(new Set([...(meta[f].confirmedBy ?? []), source]));
        }
      }
      if (!cur.name_key) {
        vals.push(n.name_key);
        sets.push(`name_key = $${vals.length}`);
      }
      if (!cur.website_domain && n.website_domain && !cur.website) {
        vals.push(n.website_domain);
        sets.push(`website_domain = $${vals.length}`);
      }
      const newSocial = n.social_urls.filter((s) => !(cur.social_urls ?? []).includes(s));
      if (newSocial.length) {
        vals.push([...(cur.social_urls ?? []), ...newSocial].slice(0, 10));
        sets.push(`social_urls = $${vals.length}`);
        changed = true;
      }
      vals.push(JSON.stringify(meta));
      sets.push(`field_meta = $${vals.length}`);
      vals.push(source);
      sets.push(`sources = case when $${vals.length} = any(sources) then sources else array_append(sources, $${vals.length}) end`);
      sets.push("last_discovered_at = now()", "first_discovered_at = coalesce(first_discovered_at, now())");
      // New data, or never processed: (re)run enrichment. Otherwise just re-qualify for this job.
      if (changed || !cur.pipeline_status) sets.push("pipeline_status = 'discovered'", "pipeline_next_at = now()", "pipeline_attempts = 0");
      else if (cur.qualified_for_job !== jobId && ["qualified", "qualify_failed"].includes(cur.pipeline_status)) sets.push("pipeline_status = 'enriched'", "pipeline_next_at = now()", "pipeline_attempts = 0");
      vals.push(leadId);
      await c.query(`update leads set ${sets.join(", ")}, updated_at = now() where id = $${vals.length}`, vals);
    }
    await c.query(
      `insert into lead_source_records (organization_id, lead_id, job_id, source, source_ref, source_url, raw)
       values ($1,$2,$3,$4,$5,$6,$7)
       on conflict (organization_id, source, source_ref) do update set raw = excluded.raw, fetched_at = now(), job_id = excluded.job_id`,
      [org, leadId, jobId, source, record.sourceRef, record.sourceUrl, JSON.stringify(record.raw)]
    );
    await c.query("insert into discovery_job_leads (job_id, lead_id, was_new) values ($1,$2,$3) on conflict do nothing", [jobId, leadId, isNew]);
    await c.query("commit");
    return { leadId, isNew, matchedBy: match?.how ?? null };
  } catch (err) {
    await c.query("rollback").catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}
