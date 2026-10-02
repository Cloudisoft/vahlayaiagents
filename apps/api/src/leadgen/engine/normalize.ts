import { normalizeE164 } from "../../utils/phone.js";

const US_STATES: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO", connecticut: "CT", delaware: "DE",
  "district of columbia": "DC", florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA",
  kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN",
  mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ",
  "new mexico": "NM", "new york": "NY", "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR",
  pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC", "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT",
  vermont: "VT", virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY", "puerto rico": "PR",
};
const ABBRS = new Set(Object.values(US_STATES));

export function normalizeState(s: string | null | undefined, country = "US"): string | null {
  const v = String(s ?? "").trim();
  if (!v) return null;
  if (country.toUpperCase() !== "US") return v;
  if (ABBRS.has(v.toUpperCase())) return v.toUpperCase();
  return US_STATES[v.toLowerCase()] ?? v;
}

export function titleCase(s: string | null | undefined): string | null {
  const v = String(s ?? "").trim().replace(/\s+/g, " ");
  if (!v) return null;
  return v === v.toUpperCase() || v === v.toLowerCase() ? v.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase()) : v;
}

const LEGAL = /\b(llc|inc|incorporated|ltd|limited|co|corp|corporation|company|pllc|pc|plc|the|and)\b/g;
// "The Roofing Guy, LLC" and "roofing guy" share one key.
export function nameKey(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(LEGAL, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function cleanName(name: string): string {
  return name.replace(/\s+/g, " ").trim();
}

// Hosts that are profiles, not a business's own website.
const NOT_A_WEBSITE = /(^|\.)(facebook|fb|instagram|linkedin|twitter|x|youtube|tiktok|yelp|google|goo|linktr|nextdoor|angi|homeadvisor|thumbtack|bbb|yellowpages|mapquest|square\.site)\.(com|gl|ee|org|me|site)$/i;

export function normalizeWebsite(raw: string | null | undefined): { website: string | null; domain: string | null; social: string | null } {
  const v = String(raw ?? "").trim();
  if (!v) return { website: null, domain: null, social: null };
  let u: URL;
  try {
    u = new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`);
  } catch {
    return { website: null, domain: null, social: null };
  }
  if (!u.hostname.includes(".")) return { website: null, domain: null, social: null };
  for (const k of Array.from(u.searchParams.keys())) if (/^(utm_|fbclid|gclid)/i.test(k)) u.searchParams.delete(k);
  u.hash = "";
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  if (NOT_A_WEBSITE.test(host)) return { website: null, domain: null, social: u.toString() };
  return { website: u.toString().replace(/\/$/, ""), domain: host, social: null };
}

// NANP sanity: area code and exchange can't start with 0/1, and the 555
// exchange is fictional or directory assistance (e.g. 555-1212) — never a
// business line.
export function validUsNumber(e164: string): boolean {
  const m = e164.match(/^\+1([2-9]\d{2})([2-9]\d{2})(\d{4})$/);
  if (!m) return false;
  if (m[2] === "555") return false;
  if (/^(\d)\1{6}$/.test(m[2] + m[3])) return false; // 777-7777 style fillers
  return true;
}

export function normalizePhone(raw: string | null | undefined, country = "US"): { e164: string | null; valid: boolean; reason: string | null } {
  const v = String(raw ?? "").trim();
  if (!v) return { e164: null, valid: false, reason: null };
  const digits = v.replace(/\D/g, "");
  const intl = v.startsWith("+") || v.startsWith("00");
  if (!intl && !["US", "CA"].includes(country.toUpperCase())) return { e164: null, valid: false, reason: "No country code; can't be normalized safely" };
  const e164 = normalizeE164(v);
  if (!e164) return { e164: null, valid: false, reason: `Not a dialable number (${digits.length} digits)` };
  if (e164.startsWith("+1") && !validUsNumber(e164)) return { e164, valid: false, reason: "Not a valid North American number" };
  return { e164, valid: true, reason: null };
}

export function normalizeEmail(raw: string | null | undefined): string | null {
  const v = String(raw ?? "").trim().toLowerCase().replace(/^mailto:/, "");
  return /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(v) ? v : null;
}

export function normalizeZip(z: string | null | undefined, country = "US"): string | null {
  const v = String(z ?? "").trim();
  if (!v) return null;
  if (country.toUpperCase() === "US") {
    const m = v.match(/^(\d{5})(-\d{4})?$/);
    return m ? m[1] : null;
  }
  return v;
}
