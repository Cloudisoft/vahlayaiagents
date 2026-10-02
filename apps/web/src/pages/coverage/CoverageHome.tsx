import { useEffect, useRef, useState } from "react";
import { api, ApiError, getAccessToken, refreshSession } from "../../lib/api.js";
import { useAuth } from "../../context/AuthContext.js";
import { Banner, Btn, Card, I, Icon, Skeleton, StatCard, inputCls } from "../../components/ui.js";

interface LookupResult {
  phoneOriginal: string;
  phoneE164: string;
  predictedCarrier: string | null;
  lineType: string | null;
  confidence: number | null;
  verificationStatus: string;
  verified: boolean;
  budgetExceeded: boolean;
  error?: string;
  confidencePct?: number | null;
  source?: string | null;
  twilioUsed?: boolean;
  prefixTrust?: string | null;
  portabilityDetected?: boolean;
  reasons?: string[];
  withheld?: boolean;
  likelyLineType?: string | null;
}

const SOURCE_LABEL: Record<string, string> = {
  twilio_validated: "Validated by Twilio now",
  twilio_cache: "Twilio-validated recently",
  phone_record: "Known number (history)",
  prefix_intelligence: "NPA-NXX intelligence",
  carrier_intelligence: "Carrier intelligence",
  neighbor_prefix: "Neighbouring prefixes",
  historical_inference: "Area-code history",
  unknown: "No evidence",
};

interface BulkJob {
  id: string;
  file_name: string | null;
  status: string;
  total: number;
  processed: number;
  summary: { unique?: number; twilioValidations?: number; costUsd?: number; budgetExceeded?: boolean; bySource?: Record<string, number>; twilioSoFar?: number };
  error: string | null;
  created_at: string;
}

async function authedFetch(path: string, init: RequestInit = {}) {
  const send = () => fetch(path, { ...init, credentials: "include", headers: { ...(init.headers ?? {}), Authorization: `Bearer ${getAccessToken()}` } });
  let res = await send();
  if (res.status === 401 && (await refreshSession())) res = await send();
  return res;
}

interface Stats {
  totalPredictions: number;
  verifiedPredictions: number;
  correctPredictions: number;
  incorrectPredictions: number;
  observedAccuracy: number | null;
  budget: { budgetUsd: number; spentUsd: number; remainingUsd: number };
}

export default function CoverageHome() {
  const [phone, setPhone] = useState("");
  const [result, setResult] = useState<LookupResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [busy, setBusy] = useState(false);
  const [bulkMessage, setBulkMessage] = useState<string | null>(null);
  const [jobs, setJobs] = useState<BulkJob[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);

  async function loadJobs() {
    const r = await api<{ jobs: BulkJob[] }>("/coverage/lookup/bulk");
    setJobs(r.jobs);
    return r.jobs;
  }
  useEffect(() => {
    loadJobs().catch(() => undefined);
  }, []);
  // Poll while a job is running.
  useEffect(() => {
    if (!jobs.some((j) => j.status === "queued" || j.status === "processing")) return;
    const t = setInterval(() => loadJobs().then(() => loadStats()).catch(() => undefined), 4000);
    return () => clearInterval(t);
  }, [jobs]);

  async function download(job: BulkJob) {
    const res = await authedFetch(`/api/coverage/lookup/bulk/${job.id}/results.csv`);
    if (!res.ok) return setError("Couldn't download the results.");
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement("a");
    a.href = url;
    a.download = `lookup-results-${(job.file_name ?? job.id).replace(/\.csv$/i, "")}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function loadStats() {
    const { stats } = await api<{ stats: Stats }>("/coverage/stats");
    setStats(stats);
  }

  useEffect(() => {
    loadStats();
  }, []);

  async function lookup() {
    setError(null);
    setResult(null);
    setBusy(true);
    try {
      const { result } = await api<{ result: LookupResult }>("/coverage/lookup", {
        method: "POST",
        body: { phone },
      });
      setResult(result);
      await loadStats();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Lookup failed.");
    } finally {
      setBusy(false);
    }
  }

  async function uploadBulk(file: File) {
    setBulkMessage(null);
    setError(null);
    const form = new FormData();
    form.append("file", file);
    setUploading(true);
    try {
      const res = await authedFetch("/api/coverage/lookup/bulk", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setBulkMessage(data.message);
      if (fileRef.current) fileRef.current.value = "";
      await Promise.all([loadStats(), loadJobs()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Bulk upload failed.");
    } finally {
      setUploading(false);
    }
  }

  const lt = result ? (result.withheld ? null : result.lineType) : null;
  const conf = result?.confidence != null ? Math.round(result.confidence * 100) : null;
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <span className="w-10 h-10 rounded-xl bg-red-50 text-red-600 flex items-center justify-center"><Icon d={I.phone} size={20} /></span>
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Coverage Intelligence</h1>
          <p className="text-sm text-slate-500">Line type and carrier for any US number — answered from Vahlay's own phone intelligence, verified live only when it matters.</p>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {!stats ? (
          Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-[88px]" />)
        ) : (
          <>
            <StatCard label="Lookups answered" value={stats.totalPredictions.toLocaleString()} icon={I.chart} hint={`${stats.verifiedPredictions.toLocaleString()} verified live`} />
            <StatCard label="Live checks today" value={`$${stats.budget.spentUsd.toFixed(2)}`} icon={I.shield} hint={`of $${stats.budget.budgetUsd.toFixed(2)} daily limit`} />
            <StatCard label="Accuracy standard" value="93%+" icon={I.check} tone="text-green-600" hint="less certain answers are marked Not classified" />
          </>
        )}
      </div>

      {error && <Banner kind="error" onClose={() => setError(null)}>{error}</Banner>}

      <div className="grid lg:grid-cols-5 gap-5">
        <Card title="Look up a number" className="lg:col-span-3">
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (phone.trim()) lookup(); }}>
            <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+1 555 123 4567" className={`${inputCls} text-base`} inputMode="tel" />
            <Btn type="submit" kind="primary" disabled={busy || !phone.trim()} className="px-5">{busy ? "Checking…" : "Look up"}</Btn>
          </form>
          {busy && <div className="mt-3 h-1 rounded-full bg-slate-100 overflow-hidden"><div className="h-full w-1/3 bg-red-500 animate-progress" /></div>}
          {!result && !busy && (
            <div className="mt-5 grid sm:grid-cols-3 gap-3 text-center">
              {[["Line type", "Mobile, landline or VoIP"], ["Carrier", "Who serves the number today"], ["Confidence", "How often answers like it are right"]].map(([t, d]) => (
                <div key={t} className="rounded-xl border border-dashed border-slate-200 p-4">
                  <div className="text-sm font-medium text-slate-700">{t}</div>
                  <div className="text-xs text-slate-400 mt-0.5">{d}</div>
                </div>
              ))}
              <p className="sm:col-span-3 text-xs text-slate-400">Any format works — (555) 123-4567, 555.123.4567 or +1 555 123 4567.</p>
            </div>
          )}
          {result && !busy && (
            <div className="mt-4 rounded-2xl border border-slate-200 p-4 animate-pop-in">
              {result.error ? (
                <div className="text-sm text-red-600">{result.error}</div>
              ) : (
                <>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="text-xs text-slate-500">Number</div>
                      <div className="text-lg font-semibold tabular-nums text-slate-900">{result.phoneE164 || "invalid"}</div>
                    </div>
                    {result.verified && <span className="text-[11px] font-semibold rounded-full bg-green-100 text-green-700 px-2 py-0.5">Verified live</span>}
                  </div>
                  <div className="grid sm:grid-cols-3 gap-3 mt-4">
                    <div className="rounded-xl bg-slate-50 p-3">
                      <div className="text-xs text-slate-500">Line type</div>
                      {result.withheld ? (
                        <>
                          <div className="text-base font-semibold text-amber-700">Not classified</div>
                          <div className="text-[11px] text-slate-500">best guess {result.likelyLineType ?? "—"}{conf != null ? ` · ${conf}%` : ""}</div>
                        </>
                      ) : (
                        <div className="text-base font-semibold text-slate-900 capitalize">{lt ?? "Unknown"}</div>
                      )}
                    </div>
                    <div className="rounded-xl bg-slate-50 p-3">
                      <div className="text-xs text-slate-500">Carrier</div>
                      <div className="text-base font-semibold text-slate-900 truncate">{result.predictedCarrier ?? "Unknown"}</div>
                    </div>
                    <div className="rounded-xl bg-slate-50 p-3">
                      <div className="text-xs text-slate-500">Confidence</div>
                      <div className="text-base font-semibold text-slate-900">{conf != null ? `${conf}%` : "—"}</div>
                      {conf != null && <div className="h-1 mt-1 rounded-full bg-slate-200 overflow-hidden"><div className={`h-full ${conf >= 93 ? "bg-green-500" : conf >= 75 ? "bg-amber-400" : "bg-red-400"}`} style={{ width: `${conf}%` }} /></div>}
                    </div>
                  </div>
                  <div className="text-xs text-slate-500 mt-3 space-y-0.5">
                    {result.source && (
                      <div>
                        Answered from: <span className="text-slate-700">{SOURCE_LABEL[result.source] ?? result.source}</span>
                        {result.prefixTrust && <> · exchange {result.prefixTrust}</>}
                        {result.twilioUsed && <> · checked with Twilio</>}
                      </div>
                    )}
                    {result.portabilityDetected && <div className="text-amber-700">Ported number — its earlier history said otherwise.</div>}
                    {result.reasons && result.reasons.length > 0 && <div>{result.reasons.join(" · ")}</div>}
                    {result.budgetExceeded && <div className="text-amber-700">Today's live-check limit is reached — showing the intelligence answer only.</div>}
                  </div>
                </>
              )}
            </div>
          )}
        </Card>
        <IntelligencePanel />
      </div>

      <Card title="Bulk lookup" action={<span className="text-xs text-slate-400">CSV with a “phone” column · up to 20,000 numbers</span>}>
        <div
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files[0]; if (f) uploadBulk(f); }}
          onClick={() => !uploading && fileRef.current?.click()}
          className={`rounded-2xl border-2 border-dashed px-5 py-5 flex items-center gap-4 cursor-pointer transition-colors ${drag ? "border-red-400 bg-red-50/60" : "border-slate-200 hover:border-red-200"}`}
        >
          <span className="w-10 h-10 rounded-xl bg-red-50 text-red-600 flex items-center justify-center shrink-0"><Icon d={I.upload} size={20} /></span>
          <div>
            <div className="text-sm font-medium text-slate-800">{uploading ? "Uploading…" : "Drop a CSV here or click to choose"}</div>
            <div className="text-xs text-slate-500">Answered from intelligence first; live checks are spent only where they teach the most, within the daily limit. Download the results when it's done.</div>
          </div>
          <input ref={fileRef} type="file" accept=".csv" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadBulk(f); }} />
        </div>
        {bulkMessage && <div className="mt-3"><Banner kind="ok" onClose={() => setBulkMessage(null)}>{bulkMessage}</Banner></div>}
        {jobs.length > 0 && (
          <ul className="mt-4 divide-y divide-slate-100">
            {jobs.map((j) => {
              const running = j.status === "queued" || j.status === "processing";
              const p = j.total ? Math.round((j.processed / j.total) * 100) : 0;
              return (
                <li key={j.id} className="py-3 flex flex-wrap items-center gap-4">
                  <span className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${j.status === "failed" ? "bg-red-50 text-red-600" : j.status === "completed" ? "bg-green-50 text-green-600" : "bg-sky-50 text-sky-600"}`}>
                    {running ? <span className="w-3.5 h-3.5 rounded-full border-2 border-sky-300 border-t-sky-600 animate-spin" /> : <Icon d={j.status === "failed" ? I.alert : I.file} size={15} />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-slate-800 truncate">{j.file_name ?? "Bulk lookup"}</div>
                    <div className="text-xs text-slate-500">
                      {new Date(j.created_at).toLocaleString()} · {(j.summary?.unique ?? j.total).toLocaleString()} numbers
                      {j.summary?.twilioValidations != null && <> · {j.summary.twilioValidations} live checks (${(j.summary.costUsd ?? 0).toFixed(2)})</>}
                    </div>
                    {running && <div className="h-1 mt-1.5 rounded-full bg-slate-100 overflow-hidden max-w-xs"><div className="h-full bg-sky-500 transition-[width]" style={{ width: `${Math.max(4, p)}%` }} /></div>}
                    {j.error && <div className="text-xs text-red-600 mt-0.5">{j.error}</div>}
                    {j.summary?.budgetExceeded && <div className="text-xs text-amber-700 mt-0.5">Daily live-check limit reached — the rest were answered from intelligence.</div>}
                  </div>
                  {j.status === "completed" ? <Btn onClick={() => download(j)}><Icon d={I.download} size={14} /> Results CSV</Btn> : <span className="text-xs text-slate-500 capitalize">{running ? (j.status === "queued" ? "Queued" : `Processing ${p}%`) : j.status}</span>}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
      <HistoryImport />
    </div>
  );
}

interface Intel {
  imports: Array<{ id: string; file_name: string; status: string; rows_valid: number; phones: number; error: string | null; created_at: string }>;
  totals: { observations: number; numbers: number; prefixes: number; carriers: number; twilio_verified_numbers: number };
  prefixTrust: Array<{ trust: string; n: number; avg_confidence: number }>;
  holdout: { evaluated: number; correct: number; coverage: number; by_type: Record<string, { n: number; correct: number }> } | null;
  audit: { samples: number; accuracy: number | null; byType: Record<string, { samples: number; accuracy: number | null }> };
  corrections: { samples: number; accuracy: number | null };
  portability30d: Record<string, number>;
  unknownRate30d: number | null;
  budgetToday: { limitUsd: number; priceUsd: number; spentUsd: number; remainingLookups: number; twilioLookups: number; localLookups: number };
  last30d: { spentUsd: number; lookups: number; twilioLookups: number; costPer1000: number | null };
}


// Plain-language explanation of how answers are produced.
function IntelligencePanel() {
  const points: Array<[string, string, string]> = [
    [I.chart, "Intelligence first", "Every lookup is answered from numbers we've seen before, what we know about each area code and exchange (NPA-NXX), and the carriers behind them. Recent information counts more than old, because numbers get ported over time."],
    [I.shield, "Live checks only when needed", "A brand-new number, conflicting history, or an exchange with heavy porting is checked live with Twilio, within a fixed daily limit. Each check improves the answers for every number in that exchange."],
    [I.upload, "Bulk works the same way", "Files are answered from intelligence first, and live checks are spent only where they teach the most. The confidence on each result is how often answers like it have been right."],
    [I.check, "Accuracy comes first", "A line type is only stated when answers like it are right at least 93% of the time, or Twilio verified it. Anything less certain is marked “Not classified” with its best guess beside it."],
  ];
  return (
    <Card title="How it works" className="lg:col-span-2">
      <ul className="space-y-3.5">
        {points.map(([icon, title, text]) => (
          <li key={title} className="flex gap-3">
            <span className="w-7 h-7 rounded-lg bg-slate-100 text-slate-500 flex items-center justify-center shrink-0"><Icon d={icon} size={14} /></span>
            <div>
              <div className="text-sm font-medium text-slate-800">{title}</div>
              <p className="text-xs text-slate-500 leading-relaxed mt-0.5">{text}</p>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

// Admins add historical lookup files that the intelligence learns from.
function HistoryImport() {
  const { user } = useAuth();
  const [d, setD] = useState<Intel | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  const load = () => api<Intel>("/coverage/intelligence").then(setD).catch(() => undefined);
  useEffect(() => {
    load();
  }, []);
  useEffect(() => {
    if (!d?.imports.some((i) => i.status === "processing")) return;
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [d]);
  const isAdmin = user?.role === "company_admin" || user?.role === "super_admin";
  if (!isAdmin || !d) return null;
  async function upload(f: File) {
    setBusy(true);
    setErr(null);
    setMsg(null);
    const form = new FormData();
    form.append("file", f);
    try {
      const res = await authedFetch("/api/coverage/intelligence/import", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setMsg(data.message);
      load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Import failed.");
    } finally {
      setBusy(false);
      if (ref.current) ref.current.value = "";
    }
  }
  return (
    <Card title="Historical data" action={<Btn onClick={() => ref.current?.click()} disabled={busy}><Icon d={I.upload} size={14} /> {busy ? "Uploading…" : "Add lookup history"}</Btn>}>
      <input ref={ref} type="file" accept=".csv" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); }} />
      <p className="text-sm text-slate-500">Past lookup exports (CSV with PHONE, TYPE, CARRIER_NAME, QUERIED_AT) teach the intelligence. The same file is never imported twice.</p>
      {msg && <div className="mt-2"><Banner kind="ok" onClose={() => setMsg(null)}>{msg}</Banner></div>}
      {err && <div className="mt-2"><Banner kind="error" onClose={() => setErr(null)}>{err}</Banner></div>}
      {d.imports.length > 0 && (
        <ul className="mt-3 divide-y divide-slate-100 text-sm">
          {d.imports.slice(0, 6).map((i) => (
            <li key={i.id} className="py-2 flex items-center justify-between gap-3">
              <span className="truncate text-slate-700">{i.file_name}</span>
              <span className={`text-xs shrink-0 ${i.status === "failed" ? "text-red-600" : "text-slate-500"}`}>
                {i.status === "completed" ? `${i.rows_valid.toLocaleString()} rows · ${i.phones.toLocaleString()} numbers` : i.status === "processing" ? "Importing…" : i.error ?? i.status}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
