import { useState, type ReactNode } from "react";
import { api, ApiError } from "../../lib/api.js";
import { invalidate, useApi } from "../../lib/useApi.js";
import type { JobPayload } from "./JobDetail.js";
import { Banner, Btn, Card, Field, I, Icon, copyText, inputCls } from "./ui.js";

type Tab = "description" | "posting" | "interview" | "scoring";

export default function JobSetup({ tab, payload, onSaved }: { tab: Tab; payload: JobPayload; onSaved: () => void }) {
  if (tab === "description") return <Description payload={payload} onSaved={onSaved} />;
  if (tab === "posting") return <Posting payload={payload} />;
  if (tab === "interview") return <Interview payload={payload} onSaved={onSaved} />;
  return <Scoring payload={payload} onSaved={onSaved} />;
}

function useSaver(jobId: string, onSaved: () => void) {
  const [state, setState] = useState<{ busy: boolean; msg: { kind: "ok" | "error"; text: string } | null }>({ busy: false, msg: null });
  const save = async (body: Record<string, unknown>) => {
    setState({ busy: true, msg: null });
    try {
      await api(`/hr/jobs/${jobId}`, { method: "PATCH", body });
      setState({ busy: false, msg: { kind: "ok", text: "Saved." } });
      setTimeout(() => setState((x) => (x.msg?.kind === "ok" ? { ...x, msg: null } : x)), 2500);
      onSaved();
      invalidate("/hr/overview");
    } catch (e) {
      setState({ busy: false, msg: { kind: "error", text: e instanceof ApiError ? e.message : "Couldn't save." } });
    }
  };
  return { ...state, save, clear: () => setState((s) => ({ ...s, msg: null })) };
}

function SaveBar({ busy, msg, onSave, dirty = true }: { busy: boolean; msg: { kind: "ok" | "error"; text: string } | null; onSave: () => void; dirty?: boolean }) {
  return (
    <div className="flex items-center justify-end gap-3 sticky bottom-3 z-10">
      <div className={`flex items-center gap-3 rounded-xl px-3 py-2 transition-shadow ${dirty ? "bg-white shadow-lg ring-1 ring-slate-200" : ""}`}>
      {dirty && !msg && <span className="text-xs text-slate-500">Unsaved changes</span>}
      {msg && <span className={`text-sm ${msg.kind === "ok" ? "text-green-600" : "text-red-600"}`}>{msg.text}</span>}
      <Btn kind="primary" onClick={onSave} disabled={busy || !dirty}>{busy ? "Saving…" : "Save changes"}</Btn>
      </div>
    </div>
  );
}

// ---------- description ----------

interface Review { score: number; issues: Array<{ severity: string; issue: string; quote: string | null; fix: string }>; improved: { description: string; requirements: string[]; requiredSkills: string[]; preferredSkills: string[]; notes: string[] } }
const list = (s: string) => s.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);

function Description({ payload, onSaved }: { payload: JobPayload; onSaved: () => void }) {
  const j = payload.job;
  const init = {
    title: j.title ?? "",
    department: j.department ?? "",
    location: j.location ?? "",
    employmentType: j.employment_type ?? "full_time",
    salaryMin: j.salary_min != null ? String(Number(j.salary_min)) : "",
    salaryMax: j.salary_max != null ? String(Number(j.salary_max)) : "",
    description: j.description ?? "",
    requirements: j.requirements ?? "",
    requiredSkills: (j.required_skills ?? []).join(", "),
    preferredSkills: (j.preferred_skills ?? []).join(", "),
    minExperienceYears: j.min_experience_years != null ? String(Number(j.min_experience_years)) : "",
    education: j.education ?? "",
  };
  const [f, setF] = useState(init);
  const dirty = JSON.stringify(f) !== JSON.stringify(init);
  const s = useSaver(j.id, onSaved);
  const [review, setReview] = useState<Review | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  async function runReview() {
    if (dirty) return setErr("Save your changes first, then run the AI review.");
    setReviewing(true);
    setErr(null);
    try {
      setReview((await api<{ review: Review }>(`/hr/jobs/${j.id}/optimize`, { method: "POST" })).review);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Review failed.");
    } finally {
      setReviewing(false);
    }
  }

  return (
    <div className="grid lg:grid-cols-3 gap-5">
      <div className="lg:col-span-2 space-y-4">
        <Card>
          <div className="space-y-3">
            <div className="grid sm:grid-cols-2 gap-3">
              <Field label="Title"><input className={inputCls} value={f.title} onChange={set("title")} /></Field>
              <Field label="Department"><input className={inputCls} value={f.department} onChange={set("department")} /></Field>
              <Field label="Location"><input className={inputCls} value={f.location} onChange={set("location")} /></Field>
              <Field label="Type">
                <select className={inputCls} value={f.employmentType} onChange={set("employmentType")}>
                  {[["full_time", "Full-time"], ["part_time", "Part-time"], ["contract", "Contract"], ["temporary", "Temporary"], ["internship", "Internship"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </Field>
              <Field label="Salary min (USD/yr)"><input type="number" className={inputCls} value={f.salaryMin} onChange={set("salaryMin")} /></Field>
              <Field label="Salary max (USD/yr)"><input type="number" className={inputCls} value={f.salaryMax} onChange={set("salaryMax")} /></Field>
            </div>
            <Field label="Description"><textarea className={`${inputCls} h-80 leading-relaxed`} value={f.description} onChange={set("description")} /></Field>
            <Field label="Must-have requirements" hint="One per line — each is checked against every resume."><textarea className={`${inputCls} h-24`} value={f.requirements} onChange={set("requirements")} /></Field>
            <div className="grid sm:grid-cols-2 gap-3">
              <Field label="Required skills"><input className={inputCls} value={f.requiredSkills} onChange={set("requiredSkills")} /></Field>
              <Field label="Preferred skills"><input className={inputCls} value={f.preferredSkills} onChange={set("preferredSkills")} /></Field>
              <Field label="Minimum experience (years)"><input type="number" className={inputCls} value={f.minExperienceYears} onChange={set("minExperienceYears")} /></Field>
              <Field label="Education"><input className={inputCls} value={f.education} onChange={set("education")} /></Field>
            </div>
          </div>
        </Card>
        <SaveBar
          {...s}
          dirty={dirty}
          onSave={() =>
            s.save({
              title: f.title,
              department: f.department || null,
              location: f.location || null,
              employmentType: f.employmentType,
              salaryMin: f.salaryMin ? Number(f.salaryMin) : null,
              salaryMax: f.salaryMax ? Number(f.salaryMax) : null,
              description: f.description || null,
              requirements: f.requirements || null,
              requiredSkills: list(f.requiredSkills),
              preferredSkills: list(f.preferredSkills),
              minExperienceYears: f.minExperienceYears ? Number(f.minExperienceYears) : null,
              education: f.education || null,
            })
          }
        />
      </div>

      <div className="space-y-4">
        <Card title="AI review" action={<Btn onClick={runReview} disabled={reviewing}><Icon d={I.spark} size={15} /> {reviewing ? "Reviewing…" : review ? "Re-run" : "Review"}</Btn>}>
          {err && <div className="mb-2"><Banner kind="error">{err}</Banner></div>}
          {!review ? (
            <p className="text-sm text-slate-500">Checks clarity, inclusive language, realistic must-haves and candidate appeal — then proposes an improved version that keeps only your facts.</p>
          ) : (
            <div className="space-y-3 animate-fade-in">
              <div className="flex items-center gap-3">
                <div className={`text-3xl font-bold tabular-nums ${review.score >= 80 ? "text-green-600" : review.score >= 60 ? "text-amber-500" : "text-red-600"}`}>{review.score}</div>
                <div className="text-xs text-slate-500">quality score<br />{review.issues.length} suggestion{review.issues.length === 1 ? "" : "s"}</div>
              </div>
              <ul className="space-y-2">
                {review.issues.map((x, i) => (
                  <li key={i} className="text-sm">
                    <div className="flex items-start gap-2">
                      <span className={`mt-1.5 w-1.5 h-1.5 rounded-full shrink-0 ${x.severity === "high" ? "bg-red-500" : x.severity === "medium" ? "bg-amber-400" : "bg-slate-300"}`} />
                      <div>
                        <div className="text-slate-800">{x.issue}</div>
                        {x.quote && <div className="text-xs italic text-slate-500">“{x.quote}”</div>}
                        <div className="text-xs text-green-700 mt-0.5">→ {x.fix}</div>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
              <Btn
                kind="primary"
                className="w-full"
                onClick={() =>
                  setF({
                    ...f,
                    description: review.improved.description || f.description,
                    requirements: review.improved.requirements?.length ? review.improved.requirements.join("\n") : f.requirements,
                    requiredSkills: review.improved.requiredSkills?.length ? review.improved.requiredSkills.join(", ") : f.requiredSkills,
                    preferredSkills: review.improved.preferredSkills?.length ? review.improved.preferredSkills.join(", ") : f.preferredSkills,
                  })
                }
              >
                Use improved version
              </Btn>
              {review.improved.notes?.length > 0 && <p className="text-xs text-amber-700">Confirm: {review.improved.notes.join(" · ")}</p>}
              <p className="text-[11px] text-slate-400">Fills the form — nothing is saved until you click Save.</p>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

// ---------- posting ----------

function CopyBlock({ label, text, rows = 6, mono = false }: { label: string; text: string; rows?: number; mono?: boolean }) {
  const [done, setDone] = useState(false);
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-medium text-slate-600">{label}</span>
        <button type="button" className="text-xs text-slate-500 hover:text-red-600 inline-flex items-center gap-1" onClick={() => { copyText(text); setDone(true); setTimeout(() => setDone(false), 1500); }}>
          <Icon d={done ? I.check : I.copy} size={13} /> {done ? "Copied" : "Copy"}
        </button>
      </div>
      <textarea readOnly rows={rows} value={text} className={`${inputCls} bg-slate-50 text-xs ${mono ? "font-mono" : ""}`} />
    </div>
  );
}

function Posting({ payload }: { payload: JobPayload }) {
  const p = payload.posting;
  const live = payload.job.status === "published";
  const ok = p.checklist.filter((c) => c.ok).length;
  return (
    <div className="grid lg:grid-cols-3 gap-5">
      <div className="lg:col-span-2 space-y-4">
        <Card title="Careers page">
          {!live && <div className="mb-3"><Banner kind="info">The job is not published. Publish it (top right) to open the careers page and job feed.</Banner></div>}
          {p.applyUrl ? (
            <div className="flex flex-wrap items-center gap-2">
              <code className="text-sm bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 truncate max-w-full">{p.applyUrl}</code>
              <Btn onClick={() => copyText(p.applyUrl!)}><Icon d={I.copy} size={14} /> Copy</Btn>
              {live && <a href={p.applyUrl} target="_blank" rel="noreferrer" className="text-sm text-red-600 hover:underline">Open ↗</a>}
            </div>
          ) : (
            <p className="text-sm text-slate-500">A link is created when you publish.</p>
          )}
          <p className="text-xs text-slate-500 mt-2">Candidates apply with a PDF or Word resume; each one is screened automatically and appears in Candidates. Nobody is contacted until you approve it.</p>
        </Card>
        <Card title="Copy-ready posts">
          <div className="space-y-3">
            <CopyBlock label="LinkedIn (fits the post limit)" text={p.copy.linkedin} rows={8} />
            <CopyBlock label="Indeed / other boards" text={p.copy.indeed} rows={6} />
            <CopyBlock label="Short post (X, WhatsApp, SMS)" text={p.copy.short} rows={2} />
          </div>
        </Card>
        <Card title="Google for Jobs">
          <p className="text-sm text-slate-600 mb-2">Your careers page already includes this structured data, so Google can list the job in search. You can also paste it into your own website's job page.</p>
          <CopyBlock label="JobPosting JSON-LD" text={`<script type="application/ld+json">\n${JSON.stringify(p.jsonLd, null, 2)}\n</script>`} rows={10} mono />
        </Card>
      </div>
      <div className="space-y-4">
        <Card title="Posting checklist" action={<span className="text-xs text-slate-500">{ok}/{p.checklist.length}</span>}>
          <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden mb-3"><div className="h-full bg-green-500 transition-[width] duration-500" style={{ width: `${(ok / p.checklist.length) * 100}%` }} /></div>
          <ul className="space-y-1.5">
            {p.checklist.map((c) => (
              <li key={c.item} className="flex items-start gap-2 text-sm">
                <span className={`mt-0.5 w-4 h-4 rounded-full flex items-center justify-center shrink-0 ${c.ok ? "bg-green-100 text-green-600" : "bg-slate-100 text-slate-400"}`}><Icon d={c.ok ? I.check : I.x} size={11} /></span>
                <span className={c.ok ? "text-slate-700" : "text-slate-500"}>{c.item}</span>
              </li>
            ))}
          </ul>
        </Card>
        <Card title="Job boards">
          <p className="text-sm text-slate-600">LinkedIn and Indeed only allow automatic posting through paid partner programs, so Vahlay HR gives you:</p>
          <ul className="text-sm text-slate-600 list-disc ml-4 mt-2 space-y-1">
            <li>the copy-ready posts on the left,</li>
            <li>Google for Jobs data on your careers page,</li>
            <li>an XML feed job aggregators can read:</li>
          </ul>
          {p.feedUrl && <code className="block mt-2 text-[11px] bg-slate-50 border border-slate-200 rounded-lg px-2 py-1.5 break-all">{p.feedUrl}</code>}
        </Card>
      </div>
    </div>
  );
}

// ---------- AI interview ----------

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const ZONES: string[] = (() => {
  try {
    return (Intl as unknown as { supportedValuesOf: (k: string) => string[] }).supportedValuesOf("timeZone");
  } catch {
    return ["America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "Europe/London", "Asia/Kolkata"];
  }
})();

function Interview({ payload, onSaved }: { payload: JobPayload; onSaved: () => void }) {
  const iv = payload.interview;
  const init = {
    questions: (iv.questions ?? []) as Array<{ question: string; purpose?: string }>,
    durationMinutes: iv.durationMinutes,
    interviewerName: iv.interviewerName,
    voiceId: iv.voiceId ?? "",
    days: iv.days as number[],
    startHour: iv.startHour,
    endHour: iv.endHour,
    slotMinutes: iv.slotMinutes,
    maxPerSlot: iv.maxPerSlot,
    timeZone: iv.timeZone,
    nextRoundThreshold: iv.nextRoundThreshold,
    holdThreshold: iv.holdThreshold,
    evaluationCriteria: iv.evaluationCriteria as Array<{ key: string; label: string; weight: number }>,
  };
  const [f, setF] = useState(init);
  const dirty = JSON.stringify(f) !== JSON.stringify(init);
  const s = useSaver(payload.job.id, onSaved);
  const { data: settings } = useApi<{ voices: Array<{ id: string; name: string; gender: string | null }>; settings: { voiceNumberId: string | null } }>("/hr/settings");
  const [gen, setGen] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function generate() {
    setGen(true);
    setErr(null);
    try {
      const r = await api<{ questions: Array<{ question: string; purpose: string }> }>(`/hr/jobs/${payload.job.id}/questions`, { method: "POST", body: { count: 6 } });
      setF({ ...f, questions: f.questions.length ? [...f.questions, ...r.questions].slice(0, 15) : r.questions });
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Couldn't generate questions.");
    } finally {
      setGen(false);
    }
  }
  const setQ = (i: number, v: Partial<{ question: string; purpose: string }>) => setF({ ...f, questions: f.questions.map((q, k) => (k === i ? { ...q, ...v } : q)) });
  const move = (i: number, d: number) => {
    const q = [...f.questions];
    const [x] = q.splice(i, 1);
    q.splice(i + d, 0, x);
    setF({ ...f, questions: q });
  };

  return (
    <div className="grid lg:grid-cols-3 gap-5">
      <div className="lg:col-span-2 space-y-4">
        {!settings?.settings.voiceNumberId && <Banner kind="info">Set the interview calling number in Vahlay HR → Settings before inviting candidates.</Banner>}
        {err && <Banner kind="error">{err}</Banner>}
        <Card title="Structured questions" action={<Btn onClick={generate} disabled={gen}><Icon d={I.spark} size={15} /> {gen ? "Writing…" : f.questions.length ? "Suggest more" : "Generate with AI"}</Btn>}>
          <p className="text-xs text-slate-500 mb-3">The AI interviewer asks every question in this order, with at most one short follow-up when an answer is vague. Every candidate gets the same questions, so evaluations are comparable.</p>
          {!f.questions.length ? (
            <p className="text-sm text-slate-500">No questions yet.</p>
          ) : (
            <ol className="space-y-2">
              {f.questions.map((q, i) => (
                <li key={i} className="flex gap-2 items-start group animate-fade-in">
                  <span className="mt-2 w-6 h-6 rounded-full bg-slate-100 text-slate-500 text-xs font-semibold flex items-center justify-center shrink-0">{i + 1}</span>
                  <div className="flex-1 space-y-1">
                    <textarea rows={2} className={inputCls} value={q.question} onChange={(e) => setQ(i, { question: e.target.value })} />
                    <input className={`${inputCls} py-1 text-xs`} placeholder="What it assesses (optional)" value={q.purpose ?? ""} onChange={(e) => setQ(i, { purpose: e.target.value })} />
                  </div>
                  <div className="flex flex-col opacity-40 group-hover:opacity-100 transition-opacity">
                    <button type="button" disabled={i === 0} onClick={() => move(i, -1)} className="px-1 text-slate-500 disabled:opacity-30">▲</button>
                    <button type="button" disabled={i === f.questions.length - 1} onClick={() => move(i, 1)} className="px-1 text-slate-500 disabled:opacity-30">▼</button>
                    <button type="button" onClick={() => setF({ ...f, questions: f.questions.filter((_, k) => k !== i) })} className="px-1 text-red-500"><Icon d={I.x} size={14} /></button>
                  </div>
                </li>
              ))}
            </ol>
          )}
          <button type="button" className="mt-3 text-sm text-red-600 hover:underline" onClick={() => setF({ ...f, questions: [...f.questions, { question: "", purpose: "" }] })}>+ Add question</button>
        </Card>

        <Card title="Evaluation">
          <p className="text-xs text-slate-500 mb-3">Scores come only from what the candidate said, each with quotes from the transcript. An interview where fewer than 80% of questions were answered is marked incomplete and goes to HR review.</p>
          <div className="space-y-2">
            {f.evaluationCriteria.map((c, i) => (
              <div key={i} className="grid grid-cols-12 gap-2 items-center">
                <input className={`${inputCls} col-span-7`} value={c.label} onChange={(e) => setF({ ...f, evaluationCriteria: f.evaluationCriteria.map((x, k) => (k === i ? { ...x, label: e.target.value } : x)) })} />
                <input type="number" min={1} max={100} className={`${inputCls} col-span-3`} value={c.weight} onChange={(e) => setF({ ...f, evaluationCriteria: f.evaluationCriteria.map((x, k) => (k === i ? { ...x, weight: Number(e.target.value) } : x)) })} />
                <button type="button" className="col-span-2 text-xs text-slate-400 hover:text-red-600" onClick={() => f.evaluationCriteria.length > 1 && setF({ ...f, evaluationCriteria: f.evaluationCriteria.filter((_, k) => k !== i) })}>Remove</button>
              </div>
            ))}
            <button type="button" className="text-sm text-red-600 hover:underline" onClick={() => setF({ ...f, evaluationCriteria: [...f.evaluationCriteria, { key: `c${Date.now().toString(36)}`, label: "New criterion", weight: 10 }] })}>+ Add criterion</button>
          </div>
          <div className="grid grid-cols-2 gap-3 mt-4">
            <Field label="Next round at or above"><input type="number" className={inputCls} value={f.nextRoundThreshold} onChange={(e) => setF({ ...f, nextRoundThreshold: Number(e.target.value) })} /></Field>
            <Field label="Hold at or above" hint="Below this: do not advance"><input type="number" className={inputCls} value={f.holdThreshold} onChange={(e) => setF({ ...f, holdThreshold: Number(e.target.value) })} /></Field>
          </div>
        </Card>
        <SaveBar
          {...s}
          dirty={dirty}
          onSave={() => {
            const questions = f.questions.filter((q) => q.question.trim().length >= 5).map((q) => ({ question: q.question.trim(), ...(q.purpose?.trim() ? { purpose: q.purpose.trim() } : {}) }));
            s.save({
              interviewSettings: {
                questions,
                durationMinutes: Number(f.durationMinutes),
                interviewerName: f.interviewerName,
                voiceId: f.voiceId || null,
                days: f.days,
                startHour: Number(f.startHour),
                endHour: Number(f.endHour),
                slotMinutes: Number(f.slotMinutes),
                maxPerSlot: Number(f.maxPerSlot),
                timeZone: f.timeZone,
                nextRoundThreshold: Number(f.nextRoundThreshold),
                holdThreshold: Number(f.holdThreshold),
                evaluationCriteria: f.evaluationCriteria.map((c) => ({ key: c.key, label: c.label.trim() || c.key, weight: Number(c.weight) || 1 })),
              },
            });
          }}
        />
      </div>

      <div className="space-y-4">
        <Card title="Interviewer">
          <div className="space-y-3">
            <Field label="Name the AI introduces itself with"><input className={inputCls} value={f.interviewerName} onChange={(e) => setF({ ...f, interviewerName: e.target.value })} /></Field>
            <Field label="Voice">
              <select className={inputCls} value={f.voiceId} onChange={(e) => setF({ ...f, voiceId: e.target.value })}>
                <option value="">VAPI default voice</option>
                {settings?.voices.map((v) => <option key={v.id} value={v.id}>{v.name}{v.gender ? ` · ${v.gender}` : ""}</option>)}
              </select>
            </Field>
            <Field label="Length (minutes)"><input type="number" min={5} max={45} className={inputCls} value={f.durationMinutes} onChange={(e) => setF({ ...f, durationMinutes: Number(e.target.value) })} /></Field>
          </div>
        </Card>
        <Card title="Availability">
          <div className="space-y-3">
            <div className="flex flex-wrap gap-1">
              {DAYS.map((d, i) => (
                <button key={d} type="button" onClick={() => setF({ ...f, days: f.days.includes(i) ? f.days.filter((x) => x !== i) : [...f.days, i].sort() })} className={`text-xs rounded-md px-2 py-1 border transition-colors ${f.days.includes(i) ? "bg-red-600 text-white border-red-600" : "bg-white text-slate-600 border-slate-200"}`}>{d}</button>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Field label="From (hour)"><input type="number" min={0} max={23} className={inputCls} value={f.startHour} onChange={(e) => setF({ ...f, startHour: Number(e.target.value) })} /></Field>
              <Field label="To (hour)"><input type="number" min={1} max={24} className={inputCls} value={f.endHour} onChange={(e) => setF({ ...f, endHour: Number(e.target.value) })} /></Field>
              <Field label="Slot length">
                <select className={inputCls} value={f.slotMinutes} onChange={(e) => setF({ ...f, slotMinutes: Number(e.target.value) })}>{[15, 20, 30, 45, 60].map((m) => <option key={m} value={m}>{m} min</option>)}</select>
              </Field>
              <Field label="Calls per slot"><input type="number" min={1} max={20} className={inputCls} value={f.maxPerSlot} onChange={(e) => setF({ ...f, maxPerSlot: Number(e.target.value) })} /></Field>
            </div>
            <Field label="Your time zone" hint="Candidates see times in their own zone.">
              <select className={inputCls} value={f.timeZone} onChange={(e) => setF({ ...f, timeZone: e.target.value })}>{ZONES.map((z) => <option key={z} value={z}>{z}</option>)}</select>
            </Field>
          </div>
        </Card>
      </div>
    </div>
  );
}

// ---------- scoring ----------

function Scoring({ payload, onSaved }: { payload: JobPayload; onSaved: () => void }) {
  const init = { criteria: payload.criteria.map((c) => ({ ...c, guidance: c.guidance ?? "" })), good: payload.job.good_fit_threshold as number, review: payload.job.review_fit_threshold as number };
  const [f, setF] = useState(init);
  const dirty = JSON.stringify(f) !== JSON.stringify(init);
  const s = useSaver(payload.job.id, onSaved);
  const totalW = f.criteria.reduce((a, c) => a + (Number(c.weight) || 0), 0) || 1;
  const upd = (i: number, v: Partial<(typeof f.criteria)[number]>) => setF({ ...f, criteria: f.criteria.map((c, k) => (k === i ? { ...c, ...v } : c)) });

  return (
    <div className="grid lg:grid-cols-3 gap-5">
      <div className="lg:col-span-2 space-y-4">
        <Card title="Resume scoring criteria">
          <div className="space-y-3">
            {f.criteria.map((c, i) => (
              <div key={i} className="border border-slate-200 rounded-xl p-3">
                <div className="grid grid-cols-12 gap-2 items-center">
                  <input className={`${inputCls} col-span-6`} value={c.label} onChange={(e) => upd(i, { label: e.target.value })} />
                  <input type="number" min={1} max={100} className={`${inputCls} col-span-2`} value={c.weight} onChange={(e) => upd(i, { weight: Number(e.target.value) })} />
                  <span className="col-span-2 text-xs text-slate-500 tabular-nums">{Math.round(((Number(c.weight) || 0) / totalW) * 100)}%</span>
                  <button type="button" className="col-span-2 text-xs text-slate-400 hover:text-red-600 text-right" onClick={() => f.criteria.length > 1 && setF({ ...f, criteria: f.criteria.filter((_, k) => k !== i) })}>Remove</button>
                </div>
                <input className={`${inputCls} mt-2 text-xs py-1.5`} placeholder="What the AI should look for (optional)" value={c.guidance} onChange={(e) => upd(i, { guidance: e.target.value })} />
              </div>
            ))}
            <div className="flex gap-3">
              <button type="button" className="text-sm text-red-600 hover:underline" onClick={() => setF({ ...f, criteria: [...f.criteria, { key: `c${Date.now().toString(36)}`, label: "New criterion", weight: 10, guidance: "" }] })}>+ Add criterion</button>
              <button type="button" className="text-sm text-slate-500 hover:underline" onClick={() => setF({ ...f, criteria: payload.defaultCriteria.map((c) => ({ ...c, guidance: c.guidance ?? "" })) })}>Reset to defaults</button>
            </div>
          </div>
        </Card>
        <Card title="Fit thresholds">
          <div className="relative h-3 rounded-full overflow-hidden flex">
            <div className="bg-red-200" style={{ width: `${f.review}%` }} />
            <div className="bg-amber-200" style={{ width: `${Math.max(0, f.good - f.review)}%` }} />
            <div className="bg-green-200 flex-1" />
          </div>
          <div className="flex justify-between text-[11px] text-slate-500 mt-1"><span>Not a fit</span><span>Review</span><span>Good fit</span></div>
          <div className="grid grid-cols-2 gap-3 mt-3">
            <Field label="Good fit at or above"><input type="number" min={1} max={100} className={inputCls} value={f.good} onChange={(e) => setF({ ...f, good: Number(e.target.value) })} /></Field>
            <Field label="Review at or above"><input type="number" min={0} max={99} className={inputCls} value={f.review} onChange={(e) => setF({ ...f, review: Number(e.target.value) })} /></Field>
          </div>
        </Card>
        <SaveBar
          {...s}
          dirty={dirty}
          onSave={() =>
            s.save({
              scoringCriteria: f.criteria.map((c) => ({ key: c.key, label: c.label.trim() || c.key, weight: Number(c.weight) || 1, ...(c.guidance.trim() ? { guidance: c.guidance.trim() } : {}) })),
              goodFitThreshold: f.good,
              reviewFitThreshold: f.review,
            })
          }
        />
      </div>
      <Card title="How scoring works" className="h-fit">
        <ol className="text-sm text-slate-600 space-y-2 list-decimal ml-4">
          <Li>The AI scores each criterion 0–100 and must quote the resume for every score.</Li>
          <Li>Every quote is checked against the resume text. Quotes that aren't there are thrown out.</Li>
          <Li>A criterion with no verified quote is capped at 30, so nothing unproven can carry the score.</Li>
          <Li>The overall score is the weighted average of the criteria — plain arithmetic, the same every time.</Li>
          <Li>A missing must-have requirement keeps a candidate out of “Good fit”.</Li>
          <Li>Fit is a recommendation. Candidates are never rejected or contacted automatically, and you can override any result with a reason.</Li>
        </ol>
        <p className="text-xs text-slate-400 mt-3">Changes apply to resumes screened from now on. Select candidates and choose “Re-screen” to apply them to existing ones.</p>
      </Card>
    </div>
  );
}

function Li({ children }: { children: ReactNode }) {
  return <li className="pl-1">{children}</li>;
}
