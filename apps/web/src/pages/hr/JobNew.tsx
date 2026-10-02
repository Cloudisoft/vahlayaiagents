import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError } from "../../lib/api.js";
import { invalidate } from "../../lib/useApi.js";
import { Banner, Btn, Card, Field, I, Icon, inputCls } from "./ui.js";

interface Draft {
  title: string;
  department: string | null;
  summary: string;
  description: string;
  requirements: string[];
  requiredSkills: string[];
  preferredSkills: string[];
  minExperienceYears: number | null;
  education: string | null;
  notes: string[];
}

const TYPES = [["full_time", "Full-time"], ["part_time", "Part-time"], ["contract", "Contract"], ["temporary", "Temporary"], ["internship", "Internship"]];
const list = (s: string) => s.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);

export default function JobNew() {
  const nav = useNavigate();
  const [brief, setBrief] = useState({ title: "", department: "", location: "", employmentType: "full_time", salaryMin: "", salaryMax: "", notes: "" });
  const [job, setJob] = useState({ description: "", requirements: "", requiredSkills: "", preferredSkills: "", minExperienceYears: "", education: "" });
  const [aiNotes, setAiNotes] = useState<string[]>([]);
  const [busy, setBusy] = useState<"gen" | "save" | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function generate() {
    if (brief.title.trim().length < 2) return setErr("Enter a job title first.");
    setBusy("gen");
    setErr(null);
    try {
      const salary = brief.salaryMin || brief.salaryMax ? `${brief.salaryMin || "?"} – ${brief.salaryMax || "?"} USD per year` : undefined;
      const { draft } = await api<{ draft: Draft }>("/hr/jd/generate", {
        method: "POST",
        body: { title: brief.title, department: brief.department || undefined, location: brief.location || undefined, employmentType: brief.employmentType, salary, notes: brief.notes || undefined },
      });
      setJob({
        description: draft.description,
        requirements: (draft.requirements ?? []).join("\n"),
        requiredSkills: (draft.requiredSkills ?? []).join(", "),
        preferredSkills: (draft.preferredSkills ?? []).join(", "),
        minExperienceYears: draft.minExperienceYears != null ? String(draft.minExperienceYears) : "",
        education: draft.education ?? "",
      });
      if (!brief.department && draft.department) setBrief((b) => ({ ...b, department: draft.department ?? "" }));
      setAiNotes(draft.notes ?? []);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Couldn't generate the description.");
    } finally {
      setBusy(null);
    }
  }

  async function create() {
    if (brief.title.trim().length < 2) return setErr("Enter a job title.");
    if (brief.salaryMin && brief.salaryMax && Number(brief.salaryMin) > Number(brief.salaryMax)) return setErr("Salary minimum is above the maximum.");
    setBusy("save");
    setErr(null);
    try {
      const { id } = await api<{ id: string }>("/hr/jobs", {
        method: "POST",
        body: {
          title: brief.title.trim(),
          department: brief.department || null,
          location: brief.location || null,
          employmentType: brief.employmentType,
          salaryMin: brief.salaryMin ? Number(brief.salaryMin) : null,
          salaryMax: brief.salaryMax ? Number(brief.salaryMax) : null,
          description: job.description || null,
          requirements: job.requirements || null,
          requiredSkills: list(job.requiredSkills),
          preferredSkills: list(job.preferredSkills),
          minExperienceYears: job.minExperienceYears ? Number(job.minExperienceYears) : null,
          education: job.education || null,
        },
      });
      invalidate("/hr/");
      nav(`/hr/jobs/${id}`, { replace: true });
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Couldn't create the job.");
      setBusy(null);
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">New job</h1>
        <p className="text-sm text-slate-500 mt-0.5">Describe the role in your own words. AI drafts an inclusive job description from your facts only — it never invents pay, perks or company details.</p>
      </div>
      {err && <Banner kind="error" onClose={() => setErr(null)}>{err}</Banner>}

      <div className="grid lg:grid-cols-5 gap-5">
        <Card title="1 · The brief" className="lg:col-span-2 h-fit">
          <div className="space-y-3">
            <Field label="Job title *"><input className={inputCls} value={brief.title} onChange={(e) => setBrief({ ...brief, title: e.target.value })} placeholder="e.g. Customer Success Manager" /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Department"><input className={inputCls} value={brief.department} onChange={(e) => setBrief({ ...brief, department: e.target.value })} /></Field>
              <Field label="Type">
                <select className={inputCls} value={brief.employmentType} onChange={(e) => setBrief({ ...brief, employmentType: e.target.value })}>
                  {TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </Field>
            </div>
            <Field label="Location" hint="City, or “Remote”"><input className={inputCls} value={brief.location} onChange={(e) => setBrief({ ...brief, location: e.target.value })} /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Salary min (USD/yr)"><input type="number" min={0} className={inputCls} value={brief.salaryMin} onChange={(e) => setBrief({ ...brief, salaryMin: e.target.value })} /></Field>
              <Field label="Salary max (USD/yr)"><input type="number" min={0} className={inputCls} value={brief.salaryMax} onChange={(e) => setBrief({ ...brief, salaryMax: e.target.value })} /></Field>
            </div>
            <Field label="What matters for this role" hint="Responsibilities, must-haves, team, benefits — AI uses only what you write here.">
              <textarea className={`${inputCls} h-36`} value={brief.notes} onChange={(e) => setBrief({ ...brief, notes: e.target.value })} placeholder={"Owns ~60 B2B accounts\nMust have Salesforce + 3 yrs CSM\nSpanish a plus\nHealth, dental, 401k"} />
            </Field>
            <Btn kind="primary" className="w-full" onClick={generate} disabled={busy !== null}>
              <Icon d={I.spark} size={16} /> {busy === "gen" ? "Writing…" : job.description ? "Regenerate with AI" : "Generate with AI"}
            </Btn>
          </div>
        </Card>

        <Card title="2 · Job description" className="lg:col-span-3" action={<span className="text-xs text-slate-400">Edit freely — you can also write it yourself</span>}>
          <div className={`space-y-3 transition-opacity ${busy === "gen" ? "opacity-50 pointer-events-none" : ""}`}>
            {aiNotes.length > 0 && (
              <Banner kind="info">
                <div className="font-medium mb-0.5">Please confirm before publishing:</div>
                <ul className="list-disc ml-4 text-xs space-y-0.5">{aiNotes.map((n, i) => <li key={i}>{n}</li>)}</ul>
              </Banner>
            )}
            <Field label="Description">
              <textarea className={`${inputCls} h-72 font-[inherit] leading-relaxed`} value={job.description} onChange={(e) => setJob({ ...job, description: e.target.value })} placeholder="About the role, what you'll do, what you'll bring…" />
            </Field>
            <Field label="Must-have requirements" hint="One per line. Each is checked against every resume.">
              <textarea className={`${inputCls} h-24`} value={job.requirements} onChange={(e) => setJob({ ...job, requirements: e.target.value })} />
            </Field>
            <div className="grid sm:grid-cols-2 gap-3">
              <Field label="Required skills" hint="Comma separated"><input className={inputCls} value={job.requiredSkills} onChange={(e) => setJob({ ...job, requiredSkills: e.target.value })} /></Field>
              <Field label="Preferred skills" hint="Comma separated"><input className={inputCls} value={job.preferredSkills} onChange={(e) => setJob({ ...job, preferredSkills: e.target.value })} /></Field>
              <Field label="Minimum experience (years)"><input type="number" min={0} className={inputCls} value={job.minExperienceYears} onChange={(e) => setJob({ ...job, minExperienceYears: e.target.value })} /></Field>
              <Field label="Education"><input className={inputCls} value={job.education} onChange={(e) => setJob({ ...job, education: e.target.value })} placeholder="Leave empty if not required" /></Field>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Btn onClick={() => nav("/hr")}>Cancel</Btn>
              <Btn kind="primary" onClick={create} disabled={busy !== null}>{busy === "save" ? "Creating…" : "Create job"}</Btn>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
