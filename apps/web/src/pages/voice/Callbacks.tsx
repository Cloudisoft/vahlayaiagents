import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../../lib/api.js";
import { useApi } from "../../lib/useApi.js";
import { K } from "../../lib/voiceKeys.js";
import { StatusPill, btnGhost, formatPhone, useCan } from "../../lib/voice.js";

interface Callback {
  id: string;
  status: string;
  next_attempt_at: string | null;
  last_disposition: string;
  attempts: number;
  campaign_id: string;
  campaign_name: string;
  campaign_status: string;
  lead_name: string;
  business_name: string | null;
  main_phone_e164: string | null;
  state: string | null;
  time_zone: string | null;
  last_call_id: string | null;
  last_summary: string | null;
}

function localTime(iso: string | null, tz: string | null) {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleString([], { timeZone: tz ?? undefined, dateStyle: "medium", timeStyle: "short" });
  } catch {
    return null;
  }
}

export default function Callbacks() {
  const can = useCan();
  const [scope, setScope] = useState<"upcoming" | "done">("upcoming");
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const cbQ = useApi<{ callbacks: Callback[] }>(K.callbacks(scope));
  const rows = cbQ.data?.callbacks ?? [];
  const load = () => cbQ.reload();

  async function act(id: string, action: "call-now" | "cancel") {
    if (action === "cancel" && !confirm("Cancel this callback? The lead won't be called again by this campaign.")) return;
    setNotice(null);
    try {
      const r = await api<{ message?: string }>(`/voice/insights/callbacks/${id}/${action}`, { method: "POST" });
      setNotice({ ok: true, text: r.message ?? "Callback cancelled." });
      await load();
    } catch (err) {
      setNotice({ ok: false, text: err instanceof ApiError ? err.message : "Request failed." });
    }
  }

  const now = Date.now();
  return (
    <div className="max-w-6xl space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-slate-900">Callbacks</h1>
        <div className="flex rounded-md border border-slate-300 overflow-hidden text-sm">
          {(["upcoming", "done"] as const).map((s) => (
            <button key={s} onClick={() => setScope(s)} className={`px-3 py-2 capitalize ${scope === s ? "bg-slate-900 text-white" : "bg-white text-slate-600"}`}>
              {s === "done" ? "Completed" : "Upcoming"}
            </button>
          ))}
        </div>
      </div>
      <p className="text-sm text-slate-500">
        Callbacks the agent booked (CALLBK). The dialer calls each lead at the booked time in the lead's own time zone, as long as the campaign is running.
      </p>
      {notice && <div className={`text-sm rounded-md p-2 border ${notice.ok ? "text-green-700 bg-green-50 border-green-200" : "text-red-600 bg-red-50 border-red-200"}`}>{notice.text}</div>}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-500 text-xs uppercase">
            <tr>
              <th className="text-left px-4 py-2">When</th>
              <th className="text-left px-4 py-2">Lead</th>
              <th className="text-left px-4 py-2">Campaign</th>
              <th className="text-left px-4 py-2">Last call</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => {
              const due = c.next_attempt_at ? new Date(c.next_attempt_at).getTime() : null;
              const overdue = scope === "upcoming" && due !== null && due < now;
              return (
                <tr key={c.id} className="border-t border-slate-100 align-top">
                  <td className="px-4 py-3 whitespace-nowrap">
                    <div className={`font-medium ${overdue ? "text-amber-700" : "text-slate-900"}`}>
                      {c.next_attempt_at ? new Date(c.next_attempt_at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "—"}
                    </div>
                    {c.time_zone && <div className="text-xs text-slate-500">{localTime(c.next_attempt_at, c.time_zone)} lead time</div>}
                    {overdue && <div className="text-xs text-amber-700">Overdue</div>}
                  </td>
                  <td className="px-4 py-3">
                    <div className="font-medium text-slate-900">{c.lead_name}</div>
                    <div className="text-xs text-slate-500">{c.business_name} · {formatPhone(c.main_phone_e164)}</div>
                  </td>
                  <td className="px-4 py-3">
                    <Link to={`/voice/campaigns/${c.campaign_id}`} className="text-slate-900 hover:underline">{c.campaign_name}</Link>
                    <div className="mt-1"><StatusPill status={c.campaign_status} /></div>
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-600 max-w-sm">{c.last_summary ?? "—"}</td>
                  <td className="px-4 py-3 text-right whitespace-nowrap">
                    {scope === "upcoming" && can("campaign.start") && (
                      <div className="flex justify-end gap-2">
                        <button onClick={() => act(c.id, "call-now")} className={btnGhost}>Call now</button>
                        <button onClick={() => act(c.id, "cancel")} className="text-xs text-slate-500 hover:text-red-600 px-2">Cancel</button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-slate-400">{scope === "upcoming" ? "No callbacks scheduled." : "No completed callbacks yet."}</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
