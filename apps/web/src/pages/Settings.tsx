import { useEffect, useState } from "react";
import { api, ApiError } from "../lib/api.js";

interface ProviderStatus {
  provider: string;
  configured: boolean;
  isActive: boolean;
  updatedAt: string | null;
}

const PROVIDER_FIELDS: Record<string, { label: string; group: string; fields: { key: string; label: string; type?: string }[] }> = {
  openai: { label: "OpenAI", group: "AI Providers", fields: [{ key: "apiKey", label: "API Key", type: "password" }] },
  vapi: { label: "VAPI", group: "AI Providers", fields: [{ key: "apiKey", label: "API Key", type: "password" }] },
  cartesia: { label: "Cartesia", group: "AI Providers", fields: [{ key: "apiKey", label: "API Key", type: "password" }] },
  twilio: {
    label: "Twilio",
    group: "Telephony",
    fields: [
      { key: "accountSid", label: "Account SID" },
      { key: "authToken", label: "Auth Token", type: "password" },
    ],
  },
  plivo: {
    label: "Plivo",
    group: "Telephony",
    fields: [
      { key: "authId", label: "Auth ID" },
      { key: "authToken", label: "Auth Token", type: "password" },
    ],
  },
  exotel: {
    label: "Exotel",
    group: "Telephony",
    fields: [
      { key: "sid", label: "SID" },
      { key: "apiKey", label: "API Key" },
      { key: "apiToken", label: "API Token", type: "password" },
    ],
  },
  smtp: {
    label: "SMTP",
    group: "Email",
    fields: [
      { key: "host", label: "Host" },
      { key: "user", label: "User" },
      { key: "pass", label: "Password", type: "password" },
      { key: "from", label: "From address" },
    ],
  },
  resend: { label: "Resend", group: "Email", fields: [{ key: "apiKey", label: "API Key", type: "password" }] },
  google_places: { label: "Google Places", group: "Lead Sources", fields: [{ key: "apiKey", label: "API Key", type: "password" }] },
  storage: {
    label: "Object Storage (S3-compatible)",
    group: "Storage",
    fields: [
      { key: "endpoint", label: "Endpoint (Supabase Storage / MinIO)" },
      { key: "bucket", label: "Bucket" },
      { key: "accessKeyId", label: "Access Key ID" },
      { key: "secretAccessKey", label: "Secret Access Key", type: "password" },
    ],
  },
};

export default function Settings() {
  const [statuses, setStatuses] = useState<ProviderStatus[]>([]);
  const [formState, setFormState] = useState<Record<string, Record<string, string>>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const { providers } = await api<{ providers: ProviderStatus[] }>("/settings/credentials");
    setStatuses(providers);
  }

  useEffect(() => {
    load();
  }, []);

  function setField(provider: string, key: string, value: string) {
    setFormState((prev) => ({ ...prev, [provider]: { ...prev[provider], [key]: value } }));
  }

  async function save(provider: string) {
    setError(null);
    setMessage(null);
    try {
      await api("/settings/credentials", {
        method: "PUT",
        body: { provider, value: formState[provider] ?? {} },
      });
      setMessage(`${PROVIDER_FIELDS[provider].label} credentials saved.`);
      setFormState((prev) => ({ ...prev, [provider]: {} }));
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to save credentials.");
    }
  }

  const groups = Array.from(new Set(Object.values(PROVIDER_FIELDS).map((p) => p.group)));

  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl font-semibold text-slate-900 mb-1">Settings</h1>
      <p className="text-sm text-slate-500 mb-6">
        Provider credentials are encrypted at rest and never sent back to the browser. Nothing here fakes a
        connection — modules that use these providers will show a real error until credentials are saved.
      </p>

      {error && <div className="mb-4 text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-2">{error}</div>}
      {message && <div className="mb-4 text-sm text-green-700 bg-green-50 border border-green-200 rounded-md p-2">{message}</div>}

      {groups.map((group) => (
        <div key={group} className="mb-8">
          <h2 className="text-sm font-semibold text-slate-700 uppercase tracking-wide mb-3">{group}</h2>
          <div className="space-y-4">
            {Object.entries(PROVIDER_FIELDS)
              .filter(([, cfg]) => cfg.group === group)
              .map(([key, cfg]) => {
                const status = statuses.find((s) => s.provider === key);
                return (
                  <div key={key} className="bg-white border border-slate-200 rounded-xl p-4">
                    <div className="flex items-center justify-between mb-3">
                      <span className="font-medium text-slate-900">{cfg.label}</span>
                      <span
                        className={`text-xs rounded-full px-2 py-0.5 ${
                          status?.configured ? "bg-green-100 text-green-700" : "bg-slate-100 text-slate-500"
                        }`}
                      >
                        {status?.configured ? "Configured" : "Not configured"}
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-3 mb-3">
                      {cfg.fields.map((f) => (
                        <div key={f.key}>
                          <label className="block text-xs text-slate-500 mb-1">{f.label}</label>
                          <input
                            type={f.type ?? "text"}
                            value={formState[key]?.[f.key] ?? ""}
                            onChange={(e) => setField(key, f.key, e.target.value)}
                            className="w-full border border-slate-300 rounded-md px-2 py-1.5 text-sm"
                          />
                        </div>
                      ))}
                    </div>
                    <button
                      onClick={() => save(key)}
                      className="text-sm bg-slate-900 text-white rounded-md px-3 py-1.5 hover:bg-slate-800"
                    >
                      Save
                    </button>
                  </div>
                );
              })}
          </div>
        </div>
      ))}
    </div>
  );
}
