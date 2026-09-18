import { NavLink } from "react-router-dom";
import { useAuth } from "../context/AuthContext.js";

const NAV = [
  { to: "/", label: "Dashboard", exact: true },
  { to: "/hr", label: "VahlayHR" },
  { to: "/coverage", label: "Vahlay Coverage" },
  { to: "/leadgen", label: "Vahlay LeadGen" },
  { to: "/voice", label: "Vahlay Voice AI" },
  { to: "/settings", label: "Settings" },
];

export default function Sidebar() {
  const { user, logout } = useAuth();

  return (
    <aside className="w-60 shrink-0 bg-white border-r border-slate-200 flex flex-col h-screen sticky top-0">
      <div className="px-4 py-5 border-b border-slate-200">
        <div className="font-semibold text-slate-900">Vahlay AI</div>
        <div className="text-xs text-slate-500 truncate">{user?.organization_name}</div>
      </div>
      <nav className="flex-1 px-2 py-4 space-y-1">
        {NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.exact}
            className={({ isActive }) =>
              `block px-3 py-2 rounded-md text-sm font-medium ${
                isActive ? "bg-indigo-50 text-indigo-700" : "text-slate-600 hover:bg-slate-50"
              }`
            }
          >
            {item.label}
          </NavLink>
        ))}
      </nav>
      <div className="px-4 py-4 border-t border-slate-200">
        <div className="text-xs text-slate-500 mb-2 truncate">
          {user?.first_name} {user?.last_name} · {user?.role}
        </div>
        <button
          onClick={() => logout()}
          className="text-sm text-slate-600 hover:text-slate-900"
        >
          Sign out
        </button>
      </div>
    </aside>
  );
}
