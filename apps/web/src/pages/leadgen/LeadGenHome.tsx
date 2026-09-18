import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../../lib/api.js";

interface LeadList {
  id: string;
  name: string;
  lead_count: string;
}

interface Lead {
  id: string;
  business_name: string;
  city: string | null;
  state: string | null;
  website: string | null;
  main_phone: string | null;
  business_email: string | null;
  quality_score: number | null;
  source: string;
}

export default function LeadGenHome() {
  const [lists, setLists] = useState<LeadList[]>([]);
  const [selectedList, setSelectedList] = useState<string>("");
  const [leads, setLeads] = useState<Lead[]>([]);
  const [keywords, setKeywords] = useState("");
  const [state, setState] = useState("");
  const [city, setCity] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const importRef = useRef<HTMLInputElement>(null);

  async function loadLists() {
    const { lists } = await api<{ lists: LeadList[] }>("/leadgen/lists");
    setLists(lists);
    if (!selectedList && lists.length > 0) setSelectedList(lists[0].id);
  }

  async function loadLeads(listId: string) {
    if (!listId) return setLeads([]);
    const { leads } = await api<{ leads: Lead[] }>(`/leadgen/leads?listId=${listId}`);
    setLeads(leads);
  }

  useEffect(() => {
    loadLists();
  }, []);

  useEffect(() => {
    loadLeads(selectedList);
  }, [selectedList]);

  async function runSearch() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await api<{ message: string; leadListId: string; savedCount?: number; duplicateCount?: number; totalFound?: number; error?: string }>(
        "/leadgen/search",
        { method: "POST", body: { keywords, state, city } }
      );
      if (result.error) {
        setError(result.error);
      } else {
        setMessage(
          `${result.message}${result.savedCount !== undefined ? ` Saved ${result.savedCount}, ${result.duplicateCount} duplicates skipped, ${result.totalFound} found.` : ""}`
        );
      }
      await loadLists();
      setSelectedList(result.leadListId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Search failed.");
    } finally {
      setBusy(false);
    }
  }

  async function importCsv() {
    const file = importRef.current?.files?.[0];
    if (!file) return;
    const form = new FormData();
    form.append("file", file);
    if (selectedList) form.append("leadListId", selectedList);
    const res = await fetch("/api/leadgen/leads/import", { method: "POST", body: form, credentials: "include" });
    const data = await res.json();
    setMessage(`Imported ${data.imported} leads.`);
    await loadLeads(selectedList);
  }

  function exportCsv() {
    window.open(`/api/leadgen/leads/export${selectedList ? `?listId=${selectedList}` : ""}`, "_blank");
  }

  return (
    <div className="max-w-5xl space-y-6">
      <h1 className="text-2xl font-semibold text-slate-900">Vahlay LeadGen</h1>

      {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-2">{error}</div>}
      {message && <div className="text-sm text-green-700 bg-green-50 border border-green-200 rounded-md p-2">{message}</div>}

      <div className="bg-white border border-slate-200 rounded-xl p-6">
        <h2 className="font-medium text-slate-900 mb-3">Discover leads</h2>
        <div className="grid grid-cols-3 gap-3 mb-3">
          <input placeholder="e.g. Roofing companies" value={keywords} onChange={(e) => setKeywords(e.target.value)} className="border border-slate-300 rounded-md px-3 py-2 text-sm" />
          <input placeholder="State (e.g. Texas)" value={state} onChange={(e) => setState(e.target.value)} className="border border-slate-300 rounded-md px-3 py-2 text-sm" />
          <input placeholder="City" value={city} onChange={(e) => setCity(e.target.value)} className="border border-slate-300 rounded-md px-3 py-2 text-sm" />
        </div>
        <button onClick={runSearch} disabled={busy || !keywords} className="bg-red-600 text-white text-sm font-medium rounded-md px-4 py-2 hover:bg-red-700 disabled:opacity-50">
          {busy ? "Searching..." : "Search"}
        </button>
      </div>

      <div className="flex items-center justify-between">
        <select value={selectedList} onChange={(e) => setSelectedList(e.target.value)} className="border border-slate-300 rounded-md px-3 py-2 text-sm">
          <option value="">All lists</option>
          {lists.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name} ({l.lead_count})
            </option>
          ))}
        </select>
        <div className="flex gap-2">
          <input ref={importRef} type="file" accept=".csv" className="text-sm" />
          <button onClick={importCsv} className="text-sm bg-slate-900 text-white rounded-md px-3 py-1.5 hover:bg-slate-800">
            Import CSV
          </button>
          <button onClick={exportCsv} className="text-sm bg-white border border-slate-300 rounded-md px-3 py-1.5 hover:bg-slate-50">
            Export CSV
          </button>
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-500 text-xs uppercase">
            <tr>
              <th className="text-left px-4 py-2">Business</th>
              <th className="text-left px-4 py-2">Location</th>
              <th className="text-left px-4 py-2">Website</th>
              <th className="text-left px-4 py-2">Phone</th>
              <th className="text-left px-4 py-2">Email</th>
              <th className="text-left px-4 py-2">Quality</th>
            </tr>
          </thead>
          <tbody>
            {leads.map((l) => (
              <tr key={l.id} className="border-t border-slate-100">
                <td className="px-4 py-2 font-medium text-slate-900">{l.business_name}</td>
                <td className="px-4 py-2 text-slate-500">{[l.city, l.state].filter(Boolean).join(", ") || "—"}</td>
                <td className="px-4 py-2 text-slate-500">
                  {l.website ? (
                    <a href={l.website} target="_blank" rel="noreferrer" className="text-red-600 hover:underline">
                      {l.website.replace(/^https?:\/\//, "")}
                    </a>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="px-4 py-2 text-slate-500">{l.main_phone ?? "—"}</td>
                <td className="px-4 py-2 text-slate-500">{l.business_email ?? "—"}</td>
                <td className="px-4 py-2">{l.quality_score ?? "—"}</td>
              </tr>
            ))}
            {leads.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-slate-500">
                  No leads yet. Run a search or import a CSV.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
