import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError, getAccessToken, refreshSession } from "../../lib/api.js";
import { invalidate, useApi } from "../../lib/useApi.js";
import { K } from "../../lib/voiceKeys.js";
import { DispositionBadge, btnGhost, btnPrimary, formatPhone, formatSeconds, inputCls } from "../../lib/voice.js";

interface LeadRow {
  id: string;
  business_name: string | null;
  first_name: string | null;
  last_name: string | null;
  main_phone_e164: string | null;
  business_email: string | null;
  state: string | null;
  current_provider: string | null;
  customer_type: string | null;
  call_status: string | null;
  status_label: string | null;
  status_color: string | null;
  attempts: number;
  last_called_at: string | null;
  is_dnc: boolean;
  list_name: string | null;
}
interface LeadList {
  id: string;
  name: string;
  description: string | null;
  lead_count: number;
  never_called: number;
}
type PasteResult = { input: string; result: string | null; status: "added" | "invalid" | "duplicate" | "dnc"; reason?: string };

const EMPTY = { search: "", callStatus: "", customerType: "", dnc: "", listId: "", called: "" };

async function uploadFile(path: string, form: FormData): Promise<any> {
  const send = () =>
    fetch(`/api${path}`, { method: "POST", credentials: "include", headers: { Authorization: `Bearer ${getAccessToken()}` }, body: form });
  let res = await send();
  if (res.status === 401 && (await refreshSession())) res = await send();
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error ?? "Upload failed.", res.status);
  return data;
}

export default function VoiceLeads() {
  const [filters, setFilters] = useState(EMPTY);
  const [applied, setApplied] = useState(EMPTY);
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [panel, setPanel] = useState<"" | "add" | "paste" | "import" | "lists">("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const listKey = (() => {
    const q = new URLSearchParams({ page: String(page) });
    for (const [k, v] of Object.entries(applied)) if (v) q.set(k, v);
    return K.leads(q.toString());
  })();
  const leadsQ = useApi<{ leads: LeadRow[]; total: number }>(listKey);
  const listsQ = useApi<{ lists: LeadList[] }>("/voice/insights/lead-lists");
  const campaigns = useApi<{ campaigns: Array<{ id: string; name: string }> }>(K.campaigns).data?.campaigns ?? [];
  const codes = useApi<{ dispositions: Array<{ key: string; label: string }> }>(K.dispositions).data?.dispositions ?? [];
  const lists = listsQ.data?.lists ?? [];
  const rows = leadsQ.data?.leads ?? [];
  const total = leadsQ.data?.total ?? 0;

  async function refresh() {
    invalidate("/voice/insights/leads");
    invalidate("/voice/insights/lead-lists");
    await Promise.all([leadsQ.reload(), listsQ.reload()]);
  }

  async function run(fn: () => Promise<string | void>) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const m = await fn();
      if (m) setMessage(m);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Request failed.");
    } finally {
      setBusy(false);
    }
  }

  function bulk(action: string, extra: Record<string, string> = {}) {
    const ids = [...selected];
    if (action === "delete" && !confirm(`Delete ${ids.length} lead(s)? Their call history stays in Call Records.`)) return;
    run(async () => {
      const r = await api<{ message: string }>("/voice/insights/leads/bulk", { method: "POST", body: { ids, action, ...extra } });
      if (action === "delete") setSelected(new Set());
      return r.message;
    });
  }

  const allOnPage = rows.length > 0 && rows.every((r) => selected.has(r.id));

  return (
    <div className="max-w-7xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold text-slate-900">Leads</h1>
        <div className="flex flex-wrap gap-2">
          <button onClick={() => setPanel(panel === "paste" ? "" : "paste")} className={btnPrimary}>Paste numbers</button>
          <button onClick={() => setPanel(panel === "import" ? "" : "import")} className={btnGhost}>Import CSV / Excel</button>
          <button onClick={() => setPanel(panel === "add" ? "" : "add")} className={btnGhost}>+ Add lead</button>
          <button onClick={() => setPanel(panel === "lists" ? "" : "lists")} className={btnGhost}>Lead lists ({lists.length})</button>
        </div>
      </div>

      {panel === "paste" && <PastePanel lists={lists} campaigns={campaigns} onDone={async (m) => { setMessage(m); await refresh(); }} />}
      {panel === "import" && (
        <ImportPanel lists={lists} campaigns={campaigns} busy={busy} onImport={(form) => run(async () => {
          const r = await uploadFile("/voice/insights/leads/import", form);
          setPanel("");
          const s = r.summary;
          return `Imported ${s.imported} lead(s)${s.duplicates ? `, ${s.duplicates} duplicate(s) skipped` : ""}${s.dncMarked ? `, ${s.dncMarked} on DNC` : ""}.${s.totalErrors ? ` ${s.totalErrors} row(s) had problems: ${s.errors.slice(0, 3).join(" ")}` : ""}`;
        })} />
      )}
      {panel === "add" && <AddLeadPanel lists={lists} campaigns={campaigns} busy={busy} onAdd={(body) => run(async () => {
        await api("/voice/insights/leads", { method: "POST", body });
        return "Lead added.";
      })} />}
      {panel === "lists" && <ListsPanel lists={lists} run={run} onOpen={(id) => { const f = { ...EMPTY, listId: id }; setFilters(f); setApplied(f); setPage(1); setPanel(""); }} />}

      {message && <div className="text-sm text-green-700 bg-green-50 border border-green-200 rounded-md p-2">{message}</div>}
      {(error || leadsQ.error) && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-2">{error || leadsQ.error}</div>}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          setPage(1);
          setApplied(filters);
        }}
        className="bg-white border border-slate-200 rounded-xl p-3 grid grid-cols-2 md:grid-cols-7 gap-2"
      >
        <input value={filters.search} onChange={(e) => setFilters({ ...filters, search: e.target.value })} placeholder="Name, business, phone, email" className={`${inputCls} col-span-2`} />
        <select value={filters.listId} onChange={(e) => setFilters({ ...filters, listId: e.target.value })} className={inputCls}>
          <option value="">All lists</option>
          <option value="none">Not in a list</option>
          {lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
        <select value={filters.callStatus} onChange={(e) => setFilters({ ...filters, callStatus: e.target.value })} className={inputCls}>
          <option value="">Any status</option>
          {codes.map((c) => <option key={c.key} value={c.key}>{c.key} – {c.label}</option>)}
        </select>
        <select value={filters.called} onChange={(e) => setFilters({ ...filters, called: e.target.value })} className={inputCls}>
          <option value="">Called or not</option>
          <option value="never">Never called</option>
          <option value="yes">Called at least once</option>
        </select>
        <select value={filters.dnc} onChange={(e) => setFilters({ ...filters, dnc: e.target.value })} className={inputCls}>
          <option value="">DNC + not DNC</option>
          <option value="true">DNC only</option>
          <option value="false">Not DNC</option>
        </select>
        <div className="flex gap-2">
          <button className="bg-slate-900 text-white text-sm rounded-md px-4 flex-1">Go</button>
          <button type="button" onClick={() => { setFilters(EMPTY); setApplied(EMPTY); setPage(1); }} className="text-sm text-slate-500 px-1">Clear</button>
        </div>
      </form>

      {selected.size > 0 && (
        <BulkBar
          count={selected.size}
          lists={lists}
          campaigns={campaigns}
          onClear={() => setSelected(new Set())}
          onAction={bulk}
        />
      )}

      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-500 text-xs uppercase">
            <tr>
              <th className="px-3 py-2 w-8">
                <input
                  type="checkbox"
                  aria-label="Select all leads on this page"
                  checked={allOnPage}
                  onChange={(e) => {
                    const next = new Set(selected);
                    for (const r of rows) e.target.checked ? next.add(r.id) : next.delete(r.id);
                    setSelected(next);
                  }}
                />
              </th>
              <th className="text-left px-3 py-2">Lead</th>
              <th className="text-left px-3 py-2">Phone</th>
              <th className="text-left px-3 py-2">List</th>
              <th className="text-left px-3 py-2">Provider</th>
              <th className="text-left px-3 py-2">Status</th>
              <th className="text-right px-3 py-2">Attempts</th>
              <th className="text-left px-3 py-2">Last called</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((l) => (
              <tr key={l.id} onClick={() => setOpenId(l.id)} className={`border-t border-slate-100 cursor-pointer ${openId === l.id ? "bg-red-50" : selected.has(l.id) ? "bg-slate-50" : "hover:bg-slate-50"}`}>
                <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    aria-label="Select lead"
                    checked={selected.has(l.id)}
                    onChange={(e) => {
                      const next = new Set(selected);
                      e.target.checked ? next.add(l.id) : next.delete(l.id);
                      setSelected(next);
                    }}
                  />
                </td>
                <td className="px-3 py-2">
                  <div className="font-medium text-slate-900">{[l.first_name, l.last_name].filter(Boolean).join(" ") || l.business_name}</div>
                  {(l.first_name || l.last_name) && l.business_name !== [l.first_name, l.last_name].filter(Boolean).join(" ") && <div className="text-xs text-slate-500">{l.business_name}</div>}
                  {l.business_email && <div className="text-xs text-slate-400">{l.business_email}</div>}
                </td>
                <td className="px-3 py-2 text-slate-600 whitespace-nowrap">{formatPhone(l.main_phone_e164)}{l.is_dnc && <span className="ml-1 text-xs text-red-600">DNC</span>}</td>
                <td className="px-3 py-2 text-xs text-slate-500">{l.list_name ?? "—"}</td>
                <td className="px-3 py-2 text-slate-600">
                  {l.current_provider ?? "—"}
                  {l.customer_type && <span className="ml-1 text-xs text-slate-400">{l.customer_type === "alc" ? "ALC" : "non-ALC"}</span>}
                </td>
                <td className="px-3 py-2"><DispositionBadge code={l.call_status} label={l.status_label ?? l.call_status} color={l.status_color} /></td>
                <td className="px-3 py-2 text-right tabular-nums">{l.attempts}</td>
                <td className="px-3 py-2 text-xs text-slate-500">{l.last_called_at ? new Date(l.last_called_at).toLocaleString() : "—"}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={8} className="px-4 py-8 text-center text-slate-400">{leadsQ.loading ? "Loading leads…" : "No leads match. Paste numbers or import a file to add some."}</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-between text-sm text-slate-500">
        <span>{total.toLocaleString()} lead(s){selected.size ? ` · ${selected.size} selected` : ""}</span>
        <div className="flex items-center gap-2">
          <button disabled={page <= 1} onClick={() => setPage(page - 1)} className={btnGhost}>Previous</button>
          <span>Page {page} of {Math.max(1, Math.ceil(total / 50))}</span>
          <button disabled={page * 50 >= total} onClick={() => setPage(page + 1)} className={btnGhost}>Next</button>
        </div>
      </div>
      {openId && <LeadDrawer id={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}

function Target({ lists, campaigns, listId, campaignId, setListId, setCampaignId }: {
  lists: LeadList[]; campaigns: Array<{ id: string; name: string }>;
  listId: string; campaignId: string; setListId: (v: string) => void; setCampaignId: (v: string) => void;
}) {
  return (
    <>
      <select value={listId} onChange={(e) => setListId(e.target.value)} className={inputCls}>
        <option value="">No list</option>
        {lists.map((l) => <option key={l.id} value={l.id}>List: {l.name}</option>)}
      </select>
      <select value={campaignId} onChange={(e) => setCampaignId(e.target.value)} className={inputCls}>
        <option value="">Don't add to a campaign</option>
        {campaigns.map((c) => <option key={c.id} value={c.id}>Campaign: {c.name}</option>)}
      </select>
    </>
  );
}

function PastePanel({ lists, campaigns, onDone }: { lists: LeadList[]; campaigns: Array<{ id: string; name: string }>; onDone: (m: string) => void }) {
  const [text, setText] = useState("");
  const [listId, setListId] = useState("");
  const [campaignId, setCampaignId] = useState("");
  const [results, setResults] = useState<PasteResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lineCount = text.split(/\n/).filter((l) => l.trim()).length;
  return (
    <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3 animate-fade-in">
      <div className="text-sm text-slate-600">
        One lead per line: <code className="text-xs">phone</code>, <code className="text-xs">name, phone</code> or{" "}
        <code className="text-xs">first, last, phone, business, email</code>. Any format works — numbers are converted to E.164 (+13025550100).
      </div>
      <textarea rows={6} value={text} onChange={(e) => setText(e.target.value)} className={`${inputCls} font-mono text-xs`} placeholder={"(302) 555-0101\nJane Doe, 302.555.0102\nJohn, Smith, +1 302 555 0103, Acme LLC, john@acme.com"} />
      <div className="grid md:grid-cols-[1fr_1fr_auto] gap-2">
        <Target lists={lists} campaigns={campaigns} listId={listId} campaignId={campaignId} setListId={setListId} setCampaignId={setCampaignId} />
        <button
          disabled={busy || lineCount === 0}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              const r = await api<{ results: PasteResult[]; summary: { imported: number; duplicates: number } }>("/voice/insights/leads/paste", {
                method: "POST",
                body: { text, listId: listId || null, campaignId: campaignId || null },
              });
              setResults(r.results);
              setText("");
              onDone(`Added ${r.summary.imported} lead(s)${r.summary.duplicates ? `; ${r.summary.duplicates} already in that list/campaign` : ""}.`);
            } catch (err) {
              setError(err instanceof ApiError ? err.message : "Paste failed.");
            } finally {
              setBusy(false);
            }
          }}
          className={btnPrimary}
        >
          {busy ? "Adding…" : `Add ${lineCount || ""} lead${lineCount === 1 ? "" : "s"}`}
        </button>
      </div>
      {error && <div className="text-sm text-red-600">{error}</div>}
      {results && (
        <div className="max-h-64 overflow-auto border border-slate-100 rounded-md">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-slate-500 uppercase sticky top-0">
              <tr><th className="text-left px-2 py-1">Input</th><th className="text-left px-2 py-1">E.164</th><th className="text-left px-2 py-1">Result</th></tr>
            </thead>
            <tbody>
              {results.map((r, i) => (
                <tr key={i} className="border-t border-slate-100">
                  <td className="px-2 py-1 font-mono">{r.input}</td>
                  <td className="px-2 py-1 font-mono">{r.result ?? "—"}</td>
                  <td className={`px-2 py-1 ${r.status === "added" ? "text-green-700" : r.status === "invalid" ? "text-red-600" : "text-amber-700"}`}>
                    {r.status === "added" ? "Added" : r.reason}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ImportPanel({ lists, campaigns, busy, onImport }: { lists: LeadList[]; campaigns: Array<{ id: string; name: string }>; busy: boolean; onImport: (f: FormData) => void }) {
  const [listId, setListId] = useState("");
  const [campaignId, setCampaignId] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const file = ref.current?.files?.[0];
        if (!file) return;
        const form = new FormData();
        form.append("file", file);
        if (listId) form.append("listId", listId);
        if (campaignId) form.append("campaignId", campaignId);
        onImport(form);
      }}
      className="bg-white border border-slate-200 rounded-xl p-4 space-y-3 animate-fade-in"
    >
      <div className="text-sm text-slate-600">
        CSV or Excel with a header row. Recognised columns include first name, last name, phone, business name, email, address, city, state,
        current provider; anything else is kept as a custom field the agent can use. Phones are converted to E.164.
      </div>
      <div className="grid md:grid-cols-[1fr_1fr_1fr_auto] gap-2 items-center">
        <input ref={ref} type="file" required accept=".csv,.xlsx,.xls" className="text-sm" />
        <Target lists={lists} campaigns={campaigns} listId={listId} campaignId={campaignId} setListId={setListId} setCampaignId={setCampaignId} />
        <button disabled={busy} className={btnPrimary}>{busy ? "Importing…" : "Import"}</button>
      </div>
    </form>
  );
}

function AddLeadPanel({ lists, campaigns, busy, onAdd }: { lists: LeadList[]; campaigns: Array<{ id: string; name: string }>; busy: boolean; onAdd: (b: Record<string, unknown>) => void }) {
  const [f, setF] = useState({ firstName: "", lastName: "", businessName: "", phone: "", email: "" });
  const [listId, setListId] = useState("");
  const [campaignId, setCampaignId] = useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onAdd({ ...f, listId: listId || null, campaignId: campaignId || null });
        setF({ firstName: "", lastName: "", businessName: "", phone: "", email: "" });
      }}
      className="bg-white border border-slate-200 rounded-xl p-4 grid md:grid-cols-5 gap-2 animate-fade-in"
    >
      <input placeholder="First name" value={f.firstName} onChange={(e) => setF({ ...f, firstName: e.target.value })} className={inputCls} />
      <input placeholder="Last name" value={f.lastName} onChange={(e) => setF({ ...f, lastName: e.target.value })} className={inputCls} />
      <input placeholder="Business name" value={f.businessName} onChange={(e) => setF({ ...f, businessName: e.target.value })} className={inputCls} />
      <input required placeholder="Phone (any format)" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} className={inputCls} />
      <input type="email" placeholder="Email (optional)" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} className={inputCls} />
      <div className="md:col-span-5 grid md:grid-cols-[1fr_1fr_auto] gap-2">
        <Target lists={lists} campaigns={campaigns} listId={listId} campaignId={campaignId} setListId={setListId} setCampaignId={setCampaignId} />
        <button disabled={busy} className={btnPrimary}>Add lead</button>
      </div>
    </form>
  );
}

function ListsPanel({ lists, run, onOpen }: { lists: LeadList[]; run: (fn: () => Promise<string | void>) => void; onOpen: (id: string) => void }) {
  const [name, setName] = useState("");
  return (
    <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3 animate-fade-in">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          run(async () => {
            await api("/voice/insights/lead-lists", { method: "POST", body: { name } });
            setName("");
            return `List "${name}" created.`;
          });
        }}
        className="flex gap-2"
      >
        <input required value={name} onChange={(e) => setName(e.target.value)} placeholder="New list name" className={`${inputCls} max-w-xs`} />
        <button className={btnPrimary}>Create list</button>
      </form>
      <table className="w-full text-sm">
        <thead className="text-xs text-slate-500 uppercase">
          <tr><th className="text-left py-1">List</th><th className="text-right py-1">Leads</th><th className="text-right py-1">Never called</th><th /></tr>
        </thead>
        <tbody>
          {lists.map((l) => (
            <tr key={l.id} className="border-t border-slate-100">
              <td className="py-1.5 font-medium text-slate-900">{l.name}</td>
              <td className="py-1.5 text-right tabular-nums">{l.lead_count}</td>
              <td className="py-1.5 text-right tabular-nums">{l.never_called}</td>
              <td className="py-1.5 text-right space-x-3 text-xs">
                <button onClick={() => onOpen(l.id)} className="text-slate-600 hover:text-red-600">View leads</button>
                <button
                  onClick={() => {
                    const name = prompt("Rename list", l.name);
                    if (name && name.trim()) run(async () => { await api(`/voice/insights/lead-lists/${l.id}`, { method: "PATCH", body: { name } }); return "List renamed."; });
                  }}
                  className="text-slate-600 hover:text-red-600"
                >
                  Rename
                </button>
                <button
                  onClick={() => {
                    if (!confirm(`Delete the list "${l.name}"? Its ${l.lead_count} lead(s) stay, just without a list.`)) return;
                    run(async () => { await api(`/voice/insights/lead-lists/${l.id}`, { method: "DELETE" }); return "List deleted; its leads were kept."; });
                  }}
                  className="text-slate-600 hover:text-red-600"
                >
                  Delete
                </button>
              </td>
            </tr>
          ))}
          {lists.length === 0 && <tr><td colSpan={4} className="py-3 text-center text-slate-400">No lists yet.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function BulkBar({ count, lists, campaigns, onClear, onAction }: {
  count: number; lists: LeadList[]; campaigns: Array<{ id: string; name: string }>;
  onClear: () => void; onAction: (action: string, extra?: Record<string, string>) => void;
}) {
  const sel = "rounded-md bg-white/10 px-2 py-1 text-white text-sm [&>option]:text-slate-900";
  return (
    <div className="sticky top-2 z-10 flex flex-wrap items-center gap-2 bg-slate-900 text-white rounded-xl px-4 py-2 text-sm shadow-lg animate-fade-in">
      <span className="font-medium">{count} selected</span>
      <button onClick={onClear} className="text-slate-300 hover:text-white">Clear</button>
      <span className="flex-1" />
      <select value="" onChange={(e) => e.target.value && onAction("move_to_list", { listId: e.target.value })} className={sel} aria-label="Move to list">
        <option value="">Move to list…</option>
        {lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
      </select>
      <button onClick={() => onAction("remove_from_list")} className="rounded-md bg-white/10 px-3 py-1 hover:bg-white/20">Remove from list</button>
      <select value="" onChange={(e) => e.target.value && onAction("add_to_campaign", { campaignId: e.target.value })} className={sel} aria-label="Add to campaign">
        <option value="">Add to campaign…</option>
        {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
      <select value="" onChange={(e) => e.target.value && onAction("remove_from_campaign", { campaignId: e.target.value })} className={sel} aria-label="Remove from campaign">
        <option value="">Remove from campaign…</option>
        {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
      <button onClick={() => onAction("retry")} className="rounded-md bg-white/10 px-3 py-1 hover:bg-white/20" title="Queue them again in their campaigns">Retry</button>
      <button onClick={() => onAction("dnc")} className="rounded-md bg-white/10 px-3 py-1 hover:bg-white/20">Mark DNC</button>
      <button onClick={() => onAction("undnc")} className="rounded-md bg-white/10 px-3 py-1 hover:bg-white/20">Un-DNC</button>
      <button onClick={() => onAction("delete")} className="rounded-md bg-red-600 px-3 py-1 hover:bg-red-700">Delete</button>
    </div>
  );
}

function LeadDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const [data, setData] = useState<any>(null);
  useEffect(() => {
    setData(null);
    api(`/voice/insights/leads/${id}`).then(setData);
  }, [id]);
  const l = data?.lead;
  const details: Record<string, unknown> = l?.custom_fields?.call_details ?? {};
  const custom = Object.entries(l?.custom_fields ?? {}).filter(([, v]) => v === null || typeof v !== "object");
  return (
    <div className="fixed inset-0 z-30 flex justify-end bg-black/20 animate-fade-in" onClick={onClose}>
      <div className="w-full max-w-xl h-full bg-white shadow-xl overflow-auto animate-slide-in-right" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 bg-white border-b border-slate-100 px-5 py-3 flex items-center justify-between">
          <div className="font-semibold text-slate-900">Lead</div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 text-xl">×</button>
        </div>
        {!l ? (
          <div className="p-5"><div className="space-y-3 animate-fade-in" aria-busy="true" aria-label="Loading">
          <div className="skeleton h-5 w-1/3" />
          <div className="skeleton h-4 w-2/3" />
          <div className="skeleton h-24 w-full" />
        </div></div>
        ) : (
          <div className="p-5 space-y-5 text-sm">
            <div>
              <div className="text-lg font-semibold text-slate-900">{[l.first_name, l.last_name].filter(Boolean).join(" ") || l.business_name}</div>
              <div className="text-slate-500">{l.business_name} · {formatPhone(l.main_phone_e164)}{l.business_email ? ` · ${l.business_email}` : ""}</div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              {[
                ["Title", l.contact_title],
                ["Provider", l.current_provider],
                ["Customer type", l.customer_type === "alc" ? "ALC" : l.customer_type === "non_alc" ? "Non-ALC" : null],
                ["Lines / locations", [l.lines_count, l.locations_count].some(Boolean) ? `${l.lines_count ?? "—"} / ${l.locations_count ?? "—"}` : null],
                ["Contract ends", l.contract_end_date ? String(l.contract_end_date).slice(0, 10) : null],
                ["Address", l.service_address ?? l.address ?? ([l.city, l.state].filter(Boolean).join(", ") || null)],
                ...custom.map(([k, v]) => [k.replace(/_/g, " "), v == null ? null : String(v)]),
              ].map(([k, v]) => (
                <div key={k as string}>
                  <div className="text-xs text-slate-500 capitalize">{k as string}</div>
                  <div className="text-slate-900">{(v as string) ?? "—"}</div>
                </div>
              ))}
            </div>
            {Object.keys(details).length > 0 && (
              <div>
                <div className="text-xs font-medium text-slate-500 uppercase mb-1">Captured by the agent</div>
                <div className="grid grid-cols-2 gap-2">
                  {Object.entries(details).map(([k, v]) => (
                    <div key={k}>
                      <div className="text-xs text-slate-500 capitalize">{k.replace(/_/g, " ")}</div>
                      <div className="text-slate-900">{Array.isArray(v) ? v.join(", ") : typeof v === "boolean" ? (v ? "Yes" : "No") : String(v)}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div>
              <div className="text-xs font-medium text-slate-500 uppercase mb-1">Campaigns</div>
              {data.campaigns.map((c: any) => (
                <div key={c.id} className="flex justify-between">
                  <Link to={`/voice/campaigns/${c.campaign_id}`} className="text-slate-900 hover:underline">{c.name}</Link>
                  <span className="text-xs text-slate-500">{c.status} · {c.attempts} attempt(s){c.next_attempt_at ? ` · next ${new Date(c.next_attempt_at).toLocaleString()}` : ""}</span>
                </div>
              ))}
              {data.campaigns.length === 0 && <div className="text-slate-400">Not in a campaign.</div>}
            </div>
            <div>
              <div className="text-xs font-medium text-slate-500 uppercase mb-1">Call history</div>
              <div className="space-y-2">
                {data.calls.map((c: any) => (
                  <div key={c.id} className="border border-slate-100 rounded-md p-2">
                    <div className="flex justify-between items-center">
                      <span className="text-xs text-slate-500">{new Date(c.created_at).toLocaleString()} · {formatSeconds(c.talk_seconds)} · {c.campaign_name ?? "—"}</span>
                      <DispositionBadge code={c.disposition_key} label={c.disposition_label ?? c.status} color={c.disposition_color} />
                    </div>
                    {c.summary && <div className="text-slate-700 mt-1">{c.summary}</div>}
                  </div>
                ))}
                {data.calls.length === 0 && <div className="text-slate-400">No calls yet.</div>}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
