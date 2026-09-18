import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../../lib/api.js";

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
  const fileRef = useRef<HTMLInputElement>(null);

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
    try {
      const res = await fetch("/api/coverage/lookup/bulk", { method: "POST", body: form, credentials: "include" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setBulkMessage(data.message);
      await loadStats();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Bulk upload failed.");
    }
  }

  return (
    <div className="max-w-3xl space-y-6">
      <h1 className="text-2xl font-semibold text-slate-900">Vahlay Coverage</h1>

      {stats && (
        <div className="grid grid-cols-4 gap-4">
          <StatCard label="Total predictions" value={stats.totalPredictions} />
          <StatCard label="Verified" value={stats.verifiedPredictions} />
          <StatCard
            label="Observed accuracy"
            value={stats.observedAccuracy === null ? "—" : `${(stats.observedAccuracy * 100).toFixed(1)}%`}
          />
          <StatCard label="Budget remaining" value={`$${stats.budget.remainingUsd.toFixed(2)} / $${stats.budget.budgetUsd.toFixed(2)}`} />
        </div>
      )}

      {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-2">{error}</div>}

      <div className="bg-white border border-slate-200 rounded-xl p-6">
        <h2 className="font-medium text-slate-900 mb-3">Single lookup</h2>
        <div className="flex gap-2">
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="+1 555 123 4567"
            className="flex-1 border border-slate-300 rounded-md px-3 py-2 text-sm"
          />
          <button onClick={lookup} disabled={busy} className="bg-indigo-600 text-white text-sm font-medium rounded-md px-4 py-2 hover:bg-indigo-700 disabled:opacity-50">
            {busy ? "Looking up..." : "Lookup"}
          </button>
        </div>
        {result && (
          <div className="mt-4 bg-slate-50 rounded-md p-4 text-sm space-y-1">
            <div><span className="text-slate-500">Normalized: </span>{result.phoneE164 || "invalid"}</div>
            <div><span className="text-slate-500">Carrier: </span>{result.predictedCarrier ?? "unknown"}</div>
            <div><span className="text-slate-500">Line type: </span>{result.lineType ?? "unknown"}</div>
            <div><span className="text-slate-500">Status: </span>{result.verificationStatus}</div>
            <div><span className="text-slate-500">Confidence: </span>{result.confidence !== null ? `${Math.round(result.confidence * 100)}%` : "—"}</div>
            {result.budgetExceeded && <div className="text-amber-600">Verification budget exceeded — showing prediction only.</div>}
            {result.error && <div className="text-red-600">{result.error}</div>}
          </div>
        )}
      </div>

      <div className="bg-white border border-slate-200 rounded-xl p-6">
        <h2 className="font-medium text-slate-900 mb-3">Bulk CSV lookup</h2>
        <p className="text-sm text-slate-500 mb-3">CSV must include a "phone" column.</p>
        <div className="flex gap-2 items-center">
          <input ref={fileRef} type="file" accept=".csv" className="text-sm" />
          <button onClick={uploadBulk} className="bg-slate-900 text-white text-sm font-medium rounded-md px-4 py-2 hover:bg-slate-800">
            Upload
          </button>
        </div>
        {bulkMessage && <div className="mt-3 text-sm text-green-700">{bulkMessage}</div>}
      </div>
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
