import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { api, ApiError, getAccessToken, refreshSession } from "../../lib/api.js";
import { invalidate, useApi } from "../../lib/useApi.js";
import { InviteModal, MessageModal, StageModal } from "./JobDetail.js";
import {
  Banner, Btn, Card, Empty, Field, FitBadge, FIT_LABEL, I, Icon, Modal, Quote, REC_LABEL, RecBadge, ScoreBar, ScoreRing, Skeleton, StageBadge, ago, initials, inputCls, personName, when,
  type Fit, type Stage,
} from "./ui.js";

interface Criterion { key: string; label: string; weight: number; score: number; rationale: string; evidence: string[]; unverified?: string[]; capped: boolean }
interface ScoreRow {
  id: string;
  overall_score: number;
  fit: Fit;
  summary: string | null;
  criteria_scores: Criterion[];
  evidence: { requirements: Array<{ requirement: string; status: string; evidence: string | null; note: string }>; strengths: Array<{ point: string; evidence: string }>; concerns: Array<{ point: string; evidence: string | null }> };
  evidence_stats: { quotes: number; verified: number; dropped: number } | null;
  model: string;
  created_at: string;
}
interface Interview {
  id: string;
  scheduling_status: string;
  scheduled_at: string | null;
  time_zone: string | null;
  call_status: string;
  call_attempts: number;
  started_at: string | null;
  duration_seconds: number | null;
  ended_reason: string | null;
  transcript_segments: Array<{ role: string; text: string; secondsFromStart: number }> | null;
  evaluation: {
    overall: number;
    complete: boolean;
    criteria: Criterion[];
    questions: Array<{ question: string; asked: boolean; answered: boolean; evidence: string | null }>;
    strengths: Array<{ point: string; evidence: string }>;
    concerns: Array<{ point: string; evidence: string | null }>;
    summary: string;
    evidenceStats: { quotes: number; verified: number };
  } | null;
  completeness: { complete: boolean; reasons: string[]; answered: number; total: number } | null;
  ai_recommendation: string | null;
  hr_recommendation: string | null;
  hr_recommendation_reason: string | null;
  overall_score: number | null;
  error: string | null;
  has_recording: boolean;
  schedule_token: string | null;
  created_at: string;
}
interface Message { id: string; channel: string; kind: string; to_address: string; subject: string | null; body: string; status: string; error: string | null; attempts: number; approved_at: string | null; sent_at: string | null; delivered_at: string | null; opened_at: string | null; replied_at: string | null; created_at: string }
interface Detail {
  application: any;
  scores: ScoreRow[];
  resume: { id: string; text_content: string | null; parsing_status: string; parse_error: string | null; file_name: string; file_type: string; file_size: number } | null;
  interviews: Interview[];
  messages: Message[];
  activity: Array<{ id: number; kind: string; title: string; detail: any; created_at: string; actor: string | null }>;
  audit: Array<{ action: string; metadata: any; created_at: string; actor: string | null }>;
}

const TABS = [["screening", "Screening"], ["resume", "Resume"], ["interview", "Interview"], ["messages", "Messages"], ["timeline", "Timeline"]] as const;
const REQ_TONE: Record<string, string> = { met: "bg-green-100 text-green-700", partial: "bg-amber-100 text-amber-700", missing: "bg-red-100 text-red-700", unclear: "bg-slate-100 text-slate-600" };

async function authedBlob(path: string) {
  const send = () => fetch(path, { credentials: "include", headers: { Authorization: `Bearer ${getAccessToken()}` } });
  let r = await send();
  if (r.status === 401 && (await refreshSession())) r = await send();
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Couldn't load the file.");
  return URL.createObjectURL(await r.blob());
}

export default function ApplicationDetail() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") ?? "screening") as (typeof TABS)[number][0];
  const { data, error, reload } = useApi<Detail>(`/hr/applications/${id}`);
  const a = data?.application;
  const processing = a && ["QUEUED", "PARSING", "SCORING"].includes(a.processing_status);
  const liveCall = data?.interviews.some((i) => ["calling", "in_progress", "ended"].includes(i.call_status));
  useEffect(() => {
    if (!processing && !liveCall) return;
    const t = setInterval(() => reload(), 4000);
    return () => clearInterval(t);
  }, [processing, liveCall, reload]);

  const [modal, setModal] = useState<null | "stage" | "fit" | "invite" | "message" | "edit">(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const refresh = async () => {
    await reload();
    invalidate("/hr/");
  };
  async function act(fn: () => Promise<unknown>, ok?: string) {
    try {
      await fn();
      if (ok) setMsg({ kind: "ok", text: ok });
      await refresh();
    } catch (e) {
      setMsg({ kind: "error", text: e instanceof ApiError ? e.message : "Something went wrong." });
    }
  }

  if (error) return <Banner kind="error">{error}</Banner>;
  if (!data || !a) return <div className="space-y-4"><Skeleton className="h-28" /><Skeleton className="h-72" /></div>;
  const score = data.scores[0];
  const iv = data.interviews[0];

  return (
    <div className="space-y-5">
      <div className="bg-white border border-slate-200 rounded-2xl p-5">
        <div className="flex flex-wrap items-start gap-4">
          <span className="w-14 h-14 rounded-2xl bg-gradient-to-br from-red-500 to-rose-600 text-white text-lg font-semibold flex items-center justify-center shrink-0">{initials(a)}</span>
          <div className="min-w-0 flex-1">
            <Link to={`/hr/jobs/${a.job_id}`} className="text-xs text-slate-500 hover:text-red-600">{a.job_title}</Link>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-semibold text-slate-900">{personName({ ...a, file_name: data.resume?.file_name })}</h1>
              <StageBadge stage={a.stage as Stage} />
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-slate-500 mt-1">
              {a.email ? <span className="inline-flex items-center gap-1"><Icon d={I.mail} size={14} />{a.email}</span> : <span className="text-amber-600">No email</span>}
              {a.phone ? <span className="inline-flex items-center gap-1"><Icon d={I.phone} size={14} />{a.phone}</span> : <span className="text-amber-600">No phone</span>}
              {a.location && <span>{a.location}</span>}
              <button type="button" className="text-red-600 hover:underline" onClick={() => setModal("edit")}>Edit</button>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <ScoreRing value={score?.overall_score ?? null} label="resume" size={76} />
            {iv?.overall_score != null && <ScoreRing value={iv.overall_score} label="interview" size={76} />}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 mt-4 pt-4 border-t border-slate-100">
          <span className="text-xs text-slate-500 mr-1">Fit</span>
          <FitBadge ai={a.ai_fit} hr={a.hr_fit} size="lg" />
          {a.hr_fit && <span className="text-xs text-slate-500 italic">“{a.hr_fit_reason}”</span>}
          <div className="flex flex-wrap gap-2 ml-auto">
            <Btn onClick={() => setModal("fit")}><Icon d={I.shield} size={14} /> Override fit</Btn>
            <Btn onClick={() => setModal("stage")}>Move stage</Btn>
            <Btn onClick={() => setModal("message")}><Icon d={I.mail} size={14} /> Message</Btn>
            <Btn kind="primary" onClick={() => setModal("invite")}><Icon d={I.phone} size={14} /> Invite to interview</Btn>
          </div>
        </div>
      </div>

      {msg && <Banner kind={msg.kind} onClose={() => setMsg(null)}>{msg.text}</Banner>}
      {processing && <Banner kind="info"><span className="inline-flex items-center gap-2"><span className="w-3 h-3 rounded-full border-2 border-sky-300 border-t-sky-700 animate-spin" />{a.processing_detail ?? "Queued for screening"}…</span></Banner>}
      {["PARSE_FAILED", "AI_FAILED"].includes(a.processing_status) && (
        <Banner kind="error">
          <div className="flex flex-wrap items-center gap-3">
            <span><b>{a.processing_status === "PARSE_FAILED" ? "The resume couldn't be read." : "AI scoring failed."}</b> {a.processing_error}</span>
            <Btn onClick={() => act(() => api(`/hr/applications/${id}/retry`, { method: "POST" }), "Screening restarted.")}><Icon d={I.retry} size={14} /> Retry</Btn>
          </div>
        </Banner>
      )}

      <div className="flex gap-1 border-b border-slate-200 overflow-x-auto">
        {TABS.map(([k, l]) => (
          <button key={k} type="button" onClick={() => setParams(k === "screening" ? {} : { tab: k }, { replace: true })} className={`relative px-3.5 py-2 text-sm whitespace-nowrap ${tab === k ? "text-red-600 font-medium" : "text-slate-500 hover:text-slate-800"}`}>
            {l}
            {k === "messages" && data.messages.length > 0 && <span className="ml-1.5 text-[11px] bg-slate-100 text-slate-600 rounded-full px-1.5">{data.messages.length}</span>}
            {tab === k && <span className="absolute left-2 right-2 -bottom-px h-0.5 bg-red-600 rounded-full" />}
          </button>
        ))}
      </div>

      <div key={tab} className="animate-fade-in">
        {tab === "screening" && <Screening score={score} history={data.scores} />}
        {tab === "resume" && <Resume appId={id!} resume={data.resume} score={score} />}
        {tab === "interview" && <InterviewTab iv={iv} all={data.interviews} act={act} onInvite={() => setModal("invite")} />}
        {tab === "messages" && <Messages list={data.messages} act={act} onCompose={() => setModal("message")} />}
        {tab === "timeline" && <Timeline activity={data.activity} audit={data.audit} />}
      </div>

      {modal === "stage" && <StageModal count={1} current={a.stage} onClose={() => setModal(null)} onApply={(s, reason) => api(`/hr/applications/${id}/stage`, { method: "POST", body: { stage: s, reason } }).then(async () => { setModal(null); await refresh(); })} />}
      {modal === "fit" && <FitModal ai={a.ai_fit} hr={a.hr_fit} onClose={() => setModal(null)} onSave={(fit, reason) => act(() => api(`/hr/applications/${id}/fit`, { method: "POST", body: { fit, reason } }), "Fit updated.").then(() => setModal(null))} />}
      {modal === "invite" && <InviteModal ids={[id!]} names={[personName(a)]} hasQuestions onClose={() => setModal(null)} onDone={async (t) => { setModal(null); setMsg({ kind: "ok", text: t }); await refresh(); }} />}
      {modal === "message" && <MessageModal ids={[id!]} onClose={() => setModal(null)} onDone={async (t) => { setModal(null); setMsg({ kind: "ok", text: t }); await refresh(); }} />}
      {modal === "edit" && <EditModal a={a} onClose={() => setModal(null)} onSave={(body) => act(() => api(`/hr/applications/${id}/candidate`, { method: "PATCH", body }), "Details saved.").then(() => setModal(null))} />}
    </div>
  );
}

// ---------- screening ----------

function CriterionRow({ c, source = "resume" }: { c: Criterion; source?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="py-2.5">
      <button type="button" className="w-full text-left" onClick={() => setOpen(!open)}>
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium text-slate-800 w-40 shrink-0 truncate">{c.label}</span>
          <ScoreBar value={c.score} className="flex-1" />
          <span className="text-[11px] text-slate-400 w-14 text-right">wt {c.weight}</span>
          <span className={`text-slate-400 text-xs transition-transform ${open ? "rotate-90" : ""}`}>▶</span>
        </div>
        {c.capped && <div className="text-[11px] text-amber-600 mt-0.5 ml-40 pl-3">Capped at 30 — no supporting text found in the {source}</div>}
      </button>
      {open && (
        <div className="mt-2 ml-1 space-y-1.5 animate-fade-in">
          <p className="text-sm text-slate-600">{c.rationale}</p>
          {c.evidence.map((q, i) => <Quote key={i} text={q} tone="green" />)}
          {!!c.unverified?.length && <p className="text-[11px] text-slate-400">{c.unverified.length} AI quote{c.unverified.length === 1 ? "" : "s"} not found in the resume {c.unverified.length === 1 ? "was" : "were"} discarded.</p>}
        </div>
      )}
    </div>
  );
}

function Screening({ score, history }: { score: ScoreRow | undefined; history: ScoreRow[] }) {
  if (!score) return <Card><Empty icon={I.spark} title="Not screened yet">The AI screening appears here once the resume is processed.</Empty></Card>;
  const reqs = score.evidence?.requirements ?? [];
  return (
    <div className="grid lg:grid-cols-3 gap-5">
      <div className="lg:col-span-2 space-y-5">
        <Card title="Summary" action={<FitBadge ai={score.fit} />}>
          <p className="text-sm text-slate-700 leading-relaxed">{score.summary}</p>
          {score.evidence_stats && (
            <p className="text-[11px] text-slate-400 mt-3 inline-flex items-center gap-1">
              <Icon d={I.shield} size={12} /> {score.evidence_stats.verified} of {score.evidence_stats.quotes} AI quotes verified against the resume{score.evidence_stats.dropped ? ` · ${score.evidence_stats.dropped} discarded` : ""} · {score.model} · {ago(score.created_at)}
            </p>
          )}
        </Card>
        <Card title="Scores by criterion">
          <div className="divide-y divide-slate-100">{score.criteria_scores.map((c) => <CriterionRow key={c.key} c={c} />)}</div>
          <p className="text-[11px] text-slate-400 mt-2">Overall {score.overall_score} = weighted average of the criteria. Click a row for the reasoning and resume quotes.</p>
        </Card>
        {reqs.length > 0 && (
          <Card title="Requirements">
            <ul className="divide-y divide-slate-100">
              {reqs.map((r, i) => (
                <li key={i} className="py-2.5 flex items-start gap-3">
                  <span className={`text-[10px] uppercase font-semibold rounded-full px-2 py-0.5 shrink-0 mt-0.5 ${REQ_TONE[r.status] ?? "bg-slate-100"}`}>{r.status}</span>
                  <div className="min-w-0">
                    <div className="text-sm text-slate-800">{r.requirement}</div>
                    {r.evidence && <div className="mt-1"><Quote text={r.evidence} tone={r.status === "met" ? "green" : "slate"} /></div>}
                    {r.note && <div className="text-xs text-slate-500 mt-0.5">{r.note}</div>}
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
      <div className="space-y-5">
        <Card title="Strengths">
          {!score.evidence?.strengths?.length ? <p className="text-sm text-slate-500">None with verifiable evidence.</p> : (
            <ul className="space-y-2.5">{score.evidence.strengths.map((s, i) => <li key={i}><div className="text-sm text-slate-800 flex gap-1.5"><span className="text-green-600">+</span>{s.point}</div><div className="mt-1"><Quote text={s.evidence} tone="green" /></div></li>)}</ul>
          )}
        </Card>
        <Card title="Concerns">
          {!score.evidence?.concerns?.length ? <p className="text-sm text-slate-500">None noted.</p> : (
            <ul className="space-y-2.5">{score.evidence.concerns.map((s, i) => <li key={i}><div className="text-sm text-slate-800 flex gap-1.5"><span className="text-red-600">–</span>{s.point}</div>{s.evidence && <div className="mt-1"><Quote text={s.evidence} tone="red" /></div>}</li>)}</ul>
          )}
        </Card>
        {history.length > 1 && (
          <Card title="Earlier screenings">
            <ul className="text-sm space-y-1">{history.slice(1).map((h) => <li key={h.id} className="flex justify-between text-slate-600"><span>{ago(h.created_at)}</span><span className="tabular-nums">{h.overall_score} · {FIT_LABEL[h.fit]}</span></li>)}</ul>
          </Card>
        )}
      </div>
    </div>
  );
}

// ---------- resume ----------

function Highlighted({ text, quotes }: { text: string; quotes: string[] }) {
  const parts = useMemo(() => {
    const qs = quotes.filter((q) => q.length > 3).map((q) => q.toLowerCase());
    if (!qs.length) return [{ t: text, hl: false }];
    const lower = text.toLowerCase();
    const marks: Array<[number, number]> = [];
    for (const q of qs) {
      let from = 0;
      for (let k = lower.indexOf(q, from); k >= 0; k = lower.indexOf(q, from)) {
        marks.push([k, k + q.length]);
        from = k + q.length;
      }
    }
    marks.sort((x, y) => x[0] - y[0]);
    const out: Array<{ t: string; hl: boolean }> = [];
    let pos = 0;
    for (const [s, e] of marks) {
      if (s < pos) continue;
      if (s > pos) out.push({ t: text.slice(pos, s), hl: false });
      out.push({ t: text.slice(s, e), hl: true });
      pos = e;
    }
    out.push({ t: text.slice(pos), hl: false });
    return out;
  }, [text, quotes]);
  return <>{parts.map((p, i) => (p.hl ? <mark key={i} className="bg-green-100 text-inherit rounded px-0.5">{p.t}</mark> : <span key={i}>{p.t}</span>))}</>;
}

function Resume({ appId, resume, score }: { appId: string; resume: Detail["resume"]; score: ScoreRow | undefined }) {
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const quotes = useMemo(() => (score ? [...score.criteria_scores.flatMap((c) => c.evidence), ...(score.evidence?.requirements ?? []).map((r) => r.evidence ?? ""), ...(score.evidence?.strengths ?? []).map((s) => s.evidence)] : []), [score]);
  const isPdf = resume?.file_type === "pdf";
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  if (!resume) return <Card><Empty icon={I.file} title="No resume on file" /></Card>;

  async function open(download: boolean) {
    setErr(null);
    try {
      const u = await authedBlob(`/api/hr/applications/${appId}/resume`);
      if (download) {
        const link = document.createElement("a");
        link.href = u;
        link.download = resume!.file_name;
        link.click();
        setTimeout(() => URL.revokeObjectURL(u), 5000);
      } else setUrl(u);
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  return (
    <div className="grid lg:grid-cols-5 gap-5">
      <Card className="lg:col-span-3" title={<span className="inline-flex items-center gap-2"><Icon d={I.file} size={16} />{resume.file_name}</span>} action={<div className="flex gap-2">{isPdf && !url && <Btn onClick={() => open(false)}>View original</Btn>}<Btn onClick={() => open(true)}><Icon d={I.download} size={14} /> Download</Btn></div>}>
        {err && <div className="mb-2"><Banner kind="error">{err}</Banner></div>}
        {url ? (
          <iframe title="Resume" src={url} className="w-full h-[70vh] rounded-lg border border-slate-200" />
        ) : resume.text_content ? (
          <>
            <p className="text-[11px] text-slate-400 mb-2">Text read from the file. <mark className="bg-green-100 rounded px-0.5">Highlighted</mark> passages are the evidence the AI cited.</p>
            <pre className="whitespace-pre-wrap font-sans text-sm text-slate-700 leading-relaxed max-h-[70vh] overflow-y-auto"><Highlighted text={resume.text_content} quotes={quotes} /></pre>
          </>
        ) : (
          <p className="text-sm text-slate-500">{resume.parse_error ?? "The text hasn't been read yet."}</p>
        )}
      </Card>
      <Card className="lg:col-span-2 h-fit" title="File">
        <dl className="text-sm space-y-1.5">
          <div className="flex justify-between"><dt className="text-slate-500">Type</dt><dd className="uppercase">{resume.file_type}</dd></div>
          <div className="flex justify-between"><dt className="text-slate-500">Size</dt><dd>{resume.file_size ? `${(resume.file_size / 1024).toFixed(0)} KB` : "—"}</dd></div>
          <div className="flex justify-between"><dt className="text-slate-500">Text extracted</dt><dd>{resume.text_content ? `${resume.text_content.split(/\s+/).length} words` : "—"}</dd></div>
        </dl>
        <p className="text-xs text-slate-400 mt-3">The original file is stored privately and only shown to signed-in HR users.</p>
      </Card>
    </div>
  );
}

// ---------- interview ----------

const CALL_LABEL: Record<string, string> = { pending: "Waiting for the scheduled time", calling: "Calling the candidate…", in_progress: "Interview in progress", ended: "Call ended — evaluating…", completed: "Completed", incomplete: "Incomplete", failed: "Call failed", no_answer: "No answer" };

function InterviewTab({ iv, all, act, onInvite }: { iv: Interview | undefined; all: Interview[]; act: (fn: () => Promise<unknown>, ok?: string) => Promise<void>; onInvite: () => void }) {
  const [audio, setAudio] = useState<string | null>(null);
  const [override, setOverride] = useState(false);
  const [resched, setResched] = useState(false);
  const player = useRef<HTMLAudioElement>(null);
  useEffect(() => () => { if (audio) URL.revokeObjectURL(audio); }, [audio]);
  if (!iv) {
    return (
      <Card>
        <Empty icon={I.phone} title="No interview yet">
          Invite the candidate: they choose a time, and the AI interviewer calls them with this job's structured questions.
          <div className="mt-4"><Btn kind="primary" onClick={onInvite}><Icon d={I.phone} size={14} /> Invite to interview</Btn></div>
        </Empty>
      </Card>
    );
  }
  const ev = iv.evaluation;
  const link = iv.schedule_token ? `${window.location.origin}/interview/${iv.schedule_token}` : null;
  const canChange = ["pending", "no_answer", "failed"].includes(iv.call_status) && iv.scheduling_status !== "cancelled";
  const seek = (sec: number) => {
    if (player.current) {
      player.current.currentTime = sec;
      player.current.play().catch(() => undefined);
    }
  };

  return (
    <div className="grid lg:grid-cols-3 gap-5">
      <div className="lg:col-span-2 space-y-5">
        {ev ? (
          <>
            <Card title="Evaluation" action={<RecBadge ai={iv.ai_recommendation} hr={iv.hr_recommendation} />}>
              {!ev.complete && iv.completeness && (
                <div className="mb-3"><Banner kind="error"><b>Incomplete interview.</b> {iv.completeness.reasons.join("; ")}. The AI can only recommend HR review.</Banner></div>
              )}
              <p className="text-sm text-slate-700 leading-relaxed">{ev.summary}</p>
              <div className="divide-y divide-slate-100 mt-3">{ev.criteria.map((c) => <CriterionRow key={c.key} c={c} source="candidate's answers" />)}</div>
              <p className="text-[11px] text-slate-400 mt-2 inline-flex items-center gap-1"><Icon d={I.shield} size={12} />{ev.evidenceStats.verified} of {ev.evidenceStats.quotes} quotes verified against the candidate's own words</p>
              {iv.hr_recommendation && <p className="text-xs text-slate-500 mt-2">HR override: <b>{REC_LABEL[iv.hr_recommendation]}</b> — “{iv.hr_recommendation_reason}” (AI said {iv.ai_recommendation ? REC_LABEL[iv.ai_recommendation] : "—"})</p>}
              <div className="flex gap-2 mt-3">
                <Btn onClick={() => setOverride(true)}><Icon d={I.shield} size={14} /> Override recommendation</Btn>
                <Btn kind="ghost" onClick={() => act(() => api(`/hr/interviews/${iv.id}/evaluate`, { method: "POST" }), "Re-evaluated.")}><Icon d={I.retry} size={14} /> Re-evaluate</Btn>
              </div>
            </Card>
            <Card title="Questions">
              <ol className="space-y-2.5">
                {ev.questions.map((q, i) => (
                  <li key={i} className="flex gap-2.5">
                    <span className={`mt-0.5 w-5 h-5 rounded-full text-[11px] font-semibold flex items-center justify-center shrink-0 ${q.answered ? "bg-green-100 text-green-700" : "bg-red-100 text-red-600"}`}>{i + 1}</span>
                    <div className="min-w-0">
                      <div className="text-sm text-slate-800">{q.question}</div>
                      {q.evidence ? <div className="mt-1"><Quote text={q.evidence} /></div> : <div className="text-xs text-red-600 mt-0.5">{q.asked ? "Asked, but not answered" : "Not asked"}</div>}
                    </div>
                  </li>
                ))}
              </ol>
            </Card>
          </>
        ) : (
          <Card title="Status">
            <div className="flex items-center gap-3">
              <span className={`w-10 h-10 rounded-xl flex items-center justify-center ${["failed", "no_answer"].includes(iv.call_status) ? "bg-red-50 text-red-600" : "bg-violet-50 text-violet-600"}`}>
                {["calling", "in_progress", "ended"].includes(iv.call_status) ? <span className="w-4 h-4 rounded-full border-2 border-violet-300 border-t-violet-700 animate-spin" /> : <Icon d={I.phone} />}
              </span>
              <div>
                <div className="font-medium text-slate-800">{iv.scheduling_status === "cancelled" ? "Cancelled" : iv.scheduling_status === "invited" ? "Invited — waiting for the candidate to pick a time" : CALL_LABEL[iv.call_status] ?? iv.call_status}</div>
                {iv.scheduled_at && <div className="text-sm text-slate-500">{when(iv.scheduled_at, iv.time_zone)} (candidate's time) · {when(iv.scheduled_at)} your time</div>}
              </div>
            </div>
            {iv.error && <div className="mt-3"><Banner kind="error">{iv.error}</Banner></div>}
            {iv.ended_reason && <p className="text-xs text-slate-500 mt-2">Ended: {iv.ended_reason}</p>}
            {iv.transcript_segments?.length && iv.call_status === "ended" && iv.error && (
              <Btn className="mt-3" onClick={() => act(() => api(`/hr/interviews/${iv.id}/evaluate`, { method: "POST" }), "Evaluated.")}><Icon d={I.retry} size={14} /> Retry evaluation</Btn>
            )}
          </Card>
        )}
        {!!iv.transcript_segments?.length && (
          <Card title="Transcript">
            <div className="space-y-2 max-h-[60vh] overflow-y-auto pr-1">
              {iv.transcript_segments.map((m, i) => (
                <button key={i} type="button" onClick={() => seek(m.secondsFromStart)} className={`block max-w-[85%] text-left rounded-xl px-3 py-2 text-sm transition-colors ${m.role === "assistant" ? "bg-slate-50 hover:bg-slate-100" : "bg-red-50/60 hover:bg-red-50 ml-auto"}`}>
                  <span className="text-[10px] uppercase tracking-wide text-slate-400 mr-2">{m.role === "assistant" ? "Interviewer" : "Candidate"} · {Math.floor(m.secondsFromStart / 60)}:{String(Math.floor(m.secondsFromStart % 60)).padStart(2, "0")}</span>
                  <span className="text-slate-700">{m.text}</span>
                </button>
              ))}
            </div>
          </Card>
        )}
      </div>

      <div className="space-y-5">
        {iv.has_recording && (
          <Card title="Recording">
            {audio ? <audio ref={player} controls src={audio} className="w-full" /> : <Btn onClick={() => authedBlob(`/api/hr/interviews/${iv.id}/recording`).then(setAudio).catch((e) => alert(e.message))}><Icon d={I.mic} size={14} /> Load recording</Btn>}
            <p className="text-[11px] text-slate-400 mt-2">Click a transcript line to jump to it.</p>
          </Card>
        )}
        <Card title="Scheduling">
          <div className="space-y-2 text-sm">
            {link && iv.scheduling_status !== "cancelled" && (
              <div>
                <div className="text-xs text-slate-500 mb-1">Candidate's private link</div>
                <code className="block text-[11px] bg-slate-50 border border-slate-200 rounded-lg px-2 py-1.5 break-all">{link}</code>
              </div>
            )}
            <div className="text-xs text-slate-500">Attempts: {iv.call_attempts} · created {ago(iv.created_at)}</div>
            {canChange && (
              <div className="flex flex-wrap gap-2 pt-1">
                <Btn onClick={() => setResched(true)}><Icon d={I.cal} size={14} /> {iv.scheduled_at ? "Reschedule" : "Book a time"}</Btn>
                <Btn kind="danger" onClick={() => confirm("Cancel this interview?") && act(() => api(`/hr/interviews/${iv.id}/cancel`, { method: "POST" }), "Interview cancelled.")}>Cancel</Btn>
              </div>
            )}
            {!canChange && iv.scheduling_status === "cancelled" && <Btn kind="primary" onClick={onInvite}>Invite again</Btn>}
          </div>
        </Card>
        {all.length > 1 && (
          <Card title="Earlier interviews">
            <ul className="text-sm space-y-1">{all.slice(1).map((x) => <li key={x.id} className="flex justify-between text-slate-600"><span>{ago(x.created_at)}</span><span>{CALL_LABEL[x.call_status] ?? x.call_status}{x.overall_score != null ? ` · ${x.overall_score}` : ""}</span></li>)}</ul>
          </Card>
        )}
      </div>

      {override && <RecModal ai={iv.ai_recommendation} hr={iv.hr_recommendation} onClose={() => setOverride(false)} onSave={(r, reason) => act(() => api(`/hr/interviews/${iv.id}/recommendation`, { method: "POST", body: { recommendation: r, reason } }), "Recommendation updated.").then(() => setOverride(false))} />}
      {resched && <RescheduleModal iv={iv} onClose={() => setResched(false)} onSave={(at, tz) => act(() => api(`/hr/interviews/${iv.id}/schedule`, { method: "POST", body: { at, timeZone: tz } }), "Interview scheduled.").then(() => setResched(false))} />}
    </div>
  );
}

function RescheduleModal({ iv, onClose, onSave }: { iv: Interview; onClose: () => void; onSave: (at: string, tz: string) => Promise<void> }) {
  const { data } = useApi<{ slots: string[]; timeZone: string }>(`/hr/interviews/${iv.id}/slots`);
  const [slot, setSlot] = useState("");
  const tz = iv.time_zone ?? data?.timeZone ?? "America/New_York";
  const byDay = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const s of data?.slots ?? []) {
      const d = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric", timeZone: tz }).format(new Date(s));
      m.set(d, [...(m.get(d) ?? []), s]);
    }
    return Array.from(m.entries()).slice(0, 7);
  }, [data, tz]);
  return (
    <Modal title="Book an interview time" onClose={onClose} wide>
      <p className="text-sm text-slate-500 mb-3">Times shown in the candidate's zone ({tz}). Use this when you agreed a time with the candidate directly — they'll get a confirmation.</p>
      {!data ? <Skeleton className="h-40" /> : !byDay.length ? <p className="text-sm text-slate-500">No free slots in the next two weeks. Widen availability in the job's AI interview settings.</p> : (
        <div className="space-y-3 max-h-[50vh] overflow-y-auto">
          {byDay.map(([d, slots]) => (
            <div key={d}>
              <div className="text-xs font-medium text-slate-500 mb-1">{d}</div>
              <div className="flex flex-wrap gap-1.5">
                {slots.map((s) => (
                  <button key={s} type="button" onClick={() => setSlot(s)} className={`text-xs rounded-lg border px-2.5 py-1 ${slot === s ? "bg-red-600 text-white border-red-600" : "border-slate-200 hover:border-red-300"}`}>
                    {new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", timeZone: tz }).format(new Date(s))}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="flex justify-end gap-2 mt-4">
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn kind="primary" disabled={!slot} onClick={() => onSave(slot, tz)}>Book</Btn>
      </div>
    </Modal>
  );
}

function RecModal({ ai, hr, onClose, onSave }: { ai: string | null; hr: string | null; onClose: () => void; onSave: (r: string | null, reason: string) => Promise<void> }) {
  const [r, setR] = useState<string>(hr ?? ai ?? "NEXT_ROUND");
  const [reason, setReason] = useState("");
  return (
    <Modal title="Override interview recommendation" onClose={onClose}>
      <div className="space-y-3">
        <p className="text-sm text-slate-500">AI recommended <b>{ai ? REC_LABEL[ai] : "—"}</b>. Your decision and reason are saved to the audit log.</p>
        <div className="grid grid-cols-2 gap-1.5">
          {Object.entries(REC_LABEL).map(([k, l]) => (
            <button key={k} type="button" onClick={() => setR(k)} className={`text-sm rounded-lg border px-3 py-2 ${r === k ? "border-red-300 bg-red-50 text-red-700" : "border-slate-200"}`}>{l}</button>
          ))}
        </div>
        <Field label="Reason *"><textarea className={`${inputCls} h-20`} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        <div className="flex justify-between">
          {hr ? <Btn kind="ghost" onClick={() => onSave(null, "")}>Clear override</Btn> : <span />}
          <div className="flex gap-2"><Btn onClick={onClose}>Cancel</Btn><Btn kind="primary" disabled={!reason.trim()} onClick={() => onSave(r, reason)}>Save</Btn></div>
        </div>
      </div>
    </Modal>
  );
}

function FitModal({ ai, hr, onClose, onSave }: { ai: Fit | null; hr: Fit | null; onClose: () => void; onSave: (f: Fit | null, reason: string) => Promise<void> }) {
  const [f, setF] = useState<Fit>(hr ?? ai ?? "REVIEW");
  const [reason, setReason] = useState("");
  return (
    <Modal title="Override fit" onClose={onClose}>
      <div className="space-y-3">
        <p className="text-sm text-slate-500">The AI said <b>{ai ? FIT_LABEL[ai] : "—"}</b>. Your override and reason are saved to the timeline and audit log.</p>
        <div className="grid grid-cols-3 gap-1.5">
          {(Object.keys(FIT_LABEL) as Fit[]).map((k) => (
            <button key={k} type="button" onClick={() => setF(k)} className={`text-sm rounded-lg border px-3 py-2 ${f === k ? "border-red-300 bg-red-50 text-red-700" : "border-slate-200"}`}>{FIT_LABEL[k]}</button>
          ))}
        </div>
        <Field label="Reason *"><textarea className={`${inputCls} h-20`} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Confirmed Spanish fluency on a phone screen" /></Field>
        <div className="flex justify-between">
          {hr ? <Btn kind="ghost" onClick={() => onSave(null, "")}>Clear override</Btn> : <span />}
          <div className="flex gap-2"><Btn onClick={onClose}>Cancel</Btn><Btn kind="primary" disabled={!reason.trim()} onClick={() => onSave(f, reason)}>Save</Btn></div>
        </div>
      </div>
    </Modal>
  );
}

function EditModal({ a, onClose, onSave }: { a: any; onClose: () => void; onSave: (body: Record<string, unknown>) => Promise<void> }) {
  const [f, setF] = useState({ firstName: a.first_name ?? "", lastName: a.last_name ?? "", email: a.email ?? "", phone: a.phone ?? "", location: a.location ?? "" });
  return (
    <Modal title="Candidate details" onClose={onClose}>
      <div className="space-y-3">
        <p className="text-xs text-slate-500">Only details read from the resume are filled in automatically. Correct or add them here.</p>
        <div className="grid grid-cols-2 gap-3">
          <Field label="First name"><input className={inputCls} value={f.firstName} onChange={(e) => setF({ ...f, firstName: e.target.value })} /></Field>
          <Field label="Last name"><input className={inputCls} value={f.lastName} onChange={(e) => setF({ ...f, lastName: e.target.value })} /></Field>
        </div>
        <Field label="Email"><input className={inputCls} value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        <Field label="Phone"><input className={inputCls} value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
        <Field label="Location"><input className={inputCls} value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} /></Field>
        <div className="flex justify-end gap-2"><Btn onClick={onClose}>Cancel</Btn><Btn kind="primary" onClick={() => onSave({ ...f, email: f.email.trim(), phone: f.phone.trim() || null, location: f.location || null })}>Save</Btn></div>
      </div>
    </Modal>
  );
}

// ---------- messages ----------

const MSG_STEPS = ["sent", "delivered", "opened", "replied"] as const;

function Messages({ list, act, onCompose }: { list: Message[]; act: (fn: () => Promise<unknown>, ok?: string) => Promise<void>; onCompose: () => void }) {
  return (
    <div className="space-y-3">
      <div className="flex justify-between items-center">
        <p className="text-sm text-slate-500">Complete history of everything sent to this candidate. Drafts are never sent until approved.</p>
        <Btn kind="primary" onClick={onCompose}><Icon d={I.plus} size={14} /> New message</Btn>
      </div>
      {!list.length ? <Card><Empty icon={I.mail} title="No messages yet" /></Card> : list.map((m) => (
        <div key={m.id} className="bg-white border border-slate-200 rounded-2xl p-4">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className={`w-7 h-7 rounded-lg flex items-center justify-center ${m.channel === "email" ? "bg-sky-50 text-sky-600" : "bg-emerald-50 text-emerald-600"}`}><Icon d={m.channel === "email" ? I.mail : I.sms} size={14} /></span>
            <span className="font-medium text-slate-800 capitalize">{m.kind.replace("_", " ")}</span>
            <span className="text-xs text-slate-400">to {m.to_address} · {ago(m.created_at)}</span>
            <span className="ml-auto"><MsgStatus m={m} /></span>
          </div>
          {m.subject && <div className="text-sm font-medium text-slate-700 mt-2">{m.subject}</div>}
          <div className="text-sm text-slate-600 whitespace-pre-line mt-1 line-clamp-6">{m.body}</div>
          {m.error && <div className="text-xs text-red-600 mt-2">{m.error}{m.status !== "failed" && m.attempts ? ` (retrying, attempt ${m.attempts})` : ""}</div>}
          <div className="flex flex-wrap gap-2 mt-3">
            {(m.status === "draft" || m.status === "failed") && <Btn kind="primary" onClick={() => act(() => api("/hr/messages/approve", { method: "POST", body: { ids: [m.id] } }), "Approved — sending now.")}>{m.status === "failed" ? "Retry" : "Approve & send"}</Btn>}
            {(m.status === "draft" || m.status === "failed") && <Btn kind="ghost" onClick={() => act(() => api(`/hr/messages/${m.id}`, { method: "DELETE" }))}>Discard</Btn>}
            {["sent", "delivered", "opened"].includes(m.status) && <Btn kind="ghost" onClick={() => act(() => api(`/hr/messages/${m.id}/replied`, { method: "POST" }), "Marked as replied.")}>Mark replied</Btn>}
          </div>
        </div>
      ))}
    </div>
  );
}

function MsgStatus({ m }: { m: Message }) {
  if (m.status === "draft") return <span className="text-[11px] font-semibold rounded-full px-2 py-0.5 bg-slate-100 text-slate-600">Draft — needs approval</span>;
  if (m.status === "queued") return <span className="text-[11px] font-semibold rounded-full px-2 py-0.5 bg-sky-50 text-sky-700">Sending…</span>;
  if (m.status === "failed") return <span className="text-[11px] font-semibold rounded-full px-2 py-0.5 bg-red-100 text-red-700">Failed</span>;
  const reached = MSG_STEPS.indexOf(m.status as (typeof MSG_STEPS)[number]);
  const stamps: Record<string, string | null> = { sent: m.sent_at, delivered: m.delivered_at, opened: m.opened_at, replied: m.replied_at };
  return (
    <span className="inline-flex items-center gap-1">
      {MSG_STEPS.filter((s) => !(m.channel === "sms" && s === "opened") && !(m.channel === "email" && s === "delivered")).map((s) => {
        const on = MSG_STEPS.indexOf(s) <= reached || Boolean(stamps[s]);
        return <span key={s} title={stamps[s] ? new Date(stamps[s]!).toLocaleString() : undefined} className={`text-[10px] font-semibold rounded-full px-1.5 py-0.5 capitalize ${on ? "bg-green-100 text-green-700" : "bg-slate-100 text-slate-400"}`}>{s}</span>;
      })}
    </span>
  );
}

// ---------- timeline ----------

const KIND_ICON: Record<string, string> = { ai_screening: I.spark, stage: I.users, message: I.mail, message_sent: I.mail, message_opened: I.mail, message_replied: I.sms, message_reply: I.sms, interview: I.mic, override: I.shield, error: I.alert, applied: I.file, retry: I.retry, edit: I.file };

function Timeline({ activity, audit }: { activity: Detail["activity"]; audit: Detail["audit"] }) {
  const [showAudit, setShowAudit] = useState(false);
  return (
    <div className="grid lg:grid-cols-3 gap-5">
      <Card title="Activity" className="lg:col-span-2">
        <ol className="relative border-l border-slate-200 ml-3 space-y-4">
          {activity.map((x) => (
            <li key={x.id} className="ml-5">
              <span className={`absolute -left-3 w-6 h-6 rounded-full flex items-center justify-center ring-4 ring-white ${x.kind === "error" ? "bg-red-50 text-red-600" : x.kind === "override" ? "bg-amber-50 text-amber-600" : "bg-slate-100 text-slate-500"}`}><Icon d={KIND_ICON[x.kind] ?? I.clock} size={12} /></span>
              <div className="text-sm text-slate-800">{x.title}</div>
              <div className="text-[11px] text-slate-400">{new Date(x.created_at).toLocaleString()} · {x.actor ?? "System"}</div>
              <Detailish d={x.detail} />
            </li>
          ))}
        </ol>
      </Card>
      <Card title="Audit log" action={<button type="button" className="text-xs text-slate-500 hover:text-red-600" onClick={() => setShowAudit(!showAudit)}>{showAudit ? "Hide" : "Show"} details</button>} className="h-fit">
        <p className="text-xs text-slate-500 mb-2">Every AI decision and HR override, with before and after values.</p>
        <ul className="space-y-2">
          {audit.map((x, i) => (
            <li key={i} className="text-sm">
              <div className="flex justify-between gap-2"><span className="font-mono text-xs text-slate-700">{x.action}</span><span className="text-[11px] text-slate-400">{ago(x.created_at)}</span></div>
              <div className="text-[11px] text-slate-500">{x.actor ?? "AI / system"}</div>
              {showAudit && <pre className="text-[10px] bg-slate-50 rounded p-1.5 mt-1 overflow-x-auto">{JSON.stringify(x.metadata, null, 1)}</pre>}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

function Detailish({ d }: { d: any }): ReactNode {
  if (!d) return null;
  const bits: string[] = [];
  if (d.reason) bits.push(`“${d.reason}”`);
  if (d.error) bits.push(d.error);
  if (d.text) bits.push(`“${d.text}”`);
  if (d.file) bits.push(d.file);
  return bits.length ? <div className="text-xs text-slate-500 mt-0.5">{bits.join(" · ")}</div> : null;
}
