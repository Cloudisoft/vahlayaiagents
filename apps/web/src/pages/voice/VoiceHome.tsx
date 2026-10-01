import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api, ApiError } from "../../lib/api.js";
import { StatusPill, btnDark, btnGhost, btnPrimary, formatPhone, formatSeconds, inputCls } from "../../lib/voice.js";

type Tab = "campaigns" | "agents" | "voices" | "numbers" | "dnc";
const TABS: Array<{ key: Tab; label: string }> = [
  { key: "campaigns", label: "Campaigns" },
  { key: "agents", label: "Agents" },
  { key: "voices", label: "Voices" },
  { key: "numbers", label: "Numbers" },
  { key: "dnc", label: "Do Not Call" },
];

interface Agent {
  id: string;
  name: string;
  agent_type: string;
  tone: string;
  voice_name: string | null;
  llm_model: string | null;
  vapi_assistant_id: string | null;
  updated_at: string;
}
interface Voice {
  id: string;
  provider: string;
  provider_voice_id: string;
  name: string;
  language: string | null;
}
interface PhoneNumber {
  id: string;
  provider: string;
  phone_e164: string;
  status: string;
  area_code: string | null;
  vapi_phone_number_id: string | null;
}
interface Campaign {
  id: string;
  name: string;
  status: string;
  agent_name: string | null;
  total_leads: number;
  leads_remaining: number;
  total_calls: number;
  live_calls: number;
  connected_calls: number;
  interested_leads: number;
  appointments: number;
  transfers: number;
  avg_talk_seconds: number | null;
  published_version: number | null;
  has_unpublished_changes: boolean;
  paused_reason: string | null;
}
interface Available {
  number: string;
  locality: string;
  region: string;
}

export default function VoiceHome() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") as Tab) || "campaigns";
  const [agents, setAgents] = useState<Agent[]>([]);
  const [voices, setVoices] = useState<Voice[]>([]);
  const [numbers, setNumbers] = useState<PhoneNumber[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [dnc, setDnc] = useState<Array<{ id: string; phone_e164: string; reason: string | null; created_at: string }>>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [voiceForm, setVoiceForm] = useState({ providerVoiceId: "", name: "" });
  const [search, setSearch] = useState({ areaCode: "", state: "" });
  const [available, setAvailable] = useState<Available[] | null>(null);
  const [dncPhone, setDncPhone] = useState("");

  async function loadAll() {
    const [a, v, n, c, d] = await Promise.all([
      api<{ agents: Agent[] }>("/voice/agents"),
      api<{ voices: Voice[] }>("/voice/voices"),
      api<{ phoneNumbers: PhoneNumber[] }>("/voice/phone-numbers"),
      api<{ campaigns: Campaign[] }>("/voice/campaigns"),
      api<{ entries: typeof dnc }>("/voice/calls/dnc/list"),
    ]);
    setAgents(a.agents);
    setVoices(v.voices);
    setNumbers(n.phoneNumbers);
    setCampaigns(c.campaigns);
    setDnc(d.entries);
  }

  useEffect(() => {
    loadAll().catch((err) => setError(err instanceof ApiError ? err.message : "Failed to load."));
  }, []);

  async function run(key: string, fn: () => Promise<string | void>) {
    setError(null);
    setMessage(null);
    setBusy(key);
    try {
      const msg = await fn();
      if (msg) setMessage(msg);
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Request failed.");
    } finally {
      setBusy(null);
    }
  }

  const setTab = (t: Tab) => setParams({ tab: t });

  async function useTemplate() {
    await run("template", async () => {
      const r = await api<{ agent: { id: string } }>("/voice/agents/templates/spectrum_business", { method: "POST" });
      navigate(`/voice/agents/${r.agent.id}`);
    });
  }

  async function searchNumbers(e: FormEvent) {
    e.preventDefault();
    await run("search", async () => {
      const q = new URLSearchParams();
      if (search.areaCode) q.set("areaCode", search.areaCode);
      if (search.state) q.set("state", search.state);
      const r = await api<{ numbers: Available[] }>(`/voice/phone-numbers/available?${q}`);
      setAvailable(r.numbers);
      return r.numbers.length ? undefined : "Twilio has no numbers matching that search.";
    });
  }

  async function buy(number: string) {
    if (!confirm(`Buy ${formatPhone(number)} on your Twilio account? Twilio bills a monthly fee per number.`)) return;
    await run(`buy-${number}`, async () => {
      const r = await api<{ warning?: string }>("/voice/phone-numbers/buy", { method: "POST", body: { phoneNumber: number } });
      setAvailable((prev) => prev?.filter((a) => a.number !== number) ?? null);
      if (r.warning) throw new ApiError(r.warning, 207);
      return `Bought ${formatPhone(number)} and connected it to VAPI.`;
    });
  }

  return (
    <div className="max-w-6xl space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-slate-900">Vahlay Voice AI</h1>
        <div className="flex gap-2 text-sm">
          <Link to="/voice/live" className={btnGhost}>Live Monitor</Link>
          <Link to="/voice/history" className={btnGhost}>Call Records</Link>
          <Link to="/voice/auditor" className={btnGhost}>Call Auditor</Link>
        </div>
      </div>

      <div className="flex gap-1 border-b border-slate-200">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2 text-sm font-medium border-b-2 ${
              tab === t.key ? "border-red-600 text-red-600" : "border-transparent text-slate-500 hover:text-slate-700"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-2">{error}</div>}
      {message && <div className="text-sm text-green-700 bg-green-50 border border-green-200 rounded-md p-2">{message}</div>}

      {tab === "campaigns" && (
        <div>
          <div className="flex justify-end mb-3">
            <Link to="/voice/campaigns/new" className={btnPrimary}>+ New Campaign</Link>
          </div>
          <div className="grid md:grid-cols-2 gap-4">
            {campaigns.map((c) => (
              <Link key={c.id} to={`/voice/campaigns/${c.id}`} className="bg-white border border-slate-200 rounded-xl p-4 hover:border-red-300">
                <div className="flex justify-between items-center mb-1">
                  <span className="font-medium text-slate-900">{c.name}</span>
                  <StatusPill status={c.status} />
                </div>
                <div className="text-xs text-slate-500 mb-3">
                  {c.agent_name ?? "No agent"} · {c.published_version ? `v${c.published_version}` : "never published"}
                  {c.has_unpublished_changes && c.published_version ? " · unpublished changes" : ""}
                  {c.live_calls > 0 && <span className="ml-1 text-green-700 font-medium">· {c.live_calls} live</span>}
                </div>
                {c.paused_reason && <div className="text-xs text-amber-800 bg-amber-50 rounded p-1.5 mb-2">{c.paused_reason}</div>}
                <div className="grid grid-cols-4 gap-2 text-xs text-slate-500">
                  <div>Leads <strong className="block text-slate-900 text-sm">{c.total_leads}</strong></div>
                  <div>Left <strong className="block text-slate-900 text-sm">{c.leads_remaining}</strong></div>
                  <div>Calls <strong className="block text-slate-900 text-sm">{c.total_calls}</strong></div>
                  <div>Connected <strong className="block text-slate-900 text-sm">{c.connected_calls}</strong></div>
                  <div>Interested <strong className="block text-slate-900 text-sm">{c.interested_leads}</strong></div>
                  <div>Transfers <strong className="block text-slate-900 text-sm">{c.transfers}</strong></div>
                  <div>Appts <strong className="block text-slate-900 text-sm">{c.appointments}</strong></div>
                  <div>Avg talk <strong className="block text-slate-900 text-sm">{formatSeconds(c.avg_talk_seconds)}</strong></div>
                </div>
              </Link>
            ))}
            {campaigns.length === 0 && <div className="text-sm text-slate-500">No campaigns yet.</div>}
          </div>
        </div>
      )}

      {tab === "agents" && (
        <div>
          <div className="flex justify-end gap-2 mb-3">
            <button onClick={() => run("import", async () => (await api<{ message: string }>("/voice/agents/import-vapi", { method: "POST" })).message)} disabled={busy !== null} className={btnDark}>
              {busy === "import" ? "Importing…" : "Import from VAPI"}
            </button>
            <button onClick={useTemplate} disabled={busy !== null} className={btnGhost}>Spectrum Business template</button>
            <Link to="/voice/agents/new" className={btnPrimary}>+ New Agent</Link>
          </div>
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-500 text-xs uppercase">
                <tr>
                  <th className="text-left px-4 py-2">Name</th>
                  <th className="text-left px-4 py-2">Type</th>
                  <th className="text-left px-4 py-2">Voice</th>
                  <th className="text-left px-4 py-2">Model</th>
                  <th className="text-left px-4 py-2">Source</th>
                </tr>
              </thead>
              <tbody>
                {agents.map((a) => (
                  <tr key={a.id} className="border-t border-slate-100 hover:bg-slate-50 cursor-pointer" onClick={() => navigate(`/voice/agents/${a.id}`)}>
                    <td className="px-4 py-2 font-medium text-slate-900">{a.name}</td>
                    <td className="px-4 py-2 text-slate-500">{a.agent_type.replace(/_/g, " ")}</td>
                    <td className="px-4 py-2 text-slate-500">{a.voice_name ?? "—"}</td>
                    <td className="px-4 py-2 text-slate-500">{a.llm_model ?? "campaign default"}</td>
                    <td className="px-4 py-2 text-slate-500">{a.vapi_assistant_id ? "VAPI import" : "Vahlay"}</td>
                  </tr>
                ))}
                {agents.length === 0 && (
                  <tr><td colSpan={5} className="px-4 py-6 text-center text-slate-500">No agents yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === "voices" && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                run("add-voice", async () => {
                  await api("/voice/voices", { method: "POST", body: voiceForm });
                  setVoiceForm({ providerVoiceId: "", name: "" });
                  return "Voice added.";
                });
              }}
            >
              <div>
                <label className="block text-xs text-slate-500 mb-1">Cartesia voice ID</label>
                <input required value={voiceForm.providerVoiceId} onChange={(e) => setVoiceForm({ ...voiceForm, providerVoiceId: e.target.value })} className={`${inputCls} w-80`} placeholder="a0e99841-438c-4a64-b679-ae501e7d6091" />
              </div>
              <div>
                <label className="block text-xs text-slate-500 mb-1">Display name</label>
                <input required value={voiceForm.name} onChange={(e) => setVoiceForm({ ...voiceForm, name: e.target.value })} className={`${inputCls} w-48`} placeholder="Ray - Conversationalist" />
              </div>
              <button disabled={busy !== null} className={btnGhost}>Add voice</button>
            </form>
            <button onClick={() => run("sync-voices", async () => (await api<{ message: string }>("/voice/voices/sync", { method: "POST" })).message)} disabled={busy !== null} className={btnDark}>
              {busy === "sync-voices" ? "Syncing…" : "Sync from Cartesia"}
            </button>
          </div>
          <p className="text-xs text-slate-500">The agent says only the first part of the voice name: "Ray - Conversationalist" introduces itself as Ray.</p>
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-500 text-xs uppercase">
                <tr>
                  <th className="text-left px-4 py-2">Name</th>
                  <th className="text-left px-4 py-2">Provider</th>
                  <th className="text-left px-4 py-2">Voice ID</th>
                  <th className="text-left px-4 py-2">Language</th>
                </tr>
              </thead>
              <tbody>
                {voices.map((v) => (
                  <tr key={v.id} className="border-t border-slate-100">
                    <td className="px-4 py-2 font-medium text-slate-900">{v.name}</td>
                    <td className="px-4 py-2 text-slate-500">{v.provider}</td>
                    <td className="px-4 py-2 text-slate-400 font-mono text-xs">{v.provider_voice_id}</td>
                    <td className="px-4 py-2 text-slate-500">{v.language ?? "—"}</td>
                  </tr>
                ))}
                {voices.length === 0 && (
                  <tr><td colSpan={4} className="px-4 py-6 text-center text-slate-500">No voices yet — sync from Cartesia (API key in Settings) or add one by ID.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === "numbers" && (
        <div className="space-y-4">
          <p className="text-sm text-slate-500">
            Campaigns dial through VAPI using your Twilio numbers. Buy local numbers per area code so leads see a familiar caller ID; the dialer prefers a number matching the lead's area code.
          </p>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <form onSubmit={searchNumbers} className="flex items-end gap-2">
              <div>
                <label className="block text-xs text-slate-500 mb-1">Area code</label>
                <input value={search.areaCode} onChange={(e) => setSearch({ ...search, areaCode: e.target.value.replace(/\D/g, "").slice(0, 3) })} className={`${inputCls} w-24`} placeholder="214" />
              </div>
              <div>
                <label className="block text-xs text-slate-500 mb-1">State</label>
                <input value={search.state} onChange={(e) => setSearch({ ...search, state: e.target.value.toUpperCase().slice(0, 2) })} className={`${inputCls} w-20`} placeholder="TX" />
              </div>
              <button disabled={busy !== null} className={btnGhost}>{busy === "search" ? "Searching…" : "Search Twilio"}</button>
            </form>
            <div className="flex gap-2">
              <button onClick={() => run("sync-vapi", async () => (await api<{ message: string }>("/voice/phone-numbers/sync-vapi", { method: "POST" })).message)} disabled={busy !== null} className={btnDark}>
                {busy === "sync-vapi" ? "Syncing…" : "Sync from VAPI"}
              </button>
              <button onClick={() => run("sync-twilio", async () => (await api<{ message: string }>("/voice/phone-numbers/sync", { method: "POST", body: { provider: "twilio" } })).message)} disabled={busy !== null} className={btnGhost}>
                Sync from Twilio
              </button>
              <button onClick={() => run("sync-plivo", async () => (await api<{ message: string }>("/voice/phone-numbers/sync", { method: "POST", body: { provider: "plivo" } })).message)} disabled={busy !== null} className={btnGhost}>
                Sync Plivo (HR)
              </button>
            </div>
          </div>

          {available && available.length > 0 && (
            <div className="bg-white border border-slate-200 rounded-xl p-3">
              <div className="text-xs font-medium text-slate-500 uppercase mb-2">Available on Twilio</div>
              <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2">
                {available.map((a) => (
                  <div key={a.number} className="flex items-center justify-between border border-slate-200 rounded-md px-3 py-2 text-sm">
                    <span>
                      <span className="font-medium">{formatPhone(a.number)}</span>
                      <span className="text-xs text-slate-500 ml-2">{[a.locality, a.region].filter(Boolean).join(", ")}</span>
                    </span>
                    <button onClick={() => buy(a.number)} disabled={busy !== null} className="text-red-600 text-xs font-medium hover:underline disabled:opacity-50">
                      {busy === `buy-${a.number}` ? "Buying…" : "Buy"}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-500 text-xs uppercase">
                <tr>
                  <th className="text-left px-4 py-2">Number</th>
                  <th className="text-left px-4 py-2">Provider</th>
                  <th className="text-left px-4 py-2">Area code</th>
                  <th className="text-left px-4 py-2">VAPI</th>
                  <th className="text-left px-4 py-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {numbers.map((n) => (
                  <tr key={n.id} className="border-t border-slate-100">
                    <td className="px-4 py-2 font-medium text-slate-900">{formatPhone(n.phone_e164)}</td>
                    <td className="px-4 py-2 text-slate-500 capitalize">{n.provider}</td>
                    <td className="px-4 py-2 text-slate-500">{n.area_code ?? "—"}</td>
                    <td className="px-4 py-2">
                      {n.vapi_phone_number_id ? (
                        <span className="text-xs text-green-700">Connected</span>
                      ) : n.provider === "twilio" ? (
                        <button
                          onClick={() => run(`connect-${n.id}`, async () => {
                            await api(`/voice/phone-numbers/${n.id}/connect-vapi`, { method: "POST" });
                            return `${formatPhone(n.phone_e164)} connected to VAPI.`;
                          })}
                          disabled={busy !== null}
                          className="text-xs text-red-600 font-medium hover:underline"
                        >
                          Connect to VAPI
                        </button>
                      ) : (
                        <span className="text-xs text-slate-400">HR only</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-slate-500">{n.status}</td>
                  </tr>
                ))}
                {numbers.length === 0 && (
                  <tr><td colSpan={5} className="px-4 py-6 text-center text-slate-500">No numbers yet — sync from VAPI/Twilio or buy one above.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === "dnc" && (
        <div className="space-y-4">
          <form
            className="flex items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              run("dnc", async () => {
                await api("/voice/calls/dnc/list", { method: "POST", body: { phone: dncPhone } });
                setDncPhone("");
                return "Added to the do-not-call list.";
              });
            }}
          >
            <div>
              <label className="block text-xs text-slate-500 mb-1">Phone number</label>
              <input required value={dncPhone} onChange={(e) => setDncPhone(e.target.value)} className={`${inputCls} w-56`} placeholder="(302) 555-0100" />
            </div>
            <button disabled={busy !== null} className={btnGhost}>Add to DNC</button>
          </form>
          <p className="text-xs text-slate-500">Numbers here are never dialed. Callers who ask not to be called are added automatically.</p>
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-500 text-xs uppercase">
                <tr>
                  <th className="text-left px-4 py-2">Number</th>
                  <th className="text-left px-4 py-2">Reason</th>
                  <th className="text-left px-4 py-2">Added</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {dnc.map((d) => (
                  <tr key={d.id} className="border-t border-slate-100">
                    <td className="px-4 py-2 font-medium">{formatPhone(d.phone_e164)}</td>
                    <td className="px-4 py-2 text-slate-500">{d.reason ?? "—"}</td>
                    <td className="px-4 py-2 text-slate-500">{new Date(d.created_at).toLocaleString()}</td>
                    <td className="px-4 py-2 text-right">
                      <button
                        onClick={() => {
                          if (confirm("Remove from DNC? This number may be called again.")) {
                            run(`rm-${d.id}`, async () => {
                              await api(`/voice/calls/dnc/list/${d.id}`, { method: "DELETE" });
                            });
                          }
                        }}
                        className="text-xs text-slate-500 hover:text-red-600"
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
                {dnc.length === 0 && (
                  <tr><td colSpan={4} className="px-4 py-6 text-center text-slate-500">The do-not-call list is empty.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
