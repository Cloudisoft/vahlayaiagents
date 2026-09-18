import { useEffect, useRef, useState } from "react";
import { api } from "../../lib/api.js";

interface AuditRow {
  id: string;
  overall_score: number | null;
  processing_status: string;
  file_name: string | null;
  created_at: string;
}

interface CriterionScore {
  criterionId: string;
  criterionName: string;
  score: number;
  passed: boolean;
  notes: string;
}

interface AuditDetail {
  audit: {
    id: string;
    overall_score: number | null;
    criterion_scores: CriterionScore[];
    strengths: string[];
    improvements: string[];
    missed_opportunities: string[];
    script_deviations: string[];
    coaching_notes: string | null;
    processing_status: string;
  };
  recordingUrl: string | null;
}

export default function AuditorHome() {
  const [audits, setAudits] = useState<AuditRow[]>([]);
  const [selected, setSelected] = useState<AuditDetail | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function load() {
    const { audits } = await api<{ audits: AuditRow[] }>("/auditor/audits");
    setAudits(audits);
  }

  useEffect(() => {
    load();
    const interval = setInterval(load, 8000);
    return () => clearInterval(interval);
  }, []);

  async function upload() {
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    setError(null);
    setMessage(null);
    const form = new FormData();
    form.append("file", file);
    try {
      const res = await fetch("/api/auditor/audits/upload", { method: "POST", body: form, credentials: "include" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setMessage(data.message);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed.");
    }
  }

  async function open(id: string) {
    const detail = await api<AuditDetail>(`/auditor/audits/${id}`);
    setSelected(detail);
  }

  return (
    <div className="max-w-4xl space-y-6">
      <h1 className="text-2xl font-semibold text-slate-900">AI Call Auditor</h1>

      {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-2">{error}</div>}
      {message && <div className="text-sm text-green-700 bg-green-50 border border-green-200 rounded-md p-2">{message}</div>}

      <div className="bg-white border border-slate-200 rounded-xl p-6">
        <h2 className="font-medium text-slate-900 mb-3">Upload a recording</h2>
        <p className="text-sm text-slate-500 mb-3">MP3, WAV, or M4A — up to 200MB / ~1 hour. Processed asynchronously.</p>
        <div className="flex gap-2">
          <input ref={fileRef} type="file" accept=".mp3,.wav,.m4a" className="text-sm" />
          <button onClick={upload} className="bg-red-600 text-white text-sm font-medium rounded-md px-4 py-2 hover:bg-red-700">
            Upload &amp; Audit
          </button>
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-500 text-xs uppercase">
            <tr>
              <th className="text-left px-4 py-2">File</th>
              <th className="text-left px-4 py-2">Status</th>
              <th className="text-left px-4 py-2">Score</th>
              <th className="text-left px-4 py-2">Date</th>
            </tr>
          </thead>
          <tbody>
            {audits.map((a) => (
              <tr key={a.id} onClick={() => open(a.id)} className="border-t border-slate-100 hover:bg-slate-50 cursor-pointer">
                <td className="px-4 py-2 font-medium text-slate-900">{a.file_name ?? "From call"}</td>
                <td className="px-4 py-2 text-slate-500">{a.processing_status}</td>
                <td className="px-4 py-2 text-slate-500">{a.overall_score ?? "—"}</td>
                <td className="px-4 py-2 text-slate-500">{new Date(a.created_at).toLocaleString()}</td>
              </tr>
            ))}
            {audits.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-slate-500">No audits yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {selected && (
        <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
          <div className="flex justify-between items-center">
            <h2 className="font-medium text-slate-900">Audit detail — {selected.audit.processing_status}</h2>
            <button onClick={() => setSelected(null)} className="text-sm text-slate-500 hover:text-slate-700">Close</button>
          </div>
          {selected.recordingUrl && <audio controls src={selected.recordingUrl} className="w-full" />}
          {selected.audit.overall_score !== null && (
            <div className="text-3xl font-semibold text-slate-900">{selected.audit.overall_score}/100</div>
          )}
          {selected.audit.criterion_scores?.length > 0 && (
            <div className="grid grid-cols-2 gap-2">
              {selected.audit.criterion_scores.map((c) => (
                <div key={c.criterionId} className="bg-slate-50 rounded-md p-2 text-sm">
                  <div className="flex justify-between">
                    <span className="font-medium">{c.criterionName}</span>
                    <span className={c.passed ? "text-green-600" : "text-red-600"}>{c.score}</span>
                  </div>
                  <div className="text-xs text-slate-500">{c.notes}</div>
                </div>
              ))}
            </div>
          )}
          {selected.audit.coaching_notes && (
            <div>
              <h3 className="text-sm font-medium text-slate-900 mb-1">Coaching notes</h3>
              <p className="text-sm text-slate-600">{selected.audit.coaching_notes}</p>
            </div>
          )}
          {selected.audit.strengths?.length > 0 && (
            <div className="text-sm"><span className="font-medium">Strengths: </span>{selected.audit.strengths.join(", ")}</div>
          )}
          {selected.audit.improvements?.length > 0 && (
            <div className="text-sm"><span className="font-medium">Improvements: </span>{selected.audit.improvements.join(", ")}</div>
          )}
        </div>
      )}
    </div>
  );
}
