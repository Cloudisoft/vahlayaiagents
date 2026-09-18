import type { NextFunction, Response } from "express";
import type { AuthedRequest } from "./auth.js";

// Role hierarchy — super_admin and company_admin implicitly pass every check.
const ELEVATED_ROLES = new Set(["super_admin", "company_admin"]);

export function requireRole(...allowedRoles: string[]) {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    const role = req.auth?.role;
    if (!role) return res.status(401).json({ error: "Unauthenticated." });
    if (ELEVATED_ROLES.has(role) || allowedRoles.includes(role)) {
      return next();
    }
    return res.status(403).json({ error: "You do not have permission to perform this action." });
  };
}
