import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext.js";
import { ApiError } from "../lib/api.js";

export default function Signup() {
  const { signup } = useAuth();
  const navigate = useNavigate();
  const [organizationName, setOrganizationName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await signup({ organizationName, email, password });
      navigate("/");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50">
      <form onSubmit={onSubmit} className="w-full max-w-sm bg-white p-8 rounded-xl shadow-sm border border-slate-200">
        <h1 className="text-xl font-semibold text-slate-900 mb-1">Create your workspace</h1>
        <p className="text-sm text-slate-500 mb-6">Start using Vahlay AI</p>
        {error && <div className="mb-4 text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-2">{error}</div>}
        <label className="block text-sm font-medium text-slate-700 mb-1">Company name</label>
        <input
          required
          value={organizationName}
          onChange={(e) => setOrganizationName(e.target.value)}
          className="w-full border border-slate-300 rounded-md px-3 py-2 mb-4 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
        <label className="block text-sm font-medium text-slate-700 mb-1">Email</label>
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full border border-slate-300 rounded-md px-3 py-2 mb-4 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
        <label className="block text-sm font-medium text-slate-700 mb-1">Password</label>
        <input
          type="password"
          required
          minLength={8}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full border border-slate-300 rounded-md px-3 py-2 mb-6 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
        <button
          type="submit"
          disabled={busy}
          className="w-full bg-indigo-600 text-white text-sm font-medium rounded-md py-2 hover:bg-indigo-700 disabled:opacity-50"
        >
          {busy ? "Creating..." : "Create account"}
        </button>
        <p className="text-sm text-slate-500 mt-4 text-center">
          Already have an account?{" "}
          <Link to="/login" className="text-indigo-600 hover:underline">
            Sign in
          </Link>
        </p>
      </form>
    </div>
  );
}
