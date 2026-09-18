import { useAuth } from "../context/AuthContext.js";

export default function Dashboard() {
  const { user } = useAuth();
  return (
    <div>
      <h1 className="text-2xl font-semibold text-slate-900 mb-1">
        Welcome{user?.first_name ? `, ${user.first_name}` : ""}
      </h1>
      <p className="text-sm text-slate-500 mb-8">{user?.organization_name}</p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {[
          { name: "VahlayHR", desc: "AI recruitment, resume evaluation, AI interviews.", status: "Phase 2" },
          { name: "Vahlay Coverage", desc: "US carrier lookup and verification.", status: "Phase 3" },
          { name: "Vahlay LeadGen", desc: "US B2B lead discovery and enrichment.", status: "Phase 4" },
          { name: "Vahlay Voice AI", desc: "AI calling platform and Call Auditor.", status: "Phase 5-7" },
        ].map((m) => (
          <div key={m.name} className="bg-white border border-slate-200 rounded-xl p-5">
            <div className="flex items-center justify-between mb-1">
              <h2 className="font-medium text-slate-900">{m.name}</h2>
              <span className="text-xs bg-slate-100 text-slate-600 rounded-full px-2 py-0.5">{m.status}</span>
            </div>
            <p className="text-sm text-slate-500">{m.desc}</p>
          </div>
        ))}
      </div>

      <div className="mt-8 bg-white border border-slate-200 rounded-xl p-5">
        <h2 className="font-medium text-slate-900 mb-2">Phase 1 — what's live now</h2>
        <ul className="text-sm text-slate-600 list-disc pl-5 space-y-1">
          <li>Authentication, organizations, roles, sessions</li>
          <li>Server-enforced authorization and org-level data isolation</li>
          <li>File storage (local disk in dev, S3-compatible in production)</li>
          <li>Encrypted provider credential storage (Settings)</li>
          <li>Background job queue harness (enable by setting REDIS_URL)</li>
          <li>Plivo telephony adapter behind a provider-agnostic interface</li>
        </ul>
      </div>
    </div>
  );
}
