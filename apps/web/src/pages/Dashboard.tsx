import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext.js";
import { api } from "../lib/api.js";
import { MODULES } from "../lib/modules.js";

interface DashboardData {
  hr: { open_jobs: string; applications: string; qualified: string; rejected: string; interviews: string; avg_score: string | null };
  coverage: {
    totalPredictions: number;
    verifiedPredictions: number;
    observedAccuracy: number | null;
    budget: { budgetUsd: number; spentUsd: number; remainingUsd: number };
  };
  leadgen: { leads_discovered: string; leads_enriched: string; valid_leads: string; avg_quality: string | null; lead_lists: string };
  voice: {
    calls_today: string;
    calls_week: string;
    connected: string;
    avg_duration: string | null;
    appointments: string;
    transfers: string;
    interested: string;
    active_calls: string;
  };
  auditor: { audited: string; avg_score: string | null };
}

const SUMMARY: Record<string, (d: DashboardData) => string> = {
  hr: (d) => `${d.hr.open_jobs} open jobs · ${d.hr.applications} applications`,
  coverage: (d) => `${d.coverage.totalPredictions} lookups · $${d.coverage.budget.remainingUsd.toFixed(2)} budget left`,
  leadgen: (d) => `${d.leadgen.leads_discovered} leads · ${d.leadgen.lead_lists} lists`,
  voice_agents: (d) => `${d.voice.calls_today} calls today · ${d.voice.active_calls} active now`,
  call_auditor: (d) => `${d.auditor.audited} calls audited`,
};

export default function Dashboard() {
  const { user } = useAuth();
  const [data, setData] = useState<DashboardData | null>(null);
  const [orgEnabled, setOrgEnabled] = useState<string[] | null>(null);
  const [busyModule, setBusyModule] = useState<string | null>(null);
  const isAdmin = user?.role === "super_admin" || user?.role === "company_admin";

  useEffect(() => {
    api<DashboardData>("/dashboard").then(setData);
  }, []);

  useEffect(() => {
    if (user) setOrgEnabled(user.organization_settings?.enabledModules ?? MODULES.map((m) => m.key));
  }, [user]);

  async function toggleOrgModule(moduleKey: string, enabled: boolean) {
    if (!orgEnabled) return;
    setBusyModule(moduleKey);
    const next = enabled ? Array.from(new Set([...orgEnabled, moduleKey])) : orgEnabled.filter((k) => k !== moduleKey);
    try {
      await api("/org", { method: "PATCH", body: { settings: { ...(user?.organization_settings ?? {}), enabledModules: next } } });
      setOrgEnabled(next);
    } finally {
      setBusyModule(null);
    }
  }

  const hasUserAccess = (moduleKey: string) => isAdmin || (user?.enabled_modules ?? []).includes(moduleKey);

  return (
    <div>
      <h1 className="text-4xl font-extrabold text-slate-900 mb-3">
        One Command Center. <span className="text-red-600">Every AI Operation.</span>
      </h1>
      <p className="text-slate-500 max-w-2xl mb-1">
        VahlaySmartAI centralizes hiring intelligence, AI calling agents, service intelligence, and lead
        generation into a single operational platform — built for speed, scale, and control.
      </p>
      <p className="text-sm text-slate-400 max-w-2xl mb-8">
        Replace fragmented tools with a unified AI command layer for modern consulting operations.
      </p>

      <div className="flex items-center gap-2 mb-4">
        <div className="w-1 h-5 bg-red-600 rounded" />
        <h2 className="text-lg font-semibold text-slate-900">AI Operations</h2>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        {MODULES.map((m) => {
          const orgOn = orgEnabled?.includes(m.key) ?? true;
          const userOk = hasUserAccess(m.key);
          const usable = orgOn && userOk;
          return (
            <div key={m.key} className="bg-white border border-slate-200 rounded-2xl p-5 flex flex-col">
              <div className="flex items-start justify-between mb-3">
                <div className="w-10 h-10 rounded-lg bg-red-50 flex items-center justify-center text-xl">{m.icon}</div>
                <span
                  className={`text-xs rounded-full px-2 py-0.5 ${
                    orgOn ? "bg-red-50 text-red-600" : "bg-slate-100 text-slate-500"
                  }`}
                >
                  ● {orgOn ? "Active" : "Disabled"}
                </span>
              </div>
              <h3 className="font-semibold text-slate-900">{m.title}</h3>
              <p className="text-xs font-medium text-red-600 mb-2">{m.subtitle}</p>
              <p className="text-sm text-slate-500 flex-1">{m.description}</p>
              {data && (
                <p className="text-xs text-slate-400 mt-3 border-t border-slate-100 pt-2">{SUMMARY[m.key]?.(data)}</p>
              )}

              {!userOk && orgOn && (
                <p className="text-xs text-amber-600 mt-2">You don't have access — ask your admin.</p>
              )}

              <Link
                to={m.route}
                aria-disabled={!usable}
                onClick={(e) => {
                  if (!usable) e.preventDefault();
                }}
                className={`mt-4 rounded-lg py-2 text-sm font-semibold text-center flex items-center justify-center gap-1 ${
                  usable ? "bg-red-600 text-white hover:bg-red-700" : "bg-slate-100 text-slate-400 cursor-not-allowed"
                }`}
              >
                Enter {m.title.replace("Vahlay", "").replace("Smart", "").trim()} →
              </Link>

              {isAdmin && (
                <label className="flex items-center justify-between mt-4 pt-3 border-t border-slate-100 text-sm">
                  <span className="text-slate-600">Enabled</span>
                  <button
                    role="switch"
                    aria-checked={orgOn}
                    disabled={busyModule === m.key}
                    onClick={() => toggleOrgModule(m.key, !orgOn)}
                    className={`w-10 h-6 rounded-full transition-colors relative ${orgOn ? "bg-red-600" : "bg-slate-300"}`}
                  >
                    <span
                      className={`absolute top-0.5 w-5 h-5 bg-white rounded-full transition-transform ${
                        orgOn ? "translate-x-4" : "translate-x-0.5"
                      }`}
                    />
                  </button>
                </label>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
