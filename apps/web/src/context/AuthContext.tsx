import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, ApiError, getAccessToken, refreshSession, setAccessToken, setSessionListener } from "../lib/api.js";
import { clearApiCache } from "../lib/useApi.js";

export interface CurrentUser {
  id: string;
  email: string;
  username: string | null;
  first_name: string | null;
  last_name: string | null;
  organization_id: string;
  role: string;
  organization_name: string;
  organization_settings: { enabledModules?: string[] } | null;
  enabled_modules: string[];
  permissions: string[];
  is_owner?: boolean;
  full_access?: boolean;
  disabled_tabs?: string[];
}

interface AuthContextValue {
  user: CurrentUser | null;
  loading: boolean;
  login: (identifier: string, password: string) => Promise<void>;
  signup: (params: { organizationName: string; email: string; username?: string; password: string }) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const USER_KEY = "vahlay.user";

function readCachedUser(): CurrentUser | null {
  try {
    const raw = sessionStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as CurrentUser) : null;
  } catch {
    return null;
  }
}

function cacheUser(user: CurrentUser | null) {
  try {
    if (user) sessionStorage.setItem(USER_KEY, JSON.stringify(user));
    else sessionStorage.removeItem(USER_KEY);
  } catch {
    // storage unavailable
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  // A reload in the same tab renders straight from the cached session and
  // revalidates in the background — no blocking auth round trips.
  const cached = getAccessToken() ? readCachedUser() : null;
  const [user, setUserState] = useState<CurrentUser | null>(cached);
  const [loading, setLoading] = useState(!cached);

  const setUser = useCallback((u: CurrentUser | null) => {
    cacheUser(u);
    setUserState(u);
  }, []);

  useEffect(() => {
    setSessionListener((u) => setUser(u as CurrentUser));
    return () => setSessionListener(null);
  }, [setUser]);

  const refresh = useCallback(async () => {
    const ok = await refreshSession(); // also delivers the user via the listener
    if (!ok) setUser(null);
    setLoading(false);
  }, [setUser]);

  useEffect(() => {
    if (cached) {
      api<{ user: CurrentUser }>("/auth/me")
        .then(({ user }) => setUser(user))
        .catch((err) => {
          // Only an expired/invalid session logs out; a network error keeps
          // the cached session and the next request will retry.
          if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
            setAccessToken(null);
            setUser(null);
          }
        });
    } else {
      refresh();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const login = useCallback(
    async (identifier: string, password: string) => {
      const { accessToken, user } = await api<{ accessToken: string; user: CurrentUser }>("/auth/login", {
        method: "POST",
        body: { identifier, password },
      });
      clearApiCache();
      setAccessToken(accessToken);
      setUser(user);
    },
    [setUser]
  );

  const signup = useCallback(
    async (params: { organizationName: string; email: string; username?: string; password: string }) => {
      const { accessToken, user } = await api<{ accessToken: string; user: CurrentUser }>("/auth/signup", {
        method: "POST",
        body: params,
      });
      clearApiCache();
      setAccessToken(accessToken);
      setUser(user);
    },
    [setUser]
  );

  const logout = useCallback(async () => {
    await api("/auth/logout", { method: "POST" }).catch(() => undefined);
    clearApiCache();
    setAccessToken(null);
    setUser(null);
  }, [setUser]);

  return (
    <AuthContext.Provider value={{ user, loading, login, signup, logout, refresh }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
