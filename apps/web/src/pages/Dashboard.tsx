import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext.js";
import { api } from "../lib/api.js";

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

function Kpi({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <div className="text-xs text-slate-500">{label}</div>
      <div className="text-lg font-semibold text-slate-900">{value}</div>
    </div>
  );
}

export default function Dashboard() {
  const { user } = useAuth();
  const [data, setData] = useState<DashboardData | null>(null);

  useEffect(() => {
    api<DashboardData>("/dashboard").then(setData);
  }, []);

  return (
    <div>
      <h1 className="text-2xl font-semibold text-slate-900 mb-1">
        Welcome{user?.first_name ? `, ${user.first_name}` : ""}
      </h1>
      <p className="text-sm text-slate-500 mb-8">{user?.organization_name}</p>

      {!data ? (
        <div className="text-sm text-slate-500">Loading...</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Link to="/hr" className="bg-white border border-slate-200 rounded-xl p-5 hover:border-indigo-300">
            <h2 className="font-medium text-slate-900 mb-3">VahlayHR</h2>
            <div className="grid grid-cols-3 gap-3">
              <Kpi label="Open jobs" value={data.hr.open_jobs} />
              <Kpi label="Applications" value={data.hr.applications} />
              <Kpi label="Qualified" value={data.hr.qualified} />
              <Kpi label="Rejected" value={data.hr.rejected} />
              <Kpi label="Interviews" value={data.hr.interviews} />
              <Kpi label="Avg score" value={data.hr.avg_score ?? "—"} />
            </div>
          </Link>

          <Link to="/coverage" className="bg-white border border-slate-200 rounded-xl p-5 hover:border-indigo-300">
            <h2 className="font-medium text-slate-900 mb-3">Vahlay Coverage</h2>
            <div className="grid grid-cols-3 gap-3">
              <Kpi label="Lookups" value={data.coverage.totalPredictions} />
              <Kpi label="Verified" value={data.coverage.verifiedPredictions} />
              <Kpi
                label="Accuracy"
                value={data.coverage.observedAccuracy === null ? "—" : `${(data.coverage.observedAccuracy * 100).toFixed(0)}%`}
              />
              <Kpi label="Spend" value={`$${data.coverage.budget.spentUsd.toFixed(2)}`} />
              <Kpi label="Budget left" value={`$${data.coverage.budget.remainingUsd.toFixed(2)}`} />
            </div>
          </Link>

          <Link to="/leadgen" className="bg-white border border-slate-200 rounded-xl p-5 hover:border-indigo-300">
            <h2 className="font-medium text-slate-900 mb-3">Vahlay LeadGen</h2>
            <div className="grid grid-cols-3 gap-3">
              <Kpi label="Leads" value={data.leadgen.leads_discovered} />
              <Kpi label="Enriched" value={data.leadgen.leads_enriched} />
              <Kpi label="Valid" value={data.leadgen.valid_leads} />
              <Kpi label="Avg quality" value={data.leadgen.avg_quality ?? "—"} />
              <Kpi label="Lists" value={data.leadgen.lead_lists} />
            </div>
          </Link>

          <Link to="/voice" className="bg-white border border-slate-200 rounded-xl p-5 hover:border-indigo-300">
            <h2 className="font-medium text-slate-900 mb-3">Vahlay Voice AI</h2>
            <div className="grid grid-cols-3 gap-3">
              <Kpi label="Calls today" value={data.voice.calls_today} />
              <Kpi label="Calls this week" value={data.voice.calls_week} />
              <Kpi label="Connected" value={data.voice.connected} />
              <Kpi label="Avg duration" value={data.voice.avg_duration ? `${data.voice.avg_duration}s` : "—"} />
              <Kpi label="Appointments" value={data.voice.appointments} />
              <Kpi label="Active now" value={data.voice.active_calls} />
            </div>
          </Link>

          <Link to="/voice/auditor" className="bg-white border border-slate-200 rounded-xl p-5 hover:border-indigo-300 md:col-span-2">
            <h2 className="font-medium text-slate-900 mb-3">AI Call Auditor</h2>
            <div className="grid grid-cols-3 gap-3">
              <Kpi label="Calls audited" value={data.auditor.audited} />
              <Kpi label="Avg score" value={data.auditor.avg_score ?? "—"} />
            </div>
          </Link>
        </div>
      )}
    </div>
  );
}
