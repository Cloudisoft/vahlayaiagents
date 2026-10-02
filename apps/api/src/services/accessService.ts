import type { NextFunction, Response } from "express";
import type { AuthedRequest } from "../middleware/auth.js";
import { pool } from "../db/pool.js";

export const ALL_MODULES = ["hr", "coverage", "leadgen", "voice_agents", "call_auditor"] as const;

// Tabs an admin can switch on/off per person inside a module.
export const MODULE_TABS: Record<string, Array<{ key: string; label: string }>> = {
  voice_agents: [
    { key: "dashboard", label: "Dashboard" },
    { key: "campaigns", label: "Campaigns" },
    { key: "callbacks", label: "Callbacks" },
    { key: "live", label: "Live Monitor" },
    { key: "leads", label: "Leads" },
    { key: "history", label: "Call Records" },
    { key: "analytics", label: "Analytics" },
    { key: "dispositions", label: "Dispositions" },
    { key: "agents", label: "AI Agents" },
    { key: "voices", label: "Voices" },
    { key: "numbers", label: "Numbers" },
    { key: "dnc", label: "Do Not Call" },
  ],
};

export const ALL_TABS = Object.entries(MODULE_TABS).flatMap(([m, tabs]) => tabs.map((t) => `${m}.${t.key}`));

export interface Access {
  full: boolean; // owner or platform super admin
  modules: Set<string>;
  disabledTabs: Set<string>;
}

export async function loadAccess(userId: string, role: string): Promise<Access> {
  const r = await pool.query<{ is_owner: boolean; modules: string[] | null; off: string[] | null }>(
    `select u.is_owner,
            (select array_agg(module_key) from user_module_access where user_id = u.id and enabled) as modules,
            (select array_agg(tab_key) from user_tab_access where user_id = u.id and not enabled) as off
     from users u where u.id = $1`,
    [userId]
  );
  const row = r.rows[0];
  const full = role === "super_admin" || Boolean(row?.is_owner);
  return {
    full,
    modules: new Set(full ? ALL_MODULES : row?.modules ?? []),
    disabledTabs: new Set(full ? [] : row?.off ?? []),
  };
}

export function canUseTab(a: Access, moduleKey: string, tab: string) {
  return a.full || (a.modules.has(moduleKey) && !a.disabledTabs.has(`${moduleKey}.${tab}`));
}

// Memoised per request so stacked checks cost one query.
async function accessFor(req: AuthedRequest): Promise<Access> {
  const r = req as AuthedRequest & { _access?: Promise<Access> };
  r._access ??= loadAccess(req.auth!.userId, req.auth!.role);
  return r._access;
}

export function requireModuleAccess(moduleKey: string) {
  return async (req: AuthedRequest, res: Response, next: NextFunction) => {
    if (!req.auth) return res.status(401).json({ error: "Unauthenticated." });
    const a = await accessFor(req);
    if (a.full || a.modules.has(moduleKey)) return next();
    return res.status(403).json({ error: "You don't have access to this module. Contact your admin." });
  };
}

// Tab gate. `readVia` lets a page that needs another tab's lists (e.g. the
// campaign editor reading agents and numbers) do so without granting edits.
export function requireTab(moduleKey: string, tab: string, opts: { readVia?: string[] } = {}) {
  return async (req: AuthedRequest, res: Response, next: NextFunction) => {
    if (!req.auth) return res.status(401).json({ error: "Unauthenticated." });
    const a = await accessFor(req);
    if (canUseTab(a, moduleKey, tab)) return next();
    if (req.method === "GET" && opts.readVia?.some((t) => canUseTab(a, moduleKey, t))) return next();
    return res.status(403).json({ error: "You don't have access to this tab. Contact your admin." });
  };
}
