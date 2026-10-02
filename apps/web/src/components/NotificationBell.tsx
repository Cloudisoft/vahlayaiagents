import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api.js";
import { useOrgEvents } from "../lib/voice.js";

interface Notification {
  id: string;
  type: string;
  title: string;
  body: string | null;
  read_at: string | null;
  created_at: string;
  metadata?: { link?: string } | null;
}

function timeAgo(iso: string) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

export default function NotificationBell() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [error, setError] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const r = await api<{ notifications: Notification[]; unreadCount: number }>("/notifications");
      setNotifications(r.notifications);
      setUnreadCount(r.unreadCount);
      setError(false);
    } catch {
      setError(true);
    }
  }, []);

  useEffect(() => {
    load();
    // Live pushes cover most updates; this is the safety net.
    const interval = setInterval(load, 60000);
    return () => clearInterval(interval);
  }, [load]);

  useOrgEvents((e) => {
    if (e.type === "notification" && e.notification) {
      const n = e.notification as Notification & { link?: string | null };
      setNotifications((prev) => [{ ...n, read_at: null, metadata: { link: n.link ?? undefined } }, ...prev.filter((x) => x.id !== n.id)].slice(0, 50));
      setUnreadCount((c) => c + 1);
    } else if (e.type === "connected") {
      load();
    }
  });

  // Close on outside click or Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (ev: MouseEvent) => {
      if (ref.current && !ref.current.contains(ev.target as Node)) setOpen(false);
    };
    const onKey = (ev: KeyboardEvent) => ev.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function markAllRead() {
    setNotifications((prev) => prev.map((n) => ({ ...n, read_at: n.read_at ?? new Date().toISOString() })));
    setUnreadCount(0);
    await api("/notifications/read-all", { method: "POST" }).catch(load);
  }

  async function openOne(n: Notification) {
    if (!n.read_at) {
      setNotifications((prev) => prev.map((x) => (x.id === n.id ? { ...x, read_at: new Date().toISOString() } : x)));
      setUnreadCount((c) => Math.max(0, c - 1));
      api(`/notifications/${n.id}/read`, { method: "POST" }).catch(() => undefined);
    }
    const link = n.metadata?.link;
    if (link) {
      setOpen(false);
      navigate(link);
    }
  }

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => {
          setOpen((o) => !o);
          if (!open) load();
        }}
        aria-haspopup="true"
        aria-expanded={open}
        className="relative text-sm text-slate-600 hover:text-slate-900 px-2 py-1"
      >
        Notifications
        {unreadCount > 0 && (
          <span className="absolute -top-1 -right-1 bg-red-500 text-white text-[10px] rounded-full min-w-4 h-4 px-1 flex items-center justify-center animate-pop-in">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute top-full right-0 mt-2 w-80 bg-white border border-slate-200 rounded-xl shadow-xl z-50 max-h-[28rem] overflow-y-auto animate-pop-in origin-top-right">
          <div className="sticky top-0 bg-white flex items-center justify-between px-3 py-2 border-b border-slate-100">
            <span className="text-xs font-medium text-slate-500 uppercase">Notifications</span>
            {unreadCount > 0 && (
              <button onClick={markAllRead} className="text-xs text-red-600 hover:underline">
                Mark all read
              </button>
            )}
          </div>
          {error && notifications.length === 0 ? (
            <div className="p-4 text-sm text-slate-500 text-center">
              Couldn't load notifications. <button onClick={load} className="text-red-600 hover:underline">Retry</button>
            </div>
          ) : notifications.length === 0 ? (
            <div className="p-4 text-sm text-slate-500 text-center">No notifications yet.</div>
          ) : (
            notifications.map((n) => (
              <button
                key={n.id}
                onClick={() => openOne(n)}
                className={`block w-full text-left px-3 py-2 border-b border-slate-50 text-sm hover:bg-slate-50 ${n.read_at ? "" : "bg-red-50/60"}`}
              >
                <div className="flex items-start gap-2">
                  {!n.read_at && <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-red-500" />}
                  <div className="min-w-0">
                    <div className="font-medium text-slate-900">{n.title}</div>
                    {n.body && <div className="text-xs text-slate-500 break-words">{n.body}</div>}
                    <div className="text-[10px] text-slate-400 mt-0.5">{timeAgo(n.created_at)}</div>
                  </div>
                </div>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
