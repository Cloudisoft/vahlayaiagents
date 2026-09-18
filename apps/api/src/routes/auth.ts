import { Router } from "express";
import { z } from "zod";
import {
  createSession,
  login,
  requestPasswordReset,
  resetPassword,
  revokeSession,
  rotateSession,
  signAccessToken,
  signup,
} from "../services/authService.js";
import { sendEmail } from "../services/emailService.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { pool } from "../db/pool.js";
import { env } from "../config/env.js";

export const authRouter = Router();

const REFRESH_COOKIE = "vahlay_refresh";
const cookieOpts = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: env.nodeEnv === "production",
  path: "/api/auth",
};

const signupSchema = z.object({
  organizationName: z.string().min(2),
  email: z.string().email(),
  username: z.string().min(3).max(32).regex(/^[a-z0-9_.]+$/i, "Username can only contain letters, numbers, underscores and periods.").optional(),
  password: z.string().min(8),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
});

authRouter.post("/signup", async (req, res) => {
  const parsed = signupSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  try {
    const user = await signup(parsed.data);
    const { refreshToken, expiresAt } = await createSession(user.id, req.headers["user-agent"], req.ip);
    res.cookie(REFRESH_COOKIE, refreshToken, { ...cookieOpts, expires: expiresAt });
    res.status(201).json({ accessToken: signAccessToken(user), user });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

const loginSchema = z.object({ identifier: z.string().min(1), password: z.string().min(1) });

authRouter.post("/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  try {
    const user = await login(parsed.data.identifier, parsed.data.password);
    const { refreshToken, expiresAt } = await createSession(user.id, req.headers["user-agent"], req.ip);
    res.cookie(REFRESH_COOKIE, refreshToken, { ...cookieOpts, expires: expiresAt });
    res.json({ accessToken: signAccessToken(user), user });
  } catch (err) {
    res.status(401).json({ error: (err as Error).message });
  }
});

authRouter.post("/refresh", async (req, res) => {
  const token = req.cookies?.[REFRESH_COOKIE];
  if (!token) return res.status(401).json({ error: "No refresh token." });
  const user = await rotateSession(token);
  if (!user) return res.status(401).json({ error: "Refresh token invalid or expired." });
  res.json({ accessToken: signAccessToken(user), user });
});

authRouter.post("/logout", async (req, res) => {
  const token = req.cookies?.[REFRESH_COOKIE];
  if (token) await revokeSession(token);
  res.clearCookie(REFRESH_COOKIE, cookieOpts);
  res.status(204).end();
});

authRouter.post("/forgot-password", async (req, res) => {
  const parsed = z.object({ email: z.string().email() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const result = await requestPasswordReset(parsed.data.email);
  if (result) {
    const resetUrl = `${env.appUrl}/reset-password?token=${result.token}`;
    try {
      await sendEmail({
        to: parsed.data.email,
        subject: "Reset your Vahlay AI password",
        html: `<p>Click the link below to reset your password. This link expires in 1 hour.</p><p><a href="${resetUrl}">${resetUrl}</a></p>`,
      });
    } catch (err) {
      // Do not leak whether the account exists or fail the request over email config —
      // log server-side so an admin can see delivery is broken.
      console.error("Failed to send password reset email:", (err as Error).message);
    }
  }
  // Always respond success to avoid account enumeration.
  res.json({ message: "If an account exists for that email, a reset link has been sent." });
});

authRouter.post("/reset-password", async (req, res) => {
  const parsed = z.object({ token: z.string().min(1), password: z.string().min(8) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const ok = await resetPassword(parsed.data.token, parsed.data.password);
  if (!ok) return res.status(400).json({ error: "This reset link is invalid or has expired." });
  res.json({ message: "Password updated successfully." });
});

authRouter.get("/me", requireAuth, async (req: AuthedRequest, res) => {
  const result = await pool.query(
    `select u.id, u.email, u.username, u.first_name, u.last_name, u.organization_id, r.key as role,
            o.name as organization_name, o.settings as organization_settings,
            coalesce(array_agg(uma.module_key) filter (where uma.enabled), '{}') as enabled_modules
     from users u
     join roles r on r.id = u.role_id
     join organizations o on o.id = u.organization_id
     left join user_module_access uma on uma.user_id = u.id
     where u.id = $1
     group by u.id, r.key, o.name, o.settings`,
    [req.auth!.userId]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: "User not found." });
  res.json({ user: result.rows[0] });
});
