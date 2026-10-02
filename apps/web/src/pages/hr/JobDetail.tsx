import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api, ApiError } from "../../lib/api.js";
import { invalidate, useApi } from "../../lib/useApi.js";
import {
  Banner, Btn, Empty, Field, FitBadge, I, Icon, Modal, RecBadge, STAGES, STAGE_DOT, STAGE_LABEL, ScoreBar, Skeleton, StageBadge, ago, initials, inputCls, personName, uploadFiles, when,
  type Fit, type Stage,
} from "./ui.js";

const JobSetup = lazy(() => import("./JobSetup.js"));

export interface JobPayload {
  job: any;
  criteria: Array<{ key: string; label: string; weight: number; guidance?: string }>;
  defaultCriteria: Array<{ key: string; label: string; weight: number; guidance?: string }>;
  requirementsList: string[];
  interview: any;
  stages: Partial<Record<Stage, number>>;
  posting: { applyUrl: string | null; jsonLd: unknown; copy: { full: string; linkedin: string; indeed: string; short: string }; feedUrl: string | null; checklist: Array<{ item: string; ok: boolean }> };
}

interface Row {
  id: string;
  stage: Stage;
  created_at: string;
  processing_status: string;
  processing_error: string | null;
  processing_detail: string | null;
  ai_fit: Fit | null;
  hr_fit: Fit | null;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  file_name: string | null;
  overall_score: number | null;
  summary: string | null;
  source: string;
  scheduled_at: string | null;
  call_status: string | null;
  ai_recommendation: string | null;
  hr_recommendation: string | null;
  interview_score: number | null;
}

const TABS = [
  ["candidates", "Candidates"],
  ["description", "Job description"],
  ["posting", "Posting"],
  ["interview", "AI interview"],
  ["scoring", "Scoring"],
] as const;
const RUNNING = ["QUEUED", "PARSING", "SCORING"];

export default function JobDetail() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") ?? "candidates") as (typeof TABS)[number][0];
  const { data, error, reload } = useApi<JobPayload>(`/hr/jobs/${id}`);
  const job = data?.job;
  const total = data ? Object.values(data.stages).reduce((a, b) => a + (b ?? 0), 0) : 0;

  async function setStatus(status: string) {
    await api(`/hr/jobs/${id}/status`, { method: "POST", body: { status } });
    await reload();
    invalidate("/hr/overview");
  }

  if (error) return <Banner kind="error">{error}</Banner>;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link to="/hr" className="text-xs text-slate-500 hover:text-red-600">Vahlay HR</Link>
          {job ? (
            <>
              <h1 className="text-2xl font-semibold text-slate-900 truncate">{job.title}</h1>
              <div className="text-sm text-slate-500">{[job.department, job.location, job.employment_type?.replace("_", "-")].filter(Boolean).join(" · ") || "—"}</div>
            </>
          ) : (
            <Skeleton className="h-8 w-72 mt-1" />
          )}
        </div>
        {job && (
          <div className="flex items-center gap-2">
            <span className={`text-xs font-semibold uppercase tracking-wide rounded-full px-2.5 py-1 ${job.status === "published" ? "bg-green-100 text-green-700" : job.status === "closed" ? "bg-slate-200 text-slate-500" : "bg-slate-100 text-slate-600"}`}>{job.status}</span>
            {job.status !== "published" ? (
              <Btn kind="primary" onClick={() => setStatus("published").catch((e) => alert(e instanceof ApiError ? e.message : "Couldn't publish."))}><Icon d={I.globe} size={15} /> Publish</Btn>
            ) : (
              <>
                <Btn onClick={() => setStatus("draft")}>Unpublish</Btn>
                <Btn onClick={() => confirm("Close this job? The careers page stops accepting applications.") && setStatus("closed")}>Close</Btn>
              </>
            )}
          </div>
        )}
      </div>

      <div className="flex gap-1 border-b border-slate-200 overflow-x-auto">
        {TABS.map(([k, l]) => (
          <button
            key={k}
            type="button"
            onClick={() => setParams(k === "candidates" ? {} : { tab: k }, { replace: true })}
            className={`relative px-3.5 py-2 text-sm whitespace-nowrap transition-colors ${tab === k ? "text-red-600 font-medium" : "text-slate-500 hover:text-slate-800"}`}
          >
            {l}
            {k === "candidates" && total > 0 && <span className="ml-1.5 text-[11px] bg-slate-100 text-slate-600 rounded-full px-1.5">{total}</span>}
            {tab === k && <span className="absolute left-2 right-2 -bottom-px h-0.5 bg-red-600 rounded-full" />}
          </button>
        ))}
      </div>

      {!data ? (
        <Skeleton className="h-64" />
      ) : tab === "candidates" ? (
        <Candidates jobId={id!} payload={data} onChanged={reload} />
      ) : (
        <Suspense fallback={<Skeleton className="h-64" />}>
          <JobSetup tab={tab} payload={data} onSaved={reload} />
        </Suspense>
      )}
    </div>
  );
}

function Candidates({ jobId, payload, onChanged }: { jobId: string; payload: JobPayload; onChanged: () => void }) {
  const nav = useNavigate();
  const [stage, setStage] = useState<Stage | "">("");
  const [fit, setFit] = useState<Fit | "">("");
  const [q, setQ] = useState("");
  const [debQ, setDebQ] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebQ(q), 250);
    return () => clearTimeout(t);
  }, [q]);
  const qs = new URLSearchParams({ ...(stage ? { stage } : {}), ...(fit ? { fit } : {}), ...(debQ ? { q: debQ } : {}) }).toString();
  const path = `/hr/jobs/${jobId}/applications${qs ? `?${qs}` : ""}`;
  const { data, reload } = useApi<{ applications: Row[] }>(path);
  const rows = data?.applications ?? [];
  const running = rows.some((r) => RUNNING.includes(r.processing_status));
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => {
      reload();
    }, 4000);
    return () => clearInterval(t);
  }, [running, reload]);

  const [sel, setSel] = useState<Set<string>>(new Set());
  useEffect(() => setSel(new Set()), [path]);
  const selected = rows.filter((r) => sel.has(r.id));
  const [modal, setModal] = useState<null | "stage" | "invite" | "message" | "delete">(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const refresh = async () => {
    await reload();
    onChanged();
    invalidate("/hr/overview");
  };

  async function bulk(body: Record<string, unknown>) {
    const r = await api<{ updated: number; errors?: string[] }>("/hr/applications/bulk", { method: "POST", body: { ids: Array.from(sel), ...body } });
    setMsg({ kind: "ok", text: `${r.updated} candidate${r.updated === 1 ? "" : "s"} updated.` });
    setSel(new Set());
    await refresh();
  }

  return (
    <div className="space-y-4">
      <Uploader jobId={jobId} onDone={refresh} />
      {msg && <Banner kind={msg.kind} onClose={() => setMsg(null)}>{msg.text}</Banner>}

      <div className="flex flex-wrap gap-1.5">
        <Chip active={!stage} onClick={() => setStage("")} label="All" n={Object.values(payload.stages).reduce((a, b) => a + (b ?? 0), 0)} />
        {STAGES.filter((s) => payload.stages[s]).map((s) => (
          <Chip key={s} active={stage === s} onClick={() => setStage(stage === s ? "" : s)} label={STAGE_LABEL[s]} n={payload.stages[s] ?? 0} dot={STAGE_DOT[s]} />
        ))}
      </div>

      <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-slate-100">
          <div className="relative flex-1 min-w-[180px]">
            <Icon d={I.search} size={15} className="absolute left-2.5 top-2.5 text-slate-400" />
            <input className={`${inputCls} pl-8 py-1.5`} placeholder="Search name, email or file" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div className="w-36 shrink-0">
            <select className={`${inputCls} py-1.5`} value={fit} onChange={(e) => setFit(e.target.value as Fit | "")}>
              <option value="">Any fit</option>
              <option value="GOOD_FIT">Good fit</option>
              <option value="REVIEW">Review</option>
              <option value="NOT_A_FIT">Not a fit</option>
            </select>
          </div>
        </div>

        {sel.size > 0 && (
          <div className="flex flex-wrap items-center gap-2 px-4 py-2 bg-red-50/60 border-b border-red-100 animate-fade-in">
            <span className="text-sm font-medium text-slate-700 mr-1">{sel.size} selected</span>
            <Btn onClick={() => setModal("stage")}>Move stage</Btn>
            <Btn onClick={() => setModal("invite")}><Icon d={I.phone} size={14} /> Invite to interview</Btn>
            <Btn onClick={() => setModal("message")}><Icon d={I.mail} size={14} /> Message</Btn>
            <Btn onClick={() => bulk({ action: "retry" })}><Icon d={I.retry} size={14} /> Re-screen</Btn>
            <Btn kind="danger" onClick={() => setModal("delete")}><Icon d={I.trash} size={14} /> Delete</Btn>
            <button type="button" className="ml-auto text-xs text-slate-500 hover:text-slate-800" onClick={() => setSel(new Set())}>Clear</button>
          </div>
        )}

        {!data ? (
          <div className="p-4 space-y-2">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-12" />)}</div>
        ) : !rows.length ? (
          <Empty icon={I.users} title={stage || fit || debQ ? "No candidates match" : "No candidates yet"}>
            {stage || fit || debQ ? "Try a different filter." : "Drop resumes above, or publish the job and share the careers link."}
          </Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-[11px] uppercase tracking-wide text-slate-400 bg-slate-50/60">
                <tr>
                  <th className="pl-4 py-2 w-8">
                    <input type="checkbox" checked={sel.size === rows.length} onChange={(e) => setSel(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())} />
                  </th>
                  <th className="text-left px-3 py-2">Candidate</th>
                  <th className="text-left px-3 py-2 w-40">Resume score</th>
                  <th className="text-left px-3 py-2">Fit</th>
                  <th className="text-left px-3 py-2">Stage</th>
                  <th className="text-left px-3 py-2">Interview</th>
                  <th className="text-right px-4 py-2">Added</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((r) => (
                  <tr key={r.id} className={`group hover:bg-slate-50/80 cursor-pointer ${sel.has(r.id) ? "bg-red-50/30" : ""}`} onClick={() => nav(`/hr/applications/${r.id}`)}>
                    <td className="pl-4 py-2.5" onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" checked={sel.has(r.id)} onChange={(e) => { const s = new Set(sel); e.target.checked ? s.add(r.id) : s.delete(r.id); setSel(s); }} />
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-2.5">
                        <span className="w-8 h-8 rounded-full bg-slate-100 text-slate-600 text-xs font-semibold flex items-center justify-center shrink-0">{initials(r)}</span>
                        <div className="min-w-0">
                          <div className="font-medium text-slate-800 truncate max-w-[220px] group-hover:text-red-600">{personName(r)}</div>
                          <div className="text-xs text-slate-400 truncate max-w-[220px]">{r.email ?? r.file_name ?? "—"}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2.5">
                      {RUNNING.includes(r.processing_status) ? (
                        <span className="inline-flex items-center gap-1.5 text-xs text-sky-700"><span className="w-3 h-3 rounded-full border-2 border-sky-300 border-t-sky-600 animate-spin" />{r.processing_detail ?? "Queued"}</span>
                      ) : r.processing_status === "PARSE_FAILED" || r.processing_status === "AI_FAILED" ? (
                        <span className="text-xs text-red-600" title={r.processing_error ?? ""}>{r.processing_status === "PARSE_FAILED" ? "Couldn't read resume" : "AI scoring failed"}</span>
                      ) : (
                        <ScoreBar value={r.overall_score} />
                      )}
                    </td>
                    <td className="px-3 py-2.5"><FitBadge ai={r.ai_fit} hr={r.hr_fit} /></td>
                    <td className="px-3 py-2.5"><StageBadge stage={r.stage} /></td>
                    <td className="px-3 py-2.5 text-xs">
                      {r.ai_recommendation || r.hr_recommendation ? (
                        <span className="inline-flex items-center gap-1.5"><RecBadge ai={r.ai_recommendation} hr={r.hr_recommendation} />{r.interview_score != null && <span className="text-slate-500 tabular-nums">{r.interview_score}</span>}</span>
                      ) : r.scheduled_at && r.call_status === "pending" ? (
                        <span className="text-purple-700">{when(r.scheduled_at)}</span>
                      ) : r.call_status && !["pending"].includes(r.call_status) ? (
                        <span className="text-slate-500">{r.call_status.replace("_", " ")}</span>
                      ) : (
                        <span className="text-slate-300">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right text-xs text-slate-400 whitespace-nowrap">{ago(r.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {modal === "stage" && <StageModal count={sel.size} onClose={() => setModal(null)} onApply={(s, reason) => bulk({ action: "stage", stage: s, reason }).then(() => setModal(null))} />}
      {modal === "delete" && (
        <Modal title="Delete candidates" onClose={() => setModal(null)}>
          <p className="text-sm text-slate-600">Permanently delete {sel.size} candidate{sel.size === 1 ? "" : "s"} and their resume, scores, messages and interview data from this job? This can't be undone. The deletion is recorded in the audit log.</p>
          <div className="flex justify-end gap-2 mt-4">
            <Btn onClick={() => setModal(null)}>Cancel</Btn>
            <Btn kind="primary" onClick={() => bulk({ action: "delete" }).then(() => setModal(null))}>Delete</Btn>
          </div>
        </Modal>
      )}
      {modal === "invite" && (
        <InviteModal
          ids={Array.from(sel)}
          names={selected.map(personName)}
          hasQuestions={(payload.interview?.questions ?? []).length > 0}
          onClose={() => setModal(null)}
          onDone={async (text) => { setModal(null); setSel(new Set()); setMsg({ kind: "ok", text }); await refresh(); }}
        />
      )}
      {modal === "message" && (
        <MessageModal
          ids={Array.from(sel)}
          onClose={() => setModal(null)}
          onDone={async (text) => { setModal(null); setSel(new Set()); setMsg({ kind: "ok", text }); await refresh(); }}
        />
      )}
    </div>
  );
}

function Chip({ active, onClick, label, n, dot }: { active: boolean; onClick: () => void; label: string; n: number; dot?: string }) {
  return (
    <button type="button" onClick={onClick} className={`inline-flex items-center gap-1.5 text-xs rounded-full px-3 py-1 border transition-colors ${active ? "bg-slate-900 text-white border-slate-900" : "bg-white text-slate-600 border-slate-200 hover:border-slate-300"}`}>
      {dot && <span className={`w-1.5 h-1.5 rounded-full ${dot}`} />}
      {label}
      <span className={`tabular-nums ${active ? "text-white/70" : "text-slate-400"}`}>{n}</span>
    </button>
  );
}

function Uploader({ jobId, onDone }: { jobId: string; onDone: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const [pct, setPct] = useState<number | null>(null);
  const [result, setResult] = useState<{ accepted: number; failed: number; results: Array<{ file: string; ok: boolean; error?: string }> } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function send(files: FileList | File[]) {
    const list = Array.from(files);
    if (!list.length) return;
    setErr(null);
    setResult(null);
    const batches: File[][] = [];
    for (let i = 0; i < list.length; i += 50) batches.push(list.slice(i, i + 50));
    const all = { accepted: 0, failed: 0, results: [] as Array<{ file: string; ok: boolean; error?: string }> };
    try {
      for (let b = 0; b < batches.length; b++) {
        const form = new FormData();
        batches[b].forEach((f) => form.append("files", f));
        const r = await uploadFiles(`/api/hr/jobs/${jobId}/resumes`, form, (p) => setPct(Math.round(((b + p / 100) / batches.length) * 100)));
        all.accepted += r.accepted;
        all.failed += r.failed;
        all.results.push(...r.results);
      }
      setResult(all);
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setPct(null);
      if (input.current) input.current.value = "";
    }
  }

  return (
    <div>
      <div
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); send(e.dataTransfer.files); }}
        onClick={() => pct == null && input.current?.click()}
        className={`relative overflow-hidden rounded-2xl border-2 border-dashed px-5 py-5 flex items-center gap-4 cursor-pointer transition-colors ${drag ? "border-red-400 bg-red-50/60" : "border-slate-200 bg-white hover:border-red-200"}`}
      >
        <span className="w-10 h-10 rounded-xl bg-red-50 text-red-600 flex items-center justify-center shrink-0"><Icon d={I.upload} size={20} /></span>
        <div className="min-w-0">
          <div className="text-sm font-medium text-slate-800">{pct != null ? `Uploading… ${pct}%` : "Drop resumes here or click to choose"}</div>
          <div className="text-xs text-slate-500">PDF, DOC or DOCX · up to 10 MB each · as many as you like. Each is screened in the background; a bad file never stops the rest.</div>
        </div>
        {pct != null && <div className="absolute left-0 bottom-0 h-1 bg-red-500 transition-[width]" style={{ width: `${pct}%` }} />}
        <input ref={input} type="file" multiple accept=".pdf,.doc,.docx" className="hidden" onChange={(e) => e.target.files && send(e.target.files)} />
      </div>
      {err && <div className="mt-2"><Banner kind="error" onClose={() => setErr(null)}>{err}</Banner></div>}
      {result && (
        <div className="mt-2">
          <Banner kind={result.failed ? "info" : "ok"} onClose={() => setResult(null)}>
            {result.accepted} resume{result.accepted === 1 ? "" : "s"} added and queued for screening{result.failed ? `, ${result.failed} skipped:` : "."}
            {result.failed > 0 && (
              <ul className="mt-1 text-xs space-y-0.5">
                {result.results.filter((r) => !r.ok).map((r, i) => <li key={i}><span className="font-medium">{r.file}</span> — {r.error}</li>)}
              </ul>
            )}
          </Banner>
        </div>
      )}
    </div>
  );
}

export function StageModal({ count, current, onClose, onApply }: { count: number; current?: Stage; onClose: () => void; onApply: (s: Stage, reason: string) => Promise<unknown> }) {
  const [s, setS] = useState<Stage>(current ?? "SHORTLISTED");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <Modal title={count > 1 ? `Move ${count} candidates` : "Move candidate"} onClose={onClose}>
      <div className="space-y-3">
        {err && <Banner kind="error">{err}</Banner>}
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
          {STAGES.map((x) => (
            <button key={x} type="button" onClick={() => setS(x)} className={`text-left text-sm rounded-lg border px-2.5 py-1.5 flex items-center gap-2 transition-colors ${s === x ? "border-red-300 bg-red-50 text-red-700" : "border-slate-200 hover:border-slate-300"}`}>
              <span className={`w-2 h-2 rounded-full ${STAGE_DOT[x]}`} />{STAGE_LABEL[x]}
            </button>
          ))}
        </div>
        <Field label="Reason (saved to the timeline and audit log)"><input className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        <p className="text-xs text-slate-500">Moving a stage never messages the candidate. Send a message separately when you're ready.</p>
        <div className="flex justify-end gap-2">
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn kind="primary" disabled={busy} onClick={async () => { setBusy(true); try { await onApply(s, reason); } catch (e) { setErr(e instanceof ApiError ? e.message : "Failed."); setBusy(false); } }}>Move</Btn>
        </div>
      </div>
    </Modal>
  );
}

export function InviteModal({ ids, names, hasQuestions, onClose, onDone }: { ids: string[]; names: string[]; hasQuestions: boolean; onClose: () => void; onDone: (msg: string) => void }) {
  const { data: tpl } = useApi<{ templates: Record<string, { subject: string; email: string; sms: string }> }>("/hr/templates");
  const [email, setEmail] = useState(true);
  const [sms, setSms] = useState(false);
  const [subject, setSubject] = useState<string | null>(null);
  const [body, setBody] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const t = tpl?.templates.invite;

  async function send() {
    setBusy(true);
    setErr(null);
    try {
      const channels = [email && "email", sms && "sms"].filter(Boolean);
      if (!channels.length) throw new Error("Choose email and/or SMS.");
      const payload = { channels, subject: subject ?? undefined, emailBody: body ?? undefined };
      if (ids.length === 1) {
        await api(`/hr/applications/${ids[0]}/invite`, { method: "POST", body: payload });
        onDone("Interview invitation approved and queued. The candidate picks a time from their private link.");
      } else {
        const r = await api<{ invited: number; results: Array<{ ok: boolean; error?: string }> }>("/hr/applications/bulk-invite", { method: "POST", body: { ...payload, ids } });
        const fails = r.results.filter((x) => !x.ok);
        onDone(`${r.invited} invitation${r.invited === 1 ? "" : "s"} queued.${fails.length ? ` ${fails.length} skipped: ${Array.from(new Set(fails.map((f) => f.error))).join("; ")}` : ""}`);
      }
    } catch (e) {
      setErr(e instanceof ApiError || e instanceof Error ? e.message : "Couldn't send.");
      setBusy(false);
    }
  }

  return (
    <Modal title={ids.length > 1 ? `Invite ${ids.length} candidates to an AI phone interview` : `Invite ${names[0] ?? "candidate"} to an AI phone interview`} onClose={onClose} wide>
      <div className="space-y-3">
        {!hasQuestions && <Banner kind="error">This job has no interview questions yet. Add them in the “AI interview” tab first.</Banner>}
        {err && <Banner kind="error">{err}</Banner>}
        <p className="text-sm text-slate-600">Each candidate gets a private link to choose a time that suits them. At that time, the AI interviewer calls them, asks your structured questions, and the call is recorded and transcribed for your review. Confirmations and reminders go out automatically after they book.</p>
        <div className="flex gap-4">
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={email} onChange={(e) => setEmail(e.target.checked)} /> Email</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={sms} onChange={(e) => setSms(e.target.checked)} /> SMS</label>
        </div>
        {email && t && (
          <>
            <Field label="Email subject"><input className={inputCls} value={subject ?? t.subject} onChange={(e) => setSubject(e.target.value)} /></Field>
            <Field label="Email" hint="{{first_name}}, {{job_title}}, {{company}}, {{schedule_link}}, {{phone}} and {{duration}} are filled in per candidate.">
              <textarea className={`${inputCls} h-48`} value={body ?? t.email} onChange={(e) => setBody(e.target.value)} />
            </Field>
          </>
        )}
        {sms && t && <div className="text-xs text-slate-500 bg-slate-50 rounded-lg p-2.5"><span className="font-medium">SMS:</span> {t.sms}</div>}
        <div className="flex justify-end gap-2 pt-1">
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn kind="primary" disabled={busy || !hasQuestions} onClick={send}><Icon d={I.check} size={15} /> {busy ? "Sending…" : "Approve & send"}</Btn>
        </div>
      </div>
    </Modal>
  );
}

const KINDS: Array<[string, string]> = [["next_round", "Next round"], ["info_request", "Request information"], ["rejection", "Rejection"], ["custom", "Custom message"]];

export function MessageModal({ ids, onClose, onDone, defaultKind = "next_round" }: { ids: string[]; onClose: () => void; onDone: (msg: string) => void; defaultKind?: string }) {
  const { data: tpl } = useApi<{ templates: Record<string, { subject: string; email: string; sms: string }> }>("/hr/templates");
  const [kind, setKind] = useState(defaultKind);
  const [channel, setChannel] = useState<"email" | "sms">("email");
  const [subject, setSubject] = useState<string | null>(null);
  const [body, setBody] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const t = tpl?.templates[kind];
  const curBody = body ?? (channel === "email" ? t?.email : t?.sms) ?? "";
  useEffect(() => {
    setBody(null);
    setSubject(null);
  }, [kind, channel]);

  async function go(send: boolean) {
    setBusy(true);
    setErr(null);
    try {
      const payload = { channel, kind, subject: channel === "email" ? subject ?? t?.subject : undefined, body: curBody, send };
      if (ids.length === 1) {
        await api(`/hr/applications/${ids[0]}/messages`, { method: "POST", body: payload });
        onDone(send ? "Message approved and queued for sending." : "Draft saved. Approve it when you're ready.");
      } else {
        const r = await api<{ created: number; results: Array<{ ok: boolean; error?: string }> }>("/hr/applications/bulk-message", { method: "POST", body: { ...payload, ids } });
        const fails = r.results.filter((x) => !x.ok);
        onDone(`${r.created} message${r.created === 1 ? "" : "s"} ${send ? "queued" : "drafted"}.${fails.length ? ` ${fails.length} skipped: ${Array.from(new Set(fails.map((f) => f.error))).join("; ")}` : ""}`);
      }
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Couldn't save the message.");
      setBusy(false);
    }
  }

  return (
    <Modal title={ids.length > 1 ? `Message ${ids.length} candidates` : "Message candidate"} onClose={onClose} wide>
      <div className="space-y-3">
        {err && <Banner kind="error">{err}</Banner>}
        <div className="grid sm:grid-cols-2 gap-3">
          <Field label="Type">
            <select className={inputCls} value={kind} onChange={(e) => setKind(e.target.value)}>{KINDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          </Field>
          <Field label="Channel">
            <select className={inputCls} value={channel} onChange={(e) => setChannel(e.target.value as "email" | "sms")}><option value="email">Email</option><option value="sms">SMS</option></select>
          </Field>
        </div>
        {channel === "email" && <Field label="Subject"><input className={inputCls} value={subject ?? t?.subject ?? ""} onChange={(e) => setSubject(e.target.value)} /></Field>}
        <Field label="Message" hint="{{first_name}}, {{job_title}} and {{company}} are filled in per candidate.">
          <textarea className={`${inputCls} ${channel === "email" ? "h-52" : "h-24"}`} value={curBody} onChange={(e) => setBody(e.target.value)} />
        </Field>
        {kind === "rejection" && <p className="text-xs text-slate-500">Sending a rejection doesn't change the stage. Move them to “Rejected” separately if you haven't.</p>}
        <div className="flex justify-end gap-2 pt-1">
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn disabled={busy} onClick={() => go(false)}>Save as draft</Btn>
          <Btn kind="primary" disabled={busy} onClick={() => go(true)}><Icon d={I.check} size={15} /> Approve & send</Btn>
        </div>
      </div>
    </Modal>
  );
}

