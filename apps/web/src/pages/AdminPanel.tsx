import { useEffect, useState } from "react";
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
  modules: Array<{ moduleKey: string; enabled: boolean }>;
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

  async function load() {
    const { users } = await api<{ users: UserRow[] }>("/org/users");
    setUsers(users);
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
          <p className="text-sm text-slate-500">Manage users, roles, and module access</p>
        </div>
        <button onClick={() => setShowCreate(true)} className="bg-red-600 text-white text-sm font-medium rounded-md px-4 py-2 hover:bg-red-700">
          + Create User
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
                <td className="px-4 py-3 font-medium text-slate-900">{u.username ?? u.email}</td>
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
                  {u.role === "super_admin" || u.role === "company_admin" ? (
                    <span className="text-xs bg-slate-100 text-slate-600 rounded-full px-2 py-0.5">All</span>
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
                    </div>
                  )}
                </td>
                <td className="px-4 py-3">
                  <div className="flex justify-end gap-2 text-slate-400">
                    <button title="Edit role & modules" onClick={() => setEditingAccess(u)} className="hover:text-red-600">
                      🛡️
                    </button>
                    <button title="Reset password" onClick={() => resetPassword(u)} className="hover:text-red-600">
                      🔑
                    </button>
                    <button title={u.is_active ? "Disable" : "Enable"} onClick={() => toggleStatus(u)} className="hover:text-red-600">
                      {u.is_active ? "🟢" : "⚪"}
                    </button>
                    <button title="Delete" onClick={() => deleteUser(u)} className="hover:text-red-600">
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

      {showCreate && (
        <CreateUserModal
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            load();
          }}
        />
      )}
      {editingAccess && (
        <EditAccessModal
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

function CreateUserModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState("user");
  const [moduleKeys, setModuleKeys] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function toggleModule(key: string) {
    setModuleKeys((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  }

  async function submit() {
    setError(null);
    setBusy(true);
    try {
      await api("/org/users", {
        method: "POST",
        body: { username, email, firstName, lastName, temporaryPassword: password, role, moduleKeys },
      });
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to create user.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl p-6 w-full max-w-md space-y-3">
        <h2 className="font-semibold text-slate-900 text-lg">Create User</h2>
        {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-2">{error}</div>}
        <div className="grid grid-cols-2 gap-3">
          <input placeholder="Username" value={username} onChange={(e) => setUsername(e.target.value)} className="border border-slate-300 rounded-md px-3 py-2 text-sm" />
          <input placeholder="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="border border-slate-300 rounded-md px-3 py-2 text-sm" />
          <input placeholder="First name" value={firstName} onChange={(e) => setFirstName(e.target.value)} className="border border-slate-300 rounded-md px-3 py-2 text-sm" />
          <input placeholder="Last name" value={lastName} onChange={(e) => setLastName(e.target.value)} className="border border-slate-300 rounded-md px-3 py-2 text-sm" />
        </div>
        <input placeholder="Temporary password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm" />
        <select value={role} onChange={(e) => setRole(e.target.value)} className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm">
          {ROLES.map((r) => (
            <option key={r.key} value={r.key}>{r.label}</option>
          ))}
        </select>
        <div>
          <div className="text-xs text-slate-500 mb-1">Module access</div>
          <div className="grid grid-cols-2 gap-1">
            {MODULES.map((m) => (
              <label key={m.key} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={moduleKeys.includes(m.key)} onChange={() => toggleModule(m.key)} />
                {moduleTitle(m.key)}
              </label>
            ))}
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} className="text-sm px-4 py-2 rounded-md border border-slate-300">Cancel</button>
          <button onClick={submit} disabled={busy} className="text-sm px-4 py-2 rounded-md bg-red-600 text-white hover:bg-red-700 disabled:opacity-50">
            {busy ? "Creating..." : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}

function EditAccessModal({ user, onClose, onSaved }: { user: UserRow; onClose: () => void; onSaved: () => void }) {
  const [role, setRole] = useState(user.role);
  const [moduleKeys, setModuleKeys] = useState<string[]>(user.modules.filter((m) => m.enabled).map((m) => m.moduleKey));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function toggleModule(key: string) {
    setModuleKeys((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  }

  async function submit() {
    setError(null);
    setBusy(true);
    try {
      if (role !== user.role) {
        await api(`/org/users/${user.id}/role`, { method: "PATCH", body: { role } });
      }
      await api(`/org/users/${user.id}/modules`, {
        method: "PATCH",
        body: { modules: MODULES.map((m) => ({ moduleKey: m.key, enabled: moduleKeys.includes(m.key) })) },
      });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to save access.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl p-6 w-full max-w-md space-y-3">
        <h2 className="font-semibold text-slate-900 text-lg">Edit access — {user.username ?? user.email}</h2>
        {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-2">{error}</div>}
        <select value={role} onChange={(e) => setRole(e.target.value)} className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm">
          {ROLES.map((r) => (
            <option key={r.key} value={r.key}>{r.label}</option>
          ))}
        </select>
        <div>
          <div className="text-xs text-slate-500 mb-1">Module access</div>
          <div className="grid grid-cols-2 gap-1">
            {MODULES.map((m) => (
              <label key={m.key} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={moduleKeys.includes(m.key)} onChange={() => toggleModule(m.key)} />
                {moduleTitle(m.key)}
              </label>
            ))}
          </div>
        </div>
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
