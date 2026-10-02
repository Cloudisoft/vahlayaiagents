import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../../lib/api.js";
import { invalidate, useApi } from "../../lib/useApi.js";
import { Banner, Btn, Empty, Field, I, Icon, Modal, Skeleton, inputCls, scoreTone } from "../../components/ui.js";
import { Pill, SITE_LABEL, SITE_TONE, SOURCE_LABEL, STATUS_LABEL, STATUS_TONE, downloadFile, type Job, type Meta } from "./shared.js";

const LeadDrawer = lazy(() => import("./LeadDrawer.js"));

export interface LeadRow {
  id: string;
  business_name: string;
  category: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  website: string | null;
  website_status: string | null;
  main_phone_e164: string | null;
  main_phone: string | null;
  business_email: string | null;
  email_valid: boolean | null;
  phone_valid: boolean | null;
  completeness: number | null;
  lead_score: number | null;
  fit_score: number | null;
  qualification_status: string | null;
  primary_opportunity: string | null;
  opportunities: string[];
  pipeline_status: string | null;
  pipeline_error: string | null;
  sources: string[];
  tags: string[];
  notes_count: number;
}

export type Filters = Record<string, string>;
const PAGE = 50;
const PROCESSING = ["discovered", "enriching", "enriched", "qualifying"];

export default function LeadsPanel({ meta, filters, setFilters }: { meta: Meta; filters: Filters; setFilters: (f: Filters) => void }) {
  const [page, setPage] = useState(1);
  const [q, setQ] = useState(filters.search ?? "");
  useEffect(() => {
    const t = setTimeout(() => q !== (filters.search ?? "") && setFilters({ ...filters, search: q }), 300);
    return () => clearTimeout(t);
  }, [q]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setPage(1), [filters]);
  const clean = Object.fromEntries(Object.entries(filters).filter(([, v]) => v));
  const qs = new URLSearchParams({ ...clean, page: String(page), pageSize: String(PAGE) }).toString();
  const { data, reload } = useApi<{ leads: LeadRow[]; total: number }>(`/leadgen/leads?${qs}`);
  const { data: jobsData } = useApi<{ jobs: Job[] }>("/leadgen/jobs");
  const { data: listData } = useApi<{ lists: Array<{ id: string; name: string; lead_count: string }> }>("/leadgen/lists");
  const leads = data?.leads ?? [];
  const processing = leads.some((l) => PROCESSING.includes(l.pipeline_status ?? ""));
  useEffect(() => {
    if (!processing) return;
    const t = setInterval(() => reload(), 4000);
    return () => clearInterval(t);
  }, [processing, reload]);

  const [sel, setSel] = useState<Set<string>>(new Set());
  useEffect(() => setSel(new Set()), [qs]);
  const [open, setOpen] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "error" | "info"; text: string } | null>(null);
  const [modal, setModal] = useState<null | "list" | "tag" | "crm" | "status">(null);
  const oppLabel = useMemo(() => Object.fromEntries(meta.opportunities.map((o) => [o.key, o.label])), [meta]);
  const set = (k: string, v: string) => setFilters({ ...filters, [k]: v });
  const active = Object.entries(clean).filter(([k]) => k !== "sort" && k !== "search").length;

  async function bulk(body: Record<string, unknown>, ok: string) {
    try {
      const r = await api<{ updated: number }>("/leadgen/leads/bulk", { method: "POST", body: { ids: Array.from(sel), ...body } });
      setMsg({ kind: "ok", text: `${r.updated} lead${r.updated === 1 ? "" : "s"} ${ok}.` });
      setSel(new Set());
      await reload();
      invalidate("/leadgen/");
    } catch (e) {
      setMsg({ kind: "error", text: e instanceof ApiError ? e.message : "Failed." });
    }
  }
  async function exportAs(format: "csv" | "xlsx") {
    try {
      await downloadFile("/api/leadgen/export", `leads-${new Date().toISOString().slice(0, 10)}.${format}`, sel.size ? { format, ids: Array.from(sel) } : { format, filter: clean });
    } catch (e) {
      setMsg({ kind: "error", text: (e as Error).message });
    }
  }

  const sel_ = `${inputCls} py-1.5 text-xs`;
  return (
    <div className="grid lg:grid-cols-[220px_minmax(0,1fr)] gap-5">
      <aside className="space-y-3">
        <div className="bg-white border border-slate-200 rounded-2xl p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-900">Filters</h3>
            {active > 0 && <button type="button" className="text-xs text-red-600 hover:underline" onClick={() => { setQ(""); setFilters({ sort: filters.sort ?? "score" }); }}>Clear {active}</button>}
          </div>
          <Field label="Discovery run">
            <select className={sel_} value={filters.jobId ?? ""} onChange={(e) => set("jobId", e.target.value)}>
              <option value="">All</option>
              {jobsData?.jobs.map((j) => <option key={j.id} value={j.id}>{j.name}</option>)}
            </select>
          </Field>
          <Field label="Industry">
            <select className={sel_} value={filters.industry ?? ""} onChange={(e) => set("industry", e.target.value)}>
              <option value="">Any</option>
              {meta.industries.map((i) => <option key={i.key} value={i.key}>{i.label}</option>)}
            </select>
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="State"><input className={sel_} value={filters.state ?? ""} onChange={(e) => set("state", e.target.value)} /></Field>
            <Field label="City"><input className={sel_} value={filters.city ?? ""} onChange={(e) => set("city", e.target.value)} /></Field>
          </div>
          <Field label="Qualification">
            <select className={sel_} value={filters.status ?? ""} onChange={(e) => set("status", e.target.value)}>
              <option value="">Any</option>
              <option value="qualified">Qualified</option>
              <option value="needs_review">Needs review</option>
              <option value="disqualified">Not a fit</option>
              <option value="processing">Still processing</option>
              <option value="failed">Failed</option>
            </select>
          </Field>
          <Field label="Minimum lead score"><input type="number" min={0} max={100} className={sel_} value={filters.minScore ?? ""} onChange={(e) => set("minScore", e.target.value)} placeholder="0" /></Field>
          <Field label="Opportunity">
            <select className={sel_} value={filters.opportunity ?? ""} onChange={(e) => set("opportunity", e.target.value)}>
              <option value="">Any</option>
              {meta.opportunities.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
            </select>
          </Field>
          <Field label="Website">
            <select className={sel_} value={filters.website ?? ""} onChange={(e) => set("website", e.target.value)}>
              <option value="">Any</option>
              {Object.entries(SITE_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Email">
              <select className={sel_} value={filters.validEmail === "true" ? "valid" : filters.hasEmail ?? ""} onChange={(e) => setFilters({ ...filters, hasEmail: e.target.value === "valid" ? "" : e.target.value, validEmail: e.target.value === "valid" ? "true" : "" })}>
                <option value="">Any</option><option value="true">Has email</option><option value="valid">Valid email</option><option value="false">No email</option>
              </select>
            </Field>
            <Field label="Phone">
              <select className={sel_} value={filters.hasPhone ?? ""} onChange={(e) => set("hasPhone", e.target.value)}>
                <option value="">Any</option><option value="true">Has phone</option><option value="false">No phone</option>
              </select>
            </Field>
          </div>
          <Field label="Contact">
            <select className={sel_} value={filters.hasContact ?? ""} onChange={(e) => set("hasContact", e.target.value)}>
              <option value="">Any</option><option value="true">Phone or email</option><option value="false">No contact info</option>
            </select>
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Size">
              <select className={sel_} value={filters.size ?? ""} onChange={(e) => set("size", e.target.value)}>
                <option value="">Any</option><option value="single">Single location</option><option value="multi">Multi-location</option>
              </select>
            </Field>
            <Field label="Source">
              <select className={sel_} value={filters.source ?? ""} onChange={(e) => set("source", e.target.value)}>
                <option value="">Any</option>
                {Object.entries(SOURCE_LABEL).filter(([k]) => !["unknown", "import"].includes(k)).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </Field>
          </div>
          <Field label="List">
            <select className={sel_} value={filters.listId ?? ""} onChange={(e) => set("listId", e.target.value)}>
              <option value="">Any</option>
              {listData?.lists.map((l) => <option key={l.id} value={l.id}>{l.name} ({l.lead_count})</option>)}
            </select>
          </Field>
          <Field label="Tag"><input className={sel_} value={filters.tag ?? ""} onChange={(e) => set("tag", e.target.value)} /></Field>
        </div>
      </aside>

      <div className="space-y-3 min-w-0">
        {msg && <Banner kind={msg.kind} onClose={() => setMsg(null)}>{msg.text}</Banner>}
        <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
          <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-slate-100">
            <div className="relative flex-1 min-w-[180px]">
              <Icon d={I.search} size={15} className="absolute left-2.5 top-2.5 text-slate-400" />
              <input className={`${inputCls} pl-8 py-1.5`} placeholder="Search name, website, email, phone or category" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <div className="w-44 shrink-0">
              <select className={`${inputCls} py-1.5`} value={filters.sort ?? "score"} onChange={(e) => set("sort", e.target.value)}>
                <option value="score">Sort: lead score</option>
                <option value="fit">Sort: fit (relevance)</option>
                <option value="completeness">Sort: data completeness</option>
                <option value="recent">Sort: recently found</option>
                <option value="name">Sort: name</option>
              </select>
            </div>
            <Btn onClick={() => exportAs("csv")} title={sel.size ? "Export selected" : "Export everything matching the filters"}><Icon d={I.download} size={14} /> CSV</Btn>
            <Btn onClick={() => exportAs("xlsx")}><Icon d={I.download} size={14} /> Excel</Btn>
          </div>
          {sel.size > 0 && (
            <div className="flex flex-wrap items-center gap-2 px-4 py-2 bg-red-50/60 border-b border-red-100 animate-fade-in">
              <span className="text-sm font-medium text-slate-700 mr-1">{sel.size} selected</span>
              <Btn kind="primary" onClick={() => setModal("crm")}><Icon d={I.link} size={14} /> Send to CRM / outreach</Btn>
              <Btn onClick={() => setModal("list")}>Add to list</Btn>
              <Btn onClick={() => setModal("tag")}>Tag</Btn>
              <Btn onClick={() => setModal("status")}>Set status</Btn>
              <Btn onClick={() => bulk({ action: "reenrich" }, "queued for re-enrichment")}><Icon d={I.retry} size={14} /> Re-enrich</Btn>
              <Btn onClick={() => bulk({ action: "requalify" }, "queued for re-qualification")}>Re-score</Btn>
              <Btn kind="danger" onClick={() => confirm(`Delete ${sel.size} lead(s)?`) && bulk({ action: "delete" }, "deleted")}><Icon d={I.trash} size={14} /></Btn>
              <button type="button" className="ml-auto text-xs text-slate-500" onClick={() => setSel(new Set())}>Clear</button>
            </div>
          )}
          {!data ? (
            <div className="p-4 space-y-2">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-12" />)}</div>
          ) : !leads.length ? (
            <Empty icon={I.search} title="No leads match">Change the filters, or start a discovery run.</Empty>
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
                      <th className="text-left px-3 py-2">Score</th>
                      <th className="text-left px-3 py-2">Opportunity</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {leads.map((l) => (
                      <tr key={l.id} onClick={() => setOpen(l.id)} className={`cursor-pointer hover:bg-slate-50/80 ${sel.has(l.id) ? "bg-red-50/30" : ""}`}>
                        <td className="pl-4 py-2.5" onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={sel.has(l.id)} onChange={(e) => { const s = new Set(sel); e.target.checked ? s.add(l.id) : s.delete(l.id); setSel(s); }} /></td>
                        <td className="px-3 py-2.5">
                          <div className="font-medium text-slate-800 truncate max-w-[240px]">{l.business_name}</div>
                          <div className="text-xs text-slate-400 truncate max-w-[240px]">{[l.category, [l.city, l.state].filter(Boolean).join(", ")].filter(Boolean).join(" · ") || "—"}</div>
                          {l.tags?.length > 0 && <div className="flex gap-1 mt-0.5">{l.tags.slice(0, 3).map((t) => <span key={t} className="text-[10px] bg-slate-100 text-slate-600 rounded px-1">{t}</span>)}</div>}
                        </td>
                        <td className="px-3 py-2.5 text-xs">
                          <div className="flex items-center gap-1.5 tabular-nums">
                            <Icon d={I.phone} size={12} className={l.main_phone_e164 ? (l.phone_valid === false ? "text-amber-500" : "text-green-600") : "text-slate-300"} />
                            {l.main_phone_e164 ?? <span className="text-slate-300">none</span>}
                          </div>
                          <div className="flex items-center gap-1.5 truncate max-w-[200px]">
                            <Icon d={I.mail} size={12} className={l.business_email ? (l.email_valid ? "text-green-600" : "text-amber-500") : "text-slate-300"} />
                            {l.business_email ?? <span className="text-slate-300">none</span>}
                          </div>
                        </td>
                        <td className="px-3 py-2.5">{l.website_status ? <Pill tone={SITE_TONE[l.website_status]}>{SITE_LABEL[l.website_status]}</Pill> : <span className="text-xs text-slate-300">—</span>}</td>
                        <td className="px-3 py-2.5">
                          {PROCESSING.includes(l.pipeline_status ?? "") ? (
                            <span className="inline-flex items-center gap-1.5 text-xs text-violet-700"><span className="w-3 h-3 rounded-full border-2 border-violet-200 border-t-violet-600 animate-spin" />{l.pipeline_status === "qualifying" || l.pipeline_status === "enriched" ? "Scoring" : "Enriching"}</span>
                          ) : l.pipeline_status?.endsWith("failed") ? (
                            <span className="text-xs text-red-600" title={l.pipeline_error ?? ""}>{l.pipeline_status === "enrich_failed" ? "Enrichment failed" : "Scoring failed"}</span>
                          ) : l.lead_score != null ? (
                            <div className="flex items-center gap-2">
                              <span className={`text-base font-bold tabular-nums ${scoreTone(l.lead_score)}`}>{l.lead_score}</span>
                              {l.qualification_status && <Pill tone={STATUS_TONE[l.qualification_status]}>{STATUS_LABEL[l.qualification_status]}</Pill>}
                            </div>
                          ) : (
                            <span className="text-xs text-slate-300">not scored</span>
                          )}
                        </td>
                        <td className="px-3 py-2.5 text-xs text-slate-600 max-w-[150px]">{l.primary_opportunity ? oppLabel[l.primary_opportunity] ?? l.primary_opportunity : <span className="text-slate-300">—</span>}{l.opportunities?.length > 1 && <span className="text-slate-400"> +{l.opportunities.length - 1}</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex items-center justify-between px-4 py-2.5 border-t border-slate-100 text-xs text-slate-500">
                <span>{(page - 1) * PAGE + 1}–{Math.min(page * PAGE, data.total)} of {data.total.toLocaleString()}</span>
                <div className="flex gap-1">
                  <Btn kind="ghost" disabled={page === 1} onClick={() => setPage(page - 1)}>‹ Prev</Btn>
                  <Btn kind="ghost" disabled={page * PAGE >= data.total} onClick={() => setPage(page + 1)}>Next ›</Btn>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {open && (
        <Suspense fallback={null}>
          <LeadDrawer id={open} meta={meta} onClose={() => setOpen(null)} onChanged={() => reload()} />
        </Suspense>
      )}
      {modal === "list" && (
        <PickModal title="Add to list" onClose={() => setModal(null)} options={(listData?.lists ?? []).map((l) => [l.id, l.name])} onPick={(v) => bulk({ action: "add_to_list", listId: v }, "added to the list").then(() => setModal(null))} />
      )}
      {modal === "status" && (
        <PickModal title="Set qualification status" onClose={() => setModal(null)} options={Object.entries(STATUS_LABEL)} onPick={(v) => bulk({ action: "set_status", status: v }, "updated").then(() => setModal(null))} />
      )}
      {modal === "tag" && <TagModal onClose={() => setModal(null)} onApply={(tag, remove) => bulk({ action: remove ? "untag" : "tag", tag }, remove ? "untagged" : "tagged").then(() => setModal(null))} />}
      {modal === "crm" && <CrmModal ids={Array.from(sel)} onClose={() => setModal(null)} onDone={(t) => { setModal(null); setSel(new Set()); setMsg({ kind: "ok", text: t }); }} />}
    </div>
  );
}

function PickModal({ title, options, onPick, onClose }: { title: string; options: string[][]; onPick: (v: string) => void; onClose: () => void }) {
  const [v, setV] = useState(options[0]?.[0] ?? "");
  return (
    <Modal title={title} onClose={onClose}>
      {!options.length ? <p className="text-sm text-slate-500">Nothing to choose yet — create a list in the Lists tab.</p> : (
        <div className="space-y-3">
          <select className={inputCls} value={v} onChange={(e) => setV(e.target.value)}>{options.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
          <div className="flex justify-end gap-2"><Btn onClick={onClose}>Cancel</Btn><Btn kind="primary" onClick={() => onPick(v)}>Apply</Btn></div>
        </div>
      )}
    </Modal>
  );
}

function TagModal({ onApply, onClose }: { onApply: (tag: string, remove: boolean) => void; onClose: () => void }) {
  const [tag, setTag] = useState("");
  return (
    <Modal title="Tag leads" onClose={onClose}>
      <div className="space-y-3">
        <input autoFocus className={inputCls} value={tag} onChange={(e) => setTag(e.target.value)} placeholder="e.g. hot, follow-up, Q4" />
        <div className="flex justify-end gap-2">
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn disabled={!tag.trim()} onClick={() => onApply(tag.trim(), true)}>Remove tag</Btn>
          <Btn kind="primary" disabled={!tag.trim()} onClick={() => onApply(tag.trim(), false)}>Add tag</Btn>
        </div>
      </div>
    </Modal>
  );
}

function CrmModal({ ids, onClose, onDone }: { ids: string[]; onClose: () => void; onDone: (t: string) => void }) {
  const { data } = useApi<{ webhookUrl: string | null; campaigns: Array<{ id: string; name: string; status: string }> }>("/leadgen/crm");
  const [dest, setDest] = useState<"webhook" | "voice_campaign">("voice_campaign");
  const [campaign, setCampaign] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function go() {
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ sent: number; note: string | null }>("/leadgen/crm/push", { method: "POST", body: { destination: dest, ids, ...(dest === "voice_campaign" ? { campaignId: campaign || data?.campaigns[0]?.id } : {}) } });
      onDone(`${r.sent} lead${r.sent === 1 ? "" : "s"} sent.${r.note ? ` ${r.note}` : ""}`);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Couldn't send.");
      setBusy(false);
    }
  }
  return (
    <Modal title={`Send ${ids.length} lead${ids.length === 1 ? "" : "s"}`} onClose={onClose}>
      <div className="space-y-3">
        {err && <Banner kind="error">{err}</Banner>}
        <label className="flex items-start gap-2 text-sm"><input type="radio" checked={dest === "voice_campaign"} onChange={() => setDest("voice_campaign")} className="mt-1" /><span><b>Voice AI campaign</b><br /><span className="text-xs text-slate-500">Adds leads with a phone number to a calling campaign. Do Not Call numbers are skipped.</span></span></label>
        {dest === "voice_campaign" && (
          <select className={inputCls} value={campaign || data?.campaigns[0]?.id || ""} onChange={(e) => setCampaign(e.target.value)}>
            {!data?.campaigns.length && <option value="">No campaigns yet</option>}
            {data?.campaigns.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.status})</option>)}
          </select>
        )}
        <label className="flex items-start gap-2 text-sm"><input type="radio" checked={dest === "webhook"} onChange={() => setDest("webhook")} className="mt-1" /><span><b>CRM webhook</b><br /><span className="text-xs text-slate-500">{data?.webhookUrl ? `Posts signed JSON to ${data.webhookUrl}` : "Set up your CRM webhook in the Lists & CRM tab first."}</span></span></label>
        <div className="flex justify-end gap-2 pt-1">
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn kind="primary" disabled={busy || (dest === "webhook" && !data?.webhookUrl) || (dest === "voice_campaign" && !data?.campaigns.length)} onClick={go}>{busy ? "Sending…" : "Send"}</Btn>
        </div>
      </div>
    </Modal>
  );
}
