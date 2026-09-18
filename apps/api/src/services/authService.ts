import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { pool, withTransaction } from "../db/pool.js";
import { env } from "../config/env.js";
import { hashToken } from "../utils/crypto.js";

export interface AuthUser {
  id: string;
  organizationId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  roleKey: string;
}

function requireJwtSecret(): string {
  if (!env.jwtSecret) {
    throw new Error("JWT_SECRET is not configured on the server.");
  }
  return env.jwtSecret;
}

export function signAccessToken(user: AuthUser): string {
  return jwt.sign(
    { sub: user.id, org: user.organizationId, role: user.roleKey, email: user.email },
    requireJwtSecret(),
    { expiresIn: env.jwtAccessTtl as any }
  );
}

export function verifyAccessToken(token: string) {
  return jwt.verify(token, requireJwtSecret()) as {
    sub: string;
    org: string;
    role: string;
    email: string;
  };
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "") || crypto.randomBytes(4).toString("hex")
  );
}

export async function signup(params: {
  organizationName: string;
  email: string;
  password: string;
  firstName?: string;
  lastName?: string;
}): Promise<AuthUser> {
  const { organizationName, email, password, firstName, lastName } = params;

  const existing = await pool.query("select id from users where email = $1", [email.toLowerCase()]);
  if (existing.rows.length > 0) {
    throw new Error("An account with this email already exists.");
  }

  const passwordHash = await bcrypt.hash(password, 12);

  return withTransaction(async (client) => {
    let slug = slugify(organizationName);
    const slugTaken = await client.query("select id from organizations where slug = $1", [slug]);
    if (slugTaken.rows.length > 0) {
      slug = `${slug}-${crypto.randomBytes(3).toString("hex")}`;
    }

    const orgResult = await client.query<{ id: string }>(
      "insert into organizations (name, slug) values ($1, $2) returning id",
      [organizationName, slug]
    );
    const organizationId = orgResult.rows[0].id;

    const roleResult = await client.query<{ id: string }>(
      "select id from roles where key = 'company_admin'"
    );
    const roleId = roleResult.rows[0].id;

    const userResult = await client.query<{ id: string }>(
      `insert into users (organization_id, email, password_hash, first_name, last_name, role_id)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [organizationId, email.toLowerCase(), passwordHash, firstName ?? null, lastName ?? null, roleId]
    );

    await client.query(
      `insert into audit_logs (organization_id, actor_user_id, action, entity_type, entity_id)
       values ($1, $2, 'user.signup', 'user', $3)`,
      [organizationId, userResult.rows[0].id, userResult.rows[0].id]
    );

    return {
      id: userResult.rows[0].id,
      organizationId,
      email: email.toLowerCase(),
      firstName: firstName ?? null,
      lastName: lastName ?? null,
      roleKey: "company_admin",
    };
  });
}

export async function login(email: string, password: string): Promise<AuthUser> {
  const result = await pool.query<{
    id: string;
    organization_id: string;
    email: string;
    password_hash: string;
    first_name: string | null;
    last_name: string | null;
    role_key: string;
    is_active: boolean;
  }>(
    `select u.id, u.organization_id, u.email, u.password_hash, u.first_name, u.last_name,
            r.key as role_key, u.is_active
     from users u join roles r on r.id = u.role_id
     where u.email = $1`,
    [email.toLowerCase()]
  );

  if (result.rows.length === 0) {
    throw new Error("Invalid email or password.");
  }
  const row = result.rows[0];
  if (!row.is_active) {
    throw new Error("This account has been deactivated.");
  }
  const valid = await bcrypt.compare(password, row.password_hash);
  if (!valid) {
    throw new Error("Invalid email or password.");
  }

  await pool.query("update users set last_login_at = now() where id = $1", [row.id]);

  return {
    id: row.id,
    organizationId: row.organization_id,
    email: row.email,
    firstName: row.first_name,
    lastName: row.last_name,
    roleKey: row.role_key,
  };
}

export async function createSession(userId: string, userAgent?: string, ip?: string) {
  const refreshToken = crypto.randomBytes(48).toString("hex");
  const expiresAt = new Date(Date.now() + env.refreshTokenTtlDays * 24 * 60 * 60 * 1000);
  await pool.query(
    `insert into sessions (user_id, refresh_token_hash, user_agent, ip_address, expires_at)
     values ($1, $2, $3, $4, $5)`,
    [userId, hashToken(refreshToken), userAgent ?? null, ip ?? null, expiresAt]
  );
  return { refreshToken, expiresAt };
}

export async function revokeSession(refreshToken: string) {
  await pool.query(
    "update sessions set revoked_at = now() where refresh_token_hash = $1 and revoked_at is null",
    [hashToken(refreshToken)]
  );
}

export async function rotateSession(refreshToken: string): Promise<AuthUser | null> {
  const tokenHash = hashToken(refreshToken);
  const result = await pool.query<{
    session_id: string;
    user_id: string;
    organization_id: string;
    email: string;
    first_name: string | null;
    last_name: string | null;
    role_key: string;
  }>(
    `select s.id as session_id, u.id as user_id, u.organization_id, u.email, u.first_name, u.last_name, r.key as role_key
     from sessions s
     join users u on u.id = s.user_id
     join roles r on r.id = u.role_id
     where s.refresh_token_hash = $1 and s.revoked_at is null and s.expires_at > now()`,
    [tokenHash]
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    id: row.user_id,
    organizationId: row.organization_id,
    email: row.email,
    firstName: row.first_name,
    lastName: row.last_name,
    roleKey: row.role_key,
  };
}

export async function requestPasswordReset(email: string): Promise<{ token: string; userId: string } | null> {
  const result = await pool.query<{ id: string }>("select id from users where email = $1", [email.toLowerCase()]);
  if (result.rows.length === 0) return null; // caller returns generic success regardless
  const userId = result.rows[0].id;
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
  await pool.query(
    "insert into password_resets (user_id, token_hash, expires_at) values ($1, $2, $3)",
    [userId, hashToken(token), expiresAt]
  );
  return { token, userId };
}

export async function resetPassword(token: string, newPassword: string): Promise<boolean> {
  const tokenHash = hashToken(token);
  const result = await pool.query<{ id: string; user_id: string }>(
    `select id, user_id from password_resets
     where token_hash = $1 and used_at is null and expires_at > now()`,
    [tokenHash]
  );
  if (result.rows.length === 0) return false;
  const row = result.rows[0];
  const passwordHash = await bcrypt.hash(newPassword, 12);
  await withTransaction(async (client) => {
    await client.query("update users set password_hash = $1 where id = $2", [passwordHash, row.user_id]);
    await client.query("update password_resets set used_at = now() where id = $1", [row.id]);
    await client.query("update sessions set revoked_at = now() where user_id = $1 and revoked_at is null", [
      row.user_id,
    ]);
  });
  return true;
}
