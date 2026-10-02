// Every AI claim about a candidate must point at text that really exists in
// the resume (or interview transcript). These helpers check that.

export function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’“”]/g, "'")
    .replace(/[–—]/g, "-")
    .replace(/\s*&\s*/g, " and ")
    .replace(/[^a-z0-9@.+#%$/-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// True when the quote appears in the source, ignoring case, punctuation and
// whitespace. Long quotes may be paraphrased at the edges, so a quote also
// passes when 90% of its words appear as one contiguous run in the source.
export function quoteFound(source: string, quote: string | null | undefined): boolean {
  if (!quote) return false;
  const q = normalizeForMatch(quote);
  if (q.length < 3) return false;
  const src = normalizeForMatch(source);
  if (src.includes(q)) return true;
  const words = q.split(" ");
  if (words.length < 6) return false;
  const need = Math.ceil(words.length * 0.9);
  for (let start = 0; start + need <= words.length; start++) {
    for (let len = words.length - start; len >= need; len--) {
      if (src.includes(words.slice(start, start + len).join(" "))) return true;
    }
  }
  return false;
}

export function cleanQuotes(source: string, quotes: unknown): { verified: string[]; rejected: string[] } {
  const list = Array.isArray(quotes) ? quotes : quotes ? [quotes] : [];
  const verified: string[] = [];
  const rejected: string[] = [];
  for (const raw of list) {
    const q = String(raw ?? "").trim().slice(0, 400);
    if (!q) continue;
    (quoteFound(source, q) ? verified : rejected).push(q);
  }
  return { verified, rejected };
}

export function clampScore(n: unknown): number {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(100, v));
}
