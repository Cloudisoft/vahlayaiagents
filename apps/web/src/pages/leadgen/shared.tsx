import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { getAccessToken, refreshSession } from "../../lib/api.js";
import { I, Icon } from "../../components/ui.js";

export interface Meta {
  industries: Array<{ key: string; label: string; group: string }>;
  opportunities: Array<{ key: string; label: string }>;
  sources: Array<{ key: string; label: string; attribution: string | null; available: boolean }>;
}

export interface Job {
  id: string;
  name: string;
  status: "queued" | "running" | "enriching" | "completed" | "partial" | "failed" | "cancelled";
  criteria: any;
  sources: string[];
  max_results: number;
  counts: { tasks?: { open: number; done: number; failed: number; skipped: number; total: number }; leads?: number; new?: number; merged?: number; enriched?: number; scored?: number; qualified?: number; pending?: number; failedLeads?: number };
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  lead_list_id: string | null;
}

export const JOB_TONE: Record<string, string> = {
  queued: "bg-slate-100 text-slate-600",
  running: "bg-sky-50 text-sky-700",
  enriching: "bg-violet-50 text-violet-700",
  completed: "bg-green-100 text-green-700",
  partial: "bg-amber-100 text-amber-800",
  failed: "bg-red-100 text-red-700",
  cancelled: "bg-slate-200 text-slate-500",
};
export const JOB_LABEL: Record<string, string> = { queued: "Queued", running: "Discovering", enriching: "Enriching & scoring", completed: "Completed", partial: "Completed with errors", failed: "Failed", cancelled: "Cancelled" };

export const STATUS_TONE: Record<string, string> = { qualified: "bg-green-100 text-green-700", needs_review: "bg-amber-100 text-amber-700", disqualified: "bg-slate-100 text-slate-500" };
export const STATUS_LABEL: Record<string, string> = { qualified: "Qualified", needs_review: "Needs review", disqualified: "Not a fit" };
export const SITE_TONE: Record<string, string> = { none: "bg-red-50 text-red-700", unreachable: "bg-red-50 text-red-700", weak: "bg-amber-50 text-amber-700", ok: "bg-green-50 text-green-700" };
export const SITE_LABEL: Record<string, string> = { none: "No website", unreachable: "Site down", weak: "Weak site", ok: "Good site" };
export const SOURCE_LABEL: Record<string, string> = { google_places: "Google Places", osm: "OpenStreetMap", website: "Company website", manual: "Entered manually", import: "Import", unknown: "Unknown" };

export function Pill({ tone, children, title }: { tone: string; children: ReactNode; title?: string }) {
  return <span title={title} className={`inline-flex items-center gap-1 text-[11px] font-medium rounded-full px-2 py-0.5 whitespace-nowrap ${tone}`}>{children}</span>;
}

export function Progress({ value, tone = "bg-red-500", className = "" }: { value: number; tone?: string; className?: string }) {
  return (
    <div className={`h-1.5 rounded-full bg-slate-100 overflow-hidden ${className}`}>
      <div className={`h-full rounded-full ${tone} transition-[width] duration-500`} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  );
}

export function Drawer({ onClose, children, title }: { onClose: () => void; children: ReactNode; title: ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return createPortal(
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-slate-900/30 animate-fade-in" onClick={onClose} />
      <aside className="absolute right-0 top-0 h-full w-full max-w-2xl bg-slate-50 shadow-2xl animate-slide-in-right flex flex-col">
        <div className="flex items-start justify-between gap-3 px-5 py-4 bg-white border-b border-slate-200">
          <div className="min-w-0">{title}</div>
          <button type="button" onClick={onClose} className="p-1 rounded-md text-slate-400 hover:text-slate-700 hover:bg-slate-100" aria-label="Close"><Icon d={I.x} /></button>
        </div>
        <div className="flex-1 overflow-y-auto p-5 space-y-4">{children}</div>
      </aside>
    </div>,
    document.body
  );
}

// POST that returns a file (export) or GET download, with the session token.
export async function downloadFile(path: string, name: string, body?: unknown) {
  const send = () =>
    fetch(path, {
      method: body ? "POST" : "GET",
      credentials: "include",
      headers: { Authorization: `Bearer ${getAccessToken()}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  let r = await send();
  if (r.status === 401 && (await refreshSession())) r = await send();
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Download failed.");
  const url = URL.createObjectURL(await r.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export const locLabel = (l: { zip?: string; city?: string; state?: string; country?: string }) => [l.zip, l.city, l.state, l.country && l.country !== "US" ? l.country : null].filter(Boolean).join(", ");
