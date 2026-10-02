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
    refreshing = fetch("/api/auth/refresh", { method: "POST", credentials: "include" })
      .then(async (res) => {
        if (!res.ok) {
          setAccessToken(null);
          return false;
        }
        const data = await res.json();
        setAccessToken(data.accessToken);
        onSessionRefreshed?.(data.user);
        return true;
      })
      .catch(() => false)
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
  let res = await send(path, options);
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
