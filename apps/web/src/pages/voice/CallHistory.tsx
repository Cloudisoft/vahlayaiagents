import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError, getAccessToken } from "../../lib/api.js";
import { DispositionBadge, btnGhost, formatPhone, formatSeconds, inputCls, useCan } from "../../lib/voice.js";

interface CallRow {
  id: string;
  status: string;
  direction: string;
  to_number: string | null;
  from_number: string | null;
  created_at: string;
  duration_seconds: number | null;
  talk_seconds: number | null;
  ended_reason: string | null;
  disposition_key: string | null;
  disposition_label: string | null;
  disposition_color: string | null;
  disposition_source: string;
  evaluation_score: number | null;
  lead_name: string | null;
  business_name: string | null;
  agent_name: string | null;
  campaign_name: string | null;
}

interface Disposition {
  key: string;
  label: string;
  color: string;
}

const EMPTY_FILTERS = { campaignId: "", disposition: "", direction: "", phone: "", q: "", dateFrom: "", dateTo: "", minTalk: "" };

export default function CallHistory() {
  const can = useCan();
  const [calls, setCalls] = useState<CallRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [applied, setApplied] = useState(EMPTY_FILTERS);
  const [campaigns, setCampaigns] = useState<Array<{ id: string; name: string }>>([]);
  const [dispositions, setDispositions] = useState<Disposition[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pageSize = 50;

  function query(f = applied) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(f)) if (v) q.set(k, v);
    return q;
  }

  async function load() {
    try {
      const q = query();
      q.set("page", String(page));
      q.set("pageSize", String(pageSize));
      const r = await api<{ calls: CallRow[]; total: number }>(`/voice/calls?${q}`);
      setCalls(r.calls);
      setTotal(r.total);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load calls.");
    }
  }

  useEffect(() => {
    load();
  }, [applied, page]);

  useEffect(() => {
    api<{ campaigns: Array<{ id: string; name: string }> }>("/voice/campaigns").then((r) => setCampaigns(r.campaigns));
    api<{ dispositions: Disposition[] }>("/voice/dispositions").then((r) => setDispositions(r.dispositions));
  }, []);

  async function exportCsv() {
    const res = await fetch(`/api/voice/calls/export?${query()}`, {
      credentials: "include",
      headers: { Authorization: `Bearer ${getAccessToken()}` },
    });
    if (!res.ok) {
      setError((await res.json().catch(() => ({ error: "Export failed." }))).error);
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `call-records-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const f = filters;
  const setF = (k: keyof typeof EMPTY_FILTERS, v: string) => setFilters({ ...filters, [k]: v });

  return (
    <div className="max-w-7xl space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <Link to="/voice" className="text-xs text-slate-500 hover:text-slate-700">← Voice AI</Link>
          <h1 className="text-2xl font-semibold text-slate-900">Call Records</h1>
        </div>
        {can("cdr.export") && <button onClick={exportCsv} className={btnGhost}>Export CSV</button>}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          setPage(1);
          setApplied(filters);
        }}
        className="bg-white border border-slate-200 rounded-xl p-3 grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-2 items-end"
      >
        <input value={f.phone} onChange={(e) => setF("phone", e.target.value)} placeholder="Phone (any format)" className={inputCls} />
        <input value={f.q} onChange={(e) => setF("q", e.target.value)} placeholder="Search transcripts" className={inputCls} />
        <select value={f.campaignId} onChange={(e) => setF("campaignId", e.target.value)} className={inputCls}>
          <option value="">All campaigns</option>
          {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select value={f.disposition} onChange={(e) => setF("disposition", e.target.value)} className={inputCls}>
          <option value="">All results</option>
          {dispositions.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
        </select>
        <select value={f.direction} onChange={(e) => setF("direction", e.target.value)} className={inputCls}>
          <option value="">In + out</option>
          <option value="outbound">Outbound</option>
          <option value="inbound">Inbound</option>
        </select>
        <select value={f.minTalk} onChange={(e) => setF("minTalk", e.target.value)} className={inputCls}>
          <option value="">Any talk time</option>
          <option value="10">10s+</option>
          <option value="30">30s+</option>
          <option value="60">1 min+</option>
          <option value="180">3 min+</option>
        </select>
        <input type="date" value={f.dateFrom} onChange={(e) => setF("dateFrom", e.target.value)} className={inputCls} title="From" />
        <input type="date" value={f.dateTo} onChange={(e) => setF("dateTo", e.target.value)} className={inputCls} title="To" />
        <div className="col-span-full flex gap-2 justify-end">
          <button type="button" onClick={() => { setFilters(EMPTY_FILTERS); setApplied(EMPTY_FILTERS); setPage(1); }} className="text-sm text-slate-500 px-2">Clear</button>
          <button className="bg-slate-900 text-white text-sm rounded-md px-4 py-2">Apply</button>
        </div>
      </form>

      {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-2">{error}</div>}

      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-500 text-xs uppercase">
            <tr>
              <th className="text-left px-3 py-2">When</th>
              <th className="text-left px-3 py-2">Lead</th>
              <th className="text-left px-3 py-2">Number</th>
              <th className="text-left px-3 py-2">Campaign</th>
              <th className="text-left px-3 py-2">Result</th>
              <th className="text-left px-3 py-2">Talk</th>
              <th className="text-left px-3 py-2">Score</th>
            </tr>
          </thead>
          <tbody>
            {calls.map((c) => (
              <tr key={c.id} onClick={() => setOpenId(c.id)} className={`border-t border-slate-100 cursor-pointer ${openId === c.id ? "bg-red-50" : "hover:bg-slate-50"}`}>
                <td className="px-3 py-2 text-slate-600 whitespace-nowrap">{new Date(c.created_at).toLocaleString()}</td>
                <td className="px-3 py-2">
                  <div className="font-medium text-slate-900">{c.lead_name ?? "—"}</div>
                  {c.business_name && c.business_name !== c.lead_name && <div className="text-xs text-slate-500">{c.business_name}</div>}
                </td>
                <td className="px-3 py-2 text-slate-600 whitespace-nowrap">
                  {c.direction === "inbound" ? "← " : ""}
                  {formatPhone(c.direction === "inbound" ? c.from_number : c.to_number)}
                </td>
                <td className="px-3 py-2 text-slate-500">{c.campaign_name ?? "—"}</td>
                <td className="px-3 py-2">
                  {c.disposition_label ? (
                    <DispositionBadge label={c.disposition_label} color={c.disposition_color} manual={c.disposition_source === "manual"} />
                  ) : (
                    <span className="text-xs text-slate-500">{c.status}</span>
                  )}
                </td>
                <td className="px-3 py-2 text-slate-600">{formatSeconds(c.talk_seconds)}</td>
                <td className="px-3 py-2 text-slate-600">{c.evaluation_score ?? "—"}</td>
              </tr>
            ))}
            {calls.length === 0 && <tr><td colSpan={7} className="px-4 py-8 text-center text-slate-500">No calls match.</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between text-sm text-slate-500">
        <span>{total} call(s)</span>
        <div className="flex gap-2">
          <button disabled={page <= 1} onClick={() => setPage(page - 1)} className={btnGhost}>Previous</button>
          <span className="px-2 py-2">Page {page} of {Math.max(1, Math.ceil(total / pageSize))}</span>
          <button disabled={page * pageSize >= total} onClick={() => setPage(page + 1)} className={btnGhost}>Next</button>
        </div>
      </div>

      {openId && <CallDrawer callId={openId} dispositions={dispositions} onClose={() => setOpenId(null)} onChanged={load} />}
    </div>
  );
}

function CallDrawer({ callId, dispositions, onClose, onChanged }: { callId: string; dispositions: Disposition[]; onClose: () => void; onChanged: () => void }) {
  const can = useCan();
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      setData(await api(`/voice/calls/${callId}`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load call.");
    }
  }
  useEffect(() => {
    setData(null);
    load();
  }, [callId]);

  async function setDisposition(key: string) {
    try {
      await api(`/voice/calls/${callId}/disposition`, { method: "PATCH", body: { dispositionKey: key } });
      await load();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to update.");
    }
  }

  const call = data?.call;
  return (
    <div className="fixed inset-0 z-30 flex justify-end bg-black/20" onClick={onClose}>
      <div className="w-full max-w-xl h-full bg-white shadow-xl overflow-auto" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 bg-white border-b border-slate-100 px-5 py-3 flex items-center justify-between">
          <div className="font-semibold text-slate-900">Call details</div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 text-xl">×</button>
        </div>
        {error && <div className="m-4 text-sm text-red-600">{error}</div>}
        {!call ? (
          <div className="p-5 text-sm text-slate-500">Loading…</div>
        ) : (
          <div className="p-5 space-y-5 text-sm">
            <div className="grid grid-cols-2 gap-3">
              <Info label="Lead">{[call.first_name, call.last_name].filter(Boolean).join(" ") || call.business_name || "—"}</Info>
              <Info label="Business">{call.business_name ?? "—"}</Info>
              <Info label="Number">{formatPhone(call.direction === "inbound" ? call.from_number : call.to_number)}</Info>
              <Info label="Caller ID used">{formatPhone(call.direction === "inbound" ? call.to_number : call.from_number)}</Info>
              <Info label="Campaign">{call.campaign_name ?? "—"}{call.campaign_version ? ` (v${call.campaign_version})` : ""}</Info>
              <Info label="Agent">{call.agent_name ?? "—"}</Info>
              <Info label="Customer">{[call.customer_type?.replace("_", "-").toUpperCase(), call.current_provider].filter(Boolean).join(" · ") || "—"}</Info>
              <Info label="Started">{new Date(call.created_at).toLocaleString()}</Info>
              <Info label="Talk / total">{formatSeconds(call.talk_seconds)} / {formatSeconds(call.duration_seconds)}</Info>
              <Info label="Ended because">{call.ended_reason ?? call.status}</Info>
              {call.voicemail_detected && <Info label="Voicemail">{call.voicemail_method ?? "detected"}</Info>}
              {call.transfer_status && <Info label="Transfer">{call.transfer_status}</Info>}
              {call.callback_at && <Info label="Callback">{new Date(call.callback_at).toLocaleString()}</Info>}
              {call.evaluation_score != null && <Info label="AI score">{call.evaluation_score} / 10</Info>}
              {call.error && <Info label="Error">{call.error}</Info>}
            </div>

            <div>
              <div className="text-xs font-medium text-slate-500 uppercase mb-1">Result</div>
              <div className="flex items-center gap-2">
                <DispositionBadge label={call.disposition_label} color={call.disposition_color} manual={call.disposition_source === "manual"} />
                {can("calls.disposition") && (
                  <select value="" onChange={(e) => e.target.value && setDisposition(e.target.value)} className={`${inputCls} w-auto py-1`}>
                    <option value="">Change…</option>
                    {dispositions.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
                  </select>
                )}
              </div>
              {call.disposition_source === "manual" && <p className="text-xs text-slate-400 mt-1">Set manually — the engine won't overwrite it.</p>}
            </div>

            {data.recordingUrl ? (
              <div>
                <div className="text-xs font-medium text-slate-500 uppercase mb-1">Recording</div>
                <audio controls preload="none" src={data.recordingUrl} className="w-full" />
              </div>
            ) : data.recording ? (
              <div className="text-xs text-slate-500">Recording {data.recording.processing_status}.</div>
            ) : null}

            {data.transcript?.summary && (
              <div>
                <div className="text-xs font-medium text-slate-500 uppercase mb-1">Summary</div>
                <p className="text-slate-700">{data.transcript.summary}</p>
              </div>
            )}

            {data.transcript?.turns?.length > 0 && (
              <div>
                <div className="text-xs font-medium text-slate-500 uppercase mb-1">Transcript</div>
                <div className="space-y-1.5">
                  {data.transcript.turns.map((t: any, i: number) => (
                    <div key={i}>
                      <span className={`font-medium ${t.speaker === "Customer" ? "text-slate-900" : "text-red-700"}`}>{t.speaker}:</span>{" "}
                      <span className="text-slate-700">{t.text}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {Array.isArray(call.events) && call.events.length > 0 && (
              <div>
                <div className="text-xs font-medium text-slate-500 uppercase mb-1">Timeline</div>
                <div className="space-y-1 text-xs text-slate-600">
                  {call.events.map((e: any, i: number) => (
                    <div key={i}>
                      <span className="text-slate-400">{e.at ? new Date(e.at).toLocaleTimeString() : ""}</span> {e.type?.replace(/_/g, " ")}
                      {e.message ? ` — "${e.message}"` : ""}
                      {e.to ? ` → ${e.to}` : ""}
                      {e.key ? ` → ${e.key}` : ""}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {data.leadHistory?.length > 0 && (
              <div>
                <div className="text-xs font-medium text-slate-500 uppercase mb-1">Earlier calls to this lead</div>
                <div className="space-y-1">
                  {data.leadHistory.map((h: any) => (
                    <div key={h.id} className="flex items-center justify-between text-xs">
                      <span className="text-slate-600">{new Date(h.created_at).toLocaleString()} · {formatSeconds(h.talk_seconds)}</span>
                      <DispositionBadge label={h.disposition_label ?? h.status} color={h.disposition_color} />
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Info({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs text-slate-500">{label}</div>
      <div className="text-slate-900">{children}</div>
    </div>
  );
}
