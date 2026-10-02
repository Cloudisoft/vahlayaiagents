import { useEffect, useRef } from "react";
import { getAccessToken } from "./api.js";
import { useAuth } from "../context/AuthContext.js";

export interface RealtimeEvent {
  type: string;
  callId?: string;
  campaignId?: string;
  [key: string]: unknown;
}

// One org event socket per subscriber, reconnecting with backoff so the
// Live Monitor recovers from API restarts and network blips.
export function useOrgEvents(onEvent: (e: RealtimeEvent) => void) {
  const handler = useRef(onEvent);
  handler.current = onEvent;

  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      const token = getAccessToken();
      if (!token || closed) {
        timer = setTimeout(connect, 1000);
        return;
      }
      const proto = window.location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${window.location.host}/ws?token=${encodeURIComponent(token)}`);
      ws.onopen = () => {
        attempt = 0;
        handler.current({ type: "connected" });
      };
      ws.onmessage = (m) => {
        try {
          handler.current(JSON.parse(m.data));
        } catch {
          // ignore non-JSON frames
        }
      };
      ws.onclose = () => {
        if (closed) return;
        handler.current({ type: "disconnected" });
        attempt++;
        timer = setTimeout(connect, Math.min(15000, 500 * 2 ** attempt));
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(timer);
      ws?.close();
    };
  }, []);
}

export function useCan() {
  const { user } = useAuth();
  return (permission: string) => Boolean(user?.permissions?.includes(permission));
}

const COLOR_CLASSES: Record<string, string> = {
  red: "bg-red-100 text-red-700 border-red-200",
  orange: "bg-orange-100 text-orange-700 border-orange-200",
  amber: "bg-amber-100 text-amber-800 border-amber-200",
  yellow: "bg-yellow-100 text-yellow-800 border-yellow-200",
  green: "bg-green-100 text-green-700 border-green-200",
  emerald: "bg-emerald-100 text-emerald-700 border-emerald-200",
  teal: "bg-teal-100 text-teal-700 border-teal-200",
  blue: "bg-blue-100 text-blue-700 border-blue-200",
  indigo: "bg-indigo-100 text-indigo-700 border-indigo-200",
  purple: "bg-purple-100 text-purple-700 border-purple-200",
  pink: "bg-pink-100 text-pink-700 border-pink-200",
  slate: "bg-slate-100 text-slate-700 border-slate-200",
  gray: "bg-slate-100 text-slate-700 border-slate-200",
};

export function DispositionBadge({
  label,
  color,
  manual,
  code,
}: {
  label: string | null;
  color?: string | null;
  manual?: boolean;
  code?: string | null;
}) {
  if (!label && !code) return <span className="text-slate-400">—</span>;
  const cls = COLOR_CLASSES[color ?? "slate"] ?? COLOR_CLASSES.slate;
  return (
    <span title={label ?? undefined} className={`inline-flex items-center gap-1 text-xs font-medium border rounded-full px-2 py-0.5 ${cls}`}>
      {code && <span className="font-semibold">{code}</span>}
      {code && label && label !== code && <span className="opacity-80">· {label}</span>}
      {!code && label}
      {manual && <span title="Set manually">✎</span>}
    </span>
  );
}

const STATUS_CLASSES: Record<string, string> = {
  draft: "bg-slate-100 text-slate-600",
  active: "bg-green-100 text-green-700",
  scheduled: "bg-blue-100 text-blue-700",
  paused: "bg-amber-100 text-amber-800",
  stopped: "bg-red-100 text-red-700",
  completed: "bg-slate-200 text-slate-700",
};

export function StatusPill({ status }: { status: string }) {
  return <span className={`text-xs font-medium rounded-full px-2 py-0.5 ${STATUS_CLASSES[status] ?? "bg-slate-100 text-slate-600"}`}>{status}</span>;
}

export function formatSeconds(s: number | null | undefined): string {
  if (s == null) return "—";
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.round(s % 60)).padStart(2, "0")}`;
}

export function formatPhone(e164: string | null | undefined): string {
  if (!e164) return "—";
  const m = e164.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}

export const inputCls = "w-full border border-slate-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-200";
export const btnPrimary = "bg-red-600 text-white text-sm font-medium rounded-md px-4 py-2 hover:bg-red-700 disabled:opacity-50";
export const btnDark = "bg-slate-900 text-white text-sm font-medium rounded-md px-4 py-2 hover:bg-slate-800 disabled:opacity-50";
export const btnGhost = "border border-slate-300 text-slate-700 text-sm font-medium rounded-md px-3 py-2 hover:bg-slate-50 disabled:opacity-50";
