import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";

interface Info {
  firstName: string | null;
  jobTitle: string;
  company: string;
  durationMinutes: number;
  phoneLast4: string | null;
  status: string;
  scheduledAt: string | null;
  timeZone: string | null;
  hiringTimeZone: string;
  slotMinutes: number;
  slots: string[];
}

const localZone = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "America/New_York";
  } catch {
    return "America/New_York";
  }
})();
const ZONES: string[] = (() => {
  try {
    const all = (Intl as unknown as { supportedValuesOf: (k: string) => string[] }).supportedValuesOf("timeZone");
    return all.includes(localZone) ? all : [localZone, ...all];
  } catch {
    return [localZone];
  }
})();

const fmt = (iso: string, tz: string, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(undefined, { ...o, timeZone: tz }).format(new Date(iso));

// Public page a candidate opens from their invitation to pick (or move) their
// AI phone interview time. Times are shown in the candidate's own zone.
export default function InterviewSchedule() {
  const { token } = useParams();
  const [info, setInfo] = useState<Info | null>(null);
  const [missing, setMissing] = useState<string | null>(null);
  const [tz, setTz] = useState(localZone);
  const [day, setDay] = useState<string | null>(null);
  const [slot, setSlot] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [changing, setChanging] = useState(false);

  const load = () =>
    fetch(`/api/public/hr/interview/${token}`)
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error);
        setInfo(d);
      })
      .catch((e) => setMissing(e.message || "This link is not valid."));
  useEffect(() => {
    load();
    document.title = "Schedule your interview";
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  const days = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const s of info?.slots ?? []) {
      const k = fmt(s, tz, { year: "numeric", month: "2-digit", day: "2-digit" });
      m.set(k, [...(m.get(k) ?? []), s]);
    }
    return Array.from(m.entries());
  }, [info, tz]);
  useEffect(() => {
    if (days.length && (!day || !days.some(([k]) => k === day))) setDay(days[0][0]);
  }, [days, day]);

  async function book() {
    if (!slot) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/api/public/hr/interview/${token}/book`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slot, timeZone: tz }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Couldn't book that time.");
      setSlot(null);
      setChanging(false);
      await load();
    } catch (e) {
      setErr((e as Error).message);
      await load();
    } finally {
      setBusy(false);
    }
  }

  const shell = (children: React.ReactNode) => (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-white py-10 px-4">
      <div className="max-w-xl mx-auto animate-page-in">{children}</div>
    </div>
  );

  if (missing) return shell(<div className="bg-white border border-slate-200 rounded-2xl p-8 text-center text-slate-600">{missing}</div>);
  if (!info) return shell(<div className="space-y-3"><div className="h-8 w-2/3 rounded-lg bg-slate-200 animate-pulse" /><div className="h-64 rounded-2xl bg-slate-200/70 animate-pulse" /></div>);

  const booked = info.status === "scheduled" && info.scheduledAt;
  const done = info.status === "completed_or_in_progress";
  const daySlots = days.find(([k]) => k === day)?.[1] ?? [];

  return shell(
    <>
      <div className="text-sm font-medium text-red-600">{info.company}</div>
      <h1 className="text-2xl font-semibold text-slate-900 mt-1">{info.firstName ? `Hi ${info.firstName}, ` : ""}let's find a time to talk</h1>
      <p className="text-sm text-slate-600 mt-2">
        A short AI-assisted phone interview for <b>{info.jobTitle}</b> — about {info.durationMinutes} minutes. At the time you choose, our AI interviewer will call you{info.phoneLast4 ? <> on the number ending <b>{info.phoneLast4}</b></> : null}, ask a few questions about your experience, and the hiring team will review your answers. The call is recorded for the hiring team.
      </p>

      {done ? (
        <div className="mt-6 bg-white border border-slate-200 rounded-2xl p-6 text-center">
          <div className="text-lg font-semibold text-slate-900">Thanks — your interview has taken place.</div>
          <p className="text-sm text-slate-500 mt-1">The hiring team will be in touch.</p>
        </div>
      ) : booked && !changing ? (
        <div className="mt-6 bg-white border border-green-200 rounded-2xl p-6 animate-pop-in">
          <div className="text-xs uppercase tracking-wide text-green-700 font-semibold">You're booked</div>
          <div className="text-xl font-semibold text-slate-900 mt-1">{fmt(info.scheduledAt!, info.timeZone ?? tz, { weekday: "long", month: "long", day: "numeric" })}</div>
          <div className="text-lg text-slate-700">{fmt(info.scheduledAt!, info.timeZone ?? tz, { hour: "numeric", minute: "2-digit", timeZoneName: "short" })}</div>
          <p className="text-sm text-slate-500 mt-3">We've emailed you a confirmation and will remind you before the call. Please keep your phone nearby.</p>
          <button type="button" onClick={() => setChanging(true)} className="mt-4 text-sm text-red-600 hover:underline">Need a different time?</button>
        </div>
      ) : (
        <div className="mt-6 bg-white border border-slate-200 rounded-2xl p-5">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
            <div className="font-semibold text-slate-900">{booked ? "Choose a new time" : "Choose a time"}</div>
            <select value={tz} onChange={(e) => setTz(e.target.value)} className="text-xs border border-slate-200 rounded-lg px-2 py-1 max-w-[220px]">
              {ZONES.map((z) => <option key={z} value={z}>{z.replace(/_/g, " ")}</option>)}
            </select>
          </div>
          {err && <div className="mb-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{err}</div>}
          {!days.length ? (
            <p className="text-sm text-slate-500">There are no open times right now. Please reply to the invitation email and we'll find one with you.</p>
          ) : (
            <>
              <div className="flex gap-2 overflow-x-auto pb-2 -mx-1 px-1">
                {days.map(([k, s]) => (
                  <button key={k} type="button" onClick={() => { setDay(k); setSlot(null); }} className={`shrink-0 rounded-xl border px-3 py-2 text-center transition-colors ${day === k ? "border-red-500 bg-red-50" : "border-slate-200 hover:border-slate-300"}`}>
                    <div className="text-[11px] uppercase text-slate-500">{fmt(s[0], tz, { weekday: "short" })}</div>
                    <div className="text-lg font-semibold text-slate-900 leading-tight">{fmt(s[0], tz, { day: "numeric" })}</div>
                    <div className="text-[11px] text-slate-500">{fmt(s[0], tz, { month: "short" })}</div>
                  </button>
                ))}
              </div>
              <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 mt-3">
                {daySlots.map((s) => (
                  <button key={s} type="button" onClick={() => setSlot(s)} className={`rounded-lg border text-sm py-2 transition-colors ${slot === s ? "bg-red-600 border-red-600 text-white" : "border-slate-200 hover:border-red-300"}`}>
                    {fmt(s, tz, { hour: "numeric", minute: "2-digit" })}
                  </button>
                ))}
              </div>
              <div className="flex items-center justify-between gap-3 mt-5">
                <span className="text-sm text-slate-600">{slot ? fmt(slot, tz, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }) : "No time selected"}</span>
                <div className="flex gap-2">
                  {changing && <button type="button" onClick={() => setChanging(false)} className="text-sm text-slate-500 px-3">Back</button>}
                  <button type="button" disabled={!slot || busy} onClick={book} className="bg-red-600 text-white text-sm font-medium rounded-lg px-5 py-2 hover:bg-red-700 disabled:opacity-50">{busy ? "Booking…" : "Confirm"}</button>
                </div>
              </div>
            </>
          )}
        </div>
      )}
      <p className="text-[11px] text-slate-400 mt-6 text-center">This link is personal to you. Please don't share it.</p>
    </>
  );
}
