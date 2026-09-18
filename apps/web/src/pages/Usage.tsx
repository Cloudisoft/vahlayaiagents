import { useEffect, useState } from "react";
import { api } from "../lib/api.js";

interface UsageData {
  byCategory: Array<{ category: string; units: string; cost_usd: string; events: string }>;
  storage: { totalBytes: number; fileCount: number; driver: string };
  balances: Record<string, { balanceUsd: number | null; error?: string; note?: string }>;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export default function Usage() {
  const [data, setData] = useState<UsageData | null>(null);

  useEffect(() => {
    api<UsageData>("/usage").then(setData);
  }, []);

  if (!data) return <div className="text-sm text-slate-500">Loading...</div>;

  const totalCost = data.byCategory.reduce((sum, c) => sum + Number(c.cost_usd), 0);

  return (
    <div className="max-w-3xl space-y-6">
      <h1 className="text-2xl font-semibold text-slate-900">Usage &amp; Balances</h1>

      <div className="bg-white border border-slate-200 rounded-xl p-6">
        <h2 className="font-medium text-slate-900 mb-3">Spend by category (tracked by this platform)</h2>
        {data.byCategory.length === 0 ? (
          <p className="text-sm text-slate-500">No usage recorded yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-xs text-slate-500 uppercase">
              <tr>
                <th className="text-left py-1">Category</th>
                <th className="text-left py-1">Events</th>
                <th className="text-left py-1">Cost</th>
              </tr>
            </thead>
            <tbody>
              {data.byCategory.map((c) => (
                <tr key={c.category} className="border-t border-slate-100">
                  <td className="py-1 capitalize">{c.category}</td>
                  <td className="py-1 text-slate-500">{c.events}</td>
                  <td className="py-1">${Number(c.cost_usd).toFixed(4)}</td>
                </tr>
              ))}
              <tr className="border-t border-slate-200 font-medium">
                <td className="py-1">Total</td>
                <td></td>
                <td className="py-1">${totalCost.toFixed(4)}</td>
              </tr>
            </tbody>
          </table>
        )}
      </div>

      <div className="bg-white border border-slate-200 rounded-xl p-6">
        <h2 className="font-medium text-slate-900 mb-3">Storage</h2>
        <p className="text-sm text-slate-600">
          {formatBytes(data.storage.totalBytes)} across {data.storage.fileCount} files ({data.storage.driver} driver)
        </p>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl p-6">
        <h2 className="font-medium text-slate-900 mb-3">Provider balances</h2>
        <div className="space-y-2 text-sm">
          {Object.entries(data.balances).map(([provider, info]) => (
            <div key={provider} className="flex justify-between">
              <span className="capitalize">{provider}</span>
              <span className="text-slate-500">
                {info.balanceUsd !== null ? `$${info.balanceUsd.toFixed(2)}` : info.error ?? info.note ?? "Unavailable"}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
