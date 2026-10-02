import { industryByKey } from "../taxonomy.js";
import { sourceFetch, sourceJson, throttle } from "../http.js";
import { PermanentSourceError, TransientSourceError, type SourceAdapter, type SourceLocation, type SourceQuery, type SourceRecord } from "./types.js";

// OpenStreetMap via Nominatim (geocoding) and Overpass (business features).
// Free, open data (ODbL) — results must be attributed to OSM contributors.
const NOMINATIM = process.env.NOMINATIM_URL ?? "https://nominatim.openstreetmap.org";
const OVERPASS = (process.env.OVERPASS_URLS ?? "https://overpass-api.de/api/interpreter,https://maps.mail.ru/osm/tools/overpass/api/interpreter,https://overpass.kumi.systems/api/interpreter")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const MAX_RESULTS = 500;

interface Geo { areaId: number | null; bbox: [number, number, number, number] | null; label: string }
const geoCache = new Map<string, Geo>();

export async function geocode(loc: SourceLocation): Promise<Geo> {
  const key = JSON.stringify(loc);
  const hit = geoCache.get(key);
  if (hit) return hit;
  const params = new URLSearchParams({ format: "jsonv2", limit: "1", countrycodes: (loc.country || "US").toLowerCase() });
  if (loc.zip) params.set("postalcode", loc.zip);
  if (loc.city) params.set("city", loc.city);
  if (loc.state) params.set("state", loc.state);
  // Nominatim's usage policy: heavy users identify themselves with a contact email.
  if (process.env.OSM_CONTACT_EMAIL) params.set("email", process.env.OSM_CONTACT_EMAIL);
  if (!loc.zip && !loc.city && !loc.state) throw new PermanentSourceError("OpenStreetMap needs at least a state, city or ZIP code.");
  await throttle("nominatim", 1100);
  const res = await sourceFetch(`${NOMINATIM}/search?${params}`, { label: "OpenStreetMap geocoding", timeoutMs: 20_000 });
  const rows = await sourceJson<Array<{ osm_type: string; osm_id: number; boundingbox: string[]; display_name: string }>>(res, "OpenStreetMap geocoding");
  if (!rows.length) throw new PermanentSourceError(`OpenStreetMap couldn't find the location "${[loc.zip, loc.city, loc.state, loc.country].filter(Boolean).join(", ")}".`);
  const r = rows[0];
  const [s, n, w, e] = r.boundingbox.map(Number);
  const geo: Geo = { areaId: r.osm_type === "relation" && !loc.zip ? 3600000000 + r.osm_id : null, bbox: [s, w, n, e], label: r.display_name };
  geoCache.set(key, geo);
  return geo;
}

const esc = (s: string) => s.replace(/[\\"]/g, "\\$&").replace(/[.*+?^${}()|[\]]/g, "\\$&");

export function buildOverpassQuery(q: SourceQuery, geo: Geo): string {
  const scope = geo.areaId ? "(area.a)" : `(${geo.bbox!.join(",")})`;
  const filters: string[] = [];
  const ind = industryByKey(q.industry);
  for (const f of ind?.osm ?? []) {
    const m = f.match(/^([\w:]+)([=~])"?([^"]*)"?$/);
    if (m) filters.push(`["${m[1]}"${m[2]}"${m[3]}"]`);
  }
  const words = q.keywords.split(/[,;]/).map((w) => w.trim()).filter((w) => w.length >= 3).slice(0, 5);
  const lines: string[] = [];
  for (const f of filters) lines.push(`nwr${scope}${f}["name"];`);
  if (words.length) {
    const rx = words.map(esc).join("|");
    // Named businesses whose name matches the keywords.
    for (const k of ["shop", "office", "craft", "amenity", "healthcare", "tourism", "company"]) lines.push(`nwr${scope}["${k}"]["name"~"${rx}",i];`);
  }
  if (!lines.length) throw new PermanentSourceError("Choose an industry or enter keywords to search OpenStreetMap.");
  return `[out:json][timeout:60];${geo.areaId ? `area(id:${geo.areaId})->.a;` : ""}(${lines.join("")});out center tags ${MAX_RESULTS};`;
}

function toRecord(el: any): SourceRecord | null {
  const t = el.tags ?? {};
  if (!t.name) return null;
  const pick = (...k: string[]) => k.map((x) => t[x]).find((v) => v && String(v).trim()) ?? null;
  const street = [t["addr:housenumber"], t["addr:street"]].filter(Boolean).join(" ");
  const tagValue = ["craft", "healthcare", "office", "shop", "amenity", "tourism", "leisure"].map((k) => t[k]).find((v) => v && v !== "yes");
  const category = tagValue ? String(tagValue).replace(/[_;]/g, " ").replace(/^\w/, (c: string) => c.toUpperCase()) : null;
  const social = ["contact:facebook", "facebook", "contact:instagram", "instagram", "contact:linkedin", "contact:twitter", "twitter"]
    .map((k) => t[k])
    .filter((v) => v && /^https?:\/\//.test(v));
  return {
    sourceRef: `${el.type}/${el.id}`,
    sourceUrl: `https://www.openstreetmap.org/${el.type}/${el.id}`,
    raw: el,
    fields: {
      businessName: String(t.name).trim(),
      category,
      description: pick("description"),
      website: pick("website", "contact:website", "url"),
      phone: pick("phone", "contact:phone", "contact:mobile"),
      email: pick("email", "contact:email"),
      address: street || null,
      city: pick("addr:city"),
      state: pick("addr:state"),
      zip: pick("addr:postcode"),
      country: pick("addr:country"),
      latitude: el.lat ?? el.center?.lat ?? null,
      longitude: el.lon ?? el.center?.lon ?? null,
      socialUrls: social,
    },
  };
}

export const osmSource: SourceAdapter = {
  key: "osm",
  label: "OpenStreetMap",
  attribution: "© OpenStreetMap contributors (ODbL)",
  available: async () => true,
  prepare: async () => ({
    search: async (q) => {
      const geo = await geocode(q.location);
      const body = new URLSearchParams({ data: buildOverpassQuery(q, geo) });
      let lastErr: Error | null = null;
      for (const url of OVERPASS) {
        try {
          await throttle(`overpass:${url}`, 2000);
          const res = await sourceFetch(url, { method: "POST", body, label: "OpenStreetMap", timeoutMs: 75_000, headers: { "Content-Type": "application/x-www-form-urlencoded" } });
          const data = await sourceJson<{ elements?: any[]; remark?: string }>(res, "OpenStreetMap");
          if (data.remark && /runtime error|timed out/i.test(data.remark)) throw new TransientSourceError(`OpenStreetMap: ${data.remark}`);
          const records = (data.elements ?? []).map(toRecord).filter((r): r is SourceRecord => r !== null);
          return { records, nextPageToken: null };
        } catch (err) {
          lastErr = err as Error;
          if (err instanceof PermanentSourceError) throw err;
          // try the next mirror
        }
      }
      throw lastErr ?? new TransientSourceError("OpenStreetMap: no endpoint answered");
    },
  }),
};
