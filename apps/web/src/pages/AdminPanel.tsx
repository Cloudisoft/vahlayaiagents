import { useEffect, useState } from "react";
import { useAuth } from "../context/AuthContext.js";
import { api, ApiError } from "../lib/api.js";
import { MODULES } from "../lib/modules.js";

const ROLES = [
  { key: "company_admin", label: "Admin" },
  { key: "hr", label: "HR" },
  { key: "recruiter", label: "Recruiter" },
  { key: "agent_manager", label: "Agent Manager" },
  { key: "user", label: "User" },
];

interface UserRow {
  id: string;
  username: string | null;
  email: string;
  first_name: string | null;
  last_name: string | null;
  role: string;
  is_active: boolean;
  is_owner: boolean;
  disabled_tabs: string[];
  modules: Array<{ moduleKey: string; enabled: boolean }>;
}

interface Catalog {
  modules: string[];
  tabs: Record<string, Array<{ key: string; label: string }>>;
  grantable: { full: boolean; modules: string[]; tabs: string[] };
}

function moduleTitle(key: string) {
  return MODULES.find((m) => m.key === key)?.title.replace("Vahlay", "").replace("Smart", "").trim() ?? key;
}

export default function AdminPanel() {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [editingAccess, setEditingAccess] = useState<UserRow | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const { user: me } = useAuth();

  async function load() {
    const [{ users }, cat] = await Promise.all([api<{ users: UserRow[] }>("/org/users"), api<Catalog>("/org/access-catalog")]);
    setUsers(users);
    setCatalog(cat);
  }

  useEffect(() => {
    load();
  }, []);

  async function toggleStatus(u: UserRow) {
    setError(null);
    try {
      await api(`/org/users/${u.id}/status`, { method: "PATCH", body: { isActive: !u.is_active } });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to update status.");
    }
  }

  async function resetPassword(u: UserRow) {
    const newPassword = window.prompt(`New temporary password for ${u.username ?? u.email} (min 8 characters):`);
    if (!newPassword) return;
    setError(null);
    try {
      await api(`/org/users/${u.id}/reset-password`, { method: "POST", body: { newPassword } });
      setMessage(`Password reset for ${u.username ?? u.email}.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to reset password.");
    }
  }

  async function deleteUser(u: UserRow) {
    if (!window.confirm(`Delete ${u.username ?? u.email}? This cannot be undone.`)) return;
    setError(null);
    try {
      await api(`/org/users/${u.id}`, { method: "DELETE" });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to delete user.");
    }
  }

  return (
    <div className="max-w-5xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Admin Panel</h1>
          <p className="text-sm text-slate-500">
            Create accounts for admins and users, and choose exactly which modules and tabs each person can open.
            {catalog && !catalog.grantable.full && " You can grant only what you have access to yourself."}
          </p>
        </div>
        <button onClick={() => setShowCreate(true)} className="bg-red-600 text-white text-sm font-medium rounded-md px-4 py-2 hover:bg-red-700">
          + Create account
        </button>
      </div>

      {error && <div className="mb-4 text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-2">{error}</div>}
      {message && <div className="mb-4 text-sm text-green-700 bg-green-50 border border-green-200 rounded-md p-2">{message}</div>}

      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-500 text-xs uppercase">
            <tr>
              <th className="text-left px-4 py-3">Username</th>
              <th className="text-left px-4 py-3">Display Name</th>
              <th className="text-left px-4 py-3">Role</th>
              <th className="text-left px-4 py-3">Status</th>
              <th className="text-left px-4 py-3">Modules</th>
              <th className="text-right px-4 py-3">Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className="border-t border-slate-100">
                <td className="px-4 py-3 font-medium text-slate-900">
                  {u.username ?? u.email}
                  {u.is_owner && <span className="ml-2 text-[10px] uppercase tracking-wide bg-amber-100 text-amber-800 rounded-full px-1.5 py-0.5">Owner</span>}
                  {u.id === me?.id && <span className="ml-1 text-xs text-slate-400">(you)</span>}
                </td>
                <td className="px-4 py-3 text-slate-500">
                  {u.first_name} {u.last_name}
                </td>
                <td className="px-4 py-3">
                  <span className={`text-xs rounded-full px-2 py-0.5 ${u.role === "super_admin" || u.role === "company_admin" ? "bg-red-600 text-white" : "bg-slate-100 text-slate-600"}`}>
                    {ROLES.find((r) => r.key === u.role)?.label ?? u.role}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <span className={`inline-flex items-center gap-1 text-xs ${u.is_active ? "text-green-600" : "text-slate-400"}`}>
                    ● {u.is_active ? "Active" : "Disabled"}
                  </span>
                </td>
                <td className="px-4 py-3">
                  {u.is_owner || u.role === "super_admin" ? (
                    <span className="text-xs bg-slate-100 text-slate-600 rounded-full px-2 py-0.5">Full access</span>
                  ) : (
                    <div className="flex flex-wrap gap-1">
                      {u.modules.filter((m) => m.enabled).length === 0 ? (
                        <span className="text-xs text-slate-400">None</span>
                      ) : (
                        u.modules
                          .filter((m) => m.enabled)
                          .map((m) => (
                            <span key={m.moduleKey} className="text-xs bg-slate-100 text-slate-600 rounded-full px-2 py-0.5">
                              {moduleTitle(m.moduleKey)}
                            </span>
                          ))
                      )}
                      {u.disabled_tabs.length > 0 && (
                        <span className="text-xs text-amber-700">{u.disabled_tabs.length} tab{u.disabled_tabs.length > 1 ? "s" : ""} off</span>
                      )}
                    </div>
                  )}
                </td>
                <td className="px-4 py-3">
                  <div className="flex justify-end gap-2 text-slate-400">
                    <button
                      title={u.is_owner ? "The owner always has full access" : u.id === me?.id ? "You can't change your own access" : "Edit role & access"}
                      disabled={u.is_owner || u.id === me?.id}
                      onClick={() => setEditingAccess(u)}
                      className="hover:text-red-600 disabled:opacity-30 disabled:cursor-not-allowed"
                    >
                      🛡️
                    </button>
                    <button title="Reset password" onClick={() => resetPassword(u)} className="hover:text-red-600">
                      🔑
                    </button>
                    <button title={u.is_active ? "Disable" : "Enable"} disabled={u.is_owner || u.id === me?.id} onClick={() => toggleStatus(u)} className="hover:text-red-600 disabled:opacity-30 disabled:cursor-not-allowed">
                      {u.is_active ? "🟢" : "⚪"}
                    </button>
                    <button title="Delete" disabled={u.is_owner || u.id === me?.id} onClick={() => deleteUser(u)} className="hover:text-red-600 disabled:opacity-30 disabled:cursor-not-allowed">
                      🗑️
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {users.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-slate-500">No users yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {showCreate && catalog && (
        <CreateUserModal
          catalog={catalog}
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            load();
          }}
        />
      )}
      {editingAccess && catalog && (
        <EditAccessModal
          catalog={catalog}
          user={editingAccess}
          onClose={() => setEditingAccess(null)}
          onSaved={() => {
            setEditingAccess(null);
            load();
          }}
        />
      )}
    </div>
  );
}

const TAB_MODULE = "voice_agents";

// Module checkboxes + per-tab switches. Anything the signed-in admin can't
// grant is shown but locked.
function AccessEditor(props: {
  catalog: Catalog;
  modules: string[];
  disabledTabs: string[];
  onChange: (modules: string[], disabledTabs: string[]) => void;
}) {
  const { catalog, modules, disabledTabs, onChange } = props;
  const g = catalog.grantable;
  const canModule = (m: string) => g.full || g.modules.includes(m);
  const canTab = (t: string) => g.full || g.tabs.includes(t);
  const toggleModule = (m: string) => onChange(modules.includes(m) ? modules.filter((x) => x !== m) : [...modules, m], disabledTabs);
  const toggleTab = (t: string) => onChange(modules, disabledTabs.includes(t) ? disabledTabs.filter((x) => x !== t) : [...disabledTabs, t]);
  return (
    <div className="space-y-3">
      <div>
        <div className="text-xs font-medium text-slate-500 mb-1">Modules</div>
        <div className="grid grid-cols-2 gap-1.5">
          {catalog.modules.map((m) => (
            <label key={m} className={`flex items-center gap-2 text-sm ${canModule(m) ? "" : "opacity-40"}`} title={canModule(m) ? "" : "You don't have this module yourself"}>
              <input type="checkbox" disabled={!canModule(m)} checked={modules.includes(m)} onChange={() => toggleModule(m)} />
              {moduleTitle(m)}
            </label>
          ))}
        </div>
      </div>
      {modules.includes(TAB_MODULE) && (
        <div className="rounded-lg border border-slate-200 p-3 animate-fade-in">
          <div className="flex items-center justify-between mb-2">
            <div className="text-xs font-medium text-slate-500">AI Agents — tabs</div>
            <div className="flex gap-2 text-xs">
              <button
                type="button"
                className="text-slate-500 hover:text-slate-900"
                onClick={() => onChange(modules, disabledTabs.filter((t) => !t.startsWith(TAB_MODULE + ".") || !canTab(t)))}
              >
                All on
              </button>
              <button
                type="button"
                className="text-slate-500 hover:text-slate-900"
                onClick={() =>
                  onChange(modules, Array.from(new Set([...disabledTabs, ...catalog.tabs[TAB_MODULE].map((t) => `${TAB_MODULE}.${t.key}`)])))
                }
              >
                All off
              </button>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            {catalog.tabs[TAB_MODULE].map((t) => {
              const key = `${TAB_MODULE}.${t.key}`;
              const can = canTab(key);
              return (
                <label key={key} className={`flex items-center gap-2 text-sm ${can ? "" : "opacity-40"}`} title={can ? "" : "You don't have this tab yourself"}>
                  <input type="checkbox" disabled={!can} checked={can && !disabledTabs.includes(key)} onChange={() => toggleTab(key)} />
                  {t.label}
                </label>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

const inputCls = "border border-slate-300 rounded-md px-3 py-2 text-sm";

function CreateUserModal({ catalog, onClose, onCreated }: { catalog: Catalog; onClose: () => void; onCreated: () => void }) {
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState("user");
  const [modules, setModules] = useState<string[]>([]);
  const [disabledTabs, setDisabledTabs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setError(null);
    setBusy(true);
    try {
      await api("/org/users", {
        method: "POST",
        body: { username, email, firstName, lastName, temporaryPassword: password, role, moduleKeys: modules, disabledTabs },
      });
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to create user.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4 animate-fade-in">
      <div className="bg-white rounded-xl p-6 w-full max-w-lg space-y-3 max-h-[90vh] overflow-auto animate-pop-in">
        <h2 className="font-semibold text-slate-900 text-lg">Create account</h2>
        {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-2">{error}</div>}
        <div className="grid grid-cols-2 gap-3">
          <input placeholder="Username" value={username} onChange={(e) => setUsername(e.target.value)} className={inputCls} />
          <input placeholder="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} className={inputCls} />
          <input placeholder="First name" value={firstName} onChange={(e) => setFirstName(e.target.value)} className={inputCls} />
          <input placeholder="Last name" value={lastName} onChange={(e) => setLastName(e.target.value)} className={inputCls} />
        </div>
        <input placeholder="Temporary password (min 8 characters)" type="password" value={password} onChange={(e) => setPassword(e.target.value)} className={`${inputCls} w-full`} />
        <div>
          <div className="text-xs font-medium text-slate-500 mb-1">Role</div>
          <select value={role} onChange={(e) => setRole(e.target.value)} className={`${inputCls} w-full`}>
            {ROLES.map((r) => (
              <option key={r.key} value={r.key}>{r.label}</option>
            ))}
          </select>
          {role === "company_admin" && (
            <p className="text-xs text-slate-500 mt-1">Admins can manage accounts, but can only grant the modules and tabs you give them here.</p>
          )}
        </div>
        <AccessEditor catalog={catalog} modules={modules} disabledTabs={disabledTabs} onChange={(m, t) => { setModules(m); setDisabledTabs(t); }} />
        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} className="text-sm px-4 py-2 rounded-md border border-slate-300">Cancel</button>
          <button onClick={submit} disabled={busy} className="text-sm px-4 py-2 rounded-md bg-red-600 text-white hover:bg-red-700 disabled:opacity-50">
            {busy ? "Creating..." : "Create account"}
          </button>
        </div>
      </div>
    </div>
  );
}

function EditAccessModal({ catalog, user, onClose, onSaved }: { catalog: Catalog; user: UserRow; onClose: () => void; onSaved: () => void }) {
  const [role, setRole] = useState(user.role);
  const [modules, setModules] = useState<string[]>(user.modules.filter((m) => m.enabled).map((m) => m.moduleKey));
  const [disabledTabs, setDisabledTabs] = useState<string[]>(user.disabled_tabs ?? []);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setError(null);
    setBusy(true);
    try {
      if (role !== user.role) {
        await api(`/org/users/${user.id}/role`, { method: "PATCH", body: { role } });
      }
      await api(`/org/users/${user.id}/access`, { method: "PATCH", body: { modules, disabledTabs } });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to save access.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4 animate-fade-in">
      <div className="bg-white rounded-xl p-6 w-full max-w-lg space-y-3 max-h-[90vh] overflow-auto animate-pop-in">
        <h2 className="font-semibold text-slate-900 text-lg">Access — {user.username ?? user.email}</h2>
        {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-2">{error}</div>}
        <div>
          <div className="text-xs font-medium text-slate-500 mb-1">Role</div>
          <select value={role} onChange={(e) => setRole(e.target.value)} className={`${inputCls} w-full`}>
            {ROLES.map((r) => (
              <option key={r.key} value={r.key}>{r.label}</option>
            ))}
          </select>
        </div>
        <AccessEditor catalog={catalog} modules={modules} disabledTabs={disabledTabs} onChange={(m, t) => { setModules(m); setDisabledTabs(t); }} />
        <p className="text-xs text-slate-400">Changes apply on their next page load.</p>
        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} className="text-sm px-4 py-2 rounded-md border border-slate-300">Cancel</button>
          <button onClick={submit} disabled={busy} className="text-sm px-4 py-2 rounded-md bg-red-600 text-white hover:bg-red-700 disabled:opacity-50">
            {busy ? "Saving..." : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
