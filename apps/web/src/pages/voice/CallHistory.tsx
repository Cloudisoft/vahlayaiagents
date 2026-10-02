import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, ApiError, getAccessToken } from "../../lib/api.js";
import { invalidate, useApi } from "../../lib/useApi.js";
import { K } from "../../lib/voiceKeys.js";
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
  ai_score: number | null;
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
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [applied, setApplied] = useState(EMPTY_FILTERS);
  const [params] = useSearchParams();
  const [openId, setOpenId] = useState<string | null>(params.get("call"));
  useEffect(() => {
    if (params.get("call")) setOpenId(params.get("call"));
  }, [params]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const pageSize = 50;

  function query(f = applied) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(f)) if (v) q.set(k, v);
    return q;
  }

  const listQ = (() => {
    const q = query();
    q.set("page", String(page));
    q.set("pageSize", String(pageSize));
    return q.toString();
  })();
  const callsQ = useApi<{ calls: CallRow[]; total: number }>(K.calls(listQ));
  const campaigns = useApi<{ campaigns: Array<{ id: string; name: string }> }>(K.campaigns).data?.campaigns ?? [];
  const dispositions = useApi<{ dispositions: Disposition[] }>(K.dispositions).data?.dispositions ?? [];
  const calls = callsQ.data?.calls ?? [];
  const total = callsQ.data?.total ?? 0;
  const load = () => {
    invalidate("/voice/calls?");
    return callsQ.reload();
  };

  async function bulk(action: "delete" | "review" | "refresh") {
    const ids = [...selected];
    if (action === "delete" && !confirm(`Delete ${ids.length} call record(s)? Recordings and transcripts go too. This can't be undone.`)) return;
    setError(null);
    setNotice(null);
    try {
      const r = await api<{ message: string }>("/voice/calls/bulk", { method: "POST", body: { ids, action } });
      setNotice(r.message);
      if (action === "delete") setSelected(new Set());
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Request failed.");
    }
  }

  async function exportCsv(onlySelected = false) {
    const q = query();
    if (onlySelected) q.set("ids", [...selected].join(","));
    const res = await fetch(`/api/voice/calls/export?${q}`, {
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
          <h1 className="text-2xl font-semibold text-slate-900">Call Records</h1>
        </div>
        {can("cdr.export") && <button onClick={() => exportCsv()} className={btnGhost}>Export CSV</button>}
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
          {dispositions.map((d) => <option key={d.key} value={d.key}>{d.key} – {d.label}</option>)}
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

      {(error || callsQ.error) && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-2">{error || callsQ.error}</div>}

      {notice && <div className="text-sm text-green-700 bg-green-50 border border-green-200 rounded-md p-2">{notice}</div>}
      {selected.size > 0 && (
        <div className="sticky top-2 z-10 flex flex-wrap items-center gap-2 bg-slate-900 text-white rounded-xl px-4 py-2 text-sm shadow-lg animate-fade-in">
          <span className="font-medium">{selected.size} selected</span>
          <button onClick={() => setSelected(new Set())} className="text-slate-300 hover:text-white">Clear</button>
          <span className="flex-1" />
          {can("cdr.export") && <button onClick={() => exportCsv(true)} className="rounded-md bg-white/10 px-3 py-1 hover:bg-white/20">Export selected</button>}
          <button onClick={() => bulk("refresh")} className="rounded-md bg-white/10 px-3 py-1 hover:bg-white/20">Fetch from VAPI</button>
          <button onClick={() => bulk("review")} className="rounded-md bg-white/10 px-3 py-1 hover:bg-white/20">Run AI review</button>
          <button onClick={() => bulk("delete")} className="rounded-md bg-red-600 px-3 py-1 hover:bg-red-700">Delete</button>
        </div>
      )}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-500 text-xs uppercase">
            <tr>
              <th className="px-3 py-2 w-8">
                <input
                  type="checkbox"
                  aria-label="Select all calls on this page"
                  checked={calls.length > 0 && calls.every((c) => selected.has(c.id))}
                  onChange={(e) => {
                    const next = new Set(selected);
                    for (const c of calls) e.target.checked ? next.add(c.id) : next.delete(c.id);
                    setSelected(next);
                  }}
                />
              </th>
              <th className="text-left px-3 py-2">When</th>
              <th className="text-left px-3 py-2">Lead</th>
              <th className="text-left px-3 py-2">Number</th>
              <th className="text-left px-3 py-2">Campaign</th>
              <th className="text-left px-3 py-2">Result</th>
              <th className="text-left px-3 py-2">Talk</th>
              <th className="text-left px-3 py-2">AI score</th>
            </tr>
          </thead>
          <tbody>
            {calls.map((c) => (
              <tr key={c.id} onClick={() => setOpenId(c.id)} className={`border-t border-slate-100 cursor-pointer ${openId === c.id ? "bg-red-50" : "hover:bg-slate-50"}`}>
                <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    aria-label="Select call"
                    checked={selected.has(c.id)}
                    onChange={(e) => {
                      const next = new Set(selected);
                      e.target.checked ? next.add(c.id) : next.delete(c.id);
                      setSelected(next);
                    }}
                  />
                </td>
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
                    <DispositionBadge code={c.disposition_key} label={c.disposition_label} color={c.disposition_color} manual={c.disposition_source === "manual"} />
                  ) : (
                    <span className="text-xs text-slate-500">{c.status}</span>
                  )}
                </td>
                <td className="px-3 py-2 text-slate-600">{formatSeconds(c.talk_seconds)}</td>
                <td className="px-3 py-2 text-slate-600">{c.ai_score ?? c.evaluation_score ?? "—"}</td>
              </tr>
            ))}
            {calls.length === 0 && <tr><td colSpan={8} className="px-4 py-8 text-center text-slate-500">No calls match.</td></tr>}
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
  const [busy, setBusy] = useState<string | null>(null);

  async function action(kind: "refresh" | "review") {
    setBusy(kind);
    setError(null);
    try {
      await api(`/voice/calls/${callId}/${kind}`, { method: "POST" });
      // The recording downloads in the background after a refresh.
      if (kind === "refresh") await new Promise((r) => setTimeout(r, 2500));
      await load();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Request failed.");
    } finally {
      setBusy(null);
    }
  }

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
    <div className="fixed inset-0 z-30 flex justify-end bg-black/20 animate-fade-in" onClick={onClose}>
      <div className="w-full max-w-xl h-full bg-white shadow-xl overflow-auto animate-slide-in-right" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 bg-white border-b border-slate-100 px-5 py-3 flex items-center justify-between">
          <div className="font-semibold text-slate-900">Call details</div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 text-xl">×</button>
        </div>
        {error && <div className="m-4 text-sm text-red-600">{error}</div>}
        {!call ? (
          <div className="p-5"><div className="space-y-3 animate-fade-in" aria-busy="true" aria-label="Loading">
          <div className="skeleton h-5 w-1/3" />
          <div className="skeleton h-4 w-2/3" />
          <div className="skeleton h-24 w-full" />
        </div></div>
        ) : (
          <div className="p-5 space-y-5 text-sm">
            <div className="grid grid-cols-2 gap-3">
              <Info label="Lead">{[call.first_name, call.last_name].filter(Boolean).join(" ") || call.business_name || "—"}</Info>
              <Info label="Business">{call.business_name ?? "—"}</Info>
              <Info label="Number">{formatPhone(call.direction === "inbound" ? call.from_number : call.to_number)}</Info>
              <Info label="Caller ID used">{formatPhone(call.direction === "inbound" ? call.to_number : call.from_number)}</Info>
              <Info label="Campaign">{call.campaign_name ?? "—"}{call.campaign_version ? ` (v${call.campaign_version})` : ""}</Info>
              <Info label="Agent">{call.agent_name ?? "—"}</Info>
              {call.call_category && <Info label="Category">{call.call_category.replace(/_/g, " ")}</Info>}
              <Info label="Customer">{[call.customer_type?.replace("_", "-").toUpperCase(), call.current_provider].filter(Boolean).join(" · ") || "—"}</Info>
              <Info label="Started">{new Date(call.created_at).toLocaleString()}</Info>
              <Info label="Talk / total">{formatSeconds(call.talk_seconds)} / {formatSeconds(call.duration_seconds)}</Info>
              <Info label="Ended because">{call.ended_reason ?? call.status}</Info>
              {call.voicemail_detected && <Info label="Voicemail">{call.voicemail_method ?? "detected"}</Info>}
              {call.transfer_status && <Info label="Transfer">{call.transfer_status}</Info>}
              {call.callback_at && <Info label="Callback">{new Date(call.callback_at).toLocaleString()}</Info>}
              {call.evaluation_score != null && <Info label="AI score">{call.evaluation_score} / 100</Info>}
              {call.error && <Info label="Error">{call.error}</Info>}
            </div>

            <div>
              <div className="text-xs font-medium text-slate-500 uppercase mb-1">Result</div>
              <div className="flex items-center gap-2">
                <DispositionBadge code={call.disposition_key} label={call.disposition_label} color={call.disposition_color} manual={call.disposition_source === "manual"} />
                {can("calls.disposition") && (
                  <select value="" onChange={(e) => e.target.value && setDisposition(e.target.value)} className={`${inputCls} w-auto py-1`}>
                    <option value="">Change…</option>
                    {dispositions.map((d) => <option key={d.key} value={d.key}>{d.key} – {d.label}</option>)}
                  </select>
                )}
              </div>
              {call.disposition_source === "manual" && <p className="text-xs text-slate-400 mt-1">Set manually — the engine won't overwrite it.</p>}
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <div className="text-xs font-medium text-slate-500 uppercase">
                  Recording{data.recording?.channels === 2 ? " · HD stereo (agent / caller)" : ""}
                </div>
                <div className="flex gap-3 text-xs">
                  {data.recordingUrl && <a href={data.recordingUrl} download className="text-slate-500 hover:text-red-600">Download</a>}
                  {call.vapi_call_id && (
                    <button disabled={busy !== null} onClick={() => action("refresh")} className="text-slate-500 hover:text-red-600 disabled:opacity-50">
                      {busy === "refresh" ? "Fetching…" : "Fetch from VAPI"}
                    </button>
                  )}
                </div>
              </div>
              {data.recordingUrl ? (
                <audio controls preload="metadata" src={data.recordingUrl} className="w-full" />
              ) : (
                <div className="text-xs text-slate-500">
                  {data.recording?.processing_status === "unavailable"
                    ? "VAPI has no recording for this call."
                    : data.recording
                      ? `Recording ${data.recording.processing_status}.`
                      : call.answered
                        ? "Not downloaded yet — it arrives within a minute of the call ending."
                        : "No recording — the call wasn't answered."}
                </div>
              )}
            </div>

            <AiReview call={call} busy={busy === "review"} onRun={() => action("review")} />

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
                      {e.status ? `: ${e.status}` : ""}
                      {e.name ? `: ${e.name}${e.args?.outcome ? ` (${e.args.outcome})` : ""}` : ""}
                      {e.destination ? ` → ${e.destination}` : ""}
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

function AiReview({ call, busy, onRun }: { call: any; busy: boolean; onRun: () => void }) {
  const r = call.ai_review;
  const Section = ({ title, items, tone }: { title: string; items?: string[]; tone: string }) =>
    items && items.length > 0 ? (
      <div>
        <div className={`text-xs font-medium mb-0.5 ${tone}`}>{title}</div>
        <ul className="list-disc pl-5 space-y-0.5 text-slate-700">
          {items.map((x, i) => <li key={i}>{x}</li>)}
        </ul>
      </div>
    ) : null;
  return (
    <div className="rounded-lg border border-slate-200 p-3 space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-xs font-medium text-slate-500 uppercase">AI coaching review</div>
        <button disabled={busy} onClick={onRun} className="text-xs text-slate-500 hover:text-red-600 disabled:opacity-50">
          {busy ? "Reviewing…" : r ? "Re-run" : "Run review"}
        </button>
      </div>
      {!r ? (
        <div className="text-xs text-slate-500">
          {busy
            ? "Reading the transcript against the SOP…"
            : call.ai_review_error
              ? call.ai_review_error
              : (call.talk_seconds ?? 0) >= 15
                ? "The review runs automatically within a minute or two of the call ending."
                : "Calls with under 15 seconds of conversation aren't reviewed automatically."}
        </div>
      ) : (
        <>
          <div className="flex gap-4">
            <Score label="Overall" value={r.overallScore} />
            <Score label="SOP adherence" value={r.sopAdherence?.score} />
          </div>
          {r.summary && <p className="text-slate-700">{r.summary}</p>}
          <Section title="What went well" items={r.whatWentWell} tone="text-green-700" />
          <Section title="What went poorly" items={r.whatWentPoorly} tone="text-red-700" />
          <Section title="SOP deviations" items={r.sopAdherence?.deviations} tone="text-amber-700" />
          <Section title="Missed opportunities" items={r.missedOpportunities} tone="text-amber-700" />
          <Section title="Incorrect statements" items={r.incorrectStatements} tone="text-red-700" />
          <Section title="Customer objections" items={r.customerObjections} tone="text-slate-600" />
          {r.betterResponses?.length > 0 && (
            <div>
              <div className="text-xs font-medium text-slate-600 mb-1">What it could have said</div>
              <div className="space-y-2">
                {r.betterResponses.map((b: any, i: number) => (
                  <div key={i} className="rounded-md bg-slate-50 p-2 text-xs">
                    {b.moment && <div className="text-slate-500 mb-0.5">{b.moment}</div>}
                    <div className="text-slate-600"><span className="font-medium">Said:</span> “{b.agentSaid}”</div>
                    <div className="text-green-800"><span className="font-medium">Better:</span> “{b.better}”</div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {r.recommendedImprovement && (
            <div className="rounded-md bg-amber-50 border border-amber-200 p-2 text-amber-900">
              <span className="font-medium">Top fix: </span>
              {r.recommendedImprovement}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Score({ label, value }: { label: string; value: number | undefined }) {
  const v = value ?? 0;
  const tone = v >= 80 ? "text-green-700" : v >= 60 ? "text-amber-700" : "text-red-700";
  return (
    <div>
      <div className="text-xs text-slate-500">{label}</div>
      <div className={`text-xl font-semibold ${tone}`}>{value ?? "—"}<span className="text-xs text-slate-400"> / 100</span></div>
    </div>
  );
}
