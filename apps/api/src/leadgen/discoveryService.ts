import { pool } from "../db/pool.js";
import { getGooglePlacesAdapter } from "./GooglePlacesAdapter.js";
import { computeQualityScore, extractWebsiteContact, normalizeLeadPhone } from "./enrichment.js";
import type { LeadSearchQuery } from "./LeadSourceAdapter.js";

export interface DiscoveryResult {
  savedCount: number;
  duplicateCount: number;
  totalFound: number;
  errors: string[];
}

// SEARCH -> DISCOVER -> DEDUPLICATE -> WEBSITE DISCOVERY -> DATA EXTRACTION
// -> CONTACT ENRICHMENT -> EMAIL VALIDATION -> PHONE NORMALIZATION ->
// QUALITY SCORE -> SAVE (spec §26)
export async function runLeadDiscovery(params: {
  organizationId: string;
  leadListId: string;
  query: LeadSearchQuery;
}): Promise<DiscoveryResult> {
  const errors: string[] = [];
  let savedCount = 0;
  let duplicateCount = 0;

  const adapter = await getGooglePlacesAdapter(params.organizationId);
  const rawResults = await adapter.search(params.query);

  for (const raw of rawResults) {
    try {
      // Dedupe against existing leads in this org by phone or (name + city).
      const phoneE164 = normalizeLeadPhone(raw.phone);
      const existing = await pool.query(
        `select id from leads where organization_id = $1
         and (
           (main_phone_e164 is not null and main_phone_e164 = $2)
           or (lower(business_name) = lower($3) and lower(coalesce(city,'')) = lower(coalesce($4,'')))
         )
         limit 1`,
        [params.organizationId, phoneE164, raw.businessName, raw.city]
      );
      if (existing.rows.length > 0) {
        duplicateCount++;
        continue;
      }

      let businessEmail: string | null = null;
      let socialUrls: string[] = [];
      if (raw.website) {
        const contact = await extractWebsiteContact(raw.website);
        businessEmail = contact.email;
        socialUrls = contact.socialUrls;
      }

      const qualityScore = computeQualityScore({
        businessName: raw.businessName,
        address: raw.address,
        website: raw.website,
        mainPhoneE164: phoneE164,
        businessEmail,
        decisionMakerEmail: null,
        lastVerifiedAt: new Date(),
      });

      await pool.query(
        `insert into leads (organization_id, lead_list_id, business_name, address, city, state, zip, website,
           main_phone, main_phone_e164, business_email, category, social_urls, source, source_url,
           data_confidence, quality_score, last_verified_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17, now())`,
        [
          params.organizationId,
          params.leadListId,
          raw.businessName,
          raw.address,
          raw.city,
          raw.state,
          raw.zip,
          raw.website,
          raw.phone,
          phoneE164,
          businessEmail,
          raw.category,
          socialUrls,
          raw.source,
          raw.sourceUrl,
          phoneE164 || businessEmail ? 0.8 : 0.5,
          qualityScore,
        ]
      );
      savedCount++;
    } catch (err) {
      errors.push(`${raw.businessName}: ${(err as Error).message}`);
    }
  }

  return { savedCount, duplicateCount, totalFound: rawResults.length, errors };
}
