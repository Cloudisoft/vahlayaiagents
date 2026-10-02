import { useEffect, useState } from "react";
import { api, ApiError } from "../../lib/api.js";
import { DispositionBadge, btnDark, inputCls, useCan } from "../../lib/voice.js";

interface Disposition {
  id: string;
  key: string;
  label: string;
  color: string;
  retryable: boolean;
  is_custom: boolean;
}

const COLORS = ["slate", "blue", "green", "teal", "amber", "red", "purple"];
// Codes the engine sets on its own, and those the AI agent may choose.
const AUTO = new Set(["AA", "AB", "ADC", "NA", "PU", "XFER", "DA", "HangUp", "DNC"]);
const AI = new Set(["NI", "DEC", "CALLBK", "FL", "PROPO", "ALC", "CORPO", "NoQua", "WN", "LNG", "SU", "NoAvl", "CBNG", "NP"]);
const ACTIVE = new Set(["A", "B", "N", "AH", "DROP", "ERI", "MAXCAL", "TIMEOT", "RQXFER", "RING", "INCALL", "QUEUE", "NEW", "HangUp", "NoAvl"]);

export default function Dispositions() {
  const can = useCan();
  const [rows, setRows] = useState<Disposition[]>([]);
  const [form, setForm] = useState({ label: "", color: "slate", retryable: false });
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const r = await api<{ dispositions: Disposition[] }>("/voice/dispositions");
    setRows(r.dispositions);
  }
  useEffect(() => {
    load();
  }, []);

  async function run(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Request failed.");
    }
  }

  const source = (d: Disposition) => (d.is_custom ? "Custom" : AUTO.has(d.key) ? "Automatic" : AI.has(d.key) ? "AI agent" : "Manual");
  const shown = rows
    .filter((d) => !["qualified", "disqualified"].includes(d.key))
    .filter((d) => !filter || `${d.key} ${d.label}`.toLowerCase().includes(filter.toLowerCase()))
    .sort((a, b) => Number(ACTIVE.has(a.key)) - Number(ACTIVE.has(b.key)) || a.key.localeCompare(b.key));

  return (
    <div className="max-w-5xl space-y-4">
      <h1 className="text-2xl font-semibold text-slate-900">Dispositions</h1>
      <p className="text-sm text-slate-500">
        Every call ends with one dial status. <strong>Automatic</strong> codes come from the call itself (no answer, busy, answering machine, transfer…),
        <strong> AI agent</strong> codes are chosen by the agent from the conversation, and any code can be set by hand from Call Records — a manual
        status is never overwritten. <strong>Retry</strong> means the dialer may call the lead again within the campaign's attempt limit.
      </p>
      {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-2">{error}</div>}

      {can("calls.disposition") && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              await api("/voice/dispositions", { method: "POST", body: form });
              setForm({ label: "", color: "slate", retryable: false });
            });
          }}
          className="bg-white border border-slate-200 rounded-xl p-3 flex flex-wrap items-end gap-2"
        >
          <div>
            <label className="block text-xs text-slate-500 mb-1">New custom status</label>
            <input required value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} className="border border-slate-300 rounded-md px-3 py-2 text-sm w-64" placeholder="e.g. Bill copy received" />
          </div>
          <select value={form.color} onChange={(e) => setForm({ ...form, color: e.target.value })} className="border border-slate-300 rounded-md px-3 py-2 text-sm">
            {COLORS.map((c) => <option key={c}>{c}</option>)}
          </select>
          <label className="flex items-center gap-2 text-sm text-slate-700 px-2 py-2">
            <input type="checkbox" checked={form.retryable} onChange={(e) => setForm({ ...form, retryable: e.target.checked })} /> Retry
          </label>
          <button className={btnDark}>Add</button>
        </form>
      )}

      <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter codes…" className="border border-slate-300 rounded-md px-3 py-2 text-sm w-64" />

      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-500 text-xs uppercase">
            <tr>
              <th className="text-left px-4 py-2">Status</th>
              <th className="text-left px-4 py-2">Set by</th>
              <th className="text-left px-4 py-2">Type</th>
              <th className="text-left px-4 py-2">Retry</th>
              <th className="text-left px-4 py-2">Colour</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {shown.map((d) => (
              <tr key={d.id} className="border-t border-slate-100">
                <td className="px-4 py-2"><DispositionBadge code={d.is_custom ? null : d.key} label={d.label} color={d.color} /></td>
                <td className="px-4 py-2 text-slate-600">{source(d)}</td>
                <td className="px-4 py-2 text-slate-600">{ACTIVE.has(d.key) ? "Active" : "Final"}</td>
                <td className="px-4 py-2 text-slate-600">
                  {d.is_custom && can("calls.disposition") ? (
                    <input type="checkbox" checked={d.retryable} onChange={(e) => run(() => api(`/voice/dispositions/${d.id}`, { method: "PATCH", body: { retryable: e.target.checked } }))} />
                  ) : d.key === "AA" ? (
                    "Campaign setting"
                  ) : d.retryable ? (
                    "Yes"
                  ) : (
                    "No"
                  )}
                </td>
                <td className="px-4 py-2">
                  {can("calls.disposition") ? (
                    <select value={d.color} onChange={(e) => run(() => api(`/voice/dispositions/${d.id}`, { method: "PATCH", body: { color: e.target.value } }))} className="text-xs border border-slate-200 rounded px-1 py-0.5">
                      {COLORS.map((c) => <option key={c}>{c}</option>)}
                    </select>
                  ) : (
                    d.color
                  )}
                </td>
                <td className="px-4 py-2 text-right">
                  {d.is_custom && can("calls.disposition") && (
                    <button onClick={() => confirm(`Delete "${d.label}"?`) && run(() => api(`/voice/dispositions/${d.id}`, { method: "DELETE" }))} className="text-xs text-slate-500 hover:text-red-600">
                      Delete
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
