import { useState, type ReactNode } from "react";
import { api, ApiError } from "../../lib/api.js";
import { useApi } from "../../lib/useApi.js";
import { Banner, Btn, I, Icon, Skeleton, ScoreBar, ScoreRing, ago, inputCls } from "../../components/ui.js";
import { Drawer, Pill, SITE_LABEL, SITE_TONE, SOURCE_LABEL, STATUS_LABEL, STATUS_TONE, type Meta } from "./shared.js";

interface Detail {
  lead: any;
  sourceRecords: Array<{ id: string; source: string; source_ref: string; source_url: string | null; raw: unknown; fetched_at: string }>;
  notes: Array<{ id: string; body: string; created_at: string; author: string | null }>;
  jobs: Array<{ id: string; name: string; was_new: boolean; created_at: string }>;
}

const FIELDS: Array<[string, string]> = [
  ["business_name", "Business name"],
  ["category", "Category"],
  ["description", "Description"],
  ["website", "Website"],
  ["main_phone", "Phone"],
  ["business_email", "Email"],
  ["address", "Address"],
  ["city", "City"],
  ["state", "State"],
  ["zip", "ZIP"],
  ["country", "Country"],
  ["social_urls", "Social profiles"],
  ["decision_maker_name", "Contact person"],
  ["company_size", "Company size"],
];

function Section({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="bg-white border border-slate-200 rounded-2xl p-4">
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-sm font-semibold text-slate-900">{title}</h4>
        {action}
      </div>
      {children}
    </section>
  );
}

export default function LeadDrawer({ id, meta, onClose, onChanged }: { id: string; meta: Meta; onClose: () => void; onChanged: () => void }) {
  const { data, reload } = useApi<Detail>(`/leadgen/leads/${id}`);
  const [note, setNote] = useState("");
  const [tag, setTag] = useState("");
  const [edit, setEdit] = useState<Record<string, string> | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const l = data?.lead;
  const q = l?.qualification;
  const v = l?.validation ?? {};
  const fm = l?.field_meta ?? {};
  const oppLabel = Object.fromEntries(meta.opportunities.map((o) => [o.key, o.label]));
  const refresh = async () => {
    await reload();
    onChanged();
  };
  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      if (ok) setMsg({ kind: "ok", text: ok });
      await refresh();
    } catch (e) {
      setMsg({ kind: "error", text: e instanceof ApiError ? e.message : "Failed." });
    }
  };

  const pipeline: Array<[string, string, "done" | "pending" | "failed" | "none", string | null]> = l
    ? [
        ["Source", (l.sources ?? []).map((s: string) => SOURCE_LABEL[s] ?? s).join(", ") || SOURCE_LABEL[l.source] || "—", "done", l.first_discovered_at ?? l.created_at],
        ["Raw data", `${data!.sourceRecords.length} record${data!.sourceRecords.length === 1 ? "" : "s"} kept`, data!.sourceRecords.length ? "done" : "none", data!.sourceRecords[0]?.fetched_at ?? null],
        ["Normalized", "Names, phones, addresses, websites cleaned", "done", l.last_discovered_at ?? l.created_at],
        ["Enrichment", l.enriched_at ? "Website analysed" : l.pipeline_status === "enrich_failed" ? l.pipeline_error : "Waiting", l.enriched_at ? "done" : l.pipeline_status === "enrich_failed" ? "failed" : l.pipeline_status ? "pending" : "none", l.enriched_at],
        ["Validation", l.validation ? "Email, phone, website checked" : "Waiting", l.validation ? "done" : l.pipeline_status ? "pending" : "none", l.validation?.checkedAt ?? null],
        ["AI qualification", l.qualified_at ? `Score ${l.lead_score}` : l.pipeline_status === "qualify_failed" ? l.pipeline_error : "Waiting", l.qualified_at ? "done" : l.pipeline_status === "qualify_failed" ? "failed" : l.pipeline_status ? "pending" : "none", l.qualified_at],
      ]
    : [];

  const val = (f: string): ReactNode => {
    const x = l?.[f === "main_phone" ? "main_phone_e164" : f] ?? l?.[f];
    if (f === "social_urls") return (l.social_urls ?? []).length ? <div className="space-y-0.5">{l.social_urls.map((u: string) => <a key={u} href={u} target="_blank" rel="noreferrer" className="block text-red-600 hover:underline truncate">{u.replace(/^https?:\/\/(www\.)?/, "")}</a>)}</div> : null;
    if (f === "website" && x) return <a href={x} target="_blank" rel="noreferrer" className="text-red-600 hover:underline break-all">{x}</a>;
    return x ?? null;
  };
  const verdict = (f: string) => {
    if (f === "business_email" && l?.business_email) return v.email ? <Pill tone={v.email.valid ? "bg-green-50 text-green-700" : "bg-amber-50 text-amber-700"} title={v.email.detail}>{v.email.valid ? "valid" : v.email.status === "unknown" ? "unverified" : "invalid"}{v.email.role ? " · generic" : ""}</Pill> : null;
    if (f === "main_phone" && (l?.main_phone_e164 || l?.main_phone)) return v.phone ? <Pill tone={v.phone.valid ? "bg-green-50 text-green-700" : "bg-amber-50 text-amber-700"} title={v.phone.detail}>{v.phone.valid ? "valid" : "invalid"}</Pill> : null;
    if (f === "website" && l?.website_status) return <Pill tone={SITE_TONE[l.website_status]}>{SITE_LABEL[l.website_status]}</Pill>;
    return null;
  };

  return (
    <Drawer
      onClose={onClose}
      title={
        l ? (
          <div className="flex items-center gap-3">
            <ScoreRing value={l.lead_score} size={56} />
            <div className="min-w-0">
              <div className="text-lg font-semibold text-slate-900 truncate">{l.business_name}</div>
              <div className="text-xs text-slate-500 truncate">{[l.category, [l.city, l.state, l.country].filter(Boolean).join(", ")].filter(Boolean).join(" · ")}</div>
              <div className="flex gap-1.5 mt-1">
                {l.qualification_status && <Pill tone={STATUS_TONE[l.qualification_status]}>{STATUS_LABEL[l.qualification_status]}</Pill>}
                {l.website_status && <Pill tone={SITE_TONE[l.website_status]}>{SITE_LABEL[l.website_status]}</Pill>}
                {l.completeness != null && <Pill tone="bg-slate-100 text-slate-600">{l.completeness}% complete</Pill>}
              </div>
            </div>
          </div>
        ) : (
          <Skeleton className="h-12 w-64" />
        )
      }
    >
      {!l ? (
        <Skeleton className="h-96" />
      ) : (
        <>
          {msg && <Banner kind={msg.kind} onClose={() => setMsg(null)}>{msg.text}</Banner>}

          <Section title="Data pipeline">
            <ol className="relative border-l border-slate-200 ml-2 space-y-2.5">
              {pipeline.map(([name, detail, st, at]) => (
                <li key={name} className="ml-4">
                  <span className={`absolute -left-[7px] w-3.5 h-3.5 rounded-full ring-2 ring-white ${st === "done" ? "bg-green-500" : st === "failed" ? "bg-red-500" : st === "pending" ? "bg-violet-400 animate-pulse" : "bg-slate-300"}`} />
                  <div className="text-sm text-slate-800 flex justify-between gap-2"><span className="font-medium">{name}</span>{at && <span className="text-[11px] text-slate-400">{ago(at)}</span>}</div>
                  <div className={`text-xs ${st === "failed" ? "text-red-600" : "text-slate-500"}`}>{detail}</div>
                </li>
              ))}
            </ol>
            <div className="flex gap-2 mt-3">
              <Btn onClick={() => act(() => api("/leadgen/leads/bulk", { method: "POST", body: { ids: [id], action: "reenrich" } }), "Re-enrichment queued.")}><Icon d={I.retry} size={14} /> Re-enrich</Btn>
              <Btn onClick={() => act(() => api("/leadgen/leads/bulk", { method: "POST", body: { ids: [id], action: "requalify" } }), "Re-scoring queued.")}>Re-score</Btn>
            </div>
          </Section>

          {q && (
            <Section title="AI qualification" action={<span className="text-[11px] text-slate-400">{q.model} · {ago(q.at)}</span>}>
              <p className="text-sm text-slate-700 leading-relaxed">{q.summary}</p>
              {q.mustHaveFailures?.length > 0 && <div className="mt-2"><Banner kind="error">Doesn't meet: {q.mustHaveFailures.join("; ")}</Banner></div>}
              <div className="mt-3 space-y-2">
                {[["Fit", q.fit?.score, q.fit?.reason, "30%"], ["Industry match", q.industry?.score, q.industry?.reason, "20%"], ["Location match", q.location?.score, q.location?.reason, "15%"], ["Data completeness", q.completeness, "How many key fields we have", "15%"], ["Top opportunity", q.opportunities?.[0]?.strength ?? 0, q.opportunities?.[0]?.label ?? "None found", "20%"]].map(([lab, s, why, w]) => (
                  <div key={lab as string}>
                    <div className="flex items-center gap-3"><span className="text-xs text-slate-600 w-32 shrink-0">{lab as string} <span className="text-slate-400">{w as string}</span></span><ScoreBar value={s as number} className="flex-1" /></div>
                    {why && <div className="text-[11px] text-slate-500 ml-[8.75rem]">{why as string}</div>}
                  </div>
                ))}
              </div>
              <p className="text-[11px] text-slate-400 mt-2">Lead score {q.leadScore} = {q.formula}. Qualifies at {q.threshold}.</p>
              {q.opportunities?.length > 0 && (
                <div className="mt-3">
                  <div className="text-xs font-medium text-slate-600 mb-1">Opportunities</div>
                  <ul className="space-y-2">
                    {q.opportunities.map((o: any) => (
                      <li key={o.key} className="rounded-xl bg-slate-50 p-2.5">
                        <div className="flex items-center justify-between text-sm"><span className="font-medium text-slate-800">{oppLabel[o.key] ?? o.label}</span><span className="text-xs text-slate-500">strength {o.strength}</span></div>
                        <div className="text-xs text-slate-600 mt-0.5">{o.reason}</div>
                        <div className="flex flex-wrap gap-1 mt-1">{o.evidence.map((e: string) => <span key={e} className="text-[10px] bg-white border border-slate-200 rounded px-1.5 text-slate-500">based on: {e.replace(/_/g, " ")}</span>)}</div>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {q.concerns?.length > 0 && <div className="text-xs text-slate-600 mt-2"><span className="font-medium">Concerns:</span> {q.concerns.join(" · ")}</div>}
              {q.discardedOpportunities?.length > 0 && <p className="text-[11px] text-slate-400 mt-2">{q.discardedOpportunities.length} AI suggestion(s) discarded because they weren't backed by collected facts.</p>}
              {q.manualStatus && <p className="text-[11px] text-slate-500 mt-1">Status set manually to {STATUS_LABEL[q.manualStatus]}.</p>}
            </Section>
          )}

          <Section title="Business data" action={edit ? null : <button type="button" className="text-xs text-red-600 hover:underline" onClick={() => setEdit({ business_name: l.business_name ?? "", website: l.website ?? "", main_phone: l.main_phone ?? "", business_email: l.business_email ?? "", decision_maker_name: l.decision_maker_name ?? "", company_size: l.company_size ?? "" })}>Edit</button>}>
            {edit ? (
              <div className="space-y-2">
                {Object.entries(edit).map(([k, value]) => (
                  <label key={k} className="block text-xs text-slate-600">{FIELDS.find(([f]) => f === k)?.[1] ?? k}<input className={`${inputCls} mt-0.5`} value={value} onChange={(e) => setEdit({ ...edit, [k]: e.target.value })} /></label>
                ))}
                <p className="text-[11px] text-slate-500">Edits are recorded as “entered manually”. Changing contact details re-runs validation and scoring.</p>
                <div className="flex justify-end gap-2">
                  <Btn onClick={() => setEdit(null)}>Cancel</Btn>
                  <Btn kind="primary" onClick={() => act(() => api(`/leadgen/leads/${id}`, { method: "PATCH", body: Object.fromEntries(Object.entries(edit).map(([k, x]) => [k, x.trim() || (k === "business_name" ? l.business_name : null)])) }), "Saved.").then(() => setEdit(null))}>Save</Btn>
                </div>
              </div>
            ) : (
              <dl className="divide-y divide-slate-100">
                {FIELDS.map(([f, label]) => {
                  const value = val(f);
                  const m = fm[f];
                  return (
                    <div key={f} className="py-2 grid grid-cols-3 gap-2 text-sm">
                      <dt className="text-slate-500 text-xs pt-0.5">{label}</dt>
                      <dd className="col-span-2 min-w-0">
                        {value != null && value !== "" ? (
                          <>
                            <div className="flex items-start justify-between gap-2"><div className="text-slate-800 break-words min-w-0">{value}</div>{verdict(f)}</div>
                            {m && (
                              <div className="text-[11px] text-slate-400 mt-0.5">
                                from {SOURCE_LABEL[m.source] ?? m.source}{m.page ? <> (<a href={m.page} target="_blank" rel="noreferrer" className="hover:underline">page</a>)</> : null}{m.at ? ` · ${ago(m.at)}` : ""}
                                {m.confirmedBy?.length ? ` · confirmed by ${m.confirmedBy.map((s: string) => SOURCE_LABEL[s] ?? s).join(", ")}` : ""}
                              </div>
                            )}
                            {m?.conflicts?.length > 0 && <div className="text-[11px] text-amber-700 mt-0.5">Other sources say: {m.conflicts.map((c: any) => `“${c.value}” (${SOURCE_LABEL[c.source] ?? c.source})`).join(", ")}</div>}
                          </>
                        ) : (
                          <span className="text-xs text-slate-400">{m?.note ?? "Not found in any source"}</span>
                        )}
                      </dd>
                    </div>
                  );
                })}
              </dl>
            )}
          </Section>

          {l.enrichment?.website && (
            <Section title="Website analysis">
              <ul className="text-sm text-slate-700 space-y-1 list-disc ml-4">{(l.enrichment.website.reasons ?? []).map((r: string) => <li key={r}>{r}</li>)}</ul>
              {l.enrichment.website.signals && !l.enrichment.website.signals.error && (
                <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-slate-500 mt-2">
                  {l.enrichment.website.signals.title && <div className="col-span-2 truncate">Title: {l.enrichment.website.signals.title}</div>}
                  {l.enrichment.website.signals.generator && <div>Built with: {l.enrichment.website.signals.generator}</div>}
                  {l.enrichment.website.signals.ms != null && <div>Load time: {(l.enrichment.website.signals.ms / 1000).toFixed(1)}s</div>}
                  {l.enrichment.website.signals.words != null && <div>Content: {l.enrichment.website.signals.words} words</div>}
                  {l.enrichment.website.signals.hasForm != null && <div>Contact form: {l.enrichment.website.signals.hasForm ? "yes" : "no"}</div>}
                </div>
              )}
            </Section>
          )}

          <Section title="Tags & notes">
            <div className="flex flex-wrap gap-1 mb-2">
              {(l.tags ?? []).map((t: string) => (
                <span key={t} className="inline-flex items-center gap-1 text-xs bg-slate-100 text-slate-700 rounded-full pl-2 pr-1 py-0.5">{t}<button type="button" onClick={() => act(() => api(`/leadgen/leads/${id}`, { method: "PATCH", body: { tags: l.tags.filter((x: string) => x !== t) } }))} className="text-slate-400 hover:text-red-600"><Icon d={I.x} size={12} /></button></span>
              ))}
              <form onSubmit={(e) => { e.preventDefault(); if (tag.trim()) act(() => api(`/leadgen/leads/${id}`, { method: "PATCH", body: { tags: [...(l.tags ?? []), tag.trim()] } })).then(() => setTag("")); }}>
                <input className="text-xs border border-dashed border-slate-300 rounded-full px-2 py-0.5 w-24 focus:outline-none focus:border-red-300" placeholder="+ tag" value={tag} onChange={(e) => setTag(e.target.value)} />
              </form>
            </div>
            <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (note.trim()) act(() => api(`/leadgen/leads/${id}/notes`, { method: "POST", body: { body: note } })).then(() => setNote("")); }}>
              <input className={`${inputCls} py-1.5`} placeholder="Add a note…" value={note} onChange={(e) => setNote(e.target.value)} />
              <Btn type="submit" kind="primary" disabled={!note.trim()}>Add</Btn>
            </form>
            <ul className="mt-2 space-y-2">
              {data!.notes.map((n) => (
                <li key={n.id} className="text-sm bg-slate-50 rounded-lg p-2 group">
                  <div className="text-slate-700 whitespace-pre-line">{n.body}</div>
                  <div className="text-[11px] text-slate-400 flex justify-between">{n.author ?? "—"} · {ago(n.created_at)}<button type="button" className="opacity-0 group-hover:opacity-100 hover:text-red-600" onClick={() => act(() => api(`/leadgen/leads/${id}/notes/${n.id}`, { method: "DELETE" }))}>delete</button></div>
                </li>
              ))}
            </ul>
          </Section>

          <Section title="Discovery history">
            {!data!.jobs.length ? <p className="text-xs text-slate-500">Added outside Lead Discovery ({SOURCE_LABEL[l.source] ?? l.source}).</p> : (
              <ul className="text-sm space-y-1">{data!.jobs.map((j) => <li key={j.id} className="flex justify-between"><span className="text-slate-700 truncate">{j.name}</span><span className="text-xs text-slate-400 shrink-0">{j.was_new ? "new" : "already known"} · {ago(j.created_at)}</span></li>)}</ul>
            )}
          </Section>

          {data!.sourceRecords.length > 0 && (
            <Section title="Raw source records">
              {data!.sourceRecords.map((r) => (
                <details key={r.id} className="text-xs border border-slate-100 rounded-lg mb-1.5">
                  <summary className="cursor-pointer px-2.5 py-1.5 text-slate-600">{SOURCE_LABEL[r.source] ?? r.source} · {r.source_ref} · {ago(r.fetched_at)}{r.source_url && <a href={r.source_url} target="_blank" rel="noreferrer" className="ml-2 text-red-600 hover:underline" onClick={(e) => e.stopPropagation()}>open</a>}</summary>
                  <pre className="px-2.5 pb-2 overflow-x-auto text-[10px] text-slate-500 max-h-64">{JSON.stringify(r.raw, null, 1)}</pre>
                </details>
              ))}
            </Section>
          )}
        </>
      )}
    </Drawer>
  );
}
