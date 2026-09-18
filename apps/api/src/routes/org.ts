import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { requireRole } from "../middleware/rbac.js";

export const orgRouter = Router();
orgRouter.use(requireAuth);

orgRouter.get("/", async (req: AuthedRequest, res) => {
  const result = await pool.query(
    "select id, name, slug, settings, created_at from organizations where id = $1",
    [req.auth!.organizationId]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: "Organization not found." });
  res.json({ organization: result.rows[0] });
});

const updateSchema = z.object({ name: z.string().min(2).optional(), settings: z.record(z.any()).optional() });

orgRouter.patch("/", requireRole("company_admin"), async (req: AuthedRequest, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const { name, settings } = parsed.data;
  const result = await pool.query(
    `update organizations
     set name = coalesce($1, name), settings = coalesce($2, settings), updated_at = now()
     where id = $3
     returning id, name, slug, settings`,
    [name ?? null, settings ? JSON.stringify(settings) : null, req.auth!.organizationId]
  );
  res.json({ organization: result.rows[0] });
});

orgRouter.get("/users", requireRole("company_admin"), async (req: AuthedRequest, res) => {
  const result = await pool.query(
    `select u.id, u.email, u.first_name, u.last_name, u.is_active, u.last_login_at, r.key as role
     from users u join roles r on r.id = u.role_id
     where u.organization_id = $1
     order by u.created_at desc`,
    [req.auth!.organizationId]
  );
  res.json({ users: result.rows });
});

const inviteSchema = z.object({
  email: z.string().email(),
  role: z.enum(["company_admin", "hr", "recruiter", "agent_manager", "user"]),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  temporaryPassword: z.string().min(8),
});

orgRouter.post("/users", requireRole("company_admin"), async (req: AuthedRequest, res) => {
  const parsed = inviteSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const { email, role, firstName, lastName, temporaryPassword } = parsed.data;

  const roleRow = await pool.query<{ id: string }>("select id from roles where key = $1", [role]);
  if (roleRow.rows.length === 0) return res.status(400).json({ error: "Unknown role." });

  const bcrypt = await import("bcryptjs");
  const passwordHash = await bcrypt.hash(temporaryPassword, 12);

  try {
    const result = await pool.query<{ id: string }>(
      `insert into users (organization_id, email, password_hash, first_name, last_name, role_id)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [req.auth!.organizationId, email.toLowerCase(), passwordHash, firstName ?? null, lastName ?? null, roleRow.rows[0].id]
    );
    await pool.query(
      `insert into audit_logs (organization_id, actor_user_id, action, entity_type, entity_id)
       values ($1, $2, 'user.invited', 'user', $3)`,
      [req.auth!.organizationId, req.auth!.userId, result.rows[0].id]
    );
    res.status(201).json({ userId: result.rows[0].id });
  } catch (err: any) {
    if (err.code === "23505") return res.status(409).json({ error: "A user with this email already exists." });
    throw err;
  }
});
