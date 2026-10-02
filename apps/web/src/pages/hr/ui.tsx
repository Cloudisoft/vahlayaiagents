import { useEffect, type ReactNode } from "react";
import { getAccessToken, refreshSession } from "../../lib/api.js";

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

export function Icon({ d, className = "", size = 18 }: { d: string; className?: string; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d={d} />
    </svg>
  );
}
export const I = {
  plus: "M12 5v14M5 12h14",
  users: "M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8zM23 21v-2a4 4 0 00-3-3.9M16 3.1a4 4 0 010 7.8",
  brief: "M20 7H4a2 2 0 00-2 2v10a2 2 0 002 2h16a2 2 0 002-2V9a2 2 0 00-2-2zM16 21V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v16",
  star: "M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z",
  phone: "M22 16.9v3a2 2 0 01-2.2 2 19.8 19.8 0 01-8.6-3.1 19.5 19.5 0 01-6-6A19.8 19.8 0 012.1 4.2 2 2 0 014.1 2h3a2 2 0 012 1.7c.1.9.4 1.8.7 2.7a2 2 0 01-.5 2.1L8 9.8a16 16 0 006 6l1.3-1.3a2 2 0 012.1-.4c.9.3 1.8.6 2.7.7a2 2 0 011.7 2z",
  mail: "M4 4h16a2 2 0 012 2v12a2 2 0 01-2 2H4a2 2 0 01-2-2V6a2 2 0 012-2zM22 6l-10 7L2 6",
  sms: "M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z",
  cal: "M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2V6a2 2 0 012-2z",
  upload: "M16 16l-4-4-4 4m4-4v9M20.4 18.4A5 5 0 0018 9h-1.3A8 8 0 103 16.3",
  file: "M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8zM14 2v6h6",
  check: "M20 6L9 17l-5-5",
  x: "M18 6L6 18M6 6l12 12",
  retry: "M1 4v6h6M3.5 15a9 9 0 102.1-9.4L1 10",
  spark: "M12 3l1.9 5.8L20 10l-6.1 1.2L12 17l-1.9-5.8L4 10l6.1-1.2z",
  gear: "M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z",
  link: "M10 13a5 5 0 007.5.5l3-3a5 5 0 00-7-7l-1.7 1.7M14 11a5 5 0 00-7.5-.5l-3 3a5 5 0 007 7l1.7-1.7",
  copy: "M20 9h-9a2 2 0 00-2 2v9a2 2 0 002 2h9a2 2 0 002-2v-9a2 2 0 00-2-2zM5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1",
  clock: "M12 8v4l3 2M21 12a9 9 0 11-18 0 9 9 0 0118 0z",
  alert: "M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0zM12 9v4m0 4h.01",
  download: "M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3",
  search: "M21 21l-4.3-4.3M11 18a7 7 0 100-14 7 7 0 000 14z",
  trash: "M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6",
  shield: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z",
  globe: "M12 22a10 10 0 100-20 10 10 0 000 20zM2 12h20M12 2a15 15 0 010 20M12 2a15 15 0 000 20",
  mic: "M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3zM19 10v2a7 7 0 01-14 0v-2M12 19v4",
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

export const scoreTone = (n: number | null | undefined) => (n == null ? "text-slate-400" : n >= 75 ? "text-green-600" : n >= 55 ? "text-amber-500" : "text-red-600");
export const barTone = (n: number) => (n >= 75 ? "bg-green-500" : n >= 55 ? "bg-amber-400" : "bg-red-500");

export function ScoreBar({ value, className = "" }: { value: number | null | undefined; className?: string }) {
  if (value == null) return <span className="text-xs text-slate-400">—</span>;
  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <div className="h-1.5 flex-1 rounded-full bg-slate-100 overflow-hidden min-w-[48px]">
        <div className={`h-full rounded-full ${barTone(value)} transition-[width] duration-500`} style={{ width: `${value}%` }} />
      </div>
      <span className={`text-xs font-semibold tabular-nums w-7 text-right ${scoreTone(value)}`}>{value}</span>
    </div>
  );
}

export function ScoreRing({ value, label, size = 96 }: { value: number | null | undefined; label?: string; size?: number }) {
  const r = 42;
  const c = 2 * Math.PI * r;
  const v = value ?? 0;
  const stroke = value == null ? "#cbd5e1" : v >= 75 ? "#16a34a" : v >= 55 ? "#f59e0b" : "#dc2626";
  return (
    <div className="inline-flex flex-col items-center">
      <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
        <svg viewBox="0 0 100 100" width={size} height={size} className="-rotate-90">
          <circle cx="50" cy="50" r={r} stroke="#f1f5f9" strokeWidth="9" fill="none" />
          <circle cx="50" cy="50" r={r} stroke={stroke} strokeWidth="9" fill="none" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c - (c * v) / 100} style={{ transition: "stroke-dashoffset 700ms cubic-bezier(.2,.7,.2,1)" }} />
        </svg>
        <div className={`absolute font-bold tabular-nums ${size > 80 ? "text-2xl" : "text-xl"} ${scoreTone(value)}`}>{value ?? "—"}</div>
      </div>
      {label && <div className="text-[10px] uppercase tracking-wide text-slate-400 mt-1">{label}</div>}
    </div>
  );
}

export function Quote({ text, tone = "slate" }: { text: string; tone?: "slate" | "green" | "red" }) {
  const t = tone === "green" ? "border-green-300 bg-green-50/60" : tone === "red" ? "border-red-300 bg-red-50/60" : "border-slate-300 bg-slate-50";
  return <div className={`text-xs italic text-slate-600 border-l-2 ${t} pl-2 py-0.5 rounded-r`}>“{text}”</div>;
}

export function StatCard({ label, value, icon, tone = "", hint }: { label: string; value: ReactNode; icon: string; tone?: string; hint?: string }) {
  return (
    <div className="bg-white border border-slate-200 rounded-2xl p-4 flex items-start justify-between transition-shadow hover:shadow-sm">
      <div>
        <div className="text-sm text-slate-500">{label}</div>
        <div className={`text-2xl font-bold mt-1 tabular-nums ${tone}`}>{value}</div>
        {hint && <div className="text-xs text-slate-400 mt-0.5">{hint}</div>}
      </div>
      <span className="rounded-lg bg-slate-100 p-1.5 text-slate-500"><Icon d={icon} /></span>
    </div>
  );
}

export function Card({ title, action, children, className = "" }: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`bg-white border border-slate-200 rounded-2xl ${className}`}>
      {(title || action) && (
        <div className="flex items-center justify-between gap-2 px-5 pt-4">
          <h3 className="font-semibold text-slate-900">{title}</h3>
          {action}
        </div>
      )}
      <div className="p-5 pt-3">{children}</div>
    </section>
  );
}

export function Modal({ title, onClose, children, wide = false }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-start sm:items-center justify-center p-4 overflow-y-auto">
      <div className="fixed inset-0 bg-slate-900/40 animate-fade-in" onClick={onClose} />
      <div className={`relative w-full ${wide ? "max-w-3xl" : "max-w-lg"} bg-white rounded-2xl shadow-xl animate-pop-in my-8 max-h-[calc(100vh-4rem)] flex flex-col`}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
          <h3 className="font-semibold text-slate-900">{title}</h3>
          <button type="button" onClick={onClose} className="p-1 rounded-md text-slate-400 hover:text-slate-700 hover:bg-slate-100" aria-label="Close"><Icon d={I.x} /></button>
        </div>
        <div className="p-5 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}

export function Btn({ children, onClick, kind = "secondary", disabled, type = "button", className = "", title }: { children: ReactNode; onClick?: () => void; kind?: "primary" | "secondary" | "danger" | "ghost"; disabled?: boolean; type?: "button" | "submit"; className?: string; title?: string }) {
  const k =
    kind === "primary" ? "bg-red-600 text-white hover:bg-red-700 shadow-sm"
    : kind === "danger" ? "bg-white text-red-600 border border-red-200 hover:bg-red-50"
    : kind === "ghost" ? "text-slate-600 hover:bg-slate-100"
    : "bg-white text-slate-700 border border-slate-200 hover:bg-slate-50";
  return (
    <button type={type} onClick={onClick} disabled={disabled} title={title} className={`inline-flex items-center justify-center gap-1.5 text-sm font-medium rounded-lg px-3 py-1.5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${k} ${className}`}>
      {children}
    </button>
  );
}

export const inputCls = "w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-100 focus:border-red-300 bg-white";

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-slate-600">{label}</span>
      <div className="mt-1">{children}</div>
      {hint && <span className="text-[11px] text-slate-400">{hint}</span>}
    </label>
  );
}

export function Banner({ kind, children, onClose }: { kind: "error" | "ok" | "info"; children: ReactNode; onClose?: () => void }) {
  const k = kind === "error" ? "bg-red-50 border-red-200 text-red-700" : kind === "ok" ? "bg-green-50 border-green-200 text-green-700" : "bg-sky-50 border-sky-200 text-sky-800";
  return (
    <div className={`border rounded-xl px-4 py-2.5 text-sm flex items-start justify-between gap-3 animate-fade-in ${k}`}>
      <div>{children}</div>
      {onClose && <button type="button" onClick={onClose} className="opacity-60 hover:opacity-100"><Icon d={I.x} size={16} /></button>}
    </div>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`rounded-lg bg-gradient-to-r from-slate-100 via-slate-50 to-slate-100 bg-[length:200%_100%] animate-shimmer ${className}`} />;
}

export function Empty({ icon, title, children }: { icon: string; title: string; children?: ReactNode }) {
  return (
    <div className="text-center py-10">
      <div className="mx-auto w-11 h-11 rounded-xl bg-red-50 text-red-600 flex items-center justify-center"><Icon d={icon} size={22} /></div>
      <div className="mt-3 font-medium text-slate-800">{title}</div>
      {children && <div className="mt-1 text-sm text-slate-500 max-w-md mx-auto">{children}</div>}
    </div>
  );
}

export function personName(p: { first_name?: string | null; last_name?: string | null; file_name?: string | null }) {
  const n = [p.first_name, p.last_name].filter(Boolean).join(" ").trim();
  return n || (p.file_name ? `Unnamed · ${p.file_name}` : "Unnamed candidate");
}

export function initials(p: { first_name?: string | null; last_name?: string | null }) {
  const s = `${p.first_name?.[0] ?? ""}${p.last_name?.[0] ?? ""}`.toUpperCase();
  return s || "?";
}

export const ago = (iso: string | null | undefined) => {
  if (!iso) return "—";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
};

export const when = (iso: string | null | undefined, tz?: string | null) =>
  iso ? new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: tz ?? undefined, timeZoneName: "short" }).format(new Date(iso)) : "—";

// Multipart upload with progress (fetch can't report upload progress).
export function uploadFiles(url: string, form: FormData, onProgress: (pct: number) => void): Promise<any> {
  const go = () =>
    new Promise<{ status: number; body: any }>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", url);
      xhr.withCredentials = true;
      xhr.setRequestHeader("Authorization", `Bearer ${getAccessToken()}`);
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100));
      xhr.onload = () => {
        let body: any = {};
        try {
          body = JSON.parse(xhr.responseText);
        } catch {
          // non-JSON error page
        }
        resolve({ status: xhr.status, body });
      };
      xhr.onerror = () => reject(new Error("Network error during upload."));
      xhr.send(form);
    });
  return go().then(async (r) => {
    if (r.status === 401 && (await refreshSession())) r = await go();
    if (r.status >= 400) throw new Error(r.body.error ?? "Upload failed.");
    return r.body;
  });
}

export function copyText(text: string) {
  return navigator.clipboard?.writeText(text).catch(() => undefined);
}
