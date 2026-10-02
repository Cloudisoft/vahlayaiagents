import { useState } from "react";
import { useApi } from "../../lib/useApi.js";
import { K, summaryKey } from "../../lib/voiceKeys.js";
import BarChart from "../../components/BarChart.js";
import { DispositionBadge, formatSeconds, inputCls } from "../../lib/voice.js";

export interface Summary {
  days: number;
  totals: {
    calls: number;
    connected: number;
    conversations: number;
    voicemails: number;
    transfers: number;
    positive: number;
    dnc: number;
    talk_seconds: number;
    avg_talk_seconds: number | null;
    cost_usd: number;
  };
  daily: Array<{ day: string; calls: number; connected: number; positive: number }>;
  dispositions: Array<{ key: string; label: string; color: string; count: number }>;
  campaigns: Array<{ id: string; name: string; status: string; calls: number; connected: number; positive: number; avg_talk_seconds: number | null }>;
  hours: Array<{ hour: number; calls: number; connected: number }>;
  liveCalls: number;
  callbacksNext24h: number;
}

export const pct = (n: number, d: number) => (d > 0 ? `${Math.round((n / d) * 100)}%` : "—");

export function StatTile({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="bg-white border border-slate-200 rounded-xl p-4">
      <div className="text-xs font-medium text-slate-500">{label}</div>
      <div className="text-2xl font-semibold text-slate-900 mt-1 tabular-nums">{value}</div>
      {sub && <div className="text-xs text-slate-500 mt-0.5">{sub}</div>}
    </div>
  );
}


function hourLabel(h: number) {
  return `${h % 12 || 12}${h < 12 ? "a" : "p"}`;
}

export default function Analytics() {
  const [days, setDays] = useState(7);
  const [campaignId, setCampaignId] = useState("");
  const campaignsQ = useApi<{ campaigns: Array<{ id: string; name: string }> }>(K.campaigns);
  const summaryQ = useApi<Summary>(summaryKey(days, campaignId));
  const campaigns = campaignsQ.data?.campaigns ?? [];
  const data = summaryQ.data ?? null;
  const error = summaryQ.error;

  const t = data?.totals;
  const maxDisp = Math.max(1, ...(data?.dispositions.map((d) => d.count) ?? [1]));

  return (
    <div className="max-w-6xl space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-2xl font-semibold text-slate-900">Analytics</h1>
        <div className="flex flex-wrap gap-2">
          <select value={campaignId} onChange={(e) => setCampaignId(e.target.value)} className={`${inputCls} w-56`}>
            <option value="">All campaigns</option>
            {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <div className="flex shrink-0 rounded-md border border-slate-300 overflow-hidden text-sm">
            {[1, 7, 30, 90].map((d) => (
              <button key={d} onClick={() => setDays(d)} className={`px-3 py-2 ${days === d ? "bg-slate-900 text-white" : "bg-white text-slate-600 hover:bg-slate-50"}`}>
                {d === 1 ? "Today" : `${d}d`}
              </button>
            ))}
          </div>
        </div>
      </div>
      {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-2">{error}</div>}
      {t && data && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
            <StatTile label="Calls" value={t.calls.toLocaleString()} />
            <StatTile label="Connected" value={pct(t.connected, t.calls)} sub={`${t.connected.toLocaleString()} answered`} />
            <StatTile label="Conversations" value={t.conversations.toLocaleString()} sub="10s+ with the customer" />
            <StatTile label="Positive" value={t.positive.toLocaleString()} sub={`${pct(t.positive, t.conversations)} of conversations`} />
            <StatTile label="Avg talk" value={formatSeconds(t.avg_talk_seconds)} sub={`${Math.round(t.talk_seconds / 60).toLocaleString()} min total`} />
            <StatTile label="VAPI cost" value={`$${t.cost_usd.toFixed(2)}`} sub={t.calls ? `$${(t.cost_usd / t.calls).toFixed(3)} per call` : undefined} />
          </div>

          <div className="grid lg:grid-cols-2 gap-4">
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <BarChart
                title="Calls per day"
                unit="calls"
                data={data.daily.map((d) => ({
                  label: d.day.slice(5),
                  value: d.calls,
                  detail: `${d.connected} connected · ${d.positive} positive`,
                }))}
              />
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <BarChart
                title="Calls by hour of day"
                unit="calls"
                data={data.hours.map((h) => ({ label: hourLabel(h.hour), value: h.calls, detail: `${pct(h.connected, h.calls)} connected` }))}
              />
            </div>
          </div>

          <div className="grid lg:grid-cols-2 gap-4">
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <div className="text-sm font-semibold text-slate-900 mb-3">Results</div>
              <div className="space-y-2">
                {data.dispositions.map((d) => (
                  <div key={d.key} className="grid grid-cols-[170px_1fr_70px] items-center gap-3 text-sm">
                    <DispositionBadge code={d.key} label={d.label} color={d.color} />
                    <div className="h-2 rounded-full bg-slate-100">
                      <div className="h-2 rounded-full bg-slate-700" style={{ width: `${(d.count / maxDisp) * 100}%` }} />
                    </div>
                    <div className="text-right tabular-nums text-slate-700">
                      {d.count} <span className="text-xs text-slate-400">{pct(d.count, t.calls)}</span>
                    </div>
                  </div>
                ))}
                {data.dispositions.length === 0 && <div className="text-sm text-slate-400">No results yet.</div>}
              </div>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <div className="text-sm font-semibold text-slate-900 mb-3">By campaign</div>
              <table className="w-full text-sm">
                <thead className="text-xs text-slate-500">
                  <tr>
                    <th className="text-left font-medium pb-2">Campaign</th>
                    <th className="text-right font-medium pb-2">Calls</th>
                    <th className="text-right font-medium pb-2">Connect</th>
                    <th className="text-right font-medium pb-2">Positive</th>
                    <th className="text-right font-medium pb-2">Avg talk</th>
                  </tr>
                </thead>
                <tbody>
                  {data.campaigns.map((c) => (
                    <tr key={c.id} className="border-t border-slate-100">
                      <td className="py-1.5 text-slate-900">{c.name}</td>
                      <td className="py-1.5 text-right tabular-nums">{c.calls}</td>
                      <td className="py-1.5 text-right tabular-nums">{pct(c.connected, c.calls)}</td>
                      <td className="py-1.5 text-right tabular-nums">{c.positive}</td>
                      <td className="py-1.5 text-right tabular-nums">{formatSeconds(c.avg_talk_seconds)}</td>
                    </tr>
                  ))}
                  {data.campaigns.length === 0 && (
                    <tr><td colSpan={5} className="py-4 text-center text-slate-400">No campaign calls in this period.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
