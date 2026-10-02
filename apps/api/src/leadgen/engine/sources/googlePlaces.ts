import { env } from "../../../config/env.js";
import { getOrgCredential } from "../../../services/credentialsService.js";
import { industryByKey } from "../taxonomy.js";
import { sourceFetch, sourceJson, throttle } from "../http.js";
import { SourceUnavailableError, type SourceAdapter, type SourceRecord } from "./types.js";

// Google Places API (New) Text Search. Paginated (20 per page, up to 3 pages).
const FIELDS = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.nationalPhoneNumber",
  "places.internationalPhoneNumber",
  "places.websiteUri",
  "places.primaryType",
  "places.primaryTypeDisplayName",
  "places.addressComponents",
  "places.businessStatus",
  "places.editorialSummary",
  "places.location",
  "places.googleMapsUri",
  "nextPageToken",
].join(",");

async function keyFor(org: string) {
  const cred = await getOrgCredential(org, "google_places");
  return cred?.apiKey ?? env.googlePlacesApiKey ?? null;
}

function toRecord(p: any): SourceRecord {
  const comp = (type: string, short = false) => {
    const c = p.addressComponents?.find((x: any) => x.types?.includes(type));
    return c ? (short ? c.shortText : c.longText) ?? null : null;
  };
  const street = [comp("street_number"), comp("route")].filter(Boolean).join(" ");
  return {
    sourceRef: p.id,
    sourceUrl: p.googleMapsUri ?? `https://www.google.com/maps/place/?q=place_id:${p.id}`,
    raw: p,
    fields: {
      businessName: p.displayName?.text ?? "",
      category: p.primaryTypeDisplayName?.text ?? p.primaryType ?? null,
      description: p.editorialSummary?.text ?? null,
      website: p.websiteUri ?? null,
      phone: p.internationalPhoneNumber ?? p.nationalPhoneNumber ?? null,
      address: street || p.formattedAddress || null,
      city: comp("locality") ?? comp("postal_town"),
      state: comp("administrative_area_level_1", true),
      zip: comp("postal_code"),
      country: comp("country", true),
      latitude: p.location?.latitude ?? null,
      longitude: p.location?.longitude ?? null,
      businessStatus: p.businessStatus ?? null,
    },
  };
}

export const googlePlacesSource: SourceAdapter = {
  key: "google_places",
  label: "Google Places",
  available: async (org) => Boolean(await keyFor(org)),
  prepare: async (org) => {
    const apiKey = await keyFor(org);
    if (!apiKey) throw new SourceUnavailableError("Google Places isn't connected. Add an API key in Settings → Lead Sources.");
    return {
      search: async (q, pageToken) => {
        const what = [industryByKey(q.industry)?.query, q.keywords].filter(Boolean).join(" ");
        const where = [q.location.zip, q.location.city, q.location.state, q.location.country && q.location.country !== "US" ? q.location.country : null].filter(Boolean).join(", ");
        await throttle("google_places", 250);
        const res = await sourceFetch("https://places.googleapis.com/v1/places:searchText", {
          method: "POST",
          label: "Google Places",
          timeoutMs: 20_000,
          headers: { "Content-Type": "application/json", "X-Goog-Api-Key": apiKey, "X-Goog-FieldMask": FIELDS },
          body: JSON.stringify({ textQuery: `${what} in ${where}`, pageSize: 20, ...(pageToken ? { pageToken } : {}), ...(q.location.country ? { regionCode: q.location.country } : {}) }),
        });
        const data = await sourceJson<{ places?: any[]; nextPageToken?: string }>(res, "Google Places");
        return { records: (data.places ?? []).filter((p) => p?.id && p.displayName?.text).map(toRecord), nextPageToken: data.nextPageToken ?? null };
      },
    };
  },
};
