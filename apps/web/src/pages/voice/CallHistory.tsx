import { useEffect, useState } from "react";
import { api } from "../../lib/api.js";

interface CallRow {
  id: string;
  status: string;
  to_number: string;
  duration_seconds: number | null;
  lead_name: string | null;
  agent_name: string | null;
  campaign_name: string | null;
  disposition_label: string | null;
  created_at: string;
}

interface CallDetail {
  call: CallRow & { ai_analysis: Record<string, unknown> | null };
  transcript: { full_text: string | null; turns: Array<{ speaker: string; text: string }>; summary: string | null } | null;
  recordingUrl: string | null;
}

export default function CallHistory() {
  const [calls, setCalls] = useState<CallRow[]>([]);
  const [selected, setSelected] = useState<CallDetail | null>(null);

  useEffect(() => {
    api<{ calls: CallRow[] }>("/voice/calls").then((r) => setCalls(r.calls));
  }, []);

  async function openCall(id: string) {
    const detail = await api<CallDetail>(`/voice/calls/${id}`);
    setSelected(detail);
  }

  return (
    <div className="max-w-5xl space-y-6">
      <h1 className="text-2xl font-semibold text-slate-900">Call History</h1>

      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-500 text-xs uppercase">
            <tr>
              <th className="text-left px-4 py-2">Lead</th>
              <th className="text-left px-4 py-2">Campaign</th>
              <th className="text-left px-4 py-2">Status</th>
              <th className="text-left px-4 py-2">Disposition</th>
              <th className="text-left px-4 py-2">Duration</th>
              <th className="text-left px-4 py-2">Date</th>
            </tr>
          </thead>
          <tbody>
            {calls.map((c) => (
              <tr key={c.id} onClick={() => openCall(c.id)} className="border-t border-slate-100 hover:bg-slate-50 cursor-pointer">
                <td className="px-4 py-2 font-medium text-slate-900">{c.lead_name ?? c.to_number}</td>
                <td className="px-4 py-2 text-slate-500">{c.campaign_name ?? "—"}</td>
                <td className="px-4 py-2 text-slate-500">{c.status}</td>
                <td className="px-4 py-2 text-slate-500">{c.disposition_label ?? "—"}</td>
                <td className="px-4 py-2 text-slate-500">{c.duration_seconds ? `${c.duration_seconds}s` : "—"}</td>
                <td className="px-4 py-2 text-slate-500">{new Date(c.created_at).toLocaleString()}</td>
              </tr>
            ))}
            {calls.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-slate-500">No calls yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {selected && (
        <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-3">
          <div className="flex justify-between items-center">
            <h2 className="font-medium text-slate-900">Call detail</h2>
            <button onClick={() => setSelected(null)} className="text-sm text-slate-500 hover:text-slate-700">
              Close
            </button>
          </div>
          {selected.recordingUrl && (
            <audio controls src={selected.recordingUrl} className="w-full" />
          )}
          {selected.transcript?.summary && <p className="text-sm text-slate-600">{selected.transcript.summary}</p>}
          <div className="bg-slate-50 rounded-md p-3 text-sm space-y-1 max-h-64 overflow-y-auto">
            {(selected.transcript?.turns ?? []).map((t, i) => (
              <div key={i}>
                <span className="font-medium">{t.speaker}: </span>
                {t.text}
              </div>
            ))}
            {(!selected.transcript || selected.transcript.turns.length === 0) && (
              <span className="text-slate-400">No transcript available.</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
