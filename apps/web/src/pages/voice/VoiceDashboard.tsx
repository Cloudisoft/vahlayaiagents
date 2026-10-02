import { Link } from "react-router-dom";
import { invalidate, useApi } from "../../lib/useApi.js";
import { K, summaryKey } from "../../lib/voiceKeys.js";
import { StatusPill, btnPrimary, formatPhone, formatSeconds, useOrgEvents } from "../../lib/voice.js";
import BarChart from "../../components/BarChart.js";
import { StatTile, pct, type Summary } from "./Analytics.js";

interface Campaign {
  id: string;
  name: string;
  status: string;
  agent_name: string | null;
  leads_remaining: number;
  live_calls: number;
  total_calls: number;
  connected_calls: number;
  interested_leads: number;
  paused_reason: string | null;
}

interface Callback {
  id: string;
  next_attempt_at: string | null;
  lead_name: string;
  business_name: string | null;
  main_phone_e164: string | null;
  campaign_name: string;
}

export default function VoiceDashboard() {
  const campaignsQ = useApi<{ campaigns: Campaign[] }>(K.campaigns);
  const callbacksQ = useApi<{ callbacks: Callback[] }>(K.callbacks());
  const todayQ = useApi<Summary>(summaryKey(1), { refreshMs: 30_000 });
  const weekQ = useApi<Summary>(summaryKey(7));
  const today = todayQ.data;
  const week = weekQ.data;
  const campaigns = campaignsQ.data?.campaigns ?? [];
  const callbacks = (callbacksQ.data?.callbacks ?? []).slice(0, 6);
  const denied = Boolean(todayQ.error);

  useOrgEvents((e) => {
    if (e.type === "call_ended" || e.type === "campaign_status") {
      invalidate("/voice/insights");
      invalidate(K.campaigns);
    }
  });

  const t = today?.totals;
  const running = campaigns.filter((c) => c.status === "active" || c.status === "scheduled" || c.status === "paused");

  return (
    <div className="max-w-6xl space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Voice AI</h1>
          <p className="text-sm text-slate-500">Today across all campaigns.</p>
        </div>
        <Link to="/voice/campaigns/new" className={btnPrimary}>+ New campaign</Link>
      </div>

      {t && today && (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          <Link to="/voice/live"><StatTile label="Live now" value={today.liveCalls} sub="calls in progress" /></Link>
          <StatTile label="Calls today" value={t.calls.toLocaleString()} />
          <StatTile label="Connect rate" value={pct(t.connected, t.calls)} />
          <StatTile label="Positive" value={t.positive} sub="interested / booked" />
          <StatTile label="Avg talk" value={formatSeconds(t.avg_talk_seconds)} />
          <Link to="/voice/callbacks"><StatTile label="Callbacks due" value={today.callbacksNext24h} sub="next 24 hours" /></Link>
        </div>
      )}
      {denied && <div className="text-sm text-slate-500">Your role can't view call statistics.</div>}

      <div className="grid lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 bg-white border border-slate-200 rounded-xl p-4">
          {week ? (
            <BarChart
              title="Calls, last 7 days"
              unit="calls"
              data={week.daily.map((d) => ({ label: d.day.slice(5), value: d.calls, detail: `${d.connected} connected · ${d.positive} positive` }))}
            />
          ) : (
            <div className="h-[200px]" />
          )}
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="text-sm font-semibold text-slate-900">Upcoming callbacks</div>
            <Link to="/voice/callbacks" className="text-xs text-slate-500 hover:text-slate-900">All →</Link>
          </div>
          <div className="space-y-2">
            {callbacks.map((c) => (
              <div key={c.id} className="text-sm">
                <div className="flex justify-between gap-2">
                  <span className="font-medium text-slate-900 truncate">{c.lead_name}</span>
                  <span className="text-xs text-slate-500 whitespace-nowrap">{c.next_attempt_at ? new Date(c.next_attempt_at).toLocaleString([], { dateStyle: "short", timeStyle: "short" }) : "—"}</span>
                </div>
                <div className="text-xs text-slate-500 truncate">{formatPhone(c.main_phone_e164)} · {c.campaign_name}</div>
              </div>
            ))}
            {callbacks.length === 0 && <div className="text-sm text-slate-400">No callbacks booked.</div>}
          </div>
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl">
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100">
          <div className="text-sm font-semibold text-slate-900">Running campaigns</div>
          <Link to="/voice/campaigns" className="text-xs text-slate-500 hover:text-slate-900">All campaigns →</Link>
        </div>
        <table className="w-full text-sm">
          <thead className="text-xs text-slate-500">
            <tr>
              <th className="text-left font-medium px-4 py-2">Campaign</th>
              <th className="text-left font-medium px-4 py-2">Status</th>
              <th className="text-right font-medium px-4 py-2">Live</th>
              <th className="text-right font-medium px-4 py-2">Left to call</th>
              <th className="text-right font-medium px-4 py-2">Connect</th>
              <th className="text-right font-medium px-4 py-2">Interested</th>
            </tr>
          </thead>
          <tbody>
            {running.map((c) => (
              <tr key={c.id} className="border-t border-slate-100 hover:bg-slate-50">
                <td className="px-4 py-2">
                  <Link to={`/voice/campaigns/${c.id}`} className="font-medium text-slate-900 hover:underline">{c.name}</Link>
                  <div className="text-xs text-slate-500">{c.agent_name ?? "No agent"}</div>
                  {c.paused_reason && <div className="text-xs text-amber-700">{c.paused_reason}</div>}
                </td>
                <td className="px-4 py-2"><StatusPill status={c.status} /></td>
                <td className="px-4 py-2 text-right tabular-nums">{c.live_calls}</td>
                <td className="px-4 py-2 text-right tabular-nums">{c.leads_remaining}</td>
                <td className="px-4 py-2 text-right tabular-nums">{pct(c.connected_calls, c.total_calls)}</td>
                <td className="px-4 py-2 text-right tabular-nums">{c.interested_leads}</td>
              </tr>
            ))}
            {running.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-6 text-center text-slate-400">No campaign is running. <Link to="/voice/campaigns" className="text-red-600 hover:underline">Start one</Link>.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
