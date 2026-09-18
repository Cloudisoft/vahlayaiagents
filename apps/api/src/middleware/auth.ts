import type { NextFunction, Request, Response } from "express";
import { verifyAccessToken } from "../services/authService.js";

export interface AuthedRequest extends Request {
  auth?: {
    userId: string;
    organizationId: string;
    role: string;
    email: string;
  };
}

export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing bearer token." });
  }
  try {
    const payload = verifyAccessToken(header.slice("Bearer ".length));
    req.auth = {
      userId: payload.sub,
      organizationId: payload.org,
      role: payload.role,
      email: payload.email,
    };
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token." });
  }
}
