import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { api, ApiError, getAccessToken, refreshSession } from "../../lib/api.js";

// ---------- types (mirror the API) ----------

type Status =
  | "UPLOADED" | "VALIDATING" | "CONVERTING" | "TRANSCRIBING" | "VALIDATING_TRANSCRIPT" | "ANALYZING" | "SAVING_REPORT" | "READY"
  | "AUDIO_FAILED" | "TRANSCRIPTION_FAILED" | "TRANSCRIPT_INCOMPLETE" | "ANALYSIS_FAILED" | "PDF_FAILED";

interface AuditRow {
  id: string;
  status: Status;
  status_message: string | null;
  overall_score: number | null;
  pass: boolean | null;
  needs_review: boolean | null;
  created_at: string;
  original_duration_sec: number | null;
  agent_name: string | null;
  business_name: string | null;
  file_name: string | null;
  call_type: string | null;
}
interface Evidence { segment: number | null; timestamp: string | null; quote: string; verified: boolean }
interface Finding { title: string; detail: string; rating: "green" | "yellow" | "red"; evidence: Evidence[] }
type RuleResult = "PASS" | "FAIL" | "PARTIAL" | "NOT_APPLICABLE";
interface Report {
  callType: string;
  callTypeTags: string[];
  agentName: string | null;
  customerName: string | null;
  businessName: string | null;
  scores: { overall: number; compliance: number; communication: number; sales: number; resolution: number; customerExperience: number; rules: number | null };
  categoryWeights: Record<string, number>;
  rulesWeight: number;
  pass: boolean;
  needsReview: boolean;
  dimensions: Array<{ key: string; label: string; score: number | null; rating: string; finding: string; evidence: Evidence[] }>;
  rules: Array<{ rule: string; mandatory: boolean; result: RuleResult; explanation: string; evidence: Evidence[] }>;
  complianceChecks: Array<{ check: string; result: RuleResult; severity: string; evidence: Evidence[] }>;
  callTypeRules: Array<{ rule: string; result: RuleResult; evidence: Evidence[] }>;
  risks: Array<{ level: string; description: string; evidence: Evidence[] }>;
  sentiment: { customer: string; agent: string; trajectory: string };
  executiveSummary: string;
  wentWell: Finding[];
  toImprove: Finding[];
  coaching: Array<{ recommendation: string; why: string; example: string | null }>;
  keyMoments: Array<{ timestamp: string | null; description: string; evidence: Evidence[] }>;
  findings: { green: Finding[]; yellow: Finding[]; red: Finding[] };
  evidenceStats: { cited: number; verified: number };
}
interface Segment { start: number; end: number; role: string; text: string }
interface AuditDetail {
  id: string;
  status: Status;
  status_message: string | null;
  failed_stage: string | null;
  overall_score: number | null;
  original_duration_sec: number | null;
  converted_duration_sec: number | null;
  transcript_end_sec: number | null;
  transcript_coverage: number | null;
  transcript: Segment[] | null;
  report: Report | null;
  agent_name: string | null;
  business_name: string | null;
  file_name: string | null;
  file_size: number | null;
  has_pdf: boolean;
  has_audio: boolean;
  created_at: string;
  stage_log?: Array<{ stage: string; at: string; [k: string]: unknown }>;
}
interface Stats { total: number; completed: number; avg_score: number | null; pass_rate: number | null; needs_review: number; failed: number; in_progress: number }

// ---------- helpers ----------

const STEPS: Array<[Status, string]> = [
  ["UPLOADED", "Queued"],
  ["VALIDATING", "Validating"],
  ["CONVERTING", "Converting"],
  ["TRANSCRIBING", "Transcribing"],
  ["VALIDATING_TRANSCRIPT", "Checking coverage"],
  ["ANALYZING", "Auditing"],
  ["SAVING_REPORT", "Saving report"],
];
const FAILED: Status[] = ["AUDIO_FAILED", "TRANSCRIPTION_FAILED", "TRANSCRIPT_INCOMPLETE", "ANALYSIS_FAILED", "PDF_FAILED"];
const FAILED_LABEL: Record<string, string> = {
  AUDIO_FAILED: "Audio failed",
  TRANSCRIPTION_FAILED: "Transcription failed",
  TRANSCRIPT_INCOMPLETE: "Transcript incomplete",
  ANALYSIS_FAILED: "Audit failed",
  PDF_FAILED: "PDF failed",
};
const isRunning = (s: Status) => s !== "READY" && !FAILED.includes(s);

function dur(sec: number | null | undefined) {
  if (sec == null) return "—";
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}
const tsToSec = (t: string | null) => {
  if (!t) return null;
  const p = t.split(":").map(Number);
  return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1];
};
const scoreTone = (n: number | null | undefined) => (n == null ? "text-slate-400" : n >= 80 ? "text-green-600" : n >= 60 ? "text-amber-500" : "text-red-600");
const barTone = (n: number) => (n >= 80 ? "bg-green-500" : n >= 60 ? "bg-amber-400" : "bg-red-500");

async function authed(path: string, init: RequestInit = {}) {
  const send = () => fetch(path, { ...init, credentials: "include", headers: { ...(init.headers ?? {}), Authorization: `Bearer ${getAccessToken()}` } });
  let res = await send();
  if (res.status === 401 && (await refreshSession())) res = await send();
  return res;
}

// Uploads with a progress bar (fetch can't report upload progress).
function uploadWithProgress(form: FormData, onProgress: (pct: number) => void): Promise<any> {
  const go = () =>
    new Promise<{ status: number; body: any }>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/auditor/audits/upload");
      xhr.withCredentials = true;
      xhr.setRequestHeader("Authorization", `Bearer ${getAccessToken()}`);
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100));
      xhr.onload = () => {
        let body: any = {};
        try {
          body = JSON.parse(xhr.responseText);
        } catch {
          // non-JSON error page
        }
        resolve({ status: xhr.status, body });
      };
      xhr.onerror = () => reject(new Error("Network error during upload."));
      xhr.send(form);
    });
  return go().then(async (r) => {
    if (r.status === 401 && (await refreshSession())) r = await go();
    if (r.status >= 400) throw new Error(r.body.error ?? "Upload failed.");
    return r.body;
  });
}

// ---------- small UI pieces ----------

function Icon({ d, className = "" }: { d: string; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d={d} />
    </svg>
  );
}
const I = {
  phone: "M22 16.9v3a2 2 0 01-2.2 2 19.8 19.8 0 01-8.6-3.1 19.5 19.5 0 01-6-6A19.8 19.8 0 012.1 4.2 2 2 0 014.1 2h3a2 2 0 012 1.7c.1.9.4 1.8.7 2.7a2 2 0 01-.5 2.1L8 9.8a16 16 0 006 6l1.3-1.3a2 2 0 012.1-.4c.9.3 1.8.6 2.7.7a2 2 0 011.7 2z",
  chart: "M4 20V10m6 10V4m6 16v-7m4 7H2",
  clock: "M12 8v4l3 2M21 12a9 9 0 11-18 0 9 9 0 0118 0z",
  alert: "M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0zM12 9v4m0 4h.01",
  upload: "M16 16l-4-4-4 4m4-4v9M20.4 18.4A5 5 0 0018 9h-1.3A8 8 0 103 16.3",
  user: "M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2M12 11a4 4 0 100-8 4 4 0 000 8z",
  building: "M3 21h18M5 21V7l8-4v18M19 21V11l-6-4M9 9h.01M9 13h.01M9 17h.01",
  pdf: "M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8zM14 2v6h6M12 18v-6m-3 3l3 3 3-3",
  download: "M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3",
  check: "M22 11.1V12a10 10 0 11-5.9-9.1M22 4L12 14l-3-3",
  x: "M15 9l-6 6m0-6l6 6M21 12a9 9 0 11-18 0 9 9 0 0118 0z",
  retry: "M1 4v6h6M3.5 15a9 9 0 102.1-9.4L1 10",
  search: "M21 21l-4.3-4.3M11 18a7 7 0 100-14 7 7 0 000 14z",
};

function StatCard({ label, value, icon, tone = "" }: { label: string; value: ReactNode; icon: string; tone?: string }) {
  return (
    <div className="bg-white border border-slate-200 rounded-2xl p-4 flex items-start justify-between transition-shadow hover:shadow-sm">
      <div>
        <div className="text-sm text-slate-500">{label}</div>
        <div className={`text-2xl font-bold mt-1 tabular-nums ${tone}`}>{value}</div>
      </div>
      <span className="rounded-lg bg-slate-100 p-1.5 text-slate-500"><Icon d={icon} /></span>
    </div>
  );
}

function EvidenceList({ list, onSeek }: { list: Evidence[]; onSeek: (t: string | null) => void }) {
  if (!list.length) return null;
  return (
    <div className="mt-1 space-y-0.5">
      {list.map((e, i) => (
        <button key={i} type="button" onClick={() => onSeek(e.timestamp)} className="block text-left text-xs text-slate-500 hover:text-slate-800" title={e.verified ? "Quoted from the transcript" : "Not found verbatim in the transcript"}>
          {e.timestamp && <span className="font-mono text-red-600 mr-1">[{e.timestamp}]</span>}
          <span className="italic">“{e.quote}”</span>
          {!e.verified && <span className="ml-1 text-amber-600">(unverified)</span>}
        </button>
      ))}
    </div>
  );
}

function ResultBadge({ r }: { r: RuleResult }) {
  const cls = r === "PASS" ? "bg-green-100 text-green-700" : r === "PARTIAL" ? "bg-amber-100 text-amber-700" : r === "FAIL" ? "bg-red-100 text-red-700" : "bg-slate-100 text-slate-500";
  return <span className={`text-[10px] font-semibold rounded-full px-2 py-0.5 ${cls}`}>{r === "NOT_APPLICABLE" ? "N/A" : r}</span>;
}

// ---------- page ----------

export default function AuditorHome() {
  const [params, setParams] = useSearchParams();
  const [audits, setAudits] = useState<AuditRow[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(params.get("audit"));
  const [detail, setDetail] = useState<AuditDetail | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const loadList = useCallback(async () => {
    const [a, s] = await Promise.all([api<{ audits: AuditRow[] }>("/auditor/audits"), api<{ stats: Stats }>("/auditor/stats")]);
    setAudits(a.audits);
    setStats(s.stats);
    return a.audits;
  }, []);

  const loadDetail = useCallback(async (id: string) => {
    try {
      const r = await api<{ audit: AuditDetail; audioUrl: string | null }>(`/auditor/audits/${id}`);
      setDetail(r.audit);
      setAudioUrl(r.audioUrl);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't load the report.");
    }
  }, []);

  useEffect(() => {
    loadList().catch(() => undefined);
  }, [loadList]);
  useEffect(() => {
    if (!selectedId) return setDetail(null);
    setDetail(null);
    loadDetail(selectedId);
  }, [selectedId, loadDetail]);
  useEffect(() => {
    const p = params.get("audit");
    if (p && p !== selectedId) setSelectedId(p);
  }, [params]); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll only while something is processing.
  const anyRunning = audits.some((a) => isRunning(a.status));
  useEffect(() => {
    if (!anyRunning) return;
    const t = setInterval(() => {
      loadList().catch(() => undefined);
      if (selectedId && detail && isRunning(detail.status)) loadDetail(selectedId);
    }, 4000);
    return () => clearInterval(t);
  }, [anyRunning, selectedId, detail, loadList, loadDetail]);
  // A selected audit that just finished: fetch its full report.
  useEffect(() => {
    const row = audits.find((a) => a.id === selectedId);
    if (row && detail && row.status !== detail.status) loadDetail(row.id);
  }, [audits]); // eslint-disable-line react-hooks/exhaustive-deps

  function select(id: string) {
    setSelectedId(id);
    setParams((p) => {
      p.set("audit", id);
      return p;
    }, { replace: true });
  }

  async function retry(id: string) {
    setError(null);
    try {
      await api(`/auditor/audits/${id}/retry`, { method: "POST" });
      await loadList();
      if (id === selectedId) loadDetail(id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Retry failed.");
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <span className="rounded-xl bg-red-50 p-2 text-red-600"><Icon d={I.phone} /></span>
        <div>
          <h1 className="text-xl font-semibold text-slate-900 leading-tight">Vahlay QCs</h1>
          <p className="text-sm text-slate-500">Automated QC analysis &amp; sales compliance</p>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 stagger">
        <StatCard label="Total Calls" value={stats?.total ?? "—"} icon={I.phone} />
        <StatCard label="Avg Score" value={stats?.avg_score != null ? `${stats.avg_score}%` : "—"} icon={I.chart} tone={scoreTone(stats?.avg_score)} />
        <StatCard label="Pass Rate" value={stats?.pass_rate != null ? `${Math.round(stats.pass_rate * 100)}%` : "—"} icon={I.clock} />
        <StatCard label="Needs Review" value={stats?.needs_review ?? "—"} icon={I.alert} tone={stats?.needs_review ? "text-amber-600" : ""} />
      </div>

      {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-2 animate-fade-in">{error}</div>}
      {message && <div className="text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg p-2 animate-fade-in">{message}</div>}

      <div className="grid lg:grid-cols-[minmax(0,420px)_minmax(0,1fr)] gap-6 items-start">
        <div className="space-y-6">
          <UploadCard
            onUploaded={async (ids, msg) => {
              setMessage(msg);
              await loadList();
              if (ids[0]) select(ids[0]);
            }}
            onError={setError}
          />
          <AuditList audits={audits} selectedId={selectedId} onSelect={select} onRetry={retry} onRetryAll={async () => {
            const r = await api<{ message: string }>("/auditor/audits/retry-failed", { method: "POST" });
            setMessage(r.message);
            loadList();
          }} />
        </div>

        <div className="bg-white border border-slate-200 rounded-2xl min-h-[420px]">
          {!selectedId ? (
            <EmptyReport />
          ) : !detail ? (
            <div className="p-6 space-y-3" aria-busy="true">
              <div className="skeleton h-5 w-1/3" />
              <div className="skeleton h-8 w-1/2" />
              <div className="skeleton h-32 w-full" />
            </div>
          ) : detail.status === "READY" && detail.report ? (
            <ReportView d={detail} audioUrl={audioUrl} />
          ) : (
            <ProcessingView d={detail} onRetry={() => retry(detail.id)} />
          )}
        </div>
      </div>
    </div>
  );
}

function EmptyReport() {
  return (
    <div className="h-full min-h-[420px] flex flex-col items-center justify-center text-center p-8 text-slate-400">
      <Icon d={I.chart} className="w-10 h-10 mb-3" />
      <div className="text-sm">Upload a recording or pick an audit to see its report.</div>
    </div>
  );
}

function UploadCard({ onUploaded, onError }: { onUploaded: (ids: string[], msg: string) => void; onError: (m: string | null) => void }) {
  const [agent, setAgent] = useState("");
  const [business, setBusiness] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [drag, setDrag] = useState(false);
  const [pct, setPct] = useState<number | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const ACCEPT = ".mp3,.wav,.m4a,.flac,.ogg,.opus,.webm,.mp4,.aac,.wma,.amr,.aiff,.3gp";

  async function submit() {
    if (!files.length) return;
    onError(null);
    const form = new FormData();
    for (const f of files) form.append("files", f);
    if (agent.trim()) form.append("agentName", agent.trim());
    if (business.trim()) form.append("businessName", business.trim());
    setPct(0);
    try {
      const r = await uploadWithProgress(form, setPct);
      setFiles([]);
      onUploaded((r.audits ?? []).map((a: { id: string }) => a.id), r.message);
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setPct(null);
    }
  }

  return (
    <div className="bg-white border border-slate-200 rounded-2xl p-5">
      <h2 className="font-semibold text-slate-900 mb-4">Upload Recording</h2>
      <div className="grid grid-cols-2 gap-3 mb-4">
        <label className="text-sm">
          <span className="flex items-center gap-1 text-slate-500 mb-1"><Icon d={I.user} className="w-3.5 h-3.5" /> Agent Name</span>
          <input value={agent} onChange={(e) => setAgent(e.target.value)} placeholder="e.g. Sarah Johnson" className="w-full rounded-lg bg-slate-50 border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-200" />
        </label>
        <label className="text-sm">
          <span className="flex items-center gap-1 text-slate-500 mb-1"><Icon d={I.building} className="w-3.5 h-3.5" /> Business Name</span>
          <input value={business} onChange={(e) => setBusiness(e.target.value)} placeholder="e.g. Acme Corp" className="w-full rounded-lg bg-slate-50 border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-200" />
        </label>
      </div>
      <div
        role="button"
        tabIndex={0}
        onClick={() => input.current?.click()}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && input.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          setFiles(Array.from(e.dataTransfer.files));
        }}
        className={`rounded-xl border-2 border-dashed p-6 text-center cursor-pointer transition-colors ${drag ? "border-red-400 bg-red-50" : "border-slate-200 hover:border-slate-300"}`}
      >
        <Icon d={I.upload} className={`w-7 h-7 mx-auto mb-2 transition-transform ${drag ? "-translate-y-0.5 text-red-500" : "text-slate-400"}`} />
        {files.length ? (
          <div className="text-sm text-slate-800 font-medium">
            {files.length === 1 ? files[0].name : `${files.length} files selected`}
            <div className="text-xs text-slate-500 font-normal">{(files.reduce((a, f) => a + f.size, 0) / 1048576).toFixed(1)} MB · click to change</div>
          </div>
        ) : (
          <>
            <div className="font-medium text-slate-800">Drop audio files here</div>
            <div className="text-xs text-slate-500 mt-1">MP3, WAV, M4A, FLAC, OGG, OPUS, WebM, MP4 — up to 500 MB each, several at once</div>
          </>
        )}
        <input ref={input} type="file" multiple accept={ACCEPT} className="hidden" onChange={(e) => setFiles(Array.from(e.target.files ?? []))} />
      </div>
      {pct !== null && (
        <div className="mt-3 h-1.5 rounded-full bg-slate-100 overflow-hidden">
          <div className="h-full bg-red-500 transition-all" style={{ width: `${pct}%` }} />
        </div>
      )}
      <button
        onClick={submit}
        disabled={!files.length || pct !== null}
        className="mt-4 w-full flex items-center justify-center gap-2 rounded-xl bg-red-600 text-white font-medium py-2.5 hover:bg-red-700 disabled:bg-red-300 transition-colors"
      >
        <Icon d={I.upload} className="w-4 h-4" />
        {pct !== null ? `Uploading ${pct}%…` : files.length > 1 ? `Analyze ${files.length} Calls` : "Analyze Call"}
      </button>
    </div>
  );
}

function AuditList({ audits, selectedId, onSelect, onRetry, onRetryAll }: {
  audits: AuditRow[]; selectedId: string | null; onSelect: (id: string) => void; onRetry: (id: string) => void; onRetryAll: () => void;
}) {
  const failed = audits.filter((a) => FAILED.includes(a.status)).length;
  return (
    <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
      <div className="flex items-center justify-between px-5 py-3 border-b border-slate-100">
        <h2 className="font-semibold text-slate-900 text-sm">Recent audits</h2>
        {failed > 1 && <button onClick={onRetryAll} className="text-xs text-red-600 hover:underline">Retry {failed} failed</button>}
      </div>
      <div className="max-h-[560px] overflow-auto divide-y divide-slate-100">
        {audits.map((a) => {
          const running = isRunning(a.status);
          const failedRow = FAILED.includes(a.status);
          return (
            <div
              key={a.id}
              onClick={() => onSelect(a.id)}
              className={`px-5 py-3 cursor-pointer transition-colors ${selectedId === a.id ? "bg-red-50/70" : "hover:bg-slate-50"}`}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-slate-900 truncate">{a.agent_name ?? a.file_name ?? "Call"}</div>
                  <div className="text-xs text-slate-500 truncate">{[a.call_type, a.file_name, dur(a.original_duration_sec)].filter(Boolean).join(" · ")}</div>
                </div>
                {a.status === "READY" ? (
                  <div className="text-right shrink-0">
                    <div className={`text-lg font-bold tabular-nums ${scoreTone(a.overall_score)}`}>{a.overall_score}</div>
                    <div className={`text-[10px] font-semibold ${a.pass ? "text-green-600" : "text-red-600"}`}>{a.pass ? "PASS" : "FAIL"}{a.needs_review ? " · review" : ""}</div>
                  </div>
                ) : failedRow ? (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onRetry(a.id);
                    }}
                    className="shrink-0 flex items-center gap-1 text-xs text-red-600 rounded-full border border-red-200 px-2 py-0.5 hover:bg-red-50"
                    title={a.status_message ?? ""}
                  >
                    <Icon d={I.retry} className="w-3 h-3" /> Retry
                  </button>
                ) : (
                  <span className="shrink-0 text-xs text-slate-500 flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full bg-red-500 animate-pulse" /> {STEPS.find(([s]) => s === a.status)?.[1]}
                  </span>
                )}
              </div>
              {failedRow && <div className="text-xs text-red-600 mt-1 line-clamp-2">{FAILED_LABEL[a.status]}: {a.status_message}</div>}
              {running && a.status_message && <div className="text-[11px] text-slate-400 mt-0.5">{a.status_message}</div>}
            </div>
          );
        })}
        {audits.length === 0 && <div className="px-5 py-8 text-center text-sm text-slate-400">No audits yet.</div>}
      </div>
    </div>
  );
}

function ProcessingView({ d, onRetry }: { d: AuditDetail; onRetry: () => void }) {
  const failed = FAILED.includes(d.status);
  const idx = STEPS.findIndex(([s]) => s === (failed ? (d.failed_stage as Status) : d.status));
  return (
    <div className="p-6 animate-fade-in">
      <div className="text-xs text-slate-500">{d.file_name} · {dur(d.original_duration_sec)}</div>
      <h2 className="text-lg font-semibold text-slate-900 mt-1">{failed ? FAILED_LABEL[d.status] : "Processing the full recording…"}</h2>
      <div className="mt-6 space-y-3">
        {STEPS.map(([s, label], i) => {
          const done = i < idx || (!failed && i < idx);
          const current = i === idx;
          return (
            <div key={s} className="flex items-center gap-3 text-sm">
              <span
                className={`h-6 w-6 rounded-full flex items-center justify-center text-[11px] font-semibold ${
                  done ? "bg-green-100 text-green-700" : current ? (failed ? "bg-red-100 text-red-700" : "bg-red-600 text-white") : "bg-slate-100 text-slate-400"
                }`}
              >
                {done ? "✓" : current && failed ? "!" : i + 1}
              </span>
              <span className={current ? "text-slate-900 font-medium" : done ? "text-slate-600" : "text-slate-400"}>{label}</span>
              {current && !failed && <span className="h-1.5 w-1.5 rounded-full bg-red-500 animate-pulse" />}
            </div>
          );
        })}
      </div>
      {d.status_message && <div className={`mt-6 text-sm rounded-lg p-3 ${failed ? "bg-red-50 text-red-700 border border-red-200" : "bg-slate-50 text-slate-600"}`}>{d.status_message}</div>}
      {failed && (
        <button onClick={onRetry} className="mt-4 flex items-center gap-2 rounded-lg bg-slate-900 text-white text-sm px-4 py-2 hover:bg-slate-800">
          <Icon d={I.retry} className="w-4 h-4" /> Retry
        </button>
      )}
      {d.stage_log && d.stage_log.length > 0 && (
        <details className="mt-6 text-xs text-slate-500">
          <summary className="cursor-pointer">Processing log</summary>
          <pre className="mt-2 whitespace-pre-wrap bg-slate-50 rounded p-2 max-h-64 overflow-auto">{d.stage_log.map((l) => `${l.at.slice(11, 19)} ${l.stage} ${JSON.stringify({ ...l, at: undefined, stage: undefined })}`).join("\n")}</pre>
        </details>
      )}
    </div>
  );
}

function ReportView({ d, audioUrl }: { d: AuditDetail; audioUrl: string | null }) {
  const r = d.report!;
  const [tab, setTab] = useState<"overview" | "coaching" | "transcript">("overview");
  const [query, setQuery] = useState("");
  const [focusSeg, setFocusSeg] = useState<number | null>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const transcript = d.transcript ?? [];

  const seek = (t: string | number | null) => {
    const sec = typeof t === "number" ? t : tsToSec(t);
    if (sec == null) return;
    if (audio.current) {
      audio.current.currentTime = sec;
      audio.current.play().catch(() => undefined);
    }
    const i = transcript.findIndex((s) => s.end >= sec);
    if (i >= 0) setFocusSeg(i);
  };

  async function downloadPdf() {
    const res = await authed(`/api/auditor/audits/${d.id}/pdf`);
    if (!res.ok) return;
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement("a");
    a.href = url;
    a.download = (res.headers.get("Content-Disposition") ?? "").match(/filename="([^"]+)"/)?.[1] ?? "QC-report.pdf";
    a.click();
    URL.revokeObjectURL(url);
  }

  const cats: Array<[string, number, number]> = [
    ["Communication", r.scores.communication, r.categoryWeights.communication],
    ["Resolution", r.scores.resolution, r.categoryWeights.resolution],
    ["CX Score", r.scores.customerExperience, r.categoryWeights.customer_experience],
    ["Compliance", r.scores.compliance, r.categoryWeights.compliance],
    ["Sales", r.scores.sales, r.categoryWeights.sales],
  ];
  const sentimentTone = (s: string) => (/positive|helpful|confident|friendly/i.test(s) ? "bg-green-50 text-green-700" : /negative|rude|rushed|frustrat/i.test(s) ? "bg-red-50 text-red-700" : "bg-amber-50 text-amber-700");

  return (
    <div className="p-6 animate-fade-in">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-xs text-slate-500">{[...(r.callTypeTags.length ? [r.callTypeTags.join(" | ")] : [r.callType])].join("")} · {dur(d.original_duration_sec)}</div>
          <h2 className="text-xl font-semibold text-slate-900 mt-0.5">{r.agentName ?? d.agent_name ?? "Not stated in transcript"}</h2>
          <div className="text-sm text-slate-500">Customer: {r.customerName ?? "Not stated"}{r.businessName ? ` · ${r.businessName}` : ""}</div>
        </div>
        <div className="flex items-center gap-3">
          <span className={`flex items-center gap-1 text-sm font-semibold rounded-full px-3 py-1 border ${r.pass ? "text-green-700 bg-green-50 border-green-200" : "text-red-700 bg-red-50 border-red-200"}`}>
            <Icon d={r.pass ? I.check : I.x} className="w-4 h-4" /> {r.pass ? "PASS" : "FAIL"}
          </span>
          <span className={`text-4xl font-bold tabular-nums ${scoreTone(r.scores.overall)}`}>{r.scores.overall}<span className="text-sm font-normal text-slate-400"> / 100</span></span>
          {d.has_pdf && (
            <button onClick={downloadPdf} className="flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50">
              <Icon d={I.pdf} className="w-4 h-4" /> PDF
            </button>
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-2 mt-3">
        <span className={`text-xs font-medium rounded-full px-3 py-1 ${sentimentTone(r.sentiment.customer)}`}>Customer: {r.sentiment.customer}</span>
        <span className={`text-xs font-medium rounded-full px-3 py-1 ${sentimentTone(r.sentiment.agent)}`}>Agent: {r.sentiment.agent}</span>
        {r.needsReview && <span className="text-xs font-medium rounded-full px-3 py-1 bg-amber-100 text-amber-800">Needs review</span>}
        <span className="text-xs rounded-full px-3 py-1 bg-slate-100 text-slate-600" title="How much of the recording the transcript covers">
          Transcript {Math.round((d.transcript_coverage ?? 0) * 100)}% · {dur(d.transcript_end_sec)} of {dur(d.original_duration_sec)}
        </span>
      </div>

      {audioUrl && (
        <div className="mt-4 flex items-center gap-2">
          <audio ref={audio} controls preload="metadata" src={audioUrl} className="w-full h-9" />
          <a href={`${audioUrl}?download=1`} className="shrink-0 flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs text-slate-700 hover:bg-slate-50" title={`Download the original recording (${((d.file_size ?? 0) / 1048576).toFixed(1)} MB)`}>
            <Icon d={I.download} className="w-3.5 h-3.5" /> Audio
          </a>
        </div>
      )}

      <div className="flex gap-6 border-b border-slate-200 mt-4 text-sm">
        {(["overview", "coaching", "transcript"] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`pb-2 -mb-px border-b-2 capitalize transition-colors ${tab === t ? "border-red-500 text-red-600 font-medium" : "border-transparent text-slate-500 hover:text-slate-800"}`}>
            {t}
          </button>
        ))}
      </div>

      {tab === "overview" && (
        <div key="o" className="mt-4 space-y-4 animate-fade-in">
          <div className="grid sm:grid-cols-3 gap-3">
            {cats.slice(0, 3).map(([label, score, w]) => <ScoreCard key={label} label={label} score={score} weight={w} />)}
          </div>
          <div className="grid sm:grid-cols-2 gap-3">
            {cats.slice(3).map(([label, score, w]) => <ScoreCard key={label} label={label} score={score} weight={w} />)}
          </div>

          <div className="rounded-2xl border border-slate-200 p-4">
            <div className="flex justify-between items-center mb-3">
              <div className="text-sm font-semibold text-slate-900">Sales Compliance Checks</div>
              <div className="text-xs text-slate-500">{Math.round(r.rulesWeight * 100)}% weight{r.scores.rules != null ? ` · ${r.scores.rules}%` : ""}</div>
            </div>
            <div className="grid sm:grid-cols-2 gap-2">
              {r.rules.map((rule, i) => (
                <div key={i} className={`rounded-xl border p-3 text-sm ${rule.result === "PASS" ? "bg-green-50 border-green-200" : rule.result === "PARTIAL" ? "bg-amber-50 border-amber-200" : rule.result === "FAIL" ? "bg-red-50 border-red-200" : "bg-slate-50 border-slate-200"}`}>
                  <div className="flex gap-2 items-start">
                    <ResultBadge r={rule.result} />
                    <span className="font-medium text-slate-900">{rule.rule}</span>
                  </div>
                  <div className="text-xs text-slate-600 mt-1">{rule.explanation || (rule.evidence.length ? "" : "Not found in transcript")}</div>
                  <EvidenceList list={rule.evidence} onSeek={seek} />
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-2xl border border-slate-200 p-4">
            <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Summary</div>
            <p className="text-sm text-slate-700 leading-relaxed">{r.executiveSummary}</p>
          </div>

          <div className="grid sm:grid-cols-3 gap-3">
            <FindingColumn tone="green" title="Green" items={r.findings.green} onSeek={seek} />
            <FindingColumn tone="yellow" title="Yellow" items={r.findings.yellow} onSeek={seek} />
            <FindingColumn tone="red" title="Red" items={r.findings.red} onSeek={seek} />
          </div>

          {r.complianceChecks.length > 0 && (
            <Section title="Compliance">
              {r.complianceChecks.map((c, i) => (
                <div key={i} className="py-2 border-t border-slate-100 first:border-0 text-sm">
                  <div className="flex items-center gap-2"><ResultBadge r={c.result} /> <span className="text-slate-800">{c.check}</span> <span className="text-[10px] text-slate-400 uppercase">{c.severity}</span></div>
                  <EvidenceList list={c.evidence} onSeek={seek} />
                </div>
              ))}
            </Section>
          )}

          {r.risks.length > 0 && (
            <Section title="Risks">
              {r.risks.map((k, i) => (
                <div key={i} className="py-2 border-t border-slate-100 first:border-0 text-sm">
                  <span className={`text-[10px] font-semibold uppercase mr-2 ${k.level === "high" ? "text-red-600" : k.level === "medium" ? "text-amber-600" : "text-slate-500"}`}>{k.level}</span>
                  {k.description}
                  <EvidenceList list={k.evidence} onSeek={seek} />
                </div>
              ))}
            </Section>
          )}

          <Section title="QC dimensions">
            <div className="grid sm:grid-cols-2 gap-x-6">
              {r.dimensions.map((dm) => (
                <details key={dm.key} className="py-2 border-t border-slate-100 text-sm group">
                  <summary className="flex justify-between cursor-pointer list-none">
                    <span className="text-slate-700">{dm.label}</span>
                    <span className={`font-semibold tabular-nums ${scoreTone(dm.score)}`}>{dm.score ?? "N/A"}</span>
                  </summary>
                  <div className="text-xs text-slate-600 mt-1">{dm.finding}</div>
                  <EvidenceList list={dm.evidence} onSeek={seek} />
                </details>
              ))}
            </div>
          </Section>
          <div className="text-[11px] text-slate-400">
            Evidence check: {r.evidenceStats.verified} of {r.evidenceStats.cited} quotes found verbatim in the transcript.
          </div>
        </div>
      )}

      {tab === "coaching" && (
        <div key="c" className="mt-4 space-y-4 animate-fade-in">
          <Section title="What went well">
            {r.wentWell.map((f, i) => <FindingItem key={i} f={f} onSeek={seek} />)}
          </Section>
          <Section title="Areas to improve">
            {r.toImprove.map((f, i) => <FindingItem key={i} f={f} onSeek={seek} />)}
          </Section>
          <Section title="Coaching recommendations">
            {r.coaching.map((c, i) => (
              <div key={i} className="py-2 border-t border-slate-100 first:border-0 text-sm">
                <div className="font-medium text-slate-900">{c.recommendation}</div>
                {c.why && <div className="text-slate-600 text-xs mt-0.5">{c.why}</div>}
                {c.example && <div className="mt-1 text-xs rounded-lg bg-green-50 text-green-800 p-2">Try: “{c.example}”</div>}
              </div>
            ))}
          </Section>
          <Section title="Key moments">
            {r.keyMoments.map((k, i) => (
              <button key={i} onClick={() => seek(k.timestamp)} className="w-full text-left py-2 border-t border-slate-100 first:border-0 text-sm hover:bg-slate-50 rounded">
                <span className="font-mono text-red-600 mr-2">{k.timestamp ?? "--:--"}</span>
                {k.description}
              </button>
            ))}
          </Section>
          {r.sentiment.trajectory && <Section title="Sentiment"><p className="text-sm text-slate-700">{r.sentiment.trajectory}</p></Section>}
        </div>
      )}

      {tab === "transcript" && (
        <TranscriptView segments={transcript} query={query} setQuery={setQuery} focus={focusSeg} onSeek={(s) => seek(s)} />
      )}
    </div>
  );
}

function ScoreCard({ label, score, weight }: { label: string; score: number; weight: number }) {
  // Bars grow in after mount: a cheap CSS width transition.
  const [w, setW] = useState(0);
  useEffect(() => {
    const t = requestAnimationFrame(() => setW(score));
    return () => cancelAnimationFrame(t);
  }, [score]);
  return (
    <div className="rounded-2xl border border-slate-200 p-4">
      <div className="flex justify-between text-sm text-slate-600">
        <span>{label}</span>
        <span className="text-slate-400">{Math.round(weight * 100)}%</span>
      </div>
      <div className={`text-2xl font-bold mt-1 tabular-nums ${scoreTone(score)}`}>{score}%</div>
      <div className="mt-2 h-2 rounded-full bg-slate-100 overflow-hidden">
        <div className={`h-full rounded-full ${barTone(score)} transition-[width] duration-700 ease-out`} style={{ width: `${w}%` }} />
      </div>
    </div>
  );
}

function FindingColumn({ tone, title, items, onSeek }: { tone: "green" | "yellow" | "red"; title: string; items: Finding[]; onSeek: (t: string | null) => void }) {
  const [open, setOpen] = useState(false);
  const cls = { green: "bg-green-50 border-green-200 text-green-700", yellow: "bg-amber-50 border-amber-200 text-amber-700", red: "bg-red-50 border-red-200 text-red-700" }[tone];
  const shown = open ? items : items.slice(0, 3);
  return (
    <div className={`rounded-2xl border p-3 ${cls}`}>
      <div className="text-sm font-semibold">{title} ({items.length})</div>
      <div className="mt-1 space-y-1">
        {shown.map((f, i) => (
          <div key={i} className="text-xs">
            <div className={open ? "font-medium" : "truncate"}>· {f.title}</div>
            {open && (
              <div className="text-slate-600 pl-2">
                {f.detail}
                <EvidenceList list={f.evidence} onSeek={onSeek} />
              </div>
            )}
          </div>
        ))}
        {items.length === 0 && <div className="text-xs opacity-70">None</div>}
      </div>
      {items.length > 0 && (
        <button onClick={() => setOpen(!open)} className="mt-1 text-[11px] underline opacity-80">{open ? "Show less" : "Show details"}</button>
      )}
    </div>
  );
}

function FindingItem({ f, onSeek }: { f: Finding; onSeek: (t: string | null) => void }) {
  const dot = { green: "bg-green-500", yellow: "bg-amber-400", red: "bg-red-500" }[f.rating];
  return (
    <div className="py-2 border-t border-slate-100 first:border-0 text-sm">
      <div className="flex items-center gap-2 font-medium text-slate-900"><span className={`h-2 w-2 rounded-full ${dot}`} /> {f.title}</div>
      <div className="text-xs text-slate-600 mt-0.5 pl-4">{f.detail}</div>
      <div className="pl-4"><EvidenceList list={f.evidence} onSeek={onSeek} /></div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-2xl border border-slate-200 p-4">
      <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">{title}</div>
      {children}
    </div>
  );
}

function TranscriptView({ segments, query, setQuery, focus, onSeek }: { segments: Segment[]; query: string; setQuery: (q: string) => void; focus: number | null; onSeek: (sec: number) => void }) {
  const q = query.trim().toLowerCase();
  const hits = useMemo(() => (q ? segments.map((s, i) => (s.text.toLowerCase().includes(q) ? i : -1)).filter((i) => i >= 0) : []), [segments, q]);
  const refs = useRef<Record<number, HTMLDivElement | null>>({});
  useEffect(() => {
    if (focus != null) refs.current[focus]?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [focus]);
  const fmtT = (s: number) => dur(s).replace(/^00:/, "");
  const mark = (text: string) => {
    if (!q) return text;
    const parts = text.split(new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "ig"));
    return parts.map((p, i) => (p.toLowerCase() === q ? <mark key={i} className="bg-yellow-200 rounded px-0.5">{p}</mark> : p));
  };
  return (
    <div className="mt-4 animate-fade-in">
      <div className="flex items-center gap-2 mb-3">
        <div className="relative flex-1">
          <Icon d={I.search} className="w-4 h-4 absolute left-2.5 top-2.5 text-slate-400" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search the transcript" className="w-full rounded-lg border border-slate-200 pl-8 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-200" />
        </div>
        {q && <span className="text-xs text-slate-500">{hits.length} match{hits.length === 1 ? "" : "es"}</span>}
      </div>
      <div className="max-h-[640px] overflow-auto space-y-1 pr-1">
        {segments.map((s, i) => {
          if (q && !hits.includes(i)) return null;
          const agent = s.role === "Agent";
          return (
            <div
              key={i}
              ref={(el) => (refs.current[i] = el)}
              onClick={() => onSeek(s.start)}
              className={`flex gap-3 rounded-lg px-2 py-1.5 text-sm cursor-pointer transition-colors ${focus === i ? "bg-yellow-50 ring-1 ring-yellow-200" : "hover:bg-slate-50"}`}
            >
              <span className="font-mono text-xs text-slate-400 pt-0.5 w-14 shrink-0">{fmtT(s.start)}</span>
              <span className={`text-xs font-semibold pt-0.5 w-16 shrink-0 ${agent ? "text-red-600" : s.role === "Customer" ? "text-slate-800" : "text-slate-400"}`}>{s.role}</span>
              <span className="text-slate-700">{mark(s.text)}</span>
            </div>
          );
        })}
      </div>
      <div className="text-[11px] text-slate-400 mt-2">{segments.length} segments · click a line to play from there</div>
    </div>
  );
}
