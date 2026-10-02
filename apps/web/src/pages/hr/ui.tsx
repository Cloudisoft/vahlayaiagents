export * from "../../components/ui.js";

export type Stage =
  | "APPLIED" | "SCREENING" | "SHORTLISTED" | "INTERVIEW_INVITED" | "SCHEDULED" | "AI_INTERVIEW" | "EVALUATED" | "NEXT_ROUND" | "HOLD" | "REJECTED" | "HIRED";
export type Fit = "GOOD_FIT" | "REVIEW" | "NOT_A_FIT";

export const STAGES: Stage[] = ["APPLIED", "SCREENING", "SHORTLISTED", "INTERVIEW_INVITED", "SCHEDULED", "AI_INTERVIEW", "EVALUATED", "NEXT_ROUND", "HOLD", "REJECTED", "HIRED"];
export const STAGE_LABEL: Record<Stage, string> = {
  APPLIED: "Applied",
  SCREENING: "Screening",
  SHORTLISTED: "Shortlisted",
  INTERVIEW_INVITED: "Invited",
  SCHEDULED: "Scheduled",
  AI_INTERVIEW: "AI interview",
  EVALUATED: "Evaluated",
  NEXT_ROUND: "Next round",
  HOLD: "Hold",
  REJECTED: "Rejected",
  HIRED: "Hired",
};
export const STAGE_TONE: Record<Stage, string> = {
  APPLIED: "bg-slate-100 text-slate-600",
  SCREENING: "bg-sky-50 text-sky-700",
  SHORTLISTED: "bg-indigo-50 text-indigo-700",
  INTERVIEW_INVITED: "bg-violet-50 text-violet-700",
  SCHEDULED: "bg-purple-50 text-purple-700",
  AI_INTERVIEW: "bg-fuchsia-50 text-fuchsia-700",
  EVALUATED: "bg-cyan-50 text-cyan-700",
  NEXT_ROUND: "bg-emerald-50 text-emerald-700",
  HOLD: "bg-amber-50 text-amber-700",
  REJECTED: "bg-red-50 text-red-700",
  HIRED: "bg-green-100 text-green-800",
};
export const STAGE_DOT: Record<Stage, string> = {
  APPLIED: "bg-slate-400",
  SCREENING: "bg-sky-500",
  SHORTLISTED: "bg-indigo-500",
  INTERVIEW_INVITED: "bg-violet-500",
  SCHEDULED: "bg-purple-500",
  AI_INTERVIEW: "bg-fuchsia-500",
  EVALUATED: "bg-cyan-500",
  NEXT_ROUND: "bg-emerald-500",
  HOLD: "bg-amber-500",
  REJECTED: "bg-red-500",
  HIRED: "bg-green-600",
};

export const FIT_LABEL: Record<Fit, string> = { GOOD_FIT: "Good fit", REVIEW: "Review", NOT_A_FIT: "Not a fit" };
const FIT_TONE: Record<Fit, string> = {
  GOOD_FIT: "bg-green-100 text-green-700 ring-green-200",
  REVIEW: "bg-amber-100 text-amber-700 ring-amber-200",
  NOT_A_FIT: "bg-red-100 text-red-700 ring-red-200",
};

export const REC_LABEL: Record<string, string> = { NEXT_ROUND: "Next round", HOLD: "Hold", HR_REVIEW: "HR review", DO_NOT_ADVANCE: "Do not advance" };
const REC_TONE: Record<string, string> = {
  NEXT_ROUND: "bg-green-100 text-green-700",
  HOLD: "bg-amber-100 text-amber-700",
  HR_REVIEW: "bg-sky-100 text-sky-700",
  DO_NOT_ADVANCE: "bg-red-100 text-red-700",
};

export function FitBadge({ ai, hr, size = "sm" }: { ai: Fit | null; hr?: Fit | null; size?: "sm" | "lg" }) {
  const fit = hr ?? ai;
  if (!fit) return <span className="text-xs text-slate-400">—</span>;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full ring-1 font-semibold ${FIT_TONE[fit]} ${size === "lg" ? "text-sm px-3 py-1" : "text-[11px] px-2 py-0.5"}`} title={hr ? `HR override (AI said ${ai ? FIT_LABEL[ai] : "—"})` : "AI screening"}>
      {FIT_LABEL[fit]}
      {hr && <span className="opacity-70">· HR</span>}
    </span>
  );
}

export function StageBadge({ stage }: { stage: Stage }) {
  return <span className={`inline-flex items-center gap-1.5 text-[11px] font-medium rounded-full px-2 py-0.5 ${STAGE_TONE[stage] ?? "bg-slate-100"}`}><span className={`w-1.5 h-1.5 rounded-full ${STAGE_DOT[stage]}`} />{STAGE_LABEL[stage] ?? stage}</span>;
}

export function RecBadge({ ai, hr }: { ai: string | null; hr?: string | null }) {
  const r = hr ?? ai;
  if (!r) return <span className="text-xs text-slate-400">—</span>;
  return (
    <span className={`text-[11px] font-semibold rounded-full px-2 py-0.5 ${REC_TONE[r] ?? "bg-slate-100"}`} title={hr ? `HR override (AI said ${ai ? REC_LABEL[ai] : "—"})` : "AI recommendation"}>
      {REC_LABEL[r] ?? r}
      {hr && <span className="opacity-70"> · HR</span>}
    </span>
  );
}

export function Quote({ text, tone = "slate" }: { text: string; tone?: "slate" | "green" | "red" }) {
  const t = tone === "green" ? "border-green-300 bg-green-50/60" : tone === "red" ? "border-red-300 bg-red-50/60" : "border-slate-300 bg-slate-50";
  return <div className={`text-xs italic text-slate-600 border-l-2 ${t} pl-2 py-0.5 rounded-r`}>“{text}”</div>;
}

export function personName(p: { first_name?: string | null; last_name?: string | null; file_name?: string | null }) {
  const n = [p.first_name, p.last_name].filter(Boolean).join(" ").trim();
  return n || (p.file_name ? `Unnamed · ${p.file_name}` : "Unnamed candidate");
}

export function initials(p: { first_name?: string | null; last_name?: string | null }) {
  const s = `${p.first_name?.[0] ?? ""}${p.last_name?.[0] ?? ""}`.toUpperCase();
  return s || "?";
}
