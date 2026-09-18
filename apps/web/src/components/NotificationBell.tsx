import { useEffect, useState } from "react";
import { api } from "../lib/api.js";

interface Notification {
  id: string;
  type: string;
  title: string;
  body: string | null;
  read_at: string | null;
  created_at: string;
}

export default function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);

  async function load() {
    const { notifications, unreadCount } = await api<{ notifications: Notification[]; unreadCount: number }>(
      "/notifications"
    );
    setNotifications(notifications);
    setUnreadCount(unreadCount);
  }

  useEffect(() => {
    load();
    const interval = setInterval(load, 20000);
    return () => clearInterval(interval);
  }, []);

  async function markAllRead() {
    await api("/notifications/read-all", { method: "POST" });
    await load();
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="relative text-sm text-slate-600 hover:text-slate-900 px-2 py-1"
      >
        Notifications
        {unreadCount > 0 && (
          <span className="absolute -top-1 -right-1 bg-red-500 text-white text-[10px] rounded-full w-4 h-4 flex items-center justify-center">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute bottom-full left-0 mb-2 w-72 bg-white border border-slate-200 rounded-lg shadow-lg z-10 max-h-80 overflow-y-auto">
          <div className="flex items-center justify-between px-3 py-2 border-b border-slate-100">
            <span className="text-xs font-medium text-slate-500 uppercase">Notifications</span>
            {unreadCount > 0 && (
              <button onClick={markAllRead} className="text-xs text-indigo-600 hover:underline">
                Mark all read
              </button>
            )}
          </div>
          {notifications.length === 0 ? (
            <div className="p-4 text-sm text-slate-500 text-center">No notifications yet.</div>
          ) : (
            notifications.map((n) => (
              <div key={n.id} className={`px-3 py-2 border-b border-slate-50 text-sm ${n.read_at ? "" : "bg-indigo-50"}`}>
                <div className="font-medium text-slate-900">{n.title}</div>
                {n.body && <div className="text-xs text-slate-500">{n.body}</div>}
                <div className="text-[10px] text-slate-400">{new Date(n.created_at).toLocaleString()}</div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
