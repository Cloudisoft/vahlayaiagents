import { PermanentSourceError, RateLimitedError, TransientSourceError } from "./sources/types.js";

export const USER_AGENT = "VahlayLeadDiscovery/1.0 (+https://vahlay.ai/bot)";

// Spaces calls per key so we stay inside each provider's published limits
// (e.g. Nominatim: 1 request/second). In-process; one worker runs discovery.
const lastCall = new Map<string, Promise<void>>();
export function throttle(key: string, minIntervalMs: number): Promise<void> {
  const prev = lastCall.get(key) ?? Promise.resolve();
  const next = prev.then(() => new Promise<void>((r) => setTimeout(r, minIntervalMs)));
  lastCall.set(key, next.catch(() => undefined));
  return prev;
}

// fetch with a hard timeout and errors classified for retry decisions.
export async function sourceFetch(url: string, init: RequestInit & { timeoutMs?: number; label: string }): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(init.timeoutMs ?? 30_000), headers: { "User-Agent": USER_AGENT, ...(init.headers ?? {}) } });
  } catch (err) {
    const e = err as Error;
    throw new TransientSourceError(`${init.label}: ${e.name === "TimeoutError" ? "timed out" : e.message}`);
  }
  if (res.status === 429) {
    const ra = Number(res.headers.get("retry-after"));
    throw new RateLimitedError(`${init.label}: rate limited`, Number.isFinite(ra) && ra > 0 ? ra : 60);
  }
  if (res.status >= 500 || res.status === 408) throw new TransientSourceError(`${init.label}: server error ${res.status}`);
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 300);
    throw new PermanentSourceError(`${init.label}: ${res.status} ${body}`);
  }
  return res;
}

export async function sourceJson<T>(res: Response, label: string): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new TransientSourceError(`${label}: invalid response (${text.slice(0, 120).replace(/\s+/g, " ")})`);
  }
}
