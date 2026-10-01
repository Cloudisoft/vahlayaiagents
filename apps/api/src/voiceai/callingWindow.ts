// Calling windows (playbook §3, §11): days + hours in the campaign's time
// zone, or — for B2B — in each lead's local time zone, optionally skipping
// a lunch hour.

export interface CallingWindow {
  days: number[]; // 0 = Sunday … 6 = Saturday
  start: string; // "09:00"
  end: string; // "18:00"
  useLeadTimeZone: boolean;
  lunchBreak: { start: string; end: string } | null;
}

export const DEFAULT_WINDOW: CallingWindow = {
  days: [1, 2, 3, 4, 5],
  start: "09:00",
  end: "18:00",
  useLeadTimeZone: true,
  lunchBreak: null,
};

const STATE_TZ: Record<string, string> = {
  AL: "America/Chicago", AK: "America/Anchorage", AZ: "America/Phoenix", AR: "America/Chicago",
  CA: "America/Los_Angeles", CO: "America/Denver", CT: "America/New_York", DE: "America/New_York",
  DC: "America/New_York", FL: "America/New_York", GA: "America/New_York", HI: "Pacific/Honolulu",
  ID: "America/Boise", IL: "America/Chicago", IN: "America/Indiana/Indianapolis", IA: "America/Chicago",
  KS: "America/Chicago", KY: "America/New_York", LA: "America/Chicago", ME: "America/New_York",
  MD: "America/New_York", MA: "America/New_York", MI: "America/Detroit", MN: "America/Chicago",
  MS: "America/Chicago", MO: "America/Chicago", MT: "America/Denver", NE: "America/Chicago",
  NV: "America/Los_Angeles", NH: "America/New_York", NJ: "America/New_York", NM: "America/Denver",
  NY: "America/New_York", NC: "America/New_York", ND: "America/Chicago", OH: "America/New_York",
  OK: "America/Chicago", OR: "America/Los_Angeles", PA: "America/New_York", RI: "America/New_York",
  SC: "America/New_York", SD: "America/Chicago", TN: "America/Chicago", TX: "America/Chicago",
  UT: "America/Denver", VT: "America/New_York", VA: "America/New_York", WA: "America/Los_Angeles",
  WV: "America/New_York", WI: "America/Chicago", WY: "America/Denver", PR: "America/Puerto_Rico",
};

const STATE_NAMES: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO",
  connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID",
  illinois: "IL", indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY", louisiana: "LA",
  maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN",
  mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV",
  "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
  "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR",
  pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC", "south dakota": "SD",
  tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT", virginia: "VA", washington: "WA",
  "west virginia": "WV", wisconsin: "WI", wyoming: "WY", "district of columbia": "DC",
};

export function timeZoneForState(state: string | null | undefined): string | null {
  if (!state) return null;
  const s = state.trim();
  const code = s.length === 2 ? s.toUpperCase() : STATE_NAMES[s.toLowerCase()];
  return code ? STATE_TZ[code] ?? null : null;
}

export function parseWindow(raw: unknown): CallingWindow {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<CallingWindow>;
  return {
    days: Array.isArray(r.days) && r.days.length > 0 ? r.days : DEFAULT_WINDOW.days,
    start: typeof r.start === "string" ? r.start : DEFAULT_WINDOW.start,
    end: typeof r.end === "string" ? r.end : DEFAULT_WINDOW.end,
    useLeadTimeZone: typeof r.useLeadTimeZone === "boolean" ? r.useLeadTimeZone : DEFAULT_WINDOW.useLeadTimeZone,
    lunchBreak: r.lunchBreak ?? null,
  };
}

function minutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + (m || 0);
}

function localParts(now: Date, timeZone: string): { day: number; minuteOfDay: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "0";
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  const hour = Number(get("hour")) % 24;
  return { day, minuteOfDay: hour * 60 + Number(get("minute")) };
}

export function resolveTimeZone(window: CallingWindow, campaignTz: string, lead: { time_zone?: string | null; state?: string | null }): string {
  if (!window.useLeadTimeZone) return campaignTz;
  return lead.time_zone || timeZoneForState(lead.state) || campaignTz;
}

export function isWithinWindow(window: CallingWindow, timeZone: string, now: Date = new Date()): boolean {
  const { day, minuteOfDay } = localParts(now, timeZone);
  if (!window.days.includes(day)) return false;
  if (minuteOfDay < minutes(window.start) || minuteOfDay >= minutes(window.end)) return false;
  if (window.lunchBreak && minuteOfDay >= minutes(window.lunchBreak.start) && minuteOfDay < minutes(window.lunchBreak.end)) {
    return false;
  }
  return true;
}

function offsetMinutes(at: Date, timeZone: string): number {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const n = (t: string) => Number(p.find((x) => x.type === t)?.value);
  return (Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second")) - at.getTime()) / 60_000;
}

// "2026-10-02T14:30" in America/Chicago -> the matching UTC instant.
export function zonedLocalToUtc(local: string, timeZone: string): Date | null {
  const m = local.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (!m) return null;
  const guess = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]));
  const first = new Date(guess.getTime() - offsetMinutes(guess, timeZone) * 60_000);
  // Re-check once so DST transitions land on the right side.
  return new Date(guess.getTime() - offsetMinutes(first, timeZone) * 60_000);
}
