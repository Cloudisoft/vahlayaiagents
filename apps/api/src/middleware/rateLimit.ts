import rateLimit from "express-rate-limit";
import { env } from "../config/env.js";

const GUARDED_AUTH = new Set(["/login", "/signup", "/forgot-password", "/reset-password"]);

// Credential endpoints only: session checks (/me) and token refreshes happen
// on every page load and must not count toward the brute-force budget.
export const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: env.nodeEnv === "production" ? 20 : 500,
  skip: (req) => req.method !== "POST" || !GUARDED_AUTH.has(req.path),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts. Please try again later." },
});

// Public-facing endpoints (job applications, etc.): looser, still bounded.
export const publicRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please try again later." },
});
