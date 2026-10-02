import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError, getAccessToken, refreshSession } from "../../lib/api.js";
import { invalidate, useApi } from "../../lib/useApi.js";
import { Banner, Btn, Card, Empty, I, Icon, Modal, Skeleton, StatCard, ago, inputCls, uploadFiles } from "../../components/ui.js";

interface LeadList { id: string; name: string; lead_count: string; created_at: string }
interface Lead {
  id: string;
  business_name: string;
  city: string | null;
  state: string | null;
  website: string | null;
  main_phone: string | null;
  main_phone_e164: string | null;
  business_email: string | null;
  decision_maker_email: string | null;
  decision_maker_name: string | null;
  industry: string | null;
  category: string | null;
  quality_score: number | null;
  source: string;
  created_at: string;
}
interface Summary { leads: number; with_email: number; with_phone: number; with_website: number; avg_quality: number | null; new_7d: number; lists: number; googlePlaces: boolean }

const PAGE = 50;
const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : "—");

async function authedDownload(path: string, name: string) {
  const send = () => fetch(path, { credentials: "include", headers: { Authorization: `Bearer ${getAccessToken()}` } });
  let r = await send();
  if (r.status === 401 && (await refreshSession())) r = await send();
  if (!r.ok) throw new Error("Export failed.");
  const url = URL.createObjectURL(await r.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function Quality({ v }: { v: number | null }) {
  if (v == null) return <span className="text-xs text-slate-400">—</span>;
  const tone = v >= 70 ? "bg-green-500" : v >= 40 ? "bg-amber-400" : "bg-slate-300";
  return (
    <span className="inline-flex items-center gap-1.5" title={`Quality ${v}/100: how complete and reachable this lead is`}>
      <span className="flex gap-0.5">{[20, 40, 60, 80, 100].map((s) => <span key={s} className={`w-1.5 h-3 rounded-sm ${v >= s - 10 ? tone : "bg-slate-100"}`} />)}</span>
      <span className="text-xs tabular-nums text-slate-500">{v}</span>
    </span>
  );
}

export default function LeadGenHome() {
  const { data: summary, reload: reloadSummary } = useApi<Summary>("/leadgen/summary");
  const { data: listData, reload: reloadLists } = useApi<{ lists: LeadList[] }>("/leadgen/lists");
  const lists = listData?.lists ?? [];
  const [listId, setListId] = useState<string>("");
  const [q, setQ] = useState("");
  const [debQ, setDebQ] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebQ(q), 250);
    return () => clearTimeout(t);
  }, [q]);
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [listId, debQ]);
  const qs = new URLSearchParams({ pageSize: String(PAGE), page: String(page), ...(listId ? { listId } : {}), ...(debQ ? { search: debQ } : {}) }).toString();
  const { data: leadData, reload: reloadLeads } = useApi<{ leads: Lead[]; total: number }>(`/leadgen/leads?${qs}`);
  const leads = leadData?.leads ?? [];
  const total = leadData?.total ?? 0;

  const [form, setForm] = useState({ keywords: "", city: "", state: "" });
  const [searching, setSearching] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "error" | "info"; text: string } | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  useEffect(() => setSel(new Set()), [qs]);
  const [showImport, setShowImport] = useState(false);
  const [newList, setNewList] = useState<string | null>(null);

  const refreshAll = async () => {
    await Promise.all([reloadLeads(), reloadLists(), reloadSummary()]);
    invalidate("/leadgen/");
  };

  async function search() {
    setSearching(true);
    setMsg(null);
    try {
      const r = await api<{ message: string; leadListId: string; savedCount?: number; duplicateCount?: number; totalFound?: number; errors?: string[] }>("/leadgen/search", {
        method: "POST",
        body: { keywords: form.keywords, city: form.city || undefined, state: form.state || undefined },
      });
      setListId(r.leadListId);
      setMsg({
        kind: "ok",
        text: r.savedCount !== undefined ? `Found ${r.totalFound} businesses · ${r.savedCount} new leads saved · ${r.duplicateCount} already in your database.` : r.message,
      });
      await refreshAll();
    } catch (e) {
      setMsg({ kind: "error", text: e instanceof ApiError ? e.message : "Search failed." });
    } finally {
      setSearching(false);
    }
  }

  async function bulkDelete() {
    if (!confirm(`Delete ${sel.size} lead${sel.size === 1 ? "" : "s"}?`)) return;
    await api("/leadgen/leads/bulk-delete", { method: "POST", body: { ids: Array.from(sel) } });
    setSel(new Set());
    await refreshAll();
  }
  async function dedupe() {
    const r = await api<{ removed: number }>("/leadgen/leads/deduplicate", { method: "POST" });
    setMsg({ kind: "ok", text: r.removed ? `Removed ${r.removed} duplicate lead${r.removed === 1 ? "" : "s"}.` : "No duplicates found." });
    await refreshAll();
  }
  async function deleteList(id: string) {
    if (!confirm("Delete this list? Its leads stay in your database.")) return;
    await api(`/leadgen/lists/${id}`, { method: "DELETE" });
    if (listId === id) setListId("");
    await refreshAll();
  }
  async function createList() {
    if (!newList?.trim()) return;
    const r = await api<{ list: LeadList }>("/leadgen/lists", { method: "POST", body: { name: newList.trim() } });
    setNewList(null);
    await reloadLists();
    setListId(r.list.id);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="w-10 h-10 rounded-xl bg-red-50 text-red-600 flex items-center justify-center"><Icon d={I.search} size={20} /></span>
          <div>
            <h1 className="text-2xl font-semibold text-slate-900">Lead Discovery</h1>
            <p className="text-sm text-slate-500">Find local businesses, enrich them with website contacts, and keep one clean lead database.</p>
          </div>
        </div>
        <div className="flex gap-2">
          <Btn onClick={() => setShowImport(true)}><Icon d={I.upload} size={15} /> Import</Btn>
          <Btn onClick={() => authedDownload(`/api/leadgen/leads/export${listId ? `?listId=${listId}` : ""}`, "leads.csv").catch((e) => setMsg({ kind: "error", text: e.message }))}><Icon d={I.download} size={15} /> Export CSV</Btn>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {!summary ? (
          Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-[88px]" />)
        ) : (
          <>
            <StatCard label="Leads" value={summary.leads.toLocaleString()} icon={I.users} hint={summary.new_7d ? `+${summary.new_7d} this week` : `${summary.lists} lists`} />
            <StatCard label="With a phone" value={pct(summary.with_phone, summary.leads)} icon={I.phone} hint={`${summary.with_phone.toLocaleString()} leads`} />
            <StatCard label="With an email" value={pct(summary.with_email, summary.leads)} icon={I.mail} hint={`${summary.with_email.toLocaleString()} leads`} />
            <StatCard label="Avg. quality" value={summary.avg_quality ?? "—"} icon={I.star} hint="completeness, 0–100" />
          </>
        )}
      </div>

      <Card
        title="Discover businesses"
        action={summary && (summary.googlePlaces ? <span className="text-[11px] font-medium text-green-700 bg-green-50 rounded-full px-2 py-0.5">Google Places connected</span> : <Link to="/settings" className="text-[11px] font-medium text-amber-700 bg-amber-50 rounded-full px-2 py-0.5 hover:underline">Add a Google Places key →</Link>)}
      >
        <form
          className="grid sm:grid-cols-12 gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (form.keywords.trim().length >= 2) search();
          }}
        >
          <div className="sm:col-span-5 relative">
            <Icon d={I.search} size={15} className="absolute left-3 top-2.5 text-slate-400" />
            <input className={`${inputCls} pl-9`} placeholder="What kind of business? e.g. roofing contractors" value={form.keywords} onChange={(e) => setForm({ ...form, keywords: e.target.value })} />
          </div>
          <input className={`${inputCls} sm:col-span-3`} placeholder="City" value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} />
          <input className={`${inputCls} sm:col-span-2`} placeholder="State" value={form.state} onChange={(e) => setForm({ ...form, state: e.target.value })} />
          <Btn type="submit" kind="primary" className="sm:col-span-2" disabled={searching || form.keywords.trim().length < 2}>{searching ? "Searching…" : "Search"}</Btn>
        </form>
        {searching && (
          <div className="mt-3 h-1 rounded-full bg-slate-100 overflow-hidden"><div className="h-full w-1/3 bg-red-500 animate-progress" /></div>
        )}
        <p className="text-xs text-slate-500 mt-2">Each search creates a list. Results are de-duplicated against every lead you already have (by phone, or name and city), websites are checked for contact emails, and phone numbers are normalized to E.164.</p>
      </Card>

      {msg && <Banner kind={msg.kind} onClose={() => setMsg(null)}>{msg.text}</Banner>}

      <div className="grid lg:grid-cols-4 gap-5">
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold text-slate-900 text-sm">Lists</h2>
            <button type="button" className="text-xs text-red-600 hover:underline" onClick={() => setNewList("")}>+ New</button>
          </div>
          {newList !== null && (
            <form className="flex gap-1" onSubmit={(e) => { e.preventDefault(); createList(); }}>
              <input autoFocus className={`${inputCls} py-1.5`} placeholder="List name" value={newList} onChange={(e) => setNewList(e.target.value)} />
              <Btn type="submit" kind="primary">Add</Btn>
            </form>
          )}
          <nav className="bg-white border border-slate-200 rounded-2xl p-1.5 max-h-[60vh] overflow-y-auto">
            <ListItem active={!listId} onClick={() => setListId("")} name="All leads" count={summary?.leads ?? 0} />
            {lists.map((l) => (
              <ListItem key={l.id} active={listId === l.id} onClick={() => setListId(l.id)} name={l.name} count={Number(l.lead_count)} sub={ago(l.created_at)} onDelete={() => deleteList(l.id)} />
            ))}
          </nav>
        </div>

        <div className="lg:col-span-3 bg-white border border-slate-200 rounded-2xl overflow-hidden h-fit">
          <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-slate-100">
            <div className="relative flex-1 min-w-[180px]">
              <Icon d={I.search} size={15} className="absolute left-2.5 top-2.5 text-slate-400" />
              <input className={`${inputCls} pl-8 py-1.5`} placeholder="Search name, website, email or phone" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <Btn kind="ghost" onClick={dedupe} title="Remove leads with the same phone or the same name and city">Remove duplicates</Btn>
          </div>
          {sel.size > 0 && (
            <div className="flex items-center gap-2 px-4 py-2 bg-red-50/60 border-b border-red-100 animate-fade-in">
              <span className="text-sm font-medium text-slate-700">{sel.size} selected</span>
              <Btn kind="danger" onClick={bulkDelete}><Icon d={I.trash} size={14} /> Delete</Btn>
              <button type="button" className="ml-auto text-xs text-slate-500" onClick={() => setSel(new Set())}>Clear</button>
            </div>
          )}
          {!leadData ? (
            <div className="p-4 space-y-2">{Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-10" />)}</div>
          ) : !leads.length ? (
            <Empty icon={I.search} title={debQ ? "No leads match" : "No leads here yet"}>{debQ ? "Try a different search." : "Run a discovery search above or import a CSV/Excel file."}</Empty>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-[11px] uppercase tracking-wide text-slate-400 bg-slate-50/60">
                    <tr>
                      <th className="pl-4 py-2 w-8"><input type="checkbox" checked={sel.size === leads.length} onChange={(e) => setSel(e.target.checked ? new Set(leads.map((l) => l.id)) : new Set())} /></th>
                      <th className="text-left px-3 py-2">Business</th>
                      <th className="text-left px-3 py-2">Contact</th>
                      <th className="text-left px-3 py-2">Website</th>
                      <th className="text-left px-3 py-2">Quality</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {leads.map((l) => (
                      <tr key={l.id} className={`hover:bg-slate-50/70 ${sel.has(l.id) ? "bg-red-50/30" : ""}`}>
                        <td className="pl-4 py-2.5"><input type="checkbox" checked={sel.has(l.id)} onChange={(e) => { const s = new Set(sel); e.target.checked ? s.add(l.id) : s.delete(l.id); setSel(s); }} /></td>
                        <td className="px-3 py-2.5">
                          <div className="font-medium text-slate-800">{l.business_name}</div>
                          <div className="text-xs text-slate-400">{[l.category ?? l.industry, [l.city, l.state].filter(Boolean).join(", ")].filter(Boolean).join(" · ") || "—"}</div>
                        </td>
                        <td className="px-3 py-2.5 text-xs">
                          <div className="text-slate-700 tabular-nums">{l.main_phone_e164 ?? l.main_phone ?? <span className="text-slate-300">no phone</span>}</div>
                          <div className="text-slate-500 truncate max-w-[220px]">{l.business_email ?? l.decision_maker_email ?? <span className="text-slate-300">no email</span>}</div>
                        </td>
                        <td className="px-3 py-2.5 text-xs">
                          {l.website ? <a href={l.website} target="_blank" rel="noreferrer" className="text-red-600 hover:underline truncate inline-block max-w-[200px] align-bottom">{l.website.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "")}</a> : <span className="text-slate-300">—</span>}
                        </td>
                        <td className="px-3 py-2.5"><Quality v={l.quality_score} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex items-center justify-between px-4 py-2.5 border-t border-slate-100 text-xs text-slate-500">
                <span>{(page - 1) * PAGE + 1}–{Math.min(page * PAGE, total)} of {total.toLocaleString()}</span>
                <div className="flex gap-1">
                  <Btn kind="ghost" disabled={page === 1} onClick={() => setPage(page - 1)}>‹ Prev</Btn>
                  <Btn kind="ghost" disabled={page * PAGE >= total} onClick={() => setPage(page + 1)}>Next ›</Btn>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {showImport && <ImportModal lists={lists} listId={listId} onClose={() => setShowImport(false)} onDone={async (t) => { setShowImport(false); setMsg({ kind: "ok", text: t }); await refreshAll(); }} />}
    </div>
  );
}

function ListItem({ active, onClick, name, count, sub, onDelete }: { active: boolean; onClick: () => void; name: string; count: number; sub?: string; onDelete?: () => void }) {
  return (
    <div className={`group flex items-center gap-2 rounded-xl px-3 py-2 cursor-pointer transition-colors ${active ? "bg-red-50 text-red-700" : "hover:bg-slate-50 text-slate-700"}`} onClick={onClick}>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium truncate">{name}</div>
        {sub && <div className="text-[11px] text-slate-400">{sub}</div>}
      </div>
      <span className="text-xs tabular-nums text-slate-400">{count.toLocaleString()}</span>
      {onDelete && (
        <button type="button" className="opacity-0 group-hover:opacity-100 text-slate-400 hover:text-red-600" onClick={(e) => { e.stopPropagation(); onDelete(); }} aria-label="Delete list"><Icon d={I.x} size={14} /></button>
      )}
    </div>
  );
}

function ImportModal({ lists, listId, onClose, onDone }: { lists: LeadList[]; listId: string; onClose: () => void; onDone: (t: string) => void }) {
  const [target, setTarget] = useState(listId);
  const [file, setFile] = useState<File | null>(null);
  const [pct, setPct] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement>(null);
  async function go() {
    if (!file) return;
    setErr(null);
    const form = new FormData();
    form.append("file", file);
    if (target) form.append("leadListId", target);
    try {
      const r = await uploadFiles("/api/leadgen/leads/import", form, setPct);
      onDone(`Imported ${r.imported ?? 0} lead${r.imported === 1 ? "" : "s"}${r.duplicates ? ` · ${r.duplicates} duplicates skipped` : ""}${r.totalErrors ? ` · ${r.totalErrors} rows skipped` : ""}.`);
    } catch (e) {
      setErr((e as Error).message);
      setPct(null);
    }
  }
  return (
    <Modal title="Import leads" onClose={onClose}>
      <div className="space-y-3">
        {err && <Banner kind="error">{err}</Banner>}
        <div onClick={() => ref.current?.click()} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); setFile(e.dataTransfer.files[0] ?? null); }} className="rounded-2xl border-2 border-dashed border-slate-200 hover:border-red-200 p-6 text-center cursor-pointer">
          <Icon d={I.upload} size={22} className="mx-auto text-red-500" />
          <div className="text-sm font-medium text-slate-800 mt-2">{file ? file.name : "Drop a CSV or Excel file, or click to choose"}</div>
          <div className="text-xs text-slate-500">Columns like business name, phone, email, website, city, state are recognised automatically.</div>
          <input ref={ref} type="file" accept=".csv,.xlsx,.xls" className="hidden" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </div>
        <label className="block text-xs font-medium text-slate-600">Add to list
          <select className={`${inputCls} mt-1`} value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">No list</option>
            {lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </label>
        {pct != null && <div className="h-1.5 rounded-full bg-slate-100 overflow-hidden"><div className="h-full bg-red-500 transition-[width]" style={{ width: `${pct}%` }} /></div>}
        <div className="flex justify-end gap-2"><Btn onClick={onClose}>Cancel</Btn><Btn kind="primary" disabled={!file || pct != null} onClick={go}>Import</Btn></div>
      </div>
    </Modal>
  );
}
