import { useEffect, useRef, useState } from "react";
import { api, ApiError, getAccessToken, refreshSession } from "../../lib/api.js";
import { useAuth } from "../../context/AuthContext.js";

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

  async function uploadBulk() {
    const file = fileRef.current?.files?.[0];
    if (!file) return;
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

  return (
    <div className="max-w-4xl space-y-6">
      <h1 className="text-2xl font-semibold text-slate-900">Vahlay Coverage</h1>

      {stats && (
        <div className="grid grid-cols-3 gap-4">
          <StatCard label="Total predictions" value={stats.totalPredictions} />
          <StatCard label="Verified" value={stats.verifiedPredictions} />
          <StatCard
            label="Observed accuracy"
            value={stats.observedAccuracy === null ? "—" : `${(stats.observedAccuracy * 100).toFixed(1)}%`}
          />
        </div>
      )}

      {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-2">{error}</div>}

      <IntelligencePanel />

      <div className="bg-white border border-slate-200 rounded-xl p-6">
        <h2 className="font-medium text-slate-900 mb-3">Single lookup</h2>
        <div className="flex gap-2">
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="+1 555 123 4567"
            className="flex-1 border border-slate-300 rounded-md px-3 py-2 text-sm"
          />
          <button onClick={lookup} disabled={busy} className="bg-red-600 text-white text-sm font-medium rounded-md px-4 py-2 hover:bg-red-700 disabled:opacity-50">
            {busy ? "Looking up..." : "Lookup"}
          </button>
        </div>
        {result && (
          <div className="mt-4 bg-slate-50 rounded-md p-4 text-sm space-y-1">
            <div><span className="text-slate-500">Normalized: </span>{result.phoneE164 || "invalid"}</div>
            <div><span className="text-slate-500">Carrier: </span>{result.predictedCarrier ?? "unknown"}</div>
            <div>
              <span className="text-slate-500">Line type: </span>
              {result.withheld ? (
                <>
                  <span className="text-xs rounded-full bg-amber-100 text-amber-800 px-2 py-0.5">Not classified</span>
                  <span className="text-slate-500 text-xs ml-2">best guess: {result.likelyLineType} ({Math.round((result.confidence ?? 0) * 100)}%)</span>
                </>
              ) : (
                result.lineType ?? "unknown"
              )}
            </div>
            <div><span className="text-slate-500">Status: </span>{result.verificationStatus}{result.verified && <span className="ml-2 text-xs rounded-full bg-green-100 text-green-800 px-2 py-0.5">Verified</span>}</div>
            <div><span className="text-slate-500">Confidence: </span>{result.confidence !== null ? `${Math.round(result.confidence * 100)}%` : "—"}</div>
            {result.source && (
              <div>
                <span className="text-slate-500">Source: </span>
                {SOURCE_LABEL[result.source] ?? result.source}
                {result.prefixTrust && <span className="text-xs text-slate-400"> · prefix {result.prefixTrust}</span>}
                {result.twilioUsed && <span className="text-xs text-slate-400"> · Twilio used</span>}
              </div>
            )}
            {result.portabilityDetected && <div className="text-amber-700">Ported number detected — its history said otherwise.</div>}
            {result.reasons && result.reasons.length > 0 && <div className="text-xs text-slate-500">{result.reasons.join(" · ")}</div>}
            {result.budgetExceeded && <div className="text-amber-600">Live verification unavailable right now — showing prediction only.</div>}
            {result.error && <div className="text-red-600">{result.error}</div>}
          </div>
        )}
      </div>

      <div className="bg-white border border-slate-200 rounded-xl p-6">
        <h2 className="font-medium text-slate-900 mb-3">Bulk CSV lookup</h2>
        <p className="text-sm text-slate-500 mb-3">
          CSV must include a "phone" column. Up to 20,000 numbers per file. Numbers are answered from history and NPA-NXX intelligence first;
          Twilio checks are spent only where they teach the most, within the daily limit.
        </p>
        <div className="flex gap-2 items-center">
          <input ref={fileRef} type="file" accept=".csv" className="text-sm" />
          <button onClick={uploadBulk} disabled={uploading} className="bg-slate-900 text-white text-sm font-medium rounded-md px-4 py-2 hover:bg-slate-800 disabled:opacity-50">
            {uploading ? "Uploading…" : "Upload"}
          </button>
        </div>
        {bulkMessage && <div className="mt-3 text-sm text-green-700">{bulkMessage}</div>}
        {jobs.length > 0 && (
          <table className="w-full text-sm mt-4">
            <thead className="text-xs text-slate-500 uppercase">
              <tr><th className="text-left py-1">File</th><th className="text-left py-1">Status</th><th className="text-right py-1">Numbers</th><th className="text-right py-1">Twilio</th><th /></tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id} className="border-t border-slate-100">
                  <td className="py-1.5">{j.file_name ?? "—"}<div className="text-xs text-slate-400">{new Date(j.created_at).toLocaleString()}</div></td>
                  <td className="py-1.5">
                    {j.status === "processing" ? `Processing… ${j.summary?.twilioSoFar ? `${j.summary.twilioSoFar} checks so far` : ""}` : j.status}
                    {j.error && <div className="text-xs text-red-600">{j.error}</div>}
                    {j.summary?.budgetExceeded && <div className="text-xs text-amber-700">Daily Twilio limit reached — rest answered locally.</div>}
                  </td>
                  <td className="py-1.5 text-right tabular-nums">{(j.summary?.unique ?? j.total).toLocaleString()}</td>
                  <td className="py-1.5 text-right tabular-nums">
                    {j.summary?.twilioValidations ?? "—"}
                    {j.summary?.costUsd != null && <div className="text-xs text-slate-400">${j.summary.costUsd.toFixed(2)}</div>}
                  </td>
                  <td className="py-1.5 text-right">
                    {j.status === "completed" && <button onClick={() => download(j)} className="text-xs text-red-600 hover:underline">Download CSV</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
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

const pct = (v: number | null | undefined) => (v == null ? "—" : `${(v * 100).toFixed(1)}%`);

// How good the intelligence actually is, measured three independent ways.
function IntelligencePanel() {
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
  if (!d) return null;
  const trust = Object.fromEntries(d.prefixTrust.map((t) => [t.trust, t]));
  const holdAcc = d.holdout ? d.holdout.correct / Math.max(1, d.holdout.evaluated) : null;
  const isAdmin = user?.role === "company_admin" || user?.role === "super_admin";
  return (
    <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="font-medium text-slate-900">How phone intelligence works</h2>

      </div>
      <div className="text-sm text-slate-600 leading-relaxed space-y-2">
        <p>
          Every lookup is answered first from Vahlay's own phone intelligence: numbers we have seen before, what we know about each
          area code and exchange (NPA-NXX), and the carriers behind them. Older information counts for less than recent information,
          because numbers get ported between carriers and line types over time.
        </p>
        <p>
          When the answer isn't certain — a brand-new number, conflicting history, or an exchange where numbers are being ported — the
          number is checked live with Twilio, within a fixed daily limit. Each live check is saved and improves the answers for every
          other number in the same exchange, so the system gets more accurate the more it is used.
        </p>
        <p>
          Bulk files work the same way: numbers are answered from intelligence first, and live checks are spent only where they teach
          the most. The confidence shown with each result is how often answers like it have been right.
        </p>
        <p>
          Accuracy comes first: a line type is only stated when answers like it are right at least 93% of the time (or Twilio has
          verified it). Anything less certain is marked "Not classified" and its best guess is shown beside it, so the line types you
          rely on stay at 93–95% accuracy.
        </p>
      </div>
      {isAdmin && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-slate-500">Add historical lookups (CSV with PHONE, TYPE, CARRIER_NAME, QUERIED_AT):</span>
          <input ref={ref} type="file" accept=".csv" className="text-sm" />
          <button
            disabled={busy}
            onClick={async () => {
              const f = ref.current?.files?.[0];
              if (!f) return;
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
              }
            }}
            className="bg-slate-900 text-white text-sm rounded-md px-3 py-1.5 disabled:opacity-50"
          >
            {busy ? "Uploading…" : "Import"}
          </button>
          {msg && <span className="text-green-700">{msg}</span>}
          {err && <span className="text-red-600">{err}</span>}
        </div>
      )}
      {d.imports.length > 0 && (
        <div className="text-xs text-slate-500 space-y-0.5">
          {d.imports.slice(0, 5).map((i) => (
            <div key={i.id}>
              {i.file_name}: {i.status}
              {i.status === "completed" ? ` · ${i.rows_valid.toLocaleString()} rows · ${i.phones.toLocaleString()} numbers` : ""}
              {i.error ? ` · ${i.error}` : ""}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Mini({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg bg-slate-50 p-3">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="text-lg font-semibold text-slate-900">{value}</div>
      {hint && <div className="text-[11px] text-slate-500">{hint}</div>}
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="bg-white border border-slate-200 rounded-xl p-4">
      <div className="text-xs text-slate-500 mb-1">{label}</div>
      <div className="text-xl font-semibold text-slate-900">{value}</div>
    </div>
  );
}
