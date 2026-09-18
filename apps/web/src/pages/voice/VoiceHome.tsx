import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../../lib/api.js";

type Tab = "campaigns" | "agents" | "voices" | "numbers";

interface Agent {
  id: string;
  name: string;
  agent_type: string;
  tone: string;
  voice_name: string | null;
}

interface Voice {
  id: string;
  provider: string;
  name: string;
  language: string | null;
}

interface PhoneNumber {
  id: string;
  provider: string;
  phone_e164: string;
  status: string;
  agent_name: string | null;
  campaign_name: string | null;
}

interface Campaign {
  id: string;
  name: string;
  status: string;
  total_leads: string;
  leads_called: string;
  connected_calls: string;
  interested_leads: string;
  appointments: string;
}

export default function VoiceHome() {
  const [tab, setTab] = useState<Tab>("campaigns");
  const [agents, setAgents] = useState<Agent[]>([]);
  const [voices, setVoices] = useState<Voice[]>([]);
  const [numbers, setNumbers] = useState<PhoneNumber[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function loadAll() {
    const [a, v, n, c] = await Promise.all([
      api<{ agents: Agent[] }>("/voice/agents"),
      api<{ voices: Voice[] }>("/voice/voices"),
      api<{ phoneNumbers: PhoneNumber[] }>("/voice/phone-numbers"),
      api<{ campaigns: Campaign[] }>("/voice/campaigns"),
    ]);
    setAgents(a.agents);
    setVoices(v.voices);
    setNumbers(n.phoneNumbers);
    setCampaigns(c.campaigns);
  }

  useEffect(() => {
    loadAll();
  }, []);

  async function syncVoices() {
    setError(null);
    setMessage(null);
    try {
      const r = await api<{ message: string }>("/voice/voices/sync", { method: "POST" });
      setMessage(r.message);
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Sync failed.");
    }
  }

  async function syncNumbers() {
    setError(null);
    setMessage(null);
    try {
      const r = await api<{ message: string }>("/voice/phone-numbers/sync", { method: "POST", body: { provider: "plivo" } });
      setMessage(r.message);
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Sync failed.");
    }
  }

  return (
    <div className="max-w-5xl space-y-6">
      <h1 className="text-2xl font-semibold text-slate-900">Vahlay Voice AI</h1>

      <div className="flex gap-1 border-b border-slate-200">
        {(["campaigns", "agents", "voices", "numbers"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium capitalize border-b-2 ${
              tab === t ? "border-indigo-600 text-indigo-600" : "border-transparent text-slate-500 hover:text-slate-700"
            }`}
          >
            {t}
          </button>
        ))}
        <Link to="/voice/live" className="px-4 py-2 text-sm font-medium text-slate-500 hover:text-slate-700 border-b-2 border-transparent">
          Live Calls
        </Link>
        <Link to="/voice/history" className="px-4 py-2 text-sm font-medium text-slate-500 hover:text-slate-700 border-b-2 border-transparent">
          Call History
        </Link>
      </div>

      {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-2">{error}</div>}
      {message && <div className="text-sm text-green-700 bg-green-50 border border-green-200 rounded-md p-2">{message}</div>}

      {tab === "campaigns" && (
        <div>
          <div className="flex justify-end mb-3">
            <Link to="/voice/campaigns/new" className="bg-indigo-600 text-white text-sm font-medium rounded-md px-4 py-2 hover:bg-indigo-700">
              + New Campaign
            </Link>
          </div>
          <div className="grid grid-cols-2 gap-4">
            {campaigns.map((c) => (
              <Link key={c.id} to={`/voice/campaigns/${c.id}`} className="bg-white border border-slate-200 rounded-xl p-4 hover:border-indigo-300">
                <div className="flex justify-between items-center mb-2">
                  <span className="font-medium text-slate-900">{c.name}</span>
                  <span className="text-xs bg-slate-100 text-slate-600 rounded-full px-2 py-0.5">{c.status}</span>
                </div>
                <div className="grid grid-cols-3 gap-2 text-xs text-slate-500">
                  <div>Leads: <strong className="text-slate-900">{c.total_leads}</strong></div>
                  <div>Called: <strong className="text-slate-900">{c.leads_called}</strong></div>
                  <div>Connected: <strong className="text-slate-900">{c.connected_calls}</strong></div>
                  <div>Interested: <strong className="text-slate-900">{c.interested_leads}</strong></div>
                  <div>Appts: <strong className="text-slate-900">{c.appointments}</strong></div>
                </div>
              </Link>
            ))}
            {campaigns.length === 0 && <div className="text-sm text-slate-500">No campaigns yet.</div>}
          </div>
        </div>
      )}

      {tab === "agents" && (
        <div>
          <div className="flex justify-end mb-3">
            <Link to="/voice/agents/new" className="bg-indigo-600 text-white text-sm font-medium rounded-md px-4 py-2 hover:bg-indigo-700">
              + New Agent
            </Link>
          </div>
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-500 text-xs uppercase">
                <tr>
                  <th className="text-left px-4 py-2">Name</th>
                  <th className="text-left px-4 py-2">Type</th>
                  <th className="text-left px-4 py-2">Tone</th>
                  <th className="text-left px-4 py-2">Voice</th>
                </tr>
              </thead>
              <tbody>
                {agents.map((a) => (
                  <tr key={a.id} className="border-t border-slate-100">
                    <td className="px-4 py-2 font-medium text-slate-900">{a.name}</td>
                    <td className="px-4 py-2 text-slate-500">{a.agent_type}</td>
                    <td className="px-4 py-2 text-slate-500">{a.tone}</td>
                    <td className="px-4 py-2 text-slate-500">{a.voice_name ?? "—"}</td>
                  </tr>
                ))}
                {agents.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-4 py-6 text-center text-slate-500">No agents yet.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === "voices" && (
        <div>
          <div className="flex justify-end mb-3">
            <button onClick={syncVoices} className="bg-slate-900 text-white text-sm font-medium rounded-md px-4 py-2 hover:bg-slate-800">
              Sync from Cartesia
            </button>
          </div>
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-500 text-xs uppercase">
                <tr>
                  <th className="text-left px-4 py-2">Name</th>
                  <th className="text-left px-4 py-2">Provider</th>
                  <th className="text-left px-4 py-2">Language</th>
                </tr>
              </thead>
              <tbody>
                {voices.map((v) => (
                  <tr key={v.id} className="border-t border-slate-100">
                    <td className="px-4 py-2 font-medium text-slate-900">{v.name}</td>
                    <td className="px-4 py-2 text-slate-500">{v.provider}</td>
                    <td className="px-4 py-2 text-slate-500">{v.language ?? "—"}</td>
                  </tr>
                ))}
                {voices.length === 0 && (
                  <tr>
                    <td colSpan={3} className="px-4 py-6 text-center text-slate-500">
                      No voices yet — sync from Cartesia once an API key is configured in Settings.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === "numbers" && (
        <div>
          <div className="flex justify-end mb-3">
            <button onClick={syncNumbers} className="bg-slate-900 text-white text-sm font-medium rounded-md px-4 py-2 hover:bg-slate-800">
              Sync from Plivo
            </button>
          </div>
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-500 text-xs uppercase">
                <tr>
                  <th className="text-left px-4 py-2">Number</th>
                  <th className="text-left px-4 py-2">Provider</th>
                  <th className="text-left px-4 py-2">Status</th>
                  <th className="text-left px-4 py-2">Agent</th>
                  <th className="text-left px-4 py-2">Campaign</th>
                </tr>
              </thead>
              <tbody>
                {numbers.map((n) => (
                  <tr key={n.id} className="border-t border-slate-100">
                    <td className="px-4 py-2 font-medium text-slate-900">{n.phone_e164}</td>
                    <td className="px-4 py-2 text-slate-500">{n.provider}</td>
                    <td className="px-4 py-2 text-slate-500">{n.status}</td>
                    <td className="px-4 py-2 text-slate-500">{n.agent_name ?? "—"}</td>
                    <td className="px-4 py-2 text-slate-500">{n.campaign_name ?? "—"}</td>
                  </tr>
                ))}
                {numbers.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-4 py-6 text-center text-slate-500">
                      No numbers yet — sync once a telephony provider is configured in Settings.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
