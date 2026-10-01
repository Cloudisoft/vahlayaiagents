import type { NextFunction, Response } from "express";
import type { AuthedRequest } from "./auth.js";

// Fine-grained call-centre permissions (playbook §6, §9): listen, whisper and
// barge are separate, so a role can monitor calls without speaking into them.
export type Permission =
  | "calls.listen"
  | "calls.whisper"
  | "calls.barge"
  | "calls.transfer"
  | "calls.end"
  | "calls.disposition"
  | "campaign.publish"
  | "campaign.start"
  | "cdr.view"
  | "cdr.export";

const ROLE_PERMISSIONS: Record<string, Permission[] | "*"> = {
  super_admin: "*",
  company_admin: "*",
  agent_manager: [
    "calls.listen",
    "calls.whisper",
    "calls.barge",
    "calls.transfer",
    "calls.end",
    "calls.disposition",
    "campaign.publish",
    "campaign.start",
    "cdr.view",
    "cdr.export",
  ],
  user: ["calls.listen", "cdr.view"],
  hr: [],
  recruiter: [],
};

export function hasPermission(role: string, permission: Permission): boolean {
  const perms = ROLE_PERMISSIONS[role];
  return perms === "*" || (perms ?? []).includes(permission);
}

export function permissionsFor(role: string): Permission[] {
  const perms = ROLE_PERMISSIONS[role];
  if (perms === "*") return Object.values(ROLE_PERMISSIONS).flatMap((p) => (p === "*" ? [] : p)).filter((p, i, a) => a.indexOf(p) === i);
  return perms ?? [];
}

export function requirePermission(permission: Permission) {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    if (!req.auth) return res.status(401).json({ error: "Unauthenticated." });
    if (hasPermission(req.auth.role, permission)) return next();
    return res.status(403).json({ error: `Missing permission: ${permission}` });
  };
}
