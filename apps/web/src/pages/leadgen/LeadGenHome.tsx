import { lazy, Suspense, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, ApiError } from "../../lib/api.js";
import { invalidate, useApi } from "../../lib/useApi.js";
import { Banner, Btn, Card, Empty, I, Icon, Modal, Skeleton, StatCard, ago, copyText, inputCls, uploadFiles } from "../../components/ui.js";
import { Pill, type Meta } from "./shared.js";
import type { Filters } from "./LeadsPanel.js";

const DiscoverForm = lazy(() => import("./DiscoverForm.js"));
const JobsPanel = lazy(() => import("./JobsPanel.js"));
const LeadsPanel = lazy(() => import("./LeadsPanel.js"));

interface LeadList { id: string; name: string; lead_count: string; created_at: string; description: string | null }
interface Summary { leads: number; discovered: number; with_email: number; with_phone: number; with_website: number; qualified: number; processing: number; avg_score: number | null; new_7d: number; activeJobs: number; jobs: number; lists: number }

const TABS = [["discover", "Discover"], ["runs", "Discovery runs"], ["leads", "Leads"], ["lists", "Lists & CRM"]] as const;
type Tab = (typeof TABS)[number][0];

export default function LeadGenHome() {
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") ?? (params.get("job") ? "runs" : "leads")) as Tab;
  const { data: meta } = useApi<Meta>("/leadgen/meta");
  const { data: summary, reload: reloadSummary } = useApi<Summary>("/leadgen/summary", { refreshMs: 10000 });
  const [filters, setFilters] = useState<Filters>({ sort: "score" });
  const go = (t: Tab, extra: Record<string, string> = {}) => setParams({ tab: t, ...extra }, { replace: true });
  const pct = (n: number) => (summary?.leads ? `${Math.round((n / summary.leads) * 100)}%` : "—");

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <span className="w-10 h-10 rounded-xl bg-red-50 text-red-600 flex items-center justify-center"><Icon d={I.search} size={20} /></span>
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Lead Discovery</h1>
          <p className="text-sm text-slate-500">Find businesses, enrich and validate their data, and let AI qualify them against what you sell.</p>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {!summary ? (
          Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-[88px]" />)
        ) : (
          <>
            <StatCard label="Leads" value={summary.leads.toLocaleString()} icon={I.users} hint={summary.processing ? `${summary.processing} being processed` : `+${summary.new_7d} this week`} />
            <StatCard label="Qualified" value={summary.qualified.toLocaleString()} icon={I.star} tone="text-green-600" hint={summary.avg_score != null ? `avg. score ${summary.avg_score}` : "not scored yet"} />
            <StatCard label="Reachable" value={pct(summary.with_phone)} icon={I.phone} hint={`with phone · ${pct(summary.with_email)} with email`} />
            <StatCard label="Discovery runs" value={summary.jobs} icon={I.search} hint={summary.activeJobs ? `${summary.activeJobs} running now` : "none running"} tone={summary.activeJobs ? "text-sky-600" : ""} />
          </>
        )}
      </div>

      <div className="flex gap-1 border-b border-slate-200 overflow-x-auto">
        {TABS.map(([k, l]) => (
          <button key={k} type="button" onClick={() => go(k)} className={`relative px-3.5 py-2 text-sm whitespace-nowrap ${tab === k ? "text-red-600 font-medium" : "text-slate-500 hover:text-slate-800"}`}>
            {l}
            {k === "runs" && summary?.activeJobs ? <span className="ml-1.5 inline-block w-1.5 h-1.5 rounded-full bg-sky-500 animate-pulse align-middle" /> : null}
            {tab === k && <span className="absolute left-2 right-2 -bottom-px h-0.5 bg-red-600 rounded-full" />}
          </button>
        ))}
      </div>

      <Suspense fallback={<Skeleton className="h-96" />}>
        <div key={tab} className="animate-fade-in">
          {!meta ? (
            <Skeleton className="h-96" />
          ) : tab === "discover" ? (
            <DiscoverForm meta={meta} onCreated={(id) => { invalidate("/leadgen/"); reloadSummary(); go("runs", { job: id }); }} />
          ) : tab === "runs" ? (
            <JobsPanel selected={params.get("job")} onSelect={(id) => go("runs", id ? { job: id } : {})} onViewLeads={(jobId) => { setFilters({ sort: "score", jobId }); go("leads"); }} />
          ) : tab === "leads" ? (
            <LeadsPanel meta={meta} filters={filters} setFilters={setFilters} />
          ) : (
            <ListsAndCrm onOpenList={(listId) => { setFilters({ sort: "score", listId }); go("leads"); }} />
          )}
        </div>
      </Suspense>
    </div>
  );
}

function ListsAndCrm({ onOpenList }: { onOpenList: (id: string) => void }) {
  const { data: listData, reload } = useApi<{ lists: LeadList[] }>("/leadgen/lists");
  const { data: crm, reload: reloadCrm } = useApi<{ webhookUrl: string | null; hasSecret: boolean; exports: Array<{ id: string; destination: string; target: string | null; lead_count: number; status: string; error: string | null; created_at: string; by: string | null }> }>("/leadgen/crm");
  const lists = listData?.lists ?? [];
  const [name, setName] = useState("");
  const [showImport, setShowImport] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const hookUrl = url ?? crm?.webhookUrl ?? "";

  async function saveHook(rotate = false) {
    try {
      const r = await api<{ secret?: string }>("/leadgen/crm", { method: "PUT", body: { webhookUrl: hookUrl.trim() || null, rotateSecret: rotate } });
      if (r.secret) setSecret(r.secret);
      setMsg({ kind: "ok", text: "CRM webhook saved." });
      setUrl(null);
      reloadCrm();
    } catch (e) {
      setMsg({ kind: "error", text: e instanceof ApiError ? e.message : "Couldn't save." });
    }
  }

  return (
    <div className="grid lg:grid-cols-2 gap-5">
      <Card title="Lists" action={<Btn onClick={() => setShowImport(true)}><Icon d={I.upload} size={14} /> Import CSV / Excel</Btn>}>
        <form className="flex gap-2 mb-3" onSubmit={async (e) => { e.preventDefault(); if (!name.trim()) return; await api("/leadgen/lists", { method: "POST", body: { name: name.trim() } }); setName(""); reload(); }}>
          <input className={`${inputCls} py-1.5`} placeholder="New list name (e.g. Q4 roofing campaign)" value={name} onChange={(e) => setName(e.target.value)} />
          <Btn type="submit" kind="primary" disabled={!name.trim()}>Create</Btn>
        </form>
        {!listData ? <Skeleton className="h-40" /> : !lists.length ? <Empty icon={I.users} title="No lists yet">Each discovery run creates one automatically.</Empty> : (
          <ul className="divide-y divide-slate-100">
            {lists.map((l) => (
              <li key={l.id} className="py-2.5 flex items-center gap-3 group">
                <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onOpenList(l.id)}>
                  <div className="text-sm font-medium text-slate-800 truncate group-hover:text-red-600">{l.name}</div>
                  <div className="text-[11px] text-slate-400">{l.description ?? "List"} · {ago(l.created_at)}</div>
                </button>
                <span className="text-sm tabular-nums text-slate-600">{Number(l.lead_count).toLocaleString()}</span>
                <button type="button" className="opacity-0 group-hover:opacity-100 text-slate-400 hover:text-red-600" onClick={async () => { if (confirm("Delete this list? Its leads stay in your database.")) { await api(`/leadgen/lists/${l.id}`, { method: "DELETE" }); reload(); } }} aria-label="Delete list"><Icon d={I.trash} size={14} /></button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <div className="space-y-5">
        <Card title="CRM webhook">
          <p className="text-sm text-slate-600">Qualified leads are posted as signed JSON to your CRM, Zapier, Make or n8n. Each request carries an <code className="text-xs bg-slate-100 rounded px-1">X-Vahlay-Signature: sha256=…</code> header (HMAC of the body with your secret).</p>
          {msg && <div className="mt-2"><Banner kind={msg.kind} onClose={() => setMsg(null)}>{msg.text}</Banner></div>}
          <div className="flex gap-2 mt-3">
            <input className={`${inputCls} py-1.5`} placeholder="https://hooks.your-crm.com/…" value={hookUrl} onChange={(e) => setUrl(e.target.value)} />
            <Btn kind="primary" onClick={() => saveHook(false)}>Save</Btn>
          </div>
          {crm?.hasSecret && <button type="button" className="text-xs text-slate-500 hover:text-red-600 mt-2" onClick={() => confirm("Create a new signing secret? Your CRM must be updated with it.") && saveHook(true)}>Rotate signing secret</button>}
          {secret && (
            <div className="mt-2 rounded-lg bg-amber-50 border border-amber-200 p-2 text-xs">
              <div className="font-medium text-amber-800">Signing secret — copy it now, it won't be shown again:</div>
              <div className="flex items-center gap-2 mt-1"><code className="break-all">{secret}</code><button type="button" onClick={() => copyText(secret)} className="text-amber-700"><Icon d={I.copy} size={13} /></button></div>
            </div>
          )}
        </Card>
        <Card title="Export & hand-off history">
          {!crm?.exports.length ? <p className="text-sm text-slate-500">Exports, CRM pushes and campaign hand-offs are listed here.</p> : (
            <ul className="divide-y divide-slate-100 text-sm">
              {crm.exports.map((e) => (
                <li key={e.id} className="py-2 flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-slate-700">{{ csv: "CSV export", xlsx: "Excel export", crm_webhook: "CRM webhook", voice_campaign: "Voice AI campaign" }[e.destination] ?? e.destination}{e.target ? ` · ${e.target}` : ""}</div>
                    <div className="text-[11px] text-slate-400">{e.by ?? "—"} · {ago(e.created_at)}{e.error ? ` · ${e.error}` : ""}</div>
                  </div>
                  <Pill tone={e.status === "failed" ? "bg-red-50 text-red-700" : "bg-slate-100 text-slate-600"}>{e.lead_count} leads</Pill>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      {showImport && <ImportModal lists={lists} listId="" onClose={() => setShowImport(false)} onDone={(t) => { setShowImport(false); setMsg({ kind: "ok", text: `${t} Select them in Leads and choose “Re-enrich” to validate and score them.` }); reload(); invalidate("/leadgen/"); }} />}
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
          <input ref={ref} type="file" accept=".csv,.xlsx" className="hidden" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
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
