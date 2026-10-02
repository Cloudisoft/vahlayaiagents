import { promises as dns } from "node:dns";
import net from "node:net";
import { pool } from "../../db/pool.js";
import { USER_AGENT } from "./http.js";
import { normalizeEmail, normalizePhone, normalizeWebsite } from "./normalize.js";

const MAX_BYTES = 2_000_000;
const JUNK_EMAIL = /(example\.|sentry|wixpress|domain\.com|email\.com|yourdomain|@2x|\.png|\.jpg|\.gif|\.webp|\.svg|godaddy|squarespace\.com|wordpress\.com)/i;
const ROLE = /^(info|contact|hello|sales|support|office|admin|service|team|enquiries|inquiries|help|billing|careers|jobs)@/i;
const PARKED = /(domain (is )?for sale|buy this domain|parked (free|domain)|this domain may be for sale|coming soon|under construction|website is under maintenance|future home of)/i;

export class TransientEnrichError extends Error {}

export interface PageFetch {
  transient?: boolean;
  url: string;
  ok: boolean;
  status: number | null;
  finalUrl: string | null;
  ms: number;
  html: string;
  error: string | null;
}

// Blocks private, loopback and link-local addresses so a "website" from a
// data source can never make the server call internal services.
function privateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80") || v.startsWith("::ffff:") && privateIp(v.slice(7));
}

export async function assertPublicUrl(raw: string): Promise<URL> {
  const u = new URL(raw);
  if (!["http:", "https:"].includes(u.protocol)) throw new Error("only http(s) websites are fetched");
  if (u.port && !["80", "443", "8080"].includes(u.port)) throw new Error("unusual port");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => privateIp(a.address))) throw new Error("website points to a private address");
  return u;
}

async function fetchPage(url: string, timeoutMs = 12_000): Promise<PageFetch> {
  const t0 = Date.now();
  try {
    let current = url;
    let res: Response | null = null;
    for (let hop = 0; hop < 5; hop++) {
      await assertPublicUrl(current);
      res = await fetch(current, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs), headers: { "User-Agent": USER_AGENT, Accept: "text/html,*/*;q=0.5" } });
      const loc = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && loc) {
        current = new URL(loc, current).toString();
        await res.body?.cancel().catch(() => undefined);
        continue;
      }
      break;
    }
    if (!res) throw new Error("no response");
    const reader = res.body?.getReader();
    let received = 0;
    const chunks: Uint8Array[] = [];
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      chunks.push(value);
      if (received > MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
    const html = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
    return { url, ok: res.ok, status: res.status, finalUrl: current, ms: Date.now() - t0, html: res.ok ? html : "", error: res.ok ? null : `HTTP ${res.status}` };
  } catch (err) {
    const e = err as Error & { cause?: { code?: string }; code?: string };
    const code = e.cause?.code ?? e.code;
    const msg = e.name === "TimeoutError" ? "timed out" : code === "ENOTFOUND" ? "domain doesn't resolve" : code === "ECONNREFUSED" ? "connection refused" : /certificate|SSL|TLS/i.test(String(e.cause ?? e.message)) ? "SSL certificate problem" : e.message;
    // Resolver hiccups and timeouts aren't proof the site is down.
    const transient = e.name === "TimeoutError" || ["EAI_AGAIN", "ETIMEDOUT", "ECONNRESET", "UND_ERR_CONNECT_TIMEOUT"].includes(String(code));
    return { url, ok: false, status: null, finalUrl: null, ms: Date.now() - t0, html: "", error: msg, transient };
  }
}

async function robotsAllows(origin: string): Promise<boolean> {
  try {
    await assertPublicUrl(`${origin}/robots.txt`);
    const r = await fetch(`${origin}/robots.txt`, { redirect: "manual", signal: AbortSignal.timeout(5000), headers: { "User-Agent": USER_AGENT } });
    if (!r.ok) return true;
    let applies = false;
    for (const line of (await r.text()).split("\n").map((l) => l.trim())) {
      if (/^user-agent:\s*\*/i.test(line)) applies = true;
      else if (/^user-agent:/i.test(line)) applies = false;
      else if (applies && /^disallow:\s*\/\s*$/i.test(line)) return false;
    }
    return true;
  } catch {
    return true;
  }
}

const text = (html: string) =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&amp;|&#\d+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').trim();

export function parseSite(html: string, baseUrl: string) {
  const meta = (name: string) =>
    html.match(new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]*content=["']([^"']*)["']`, "i"))?.[1] ??
    html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:name|property)=["']${name}["']`, "i"))?.[1] ??
    null;
  const body = text(html);
  const mailtos = Array.from(html.matchAll(/mailto:([^"'?>\s]+)/gi)).map((m) => decodeURIComponent(m[1]));
  const inText = body.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) ?? [];
  const emails = Array.from(new Set([...mailtos, ...inText].map((e) => normalizeEmail(e)).filter((e): e is string => Boolean(e) && !JUNK_EMAIL.test(e!)))).slice(0, 10);
  const tels = Array.from(new Set(Array.from(html.matchAll(/href=["']tel:([^"']+)["']/gi)).map((m) => decodeURIComponent(m[1]).trim()))).slice(0, 5);
  const social = Array.from(
    new Set(Array.from(html.matchAll(/https?:\/\/(?:www\.)?(?:facebook|linkedin|instagram|twitter|x|youtube|tiktok)\.com\/[A-Za-z0-9_.\-\/%]+/gi)).map((m) => m[0].replace(/\/$/, "")))
  )
    .filter((u) => !/\/(sharer|share|intent|plugins|dialog|tr)\b/i.test(u))
    .slice(0, 8);
  const years = Array.from(body.matchAll(/(?:©|&copy;|copyright)\s*(?:\d{4}\s*[-–]\s*)?(\d{4})/gi)).map((m) => Number(m[1])).filter((y) => y > 1995 && y <= new Date().getFullYear() + 1);
  let contactUrl: string | null = null;
  const link = html.match(/<a[^>]+href=["']([^"'#]*(?:contact|about)[^"']*)["']/i)?.[1];
  if (link) {
    try {
      const u = new URL(link, baseUrl);
      if (u.hostname === new URL(baseUrl).hostname) contactUrl = u.toString();
    } catch {
      // ignore bad links
    }
  }
  return {
    title: decode(html.match(/<title[^>]*>([^<]{1,200})<\/title>/i)?.[1] ?? "") || null,
    description: decode(meta("description") ?? meta("og:description") ?? "") || null,
    viewport: /<meta[^>]+name=["']viewport["']/i.test(html),
    generator: meta("generator"),
    words: body ? body.split(" ").length : 0,
    emails,
    tels,
    social,
    copyrightYear: years.length ? Math.max(...years) : null,
    hasForm: /<form[\s>]/i.test(html),
    parked: PARKED.test(body.slice(0, 5000)),
    contactUrl,
  };
}

export type WebsiteStatus = "none" | "unreachable" | "weak" | "ok";

export async function analyzeWebsite(website: string | null) {
  if (!website) return { status: "none" as WebsiteStatus, reasons: ["No website found in any source"], signals: null, found: { emails: [], phones: [], social: [], description: null as string | null } };
  const origin = new URL(website).origin;
  if (!(await robotsAllows(origin))) {
    return { status: "ok" as WebsiteStatus, reasons: ["Website blocks automated reading (robots.txt), so it wasn't analysed"], signals: { robotsBlocked: true }, found: { emails: [], phones: [], social: [], description: null } };
  }
  let home = await fetchPage(website);
  if (!home.ok && website.startsWith("https://")) {
    const plain = await fetchPage(website.replace(/^https:/, "http:"));
    if (plain.ok) home = plain;
  }
  if (!home.ok && home.transient) throw new TransientEnrichError(`Website check didn't finish (${home.error}); will retry`);
  if (!home.ok) return { status: "unreachable" as WebsiteStatus, reasons: [`Website didn't load: ${home.error}`], signals: { status: home.status, error: home.error, ms: home.ms }, found: { emails: [], phones: [], social: [], description: null } };
  const p = parseSite(home.html, home.finalUrl ?? website);
  let contact: ReturnType<typeof parseSite> | null = null;
  if (p.contactUrl && (!p.emails.length || !p.tels.length)) {
    const cp = await fetchPage(p.contactUrl, 10_000);
    if (cp.ok) contact = parseSite(cp.html, cp.finalUrl ?? p.contactUrl);
  }
  const https = (home.finalUrl ?? website).startsWith("https://");
  const reasons: string[] = [];
  if (p.parked) reasons.push("Looks parked or unfinished (\"coming soon\" / domain for sale)");
  if (!https) reasons.push("No HTTPS (insecure)");
  if (!p.viewport) reasons.push("Not mobile-friendly (no viewport tag)");
  const nowY = new Date().getFullYear();
  if (p.copyrightYear && p.copyrightYear < nowY - 2) reasons.push(`Copyright last updated ${p.copyrightYear}`);
  if (p.words < 150) reasons.push(`Very little content (${p.words} words)`);
  if (home.ms > 6000) reasons.push(`Slow to load (${(home.ms / 1000).toFixed(1)}s)`);
  const status: WebsiteStatus = p.parked || reasons.length >= 2 ? "weak" : "ok";
  return {
    status,
    reasons: reasons.length ? reasons : ["Website loads, uses HTTPS and is mobile-friendly"],
    signals: { https, ms: home.ms, finalUrl: home.finalUrl, title: p.title, viewport: p.viewport, generator: p.generator, words: p.words, copyrightYear: p.copyrightYear, hasForm: p.hasForm || Boolean(contact?.hasForm), parked: p.parked, contactPage: p.contactUrl },
    found: {
      emails: Array.from(new Set([...p.emails, ...(contact?.emails ?? [])])),
      phones: Array.from(new Set([...p.tels, ...(contact?.tels ?? [])])),
      social: Array.from(new Set([...p.social, ...(contact?.social ?? [])])),
      description: p.description,
      foundOn: { emails: p.emails.length ? home.finalUrl : contact?.emails.length ? p.contactUrl : null },
    },
  };
}

const withTimeout = <T,>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error("DNS timeout")), ms))]);

export async function validateEmail(email: string, websiteDomain: string | null) {
  const domain = email.split("@")[1];
  let mail: "ok" | "no_mail_server" | "unknown" = "unknown";
  let detail: string;
  try {
    const mx = await withTimeout(dns.resolveMx(domain), 5000);
    mail = mx.length ? "ok" : "no_mail_server";
    detail = mx.length ? `Domain accepts email (${mx.length} mail server${mx.length > 1 ? "s" : ""})` : "Domain has no mail server";
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOTFOUND" || code === "ENODATA") {
      mail = "no_mail_server";
      detail = "Domain has no mail server";
    } else detail = `Couldn't check the domain (${(err as Error).message})`;
  }
  const onDomain = Boolean(websiteDomain && (domain === websiteDomain || domain.endsWith(`.${websiteDomain}`)));
  return {
    valid: mail === "ok",
    status: mail,
    detail,
    role: ROLE.test(email),
    onCompanyDomain: onDomain,
    freeProvider: /@(gmail|yahoo|hotmail|outlook|aol|icloud|live|msn|proton(mail)?)\./i.test(email),
  };
}

export function completeness(l: { business_name?: string | null; category?: string | null; website?: string | null; main_phone_e164?: string | null; business_email?: string | null; address?: string | null; city?: string | null; state?: string | null; description?: string | null; social_urls?: string[] | null }) {
  let s = 0;
  if (l.business_name) s += 10;
  if (l.category) s += 10;
  if (l.website) s += 15;
  if (l.main_phone_e164) s += 20;
  if (l.business_email) s += 20;
  if (l.address) s += 10;
  if (l.city && l.state) s += 5;
  if (l.description) s += 5;
  if ((l.social_urls ?? []).length) s += 5;
  return s;
}

// ENRICHMENT + VALIDATION for one lead. Adds only what the website really
// shows (with where it was found) and records a verdict for each contact field.
export async function enrichLead(leadId: string) {
  const lead = (await pool.query("select * from leads where id = $1", [leadId])).rows[0];
  if (!lead) return;
  const at = new Date().toISOString();
  const meta = lead.field_meta ?? {};
  const site = await analyzeWebsite(lead.website);
  const updates: Record<string, unknown> = {};
  const siteUrl = (site.signals as any)?.finalUrl ?? lead.website;

  if (!lead.business_email && site.found.emails.length) {
    const domain = lead.website_domain;
    const best = [...site.found.emails].sort((a, b) => Number(Boolean(domain && b.endsWith(domain))) - Number(Boolean(domain && a.endsWith(domain))))[0];
    updates.business_email = best;
    meta.business_email = { source: "website", at, page: (site.found as any).foundOn?.emails ?? siteUrl };
  }
  if (!lead.main_phone_e164 && site.found.phones.length) {
    const ph = normalizePhone(site.found.phones[0], lead.country ?? "US");
    if (ph.e164) {
      updates.main_phone = site.found.phones[0];
      updates.main_phone_e164 = ph.e164;
      meta.main_phone = { source: "website", at, page: siteUrl };
    }
  }
  if (!lead.description && site.found.description) {
    updates.description = site.found.description.slice(0, 600);
    meta.description = { source: "website", at, page: siteUrl };
  }
  const social = site.found.social.map((s) => normalizeWebsite(s).social ?? s).filter((s) => !(lead.social_urls ?? []).includes(s));
  if (social.length) {
    updates.social_urls = [...(lead.social_urls ?? []), ...social].slice(0, 10);
    meta.social_urls = { ...(meta.social_urls ?? {}), source: meta.social_urls?.source ?? "website", at };
  }

  const merged = { ...lead, ...updates };
  const validation: Record<string, unknown> = { checkedAt: at };
  if (merged.business_email) {
    const v = await validateEmail(merged.business_email, merged.website_domain);
    validation.email = v;
    meta.business_email = { ...(meta.business_email ?? {}), validated: v.valid ? "valid" : v.status === "unknown" ? "unverified" : "invalid" };
  } else validation.email = { valid: false, status: "missing", detail: "No email found in sources or on the website" };
  if (merged.main_phone || merged.main_phone_e164) {
    const ph = normalizePhone(merged.main_phone_e164 ?? merged.main_phone, merged.country ?? "US");
    validation.phone = { valid: ph.valid, e164: ph.e164, detail: ph.valid ? "Valid, dialable number" : ph.reason };
    meta.main_phone = { ...(meta.main_phone ?? {}), validated: ph.valid ? "valid" : "invalid" };
  } else validation.phone = { valid: false, detail: "No phone found in sources or on the website" };
  validation.website = { status: site.status, detail: site.reasons.join("; ") };
  if (lead.website) meta.website = { ...(meta.website ?? {}), validated: site.status === "unreachable" ? "invalid" : "valid" };
  validation.address = merged.address && merged.city ? { valid: true, detail: "Street address and city present" } : { valid: false, detail: merged.city ? "City only, no street address" : "No address" };

  const cols = Object.keys(updates);
  const vals = cols.map((k) => updates[k]);
  await pool.query(
    `update leads set ${cols.map((k, i) => `${k} = $${i + 2}`).join(", ")}${cols.length ? "," : ""}
       field_meta = $${cols.length + 2}, enrichment = $${cols.length + 3}, validation = $${cols.length + 4}, website_status = $${cols.length + 5},
       completeness = $${cols.length + 6}, enriched_at = now(), last_verified_at = now(), quality_score = $${cols.length + 6},
       pipeline_status = 'enriched', pipeline_error = null, pipeline_attempts = 0, pipeline_next_at = now(), pipeline_locked_at = null, updated_at = now()
     where id = $1`,
    [leadId, ...vals, JSON.stringify(meta), JSON.stringify({ website: { status: site.status, reasons: site.reasons, signals: site.signals }, found: site.found }), JSON.stringify(validation), site.status, completeness(merged)]
  );
}
