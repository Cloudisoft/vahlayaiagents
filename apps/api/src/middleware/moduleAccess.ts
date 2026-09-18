import type { NextFunction, Response } from "express";
import type { AuthedRequest } from "./auth.js";
import { pool } from "../db/pool.js";

const ELEVATED_ROLES = new Set(["super_admin", "company_admin"]);

// Per-user module gating from the Admin Panel (spec: per-user module
// checkboxes), orthogonal to role-based RBAC. Admins always have access —
// this is about which of the five product modules a regular user can open,
// not what actions they can take within one (requireRole still applies).
export function requireModuleAccess(moduleKey: string) {
  return async (req: AuthedRequest, res: Response, next: NextFunction) => {
    if (!req.auth) return res.status(401).json({ error: "Unauthenticated." });
    if (ELEVATED_ROLES.has(req.auth.role)) return next();

    const result = await pool.query(
      "select enabled from user_module_access where user_id = $1 and module_key = $2",
      [req.auth.userId, moduleKey]
    );
    if (result.rows.length > 0 && result.rows[0].enabled) return next();

    return res.status(403).json({ error: "You don't have access to this module. Contact your admin." });
  };
}
