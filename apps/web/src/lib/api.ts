// Short-lived (15 min) access token. Kept in memory and mirrored to this
// tab's sessionStorage so a reload can render and fetch immediately instead
// of waiting on a refresh round trip. The long-lived refresh token stays in
// an httpOnly cookie the page can't read.
const TOKEN_KEY = "vahlay.at";
let accessToken: string | null = readStored();

function readStored(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setAccessToken(token: string | null) {
  accessToken = token;
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // storage unavailable — memory only
  }
}

export function getAccessToken(): string | null {
  return accessToken;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message);
  }
}

let refreshing: Promise<boolean> | null = null;
let onSessionRefreshed: ((user: unknown) => void) | null = null;

export function setSessionListener(fn: ((user: unknown) => void) | null) {
  onSessionRefreshed = fn;
}

// One shared refresh for every request that hit an expired token at once.
export function refreshSession(): Promise<boolean> {
  if (!refreshing) {
    // A network blip or a server hiccup is retried; only the server saying
    // "no valid session" (4xx) ends the session.
    refreshing = (async () => {
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const res = await fetch("/api/auth/refresh", { method: "POST", credentials: "include" });
          if (res.ok) {
            const data = await res.json();
            setAccessToken(data.accessToken);
            onSessionRefreshed?.(data.user);
            return true;
          }
          if (res.status < 500) {
            setAccessToken(null);
            return false;
          }
        } catch {
          // offline or connection dropped — try again
        }
        if (attempt < 3) await new Promise((r) => setTimeout(r, 800 * attempt));
      }
      return false;
    })()
      .finally(() => {
        refreshing = null;
      });
  }
  return refreshing;
}

async function send(path: string, options: { method?: string; body?: unknown }) {
  return fetch(`/api${path}`, {
    method: options.method ?? "GET",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
}

export async function api<T = unknown>(
  path: string,
  options: { method?: string; body?: unknown } = {}
): Promise<T> {
  // Reads are retried on a dropped connection; writes are never repeated.
  const isRead = (options.method ?? "GET") === "GET";
  let res: Response | undefined;
  for (let attempt = 1; ; attempt++) {
    try {
      res = await send(path, options);
      break;
    } catch (err) {
      if (!isRead || attempt >= 3) throw new ApiError("Can't reach the server. Check your connection and try again.", 0);
      await new Promise((r) => setTimeout(r, 600 * attempt));
    }
  }
  // Expired access token: refresh once and replay the request.
  if (res.status === 401 && !/^\/auth\/(login|signup|refresh|logout|forgot|reset)/.test(path) && (await refreshSession())) {
    res = await send(path, options);
  }

  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(data.error ?? "Request failed", res.status);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}
