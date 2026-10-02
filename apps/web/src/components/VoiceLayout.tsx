import { useEffect, useState, type ReactNode } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { api } from "../lib/api.js";
import { useOrgEvents } from "../lib/voice.js";

interface NavItem {
  to: string;
  label: string;
  icon: string;
  end?: boolean;
}

const SECTIONS: Array<{ title: string; items: NavItem[] }> = [
  {
    title: "Operate",
    items: [
      { to: "/voice", label: "Dashboard", icon: "M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z", end: true },
      { to: "/voice/campaigns", label: "Campaigns", icon: "M3 11l18-8v18L3 13v-2zm4 3v5h3v-4" },
      { to: "/voice/callbacks", label: "Callbacks", icon: "M12 8v4l3 2M21 12a9 9 0 11-18 0 9 9 0 0118 0z" },
      { to: "/voice/live", label: "Live Monitor", icon: "M2 12h3l3-8 4 16 3-8h7" },
    ],
  },
  {
    title: "Records",
    items: [
      { to: "/voice/leads", label: "Leads", icon: "M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8zm13 10v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" },
      { to: "/voice/history", label: "Call Records", icon: "M4 6h16M4 12h16M4 18h10" },
      { to: "/voice/analytics", label: "Analytics", icon: "M4 20V10m6 10V4m6 16v-7m4 7H2" },
      { to: "/voice/dispositions", label: "Dispositions", icon: "M7 7h.01M3 3h8l10 10-8 8L3 11V3z" },
      { to: "/voice/auditor", label: "Call Auditor", icon: "M9 12l2 2 4-4M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7l8-4z" },
    ],
  },
  {
    title: "Configure",
    items: [
      { to: "/voice/agents", label: "AI Agents", icon: "M12 2a4 4 0 014 4v2a4 4 0 01-8 0V6a4 4 0 014-4zM4 22a8 8 0 0116 0" },
      { to: "/voice/voices", label: "Voices", icon: "M12 2a3 3 0 013 3v6a3 3 0 01-6 0V5a3 3 0 013-3zm7 9a7 7 0 01-14 0m7 7v4" },
      { to: "/voice/numbers", label: "Numbers", icon: "M22 16.9v3a2 2 0 01-2.2 2 19.8 19.8 0 01-8.6-3.1 19.5 19.5 0 01-6-6A19.8 19.8 0 012.1 4.2 2 2 0 014.1 2h3a2 2 0 012 1.7c.1.9.4 1.8.7 2.7a2 2 0 01-.5 2.1L8 9.8a16 16 0 006 6l1.3-1.3a2 2 0 012.1-.4c.9.3 1.8.6 2.7.7a2 2 0 011.7 2z" },
      { to: "/voice/dnc", label: "Do Not Call", icon: "M18.4 5.6L5.6 18.4M21 12a9 9 0 11-18 0 9 9 0 0118 0z" },
    ],
  },
];

function Icon({ d }: { d: string }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  );
}

export default function VoiceLayout({ children }: { children: ReactNode }) {
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [live, setLive] = useState(0);
  const [dueCallbacks, setDueCallbacks] = useState(0);

  async function loadCounts() {
    try {
      const r = await api<{ liveCalls: number; callbacksNext24h: number }>("/voice/insights/summary?days=1");
      setLive(r.liveCalls);
      setDueCallbacks(r.callbacksNext24h);
    } catch {
      // badge counts are optional (e.g. a role without CDR access)
    }
  }

  useEffect(() => {
    loadCounts();
  }, []);
  useEffect(() => setOpen(false), [location.pathname]);
  useOrgEvents((e) => {
    if (e.type === "call_status" || e.type === "call_ended" || e.type === "connected") loadCounts();
  });

  const badge = (to: string) => (to === "/voice/live" ? live : to === "/voice/callbacks" ? dueCallbacks : 0);

  const nav = (
    <nav className="space-y-5">
      {SECTIONS.map((s) => (
        <div key={s.title}>
          <div className="px-3 mb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400">{s.title}</div>
          <div className="space-y-0.5">
            {s.items.map((it) => (
              <NavLink
                key={it.to}
                to={it.to}
                end={it.end}
                className={({ isActive }) =>
                  `flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                    isActive ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                  }`
                }
              >
                <Icon d={it.icon} />
                <span className="flex-1">{it.label}</span>
                {badge(it.to) > 0 && (
                  <span className={`text-[11px] font-semibold rounded-full px-1.5 py-0.5 ${it.to === "/voice/live" ? "bg-green-500 text-white" : "bg-amber-400 text-slate-900"}`}>
                    {badge(it.to)}
                  </span>
                )}
              </NavLink>
            ))}
          </div>
        </div>
      ))}
    </nav>
  );

  return (
    <div className="flex min-h-[calc(100vh-61px)]">
      <aside className="hidden lg:block w-60 shrink-0 border-r border-slate-200 bg-white px-3 py-5 sticky top-[61px] h-[calc(100vh-61px)] overflow-y-auto">
        <div className="px-3 mb-5">
          <div className="text-xs text-slate-400">Vahlay</div>
          <div className="text-base font-semibold text-slate-900">Voice AI</div>
        </div>
        {nav}
      </aside>
      <div className="flex-1 min-w-0">
        <div className="lg:hidden border-b border-slate-200 bg-white px-4 py-2">
          <button onClick={() => setOpen((o) => !o)} className="text-sm font-medium text-slate-700">
            ☰ Voice AI menu
          </button>
          {open && <div className="mt-3 pb-2">{nav}</div>}
        </div>
        <main className="px-4 sm:px-8 py-6">{children}</main>
      </div>
    </div>
  );
}
