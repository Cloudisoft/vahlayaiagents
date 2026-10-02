import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, ApiError } from "../../lib/api.js";
import { invalidate, useApi } from "../../lib/useApi.js";
import {
  Banner, Btn, Card, Empty, Field, I, Icon, Modal, STAGES, STAGE_DOT, STAGE_LABEL, Skeleton, StatCard, ago, inputCls, personName, when, type Stage,
} from "./ui.js";

interface Overview {
  stages: Record<Stage, number>;
  jobs: Array<{ id: string; title: string; status: string; department: string | null; location: string | null; created_at: string; total: number; new_7d: number; good_fit: number; interviewing: number; hired: number }>;
  processing: Record<string, number>;
  upcoming: Array<{ id: string; scheduled_at: string; time_zone: string | null; application_id: string; first_name: string; last_name: string; title: string }>;
  activity: Array<{ id: number; kind: string; title: string; created_at: string; application_id: string; first_name: string; last_name: string; job_title: string }>;
  draftMessages: number;
}
interface Draft { id: string; channel: string; kind: string; to_address: string; subject: string | null; body: string; status: string; error: string | null; created_at: string; application_id: string; first_name: string; last_name: string; job_title: string }

const STATUS_TONE: Record<string, string> = { draft: "bg-slate-100 text-slate-600", published: "bg-green-100 text-green-700", closed: "bg-slate-200 text-slate-500" };
const ACT_ICON: Record<string, string> = { ai_screening: I.spark, stage: I.users, message: I.mail, message_sent: I.mail, message_opened: I.mail, message_replied: I.sms, interview: I.mic, override: I.shield, error: I.alert, applied: I.file };

export default function HrHome() {
  const nav = useNavigate();
  const { data, loading, error } = useApi<Overview>("/hr/overview", { refreshMs: 20000 });
  const [showSettings, setShowSettings] = useState(false);
  const [showDrafts, setShowDrafts] = useState(false);
  const total = data ? Object.values(data.stages).reduce((a, b) => a + b, 0) : 0;
  const active = data ? total - data.stages.REJECTED - data.stages.HIRED : 0;
  const failed = (data?.processing.PARSE_FAILED ?? 0) + (data?.processing.AI_FAILED ?? 0);
  const screening = (data?.processing.QUEUED ?? 0) + (data?.processing.PARSING ?? 0) + (data?.processing.SCORING ?? 0);
  const openJobs = data?.jobs.filter((j) => j.status === "published").length ?? 0;
  const maxStage = data ? Math.max(1, ...STAGES.map((s) => data.stages[s])) : 1;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Vahlay HR</h1>
          <p className="text-sm text-slate-500 mt-0.5">AI screening, outreach and phone interviews — every decision explained, every message approved by you.</p>
        </div>
        <div className="flex gap-2">
          <Btn onClick={() => setShowSettings(true)}><Icon d={I.gear} size={16} /> Settings</Btn>
          <Btn kind="primary" onClick={() => nav("/hr/jobs/new")}><Icon d={I.plus} size={16} /> New job</Btn>
        </div>
      </div>

      {error && <Banner kind="error">{error}</Banner>}
      {data && data.draftMessages > 0 && (
        <Banner kind="info">
          <button type="button" className="font-medium underline-offset-2 hover:underline" onClick={() => setShowDrafts(true)}>
            {data.draftMessages} message{data.draftMessages === 1 ? "" : "s"} waiting for your approval →
          </button>{" "}
          Nothing is sent to candidates until you approve it.
        </Banner>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {loading && !data ? (
          Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-[88px]" />)
        ) : (
          <>
            <StatCard label="Open jobs" value={openJobs} icon={I.brief} hint={`${data?.jobs.length ?? 0} total`} />
            <StatCard label="Active candidates" value={active} icon={I.users} hint={screening ? `${screening} being screened` : undefined} />
            <StatCard label="Interviews booked" value={data?.upcoming.length ?? 0} icon={I.cal} hint="upcoming" />
            <StatCard label="Needs attention" value={failed} icon={I.alert} tone={failed ? "text-red-600" : ""} hint={failed ? "resumes failed to process" : "all clear"} />
          </>
        )}
      </div>

      <Card title="Pipeline" action={<span className="text-xs text-slate-400">{total} candidates across all jobs</span>}>
        <div className="grid grid-cols-11 gap-1.5 items-end h-28">
          {STAGES.map((s, i) => {
            const n = data?.stages[s] ?? 0;
            return (
              <div key={s} className="flex flex-col items-center justify-end h-full group" title={`${STAGE_LABEL[s]}: ${n}`}>
                <div className="text-xs font-semibold tabular-nums text-slate-700 mb-1">{n}</div>
                <div className={`w-full rounded-t-md ${STAGE_DOT[s]} opacity-80 group-hover:opacity-100 transition-all duration-500`} style={{ height: `${Math.max(4, (n / maxStage) * 70)}%`, transitionDelay: `${i * 30}ms` }} />
              </div>
            );
          })}
        </div>
        <div className="grid grid-cols-11 gap-1.5 mt-2">
          {STAGES.map((s) => (
            <div key={s} className="text-[10px] leading-tight text-center text-slate-500 truncate" title={STAGE_LABEL[s]}>{STAGE_LABEL[s]}</div>
          ))}
        </div>
      </Card>

      <div className="grid lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold text-slate-900">Jobs</h2>
          </div>
          {loading && !data ? (
            <div className="space-y-3">{Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-20" />)}</div>
          ) : !data?.jobs.length ? (
            <Card>
              <Empty icon={I.brief} title="No jobs yet">
                Create a job, let AI draft and polish the description, then upload resumes or share the careers link.
                <div className="mt-4"><Btn kind="primary" onClick={() => nav("/hr/jobs/new")}><Icon d={I.plus} size={16} /> Create your first job</Btn></div>
              </Empty>
            </Card>
          ) : (
            data.jobs.map((j, i) => (
              <Link key={j.id} to={`/hr/jobs/${j.id}`} className="block bg-white border border-slate-200 rounded-2xl p-4 hover:border-red-200 hover:shadow-sm transition-all animate-page-in" style={{ animationDelay: `${Math.min(i, 8) * 30}ms` }}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-slate-900 truncate">{j.title}</span>
                      <span className={`text-[10px] uppercase tracking-wide font-semibold rounded-full px-2 py-0.5 ${STATUS_TONE[j.status] ?? "bg-slate-100"}`}>{j.status}</span>
                    </div>
                    <div className="text-xs text-slate-500 mt-0.5">{[j.department, j.location].filter(Boolean).join(" · ") || "—"} · created {ago(j.created_at)}</div>
                  </div>
                  {j.new_7d > 0 && <span className="text-[11px] font-medium text-red-600 bg-red-50 rounded-full px-2 py-0.5 shrink-0">+{j.new_7d} this week</span>}
                </div>
                <div className="grid grid-cols-4 gap-2 mt-3 text-center">
                  {[["Candidates", j.total, ""], ["Good fit", j.good_fit, "text-green-600"], ["Interviewing", j.interviewing, "text-violet-600"], ["Hired", j.hired, "text-emerald-700"]].map(([l, v, t]) => (
                    <div key={l as string} className="rounded-lg bg-slate-50 py-1.5">
                      <div className={`text-lg font-bold tabular-nums ${t}`}>{v as number}</div>
                      <div className="text-[10px] text-slate-500 uppercase tracking-wide">{l as string}</div>
                    </div>
                  ))}
                </div>
              </Link>
            ))
          )}
        </div>

        <div className="space-y-6">
          <Card title="Upcoming interviews">
            {!data?.upcoming.length ? (
              <p className="text-sm text-slate-500">No interviews booked. Invite shortlisted candidates from a job's candidate list.</p>
            ) : (
              <ul className="space-y-2">
                {data.upcoming.map((u) => (
                  <li key={u.id}>
                    <Link to={`/hr/applications/${u.application_id}`} className="flex items-center gap-3 rounded-lg p-2 -mx-2 hover:bg-slate-50">
                      <span className="w-8 h-8 rounded-lg bg-violet-50 text-violet-600 flex items-center justify-center shrink-0"><Icon d={I.phone} size={15} /></span>
                      <span className="min-w-0">
                        <span className="block text-sm font-medium text-slate-800 truncate">{personName(u)}</span>
                        <span className="block text-xs text-slate-500 truncate">{u.title} · {when(u.scheduled_at)}</span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="Recent activity">
            {!data?.activity.length ? (
              <p className="text-sm text-slate-500">Activity on candidates shows up here.</p>
            ) : (
              <ul className="space-y-2.5">
                {data.activity.slice(0, 10).map((a) => (
                  <li key={a.id}>
                    <Link to={`/hr/applications/${a.application_id}`} className="flex gap-2.5 group">
                      <span className={`mt-0.5 w-6 h-6 rounded-md flex items-center justify-center shrink-0 ${a.kind === "error" ? "bg-red-50 text-red-600" : "bg-slate-100 text-slate-500"}`}><Icon d={ACT_ICON[a.kind] ?? I.clock} size={13} /></span>
                      <span className="min-w-0">
                        <span className="block text-sm text-slate-700 group-hover:text-red-600 line-clamp-2">{a.title}</span>
                        <span className="block text-[11px] text-slate-400">{personName(a)} · {a.job_title} · {ago(a.created_at)}</span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>

      {showSettings && <HrSettingsModal onClose={() => setShowSettings(false)} />}
      {showDrafts && <DraftsModal onClose={() => { setShowDrafts(false); invalidate("/hr/overview"); }} />}
    </div>
  );
}

function HrSettingsModal({ onClose }: { onClose: () => void }) {
  const { data } = useApi<{ settings: { companyName: string; smsFrom: string | null; voiceNumberId: string | null }; orgName: string; numbers: Array<{ id: string; phone_e164: string; friendly_name: string | null; vapi_ready: boolean }> }>("/hr/settings");
  const [form, setForm] = useState<{ companyName: string; smsFrom: string; voiceNumberId: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const f = form ?? (data ? { companyName: data.settings.companyName, smsFrom: data.settings.smsFrom ?? "", voiceNumberId: data.settings.voiceNumberId ?? "" } : null);

  async function save() {
    if (!f) return;
    setBusy(true);
    setErr(null);
    try {
      await api("/hr/settings", { method: "PUT", body: { companyName: f.companyName, smsFrom: f.smsFrom || null, voiceNumberId: f.voiceNumberId || null } });
      invalidate("/hr/settings");
      onClose();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Couldn't save.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="HR settings" onClose={onClose}>
      {!f ? (
        <Skeleton className="h-40" />
      ) : (
        <div className="space-y-4">
          {err && <Banner kind="error">{err}</Banner>}
          <Field label="Company name shown to candidates" hint={`Defaults to “${data?.orgName}”.`}>
            <input className={inputCls} value={f.companyName} onChange={(e) => setForm({ ...f, companyName: e.target.value })} placeholder={data?.orgName} />
          </Field>
          <Field label="Interview calling number" hint="AI phone interviews are placed from this number (must be connected to VAPI).">
            <select className={inputCls} value={f.voiceNumberId} onChange={(e) => setForm({ ...f, voiceNumberId: e.target.value })}>
              <option value="">— Not set —</option>
              {data?.numbers.map((n) => (
                <option key={n.id} value={n.id} disabled={!n.vapi_ready}>{n.phone_e164}{n.friendly_name ? ` · ${n.friendly_name}` : ""}{n.vapi_ready ? "" : " (not on VAPI)"}</option>
              ))}
            </select>
          </Field>
          <Field label="SMS sender number" hint="Used for SMS invites and reminders. Leave empty to send email only.">
            <select className={inputCls} value={f.smsFrom} onChange={(e) => setForm({ ...f, smsFrom: e.target.value })}>
              <option value="">— Email only —</option>
              {data?.numbers.map((n) => <option key={n.id} value={n.phone_e164}>{n.phone_e164}{n.friendly_name ? ` · ${n.friendly_name}` : ""}</option>)}
            </select>
          </Field>
          <p className="text-xs text-slate-500">Email is sent with the SMTP or Resend account in <Link to="/settings" className="text-red-600 hover:underline">Settings → Email</Link>.</p>
          <div className="flex justify-end gap-2 pt-1">
            <Btn onClick={onClose}>Cancel</Btn>
            <Btn kind="primary" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save"}</Btn>
          </div>
        </div>
      )}
    </Modal>
  );
}

export function DraftsModal({ onClose }: { onClose: () => void }) {
  const { data, reload } = useApi<{ messages: Draft[] }>("/hr/messages/drafts");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const list = data?.messages ?? [];

  async function approve(ids: string[]) {
    setBusy(true);
    setErr(null);
    try {
      await api("/hr/messages/approve", { method: "POST", body: { ids } });
      setSel(new Set());
      await reload();
      invalidate("/hr/");
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Couldn't approve.");
    } finally {
      setBusy(false);
    }
  }
  async function discard(id: string) {
    await api(`/hr/messages/${id}`, { method: "DELETE" }).catch(() => undefined);
    await reload();
  }

  return (
    <Modal title="Messages awaiting approval" onClose={onClose} wide>
      {err && <div className="mb-3"><Banner kind="error">{err}</Banner></div>}
      {!list.length ? (
        <Empty icon={I.check} title="Nothing to approve">Drafted and failed messages show up here.</Empty>
      ) : (
        <>
          <div className="flex items-center justify-between mb-3">
            <label className="text-sm text-slate-600 flex items-center gap-2">
              <input type="checkbox" checked={sel.size === list.length} onChange={(e) => setSel(e.target.checked ? new Set(list.map((m) => m.id)) : new Set())} /> Select all
            </label>
            <Btn kind="primary" disabled={!sel.size || busy} onClick={() => approve(Array.from(sel))}><Icon d={I.check} size={15} /> Approve & send {sel.size || ""}</Btn>
          </div>
          <ul className="space-y-2">
            {list.map((m) => (
              <li key={m.id} className="border border-slate-200 rounded-xl p-3">
                <div className="flex items-start gap-3">
                  <input type="checkbox" className="mt-1" checked={sel.has(m.id)} onChange={(e) => { const s = new Set(sel); e.target.checked ? s.add(m.id) : s.delete(m.id); setSel(s); }} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <Icon d={m.channel === "email" ? I.mail : I.sms} size={14} className="text-slate-400" />
                      <Link to={`/hr/applications/${m.application_id}`} onClick={onClose} className="font-medium text-slate-800 hover:text-red-600">{personName(m)}</Link>
                      <span className="text-xs text-slate-400">{m.job_title} · {m.kind.replace("_", " ")} · to {m.to_address}</span>
                      {m.status === "failed" && <span className="text-[11px] font-semibold text-red-700 bg-red-50 rounded-full px-2">failed</span>}
                    </div>
                    {m.subject && <div className="text-sm font-medium text-slate-700 mt-1">{m.subject}</div>}
                    <div className="text-xs text-slate-500 whitespace-pre-line line-clamp-3 mt-0.5">{m.body}</div>
                    {m.error && <div className="text-xs text-red-600 mt-1">{m.error}</div>}
                  </div>
                  <div className="flex flex-col gap-1 shrink-0">
                    <Btn kind="primary" disabled={busy} onClick={() => approve([m.id])}>{m.status === "failed" ? "Retry" : "Send"}</Btn>
                    <Btn kind="ghost" onClick={() => discard(m.id)}>Discard</Btn>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </Modal>
  );
}
