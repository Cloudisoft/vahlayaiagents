// Minimal, dependency-free phone normalization for the two markets this
// platform targets: US (Coverage/LeadGen/Voice AI) and India (HR interviews).
// This intentionally does not claim to validate every global number —
// it covers the documented use cases and returns null when it cannot.

export function normalizeUsE164(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

export function normalizeIndiaE164(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  // Indian mobile numbers: 10 digits starting 6-9, optionally prefixed with 91 or 0
  let local = digits;
  if (local.startsWith("91") && local.length === 12) local = local.slice(2);
  if (local.startsWith("0") && local.length === 11) local = local.slice(1);
  if (local.length === 10 && /^[6-9]/.test(local)) return `+91${local}`;
  return null;
}

export function parseNpaNxx(e164Us: string): { npa: string; nxx: string } | null {
  const match = e164Us.match(/^\+1(\d{3})(\d{3})\d{4}$/);
  if (!match) return null;
  return { npa: match[1], nxx: match[2] };
}

// Any dialable number to E.164: "+44 20 7946 0958" keeps its country code,
// bare 10/11-digit numbers are taken as US. Returns null when it can't tell.
export function normalizeE164(raw: string): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const digits = s.replace(/\D/g, "");
  if (s.startsWith("+") || s.startsWith("00")) {
    const intl = s.startsWith("00") ? digits.slice(2) : digits;
    if (intl.startsWith("1")) return normalizeUsE164(intl);
    return intl.length >= 8 && intl.length <= 15 && !intl.startsWith("0") ? `+${intl}` : null;
  }
  return normalizeUsE164(digits);
}
