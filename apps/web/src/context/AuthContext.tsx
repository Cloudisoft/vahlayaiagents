import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, setAccessToken } from "../lib/api.js";

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

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(true);

  const loadMe = useCallback(async () => {
    try {
      const { user } = await api<{ user: CurrentUser }>("/auth/me");
      setUser(user);
    } catch {
      setUser(null);
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      const { accessToken } = await api<{ accessToken: string }>("/auth/refresh", { method: "POST" });
      setAccessToken(accessToken);
      await loadMe();
    } catch {
      setAccessToken(null);
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, [loadMe]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const login = useCallback(async (identifier: string, password: string) => {
    const { accessToken, user } = await api<{ accessToken: string; user: any }>("/auth/login", {
      method: "POST",
      body: { identifier, password },
    });
    setAccessToken(accessToken);
    setUser(user);
    await loadMe();
  }, [loadMe]);

  const signup = useCallback(
    async (params: { organizationName: string; email: string; username?: string; password: string }) => {
      const { accessToken, user } = await api<{ accessToken: string; user: any }>("/auth/signup", {
        method: "POST",
        body: params,
      });
      setAccessToken(accessToken);
      setUser(user);
      await loadMe();
    },
    [loadMe]
  );

  const logout = useCallback(async () => {
    await api("/auth/logout", { method: "POST" }).catch(() => undefined);
    setAccessToken(null);
    setUser(null);
  }, []);

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
