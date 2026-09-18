import { useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext.js";
import BrandMark from "./BrandMark.js";
import NotificationBell from "./NotificationBell.js";

const ROLE_LABELS: Record<string, string> = {
  super_admin: "Global Admin",
  company_admin: "Admin",
  hr: "HR",
  recruiter: "Recruiter",
  agent_manager: "Agent Manager",
  user: "User",
};

export default function Navbar() {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const isAdmin = user?.role === "super_admin" || user?.role === "company_admin";
  const roleLabel = user ? ROLE_LABELS[user.role] ?? user.role : "";

  return (
    <header className="bg-white border-b border-slate-200 px-6 py-3 flex items-center justify-between sticky top-0 z-20">
      <Link to="/" className="flex items-center gap-3">
        <BrandMark size={36} />
        <span className="font-bold text-slate-900 text-lg">VahlaySmartAI</span>
      </Link>

      <div className="flex items-center gap-4">
        <NotificationBell />
        <div className="relative">
          <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-2">
            <div className="w-9 h-9 rounded-full bg-red-50 text-red-600 flex items-center justify-center">👤</div>
            <div className="text-left">
              <div className="text-sm font-semibold text-slate-900 leading-tight">
                {user?.first_name || user?.username || "Account"}
              </div>
              <div className="text-xs text-red-600 leading-tight">{roleLabel}</div>
            </div>
            <span className="text-slate-400 text-xs">▾</span>
          </button>
          {open && (
            <div className="absolute right-0 mt-2 w-56 bg-white border border-slate-200 rounded-lg shadow-lg py-1 z-30">
              <Link to="/profile" onClick={() => setOpen(false)} className="flex items-center gap-2 px-4 py-2 text-sm text-slate-700 hover:bg-slate-50">
                👤 Profile
              </Link>
              {isAdmin && (
                <Link to="/admin" onClick={() => setOpen(false)} className="flex items-center gap-2 px-4 py-2 text-sm text-slate-700 hover:bg-slate-50">
                  ⚙️ Admin Panel
                </Link>
              )}
              <div className="px-4 py-2 text-xs text-slate-400 border-t border-slate-100 mt-1 pt-2">Role: {roleLabel}</div>
              <button
                onClick={() => logout()}
                className="w-full text-left flex items-center gap-2 px-4 py-2 text-sm text-red-600 hover:bg-red-50 border-t border-slate-100"
              >
                ↪ Logout
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
