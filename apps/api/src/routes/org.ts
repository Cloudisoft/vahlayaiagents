import { Router } from "express";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { pool } from "../db/pool.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { requireRole } from "../middleware/rbac.js";
import { ALL_MODULES, ALL_TABS, MODULE_TABS, loadAccess, type Access } from "../services/accessService.js";

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

// Static module catalog (matches the Admin Panel's checkbox grid).
orgRouter.get("/modules", async (_req, res) => {
  const result = await pool.query("select key, name, description from modules order by key");
  res.json({ modules: result.rows });
});

// What exists, and what the signed-in admin may hand out (their own access).
orgRouter.get("/access-catalog", requireRole("company_admin"), async (req: AuthedRequest, res) => {
  const a = await loadAccess(req.auth!.userId, req.auth!.role);
  res.json({
    modules: ALL_MODULES,
    tabs: MODULE_TABS,
    grantable: {
      full: a.full,
      modules: [...a.modules],
      tabs: ALL_TABS.filter((t) => a.modules.has(t.split(".")[0]) && !a.disabledTabs.has(t)),
    },
  });
});

async function targetUser(req: AuthedRequest) {
  const r = await pool.query<{ id: string; is_owner: boolean; role: string }>(
    `select u.id, u.is_owner, r.key as role from users u join roles r on r.id = u.role_id
     where u.id = $1 and u.organization_id = $2`,
    [req.params.id, req.auth!.organizationId]
  );
  return r.rows[0] ?? null;
}

// Only the owner (or a platform super admin) may change the owner's account.
async function guardTarget(req: AuthedRequest, actor: Access) {
  const t = await targetUser(req);
  if (!t) return { error: [404, "User not found."] as const };
  if (t.is_owner && !actor.full) return { error: [403, "Only the account owner can change the owner's account."] as const };
  if (t.role === "super_admin" && req.auth!.role !== "super_admin") return { error: [403, "You can't change a platform admin."] as const };
  return { target: t };
}

// Apply module + tab grants within the actor's own scope. Anything outside
// the actor's scope on the target is left exactly as it was.
async function applyAccess(actor: Access, actorId: string, userId: string, modules: string[], disabledTabs: string[]) {
  const grantableModules = actor.full ? new Set<string>(ALL_MODULES) : actor.modules;
  for (const m of modules) if (!grantableModules.has(m)) throw new Error(`You can't grant the ${m} module — you don't have it yourself.`);
  for (const m of grantableModules) {
    await pool.query(
      `insert into user_module_access (user_id, module_key, enabled, granted_by) values ($1,$2,$3,$4)
       on conflict (user_id, module_key) do update set enabled = excluded.enabled, granted_by = excluded.granted_by`,
      [userId, m, modules.includes(m), actorId]
    );
  }
  for (const tab of ALL_TABS) {
    const moduleKey = tab.split(".")[0];
    if (!grantableModules.has(moduleKey)) continue;
    const actorHasTab = actor.full || !actor.disabledTabs.has(tab);
    if (!actorHasTab) {
      // The target can't receive a tab the actor lacks; leave any existing grant alone.
      await pool.query(
        `insert into user_tab_access (user_id, tab_key, enabled, granted_by) values ($1,$2,false,$3) on conflict (user_id, tab_key) do nothing`,
        [userId, tab, actorId]
      );
      continue;
    }
    await pool.query(
      `insert into user_tab_access (user_id, tab_key, enabled, granted_by, updated_at) values ($1,$2,$3,$4,now())
       on conflict (user_id, tab_key) do update set enabled = excluded.enabled, granted_by = excluded.granted_by, updated_at = now()`,
      [userId, tab, !disabledTabs.includes(tab), actorId]
    );
  }
}

orgRouter.get("/users", requireRole("company_admin"), async (req: AuthedRequest, res) => {
  const result = await pool.query(
    `select u.id, u.email, u.username, u.first_name, u.last_name, u.is_active, u.last_login_at, r.key as role, u.is_owner,
            (select coalesce(array_agg(tab_key), '{}') from user_tab_access where user_id = u.id and not enabled) as disabled_tabs,
            coalesce(
              json_agg(json_build_object('moduleKey', uma.module_key, 'enabled', uma.enabled)) filter (where uma.module_key is not null),
              '[]'
            ) as modules
     from users u
     join roles r on r.id = u.role_id
     left join user_module_access uma on uma.user_id = u.id
     where u.organization_id = $1
     group by u.id, r.key
     order by u.created_at desc`,
    [req.auth!.organizationId]
  );
  res.json({ users: result.rows });
});

const inviteSchema = z.object({
  email: z.string().email(),
  username: z.string().min(3).max(32).regex(/^[a-z0-9_.]+$/i, "Username can only contain letters, numbers, underscores and periods."),
  role: z.enum(["company_admin", "hr", "recruiter", "agent_manager", "user"]),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  temporaryPassword: z.string().min(8),
  moduleKeys: z.array(z.string()).optional(),
  disabledTabs: z.array(z.string()).optional(),
});

orgRouter.post("/users", requireRole("company_admin"), async (req: AuthedRequest, res) => {
  const parsed = inviteSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const { email, username, role, firstName, lastName, temporaryPassword, moduleKeys, disabledTabs } = parsed.data;
  const actor = await loadAccess(req.auth!.userId, req.auth!.role);
  const blocked = (moduleKeys ?? []).find((m) => !actor.full && !actor.modules.has(m));
  if (blocked) return res.status(403).json({ error: `You can't grant the ${blocked} module — you don't have it yourself.` });

  const roleRow = await pool.query<{ id: string }>("select id from roles where key = $1", [role]);
  if (roleRow.rows.length === 0) return res.status(400).json({ error: "Unknown role." });

  const passwordHash = await bcrypt.hash(temporaryPassword, 12);

  try {
    const result = await pool.query<{ id: string }>(
      `insert into users (organization_id, email, username, password_hash, first_name, last_name, role_id)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [req.auth!.organizationId, email.toLowerCase(), username, passwordHash, firstName ?? null, lastName ?? null, roleRow.rows[0].id]
    );
    const userId = result.rows[0].id;

    await applyAccess(actor, req.auth!.userId, userId, moduleKeys ?? [], disabledTabs ?? []);

    await pool.query(
      `insert into audit_logs (organization_id, actor_user_id, action, entity_type, entity_id)
       values ($1, $2, 'user.invited', 'user', $3)`,
      [req.auth!.organizationId, req.auth!.userId, userId]
    );
    res.status(201).json({ userId });
  } catch (err: any) {
    if (err.code === "23505") return res.status(409).json({ error: "A user with this email or username already exists." });
    throw err;
  }
});

const roleSchema = z.object({ role: z.enum(["company_admin", "hr", "recruiter", "agent_manager", "user"]) });

orgRouter.patch("/users/:id/role", requireRole("company_admin"), async (req: AuthedRequest, res) => {
  const parsed = roleSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  if (req.params.id === req.auth!.userId) return res.status(400).json({ error: "You can't change your own role." });
  const g = await guardTarget(req, await loadAccess(req.auth!.userId, req.auth!.role));
  if (g.error) return res.status(g.error[0]).json({ error: g.error[1] });
  const roleRow = await pool.query<{ id: string }>("select id from roles where key = $1", [parsed.data.role]);
  if (roleRow.rows.length === 0) return res.status(400).json({ error: "Unknown role." });
  const result = await pool.query(
    "update users set role_id = $1 where id = $2 and organization_id = $3 returning id",
    [roleRow.rows[0].id, req.params.id, req.auth!.organizationId]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: "User not found." });
  res.status(204).end();
});

const accessSchema = z.object({ modules: z.array(z.string()), disabledTabs: z.array(z.string()).default([]) });

orgRouter.patch("/users/:id/access", requireRole("company_admin"), async (req: AuthedRequest, res) => {
  const parsed = accessSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  if (req.params.id === req.auth!.userId) return res.status(400).json({ error: "You can't change your own access." });
  const actor = await loadAccess(req.auth!.userId, req.auth!.role);
  const g = await guardTarget(req, actor);
  if (g.error) return res.status(g.error[0]).json({ error: g.error[1] });
  if (g.target!.is_owner) return res.status(400).json({ error: "The account owner always has full access." });
  try {
    await applyAccess(actor, req.auth!.userId, req.params.id, parsed.data.modules, parsed.data.disabledTabs);
  } catch (err) {
    return res.status(403).json({ error: (err as Error).message });
  }
  await pool.query(
    `insert into audit_logs (organization_id, actor_user_id, action, entity_type, entity_id, metadata)
     values ($1, $2, 'user.access_changed', 'user', $3, $4)`,
    [req.auth!.organizationId, req.auth!.userId, req.params.id, JSON.stringify(parsed.data)]
  );
  res.status(204).end();
});

orgRouter.patch("/users/:id/status", requireRole("company_admin"), async (req: AuthedRequest, res) => {
  {
    const g = await guardTarget(req, await loadAccess(req.auth!.userId, req.auth!.role));
    if (g.error) return res.status(g.error[0]).json({ error: g.error[1] });
    if (g.target!.is_owner && req.method !== "POST") return res.status(400).json({ error: "The account owner can't be disabled or deleted." });
  }
  const parsed = z.object({ isActive: z.boolean() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  if (req.params.id === req.auth!.userId) return res.status(400).json({ error: "You cannot deactivate your own account." });
  const result = await pool.query(
    "update users set is_active = $1 where id = $2 and organization_id = $3 returning id",
    [parsed.data.isActive, req.params.id, req.auth!.organizationId]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: "User not found." });
  res.status(204).end();
});

orgRouter.post("/users/:id/reset-password", requireRole("company_admin"), async (req: AuthedRequest, res) => {
  {
    const g = await guardTarget(req, await loadAccess(req.auth!.userId, req.auth!.role));
    if (g.error) return res.status(g.error[0]).json({ error: g.error[1] });
    if (g.target!.is_owner && req.method !== "POST") return res.status(400).json({ error: "The account owner can't be disabled or deleted." });
  }
  const parsed = z.object({ newPassword: z.string().min(8) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const passwordHash = await bcrypt.hash(parsed.data.newPassword, 12);
  const result = await pool.query(
    "update users set password_hash = $1 where id = $2 and organization_id = $3 returning id",
    [passwordHash, req.params.id, req.auth!.organizationId]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: "User not found." });
  await pool.query("update sessions set revoked_at = now() where user_id = $1 and revoked_at is null", [req.params.id]);
  res.status(204).end();
});

orgRouter.delete("/users/:id", requireRole("company_admin"), async (req: AuthedRequest, res) => {
  {
    const g = await guardTarget(req, await loadAccess(req.auth!.userId, req.auth!.role));
    if (g.error) return res.status(g.error[0]).json({ error: g.error[1] });
    if (g.target!.is_owner && req.method !== "POST") return res.status(400).json({ error: "The account owner can't be disabled or deleted." });
  }
  if (req.params.id === req.auth!.userId) return res.status(400).json({ error: "You cannot delete your own account." });
  await pool.query("delete from users where id = $1 and organization_id = $2", [req.params.id, req.auth!.organizationId]);
  res.status(204).end();
});
