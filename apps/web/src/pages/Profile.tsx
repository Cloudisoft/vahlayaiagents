import { useAuth } from "../context/AuthContext.js";

const ROLE_LABELS: Record<string, string> = {
  super_admin: "Global Admin",
  company_admin: "Admin",
  hr: "HR",
  recruiter: "Recruiter",
  agent_manager: "Agent Manager",
  user: "User",
};

export default function Profile() {
  const { user } = useAuth();
  if (!user) return null;

  return (
    <div className="max-w-lg">
      <h1 className="text-2xl font-semibold text-slate-900 mb-6">Profile</h1>
      <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
        <div className="flex items-center gap-4">
          <div className="w-14 h-14 rounded-full bg-red-50 text-red-600 flex items-center justify-center text-2xl">👤</div>
          <div>
            <div className="font-semibold text-slate-900">
              {user.first_name} {user.last_name}
            </div>
            <div className="text-sm text-red-600">{ROLE_LABELS[user.role] ?? user.role}</div>
          </div>
        </div>
        <dl className="text-sm space-y-2 pt-2 border-t border-slate-100">
          <div className="flex justify-between">
            <dt className="text-slate-500">Username</dt>
            <dd className="text-slate-900">{user.username ?? "—"}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-slate-500">Email</dt>
            <dd className="text-slate-900">{user.email}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-slate-500">Organization</dt>
            <dd className="text-slate-900">{user.organization_name}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-slate-500">Module access</dt>
            <dd className="text-slate-900">{user.enabled_modules?.length ? user.enabled_modules.join(", ") : "All (admin)"}</dd>
          </div>
        </dl>
      </div>
    </div>
  );
}
