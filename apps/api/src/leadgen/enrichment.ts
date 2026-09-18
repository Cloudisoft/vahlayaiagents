import { normalizeUsE164 } from "../utils/phone.js";

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

// Best-effort website contact extraction. Respects robots.txt (skips the
// fetch if disallowed) and never invents an email that isn't actually on
// the page — a null businessEmail is a correct, honest result.
export async function extractWebsiteContact(
  website: string
): Promise<{ email: string | null; socialUrls: string[] }> {
  try {
    const url = new URL(website.startsWith("http") ? website : `https://${website}`);

    const robotsAllowed = await checkRobotsAllowed(url);
    if (!robotsAllowed) return { email: null, socialUrls: [] };

    const res = await fetch(url.toString(), {
      redirect: "follow",
      signal: AbortSignal.timeout(8000),
      headers: { "User-Agent": "VahlayLeadGenBot/1.0 (+https://vahlay.ai/bot)" },
    });
    if (!res.ok) return { email: null, socialUrls: [] };
    const html = await res.text();

    const emails = Array.from(new Set(html.match(EMAIL_REGEX) ?? [])).filter(
      (e) => !e.endsWith(".png") && !e.endsWith(".jpg") && !e.endsWith(".gif")
    );

    const socialUrls = Array.from(
      new Set(
        Array.from(
          html.matchAll(/https?:\/\/(www\.)?(facebook|linkedin|instagram|twitter|x)\.com\/[a-zA-Z0-9_.\/-]+/g)
        ).map((m) => m[0])
      )
    ).slice(0, 5);

    return { email: emails[0] ?? null, socialUrls };
  } catch {
    return { email: null, socialUrls: [] };
  }
}

async function checkRobotsAllowed(url: URL): Promise<boolean> {
  try {
    const robotsRes = await fetch(`${url.protocol}//${url.host}/robots.txt`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!robotsRes.ok) return true; // no robots.txt -> assume allowed
    const text = await robotsRes.text();
    // Minimal check: a blanket "Disallow: /" under "User-agent: *" blocks us.
    const lines = text.split("\n").map((l) => l.trim());
    let applies = false;
    for (const line of lines) {
      if (/^user-agent:\s*\*/i.test(line)) applies = true;
      else if (/^user-agent:/i.test(line)) applies = false;
      else if (applies && /^disallow:\s*\/\s*$/i.test(line)) return false;
    }
    return true;
  } catch {
    return true;
  }
}

export function isValidEmailSyntax(email: string): boolean {
  return /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(email);
}

export interface QualityScoreInput {
  businessName: string;
  address: string | null;
  website: string | null;
  mainPhoneE164: string | null;
  businessEmail: string | null;
  decisionMakerEmail: string | null;
  lastVerifiedAt: Date | null;
}

// Lead Quality: 0-100, derived from real completeness signals (spec §27) —
// never a fabricated number.
export function computeQualityScore(input: QualityScoreInput): number {
  let score = 0;
  if (input.businessName) score += 15;
  if (input.address) score += 15;
  if (input.website) score += 20;
  if (input.mainPhoneE164) score += 20;
  if (input.businessEmail) score += 15;
  if (input.decisionMakerEmail) score += 10;
  if (input.lastVerifiedAt && Date.now() - input.lastVerifiedAt.getTime() < 90 * 24 * 60 * 60 * 1000) score += 5;
  return Math.min(100, score);
}

export function normalizeLeadPhone(raw: string | null): string | null {
  if (!raw) return null;
  return normalizeUsE164(raw);
}
