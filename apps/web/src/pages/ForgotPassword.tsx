import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../lib/api.js";

export default function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await api<{ message: string }>("/auth/forgot-password", { method: "POST", body: { email } });
      setMessage(res.message);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50">
      <form onSubmit={onSubmit} className="w-full max-w-sm bg-white p-8 rounded-xl shadow-sm border border-slate-200">
        <h1 className="text-xl font-semibold text-slate-900 mb-1">Reset your password</h1>
        <p className="text-sm text-slate-500 mb-6">We'll email you a reset link if an account exists.</p>
        {error && <div className="mb-4 text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-2">{error}</div>}
        {message && <div className="mb-4 text-sm text-green-700 bg-green-50 border border-green-200 rounded-md p-2">{message}</div>}
        <label className="block text-sm font-medium text-slate-700 mb-1">Email</label>
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full border border-slate-300 rounded-md px-3 py-2 mb-6 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
        <button
          type="submit"
          disabled={busy}
          className="w-full bg-indigo-600 text-white text-sm font-medium rounded-md py-2 hover:bg-indigo-700 disabled:opacity-50"
        >
          {busy ? "Sending..." : "Send reset link"}
        </button>
        <p className="text-sm text-slate-500 mt-4 text-center">
          <Link to="/login" className="text-indigo-600 hover:underline">
            Back to sign in
          </Link>
        </p>
      </form>
    </div>
  );
}
