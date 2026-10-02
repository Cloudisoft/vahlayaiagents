import { useCallback, useEffect, useReducer, useState } from "react";
import { api, ApiError } from "./api.js";

// Stale-while-revalidate cache for GET requests: a page renders its last
// known data instantly, then refreshes in the background. Identical requests
// in flight are shared, and hovering a nav item prefetches its data.
interface Entry {
  data: unknown;
  at: number;
}

const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<unknown>>();
const listeners = new Map<string, Set<() => void>>();
const FRESH_MS = 10_000;

function notify(path: string) {
  listeners.get(path)?.forEach((fn) => fn());
}

export function fetchCached<T>(path: string): Promise<T> {
  const running = inflight.get(path);
  if (running) return running as Promise<T>;
  const p = api<T>(path)
    .then((data) => {
      cache.set(path, { data, at: Date.now() });
      notify(path);
      return data;
    })
    .finally(() => inflight.delete(path));
  inflight.set(path, p);
  return p;
}

export function prefetch(path: string) {
  const hit = cache.get(path);
  if (hit && Date.now() - hit.at < FRESH_MS) return;
  fetchCached(path).catch(() => undefined);
}

// Refetch every cached path starting with `prefix` (after a mutation).
export function invalidate(prefix: string) {
  for (const key of Array.from(cache.keys())) {
    if (!key.startsWith(prefix)) continue;
    if (listeners.get(key)?.size) fetchCached(key).catch(() => undefined);
    else cache.delete(key);
  }
}

export function clearApiCache() {
  cache.clear();
  inflight.clear();
}

export function useApi<T>(path: string | null, opts: { refreshMs?: number } = {}) {
  const [, rerender] = useReducer((x: number) => x + 1, 0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!path) return;
    let set = listeners.get(path);
    if (!set) listeners.set(path, (set = new Set()));
    set.add(rerender);
    setError(null);
    const load = () =>
      fetchCached(path).catch((err) => setError(err instanceof ApiError ? err.message : "Failed to load."));
    load();
    const timer = opts.refreshMs ? setInterval(load, opts.refreshMs) : undefined;
    return () => {
      set!.delete(rerender);
      if (timer) clearInterval(timer);
    };
  }, [path, opts.refreshMs]);

  const reload = useCallback(() => (path ? fetchCached<T>(path) : Promise.resolve(undefined as T)), [path]);
  const entry = path ? cache.get(path) : undefined;
  return {
    data: entry?.data as T | undefined,
    error: entry ? null : error,
    loading: Boolean(path) && !entry && !error,
    reload,
  };
}
