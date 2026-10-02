import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, ApiError } from "../../lib/api.js";
import { prefetch, useApi } from "../../lib/useApi.js";
import { K } from "../../lib/voiceKeys.js";
import VoicesPanel from "./VoicesPanel.js";
import { StatusPill, btnDark, btnGhost, btnPrimary, formatPhone, formatSeconds, inputCls } from "../../lib/voice.js";

type Tab = "campaigns" | "agents" | "voices" | "numbers" | "dnc";
const TITLES: Record<Tab, string> = {
  campaigns: "Campaigns",
  agents: "AI Agents",
  voices: "Voices",
  numbers: "Numbers",
  dnc: "Do Not Call",
};

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
  inbound_route: { mode?: string } | null;
  inbound_enabled: boolean;
  assigned_campaign_id: string | null;
  campaign_name: string | null;
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

interface Template {
  key: string;
  name: string;
  purpose: string;
}

export default function VoiceHome({ tab }: { tab: Tab }) {
  const navigate = useNavigate();
  type DncEntry = { id: string; phone_e164: string; reason: string | null; created_at: string };
  // Each page fetches only what it shows; cached data renders instantly.
  const agentsQ = useApi<{ agents: Agent[] }>(tab === "agents" ? K.agents : null);
  const templatesQ = useApi<{ templates: Template[] }>(tab === "agents" || tab === "campaigns" ? K.templates : null);
  const voicesQ = useApi<{ voices: Voice[] }>(null);
  const numbersQ = useApi<{ phoneNumbers: PhoneNumber[] }>(tab === "numbers" ? K.numbers : null);
  const campaignsQ = useApi<{ campaigns: Campaign[] }>(tab === "campaigns" || tab === "numbers" ? K.campaigns : null);
  const dncQ = useApi<{ entries: DncEntry[] }>(tab === "dnc" ? K.dnc : null);
  const templates = templatesQ.data?.templates ?? [];
  const agents = agentsQ.data?.agents ?? [];
  const voices = voicesQ.data?.voices ?? [];
  const numbers = numbersQ.data?.phoneNumbers ?? [];
  const campaigns = campaignsQ.data?.campaigns ?? [];
  const dnc = dncQ.data?.entries ?? [];
  const loading = [agentsQ, voicesQ, numbersQ, campaignsQ, dncQ].some((q) => q.loading);
  const loadError = [agentsQ, voicesQ, numbersQ, campaignsQ, dncQ].map((q) => q.error).find(Boolean) ?? null;
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [voiceForm, setVoiceForm] = useState({ providerVoiceId: "", name: "" });
  const [search, setSearch] = useState({ areaCode: "", state: "" });
  const [available, setAvailable] = useState<Available[] | null>(null);
  const [dncPhone, setDncPhone] = useState("");

  async function loadAll() {
    const reloads = { agents: agentsQ, voices: voicesQ, numbers: numbersQ, campaigns: campaignsQ, dnc: dncQ } as const;
    await reloads[tab].reload();
  }

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


  async function useTemplate(key: string) {
    await run("template", async () => {
      const r = await api<{ agent: { id: string } }>(`/voice/agents/templates/${key}`, { method: "POST" });
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
      <h1 className="text-2xl font-semibold text-slate-900">{TITLES[tab]}</h1>

      {loading && (<div className="space-y-3 animate-fade-in" aria-busy="true" aria-label="Loading">
          <div className="skeleton h-5 w-1/3" />
          <div className="skeleton h-4 w-2/3" />
          <div className="skeleton h-24 w-full" />
        </div>)}
      {loadError && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-2">{loadError}</div>}
      {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-2">{error}</div>}
      {message && <div className="text-sm text-green-700 bg-green-50 border border-green-200 rounded-md p-2">{message}</div>}

      {tab === "campaigns" && (
        <div>
          <div className="flex justify-end mb-3">
            <Link to="/voice/campaigns/new" className={btnPrimary}>+ New Campaign</Link>
          </div>
          <div className="grid md:grid-cols-2 gap-4 stagger">
            {campaigns.map((c) => (
              <Link key={c.id} to={`/voice/campaigns/${c.id}`} onMouseEnter={() => prefetch(K.campaign(c.id))} className="bg-white border border-slate-200 rounded-xl p-4 hover:border-red-300">
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
          <div className="flex flex-wrap justify-end gap-2 mb-3">
            <button onClick={() => run("import", async () => (await api<{ message: string }>("/voice/agents/import-vapi", { method: "POST" })).message)} disabled={busy !== null} className={btnDark}>
              {busy === "import" ? "Importing…" : "Import from VAPI"}
            </button>
            {templates.map((t) => (
              <button key={t.key} onClick={() => useTemplate(t.key)} disabled={busy !== null} className={btnGhost} title={t.purpose}>
                + {t.name}
              </button>
            ))}
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

      {tab === "voices" && <VoicesPanel />}

      {tab === "numbers" && (
        <div className="space-y-4">
          <ProvidersCard />
          <p className="text-sm text-slate-500">
            Campaigns dial out through VAPI using these numbers; the dialer prefers one matching the lead's area code. Only numbers listed here are used — your other Twilio numbers are never touched. Removing a number here doesn't change it in Twilio or VAPI.
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
                  <th className="text-left px-4 py-2">Inbound — AI answering</th>
                  <th />
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
                          onClick={() => {
                            if (!confirm(`Connect ${formatPhone(n.phone_e164)} to VAPI? VAPI will take over this number's incoming-call settings in Twilio.`)) return;
                            run(`connect-${n.id}`, async () => {
                            await api(`/voice/phone-numbers/${n.id}/connect-vapi`, { method: "POST" });
                            return `${formatPhone(n.phone_e164)} connected to VAPI.`;
                          });
                          }}
                          disabled={busy !== null}
                          className="text-xs text-red-600 font-medium hover:underline"
                        >
                          Connect to VAPI
                        </button>
                      ) : (
                        <span className="text-xs text-slate-400">HR only</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-xs">
                      {n.vapi_phone_number_id ? (
                        <InboundControl
                          number={n}
                          campaigns={campaigns}
                          busy={busy === `inbound-${n.id}`}
                          onSave={(enabled, campaignId) =>
                            run(`inbound-${n.id}`, async () => {
                              await api(`/voice/phone-numbers/${n.id}/inbound`, { method: "PUT", body: { enabled, campaignId } });
                              return enabled
                                ? `AI now answers calls to ${formatPhone(n.phone_e164)}.`
                                : `AI answering turned off for ${formatPhone(n.phone_e164)}.`;
                            })
                          }
                        />
                      ) : (
                        <span className="text-slate-400">Connect to VAPI first</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <button
                        onClick={() => {
                          if (!confirm(`Remove ${formatPhone(n.phone_e164)} from this app? It stays in Twilio and VAPI.`)) return;
                          run(`rm-${n.id}`, async () => {
                            await api(`/voice/phone-numbers/${n.id}`, { method: "DELETE" });
                          });
                        }}
                        className="text-xs text-slate-500 hover:text-red-600"
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
                {numbers.length === 0 && (
                  <tr><td colSpan={6} className="px-4 py-6 text-center text-slate-500">No numbers yet — sync from VAPI/Twilio or buy one above.</td></tr>
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

// Per-number inbound route: which campaign's agent answers, and on/off.
function InboundControl(props: {
  number: PhoneNumber;
  campaigns: Campaign[];
  busy: boolean;
  onSave: (enabled: boolean, campaignId: string | null) => void;
}) {
  const { number: n, campaigns, busy } = props;
  const [campaignId, setCampaignId] = useState(n.assigned_campaign_id ?? "");
  useEffect(() => setCampaignId(n.assigned_campaign_id ?? ""), [n.assigned_campaign_id]);
  return (
    <div className="flex items-center gap-2">
      <select
        value={campaignId}
        onChange={(e) => {
          setCampaignId(e.target.value);
          if (n.inbound_enabled && e.target.value) props.onSave(true, e.target.value);
        }}
        className="border border-slate-300 rounded-md px-2 py-1 text-xs max-w-[11rem]"
        aria-label="Campaign that answers"
      >
        <option value="">Choose campaign…</option>
        {campaigns.map((c) => (
          <option key={c.id} value={c.id}>{c.name}</option>
        ))}
      </select>
      <button
        type="button"
        role="switch"
        aria-checked={n.inbound_enabled}
        disabled={busy || (!n.inbound_enabled && !campaignId)}
        title={!campaignId ? "Choose a campaign first" : n.inbound_enabled ? "Turn AI answering off" : "Turn AI answering on"}
        onClick={() => props.onSave(!n.inbound_enabled, campaignId || null)}
        className={`relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-40 ${n.inbound_enabled ? "bg-green-600" : "bg-slate-300"}`}
      >
        <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${n.inbound_enabled ? "left-[18px]" : "left-0.5"}`} />
      </button>
      <span className={n.inbound_enabled ? "text-green-700" : "text-slate-400"}>{busy ? "Saving…" : n.inbound_enabled ? "On" : "Off"}</span>
    </div>
  );
}

interface Providers {
  twilio: { connected: boolean; balanceUsd?: number | null; error?: string };
  vapi: { connected: boolean; monthToDateUsd?: number; monthToDateCalls?: number; billingUrl: string; error?: string };
}

function ProvidersCard() {
  const q = useApi<Providers>("/voice/phone-numbers/providers");
  const p = q.data;
  const usd = (n: number | null | undefined) => (n == null ? "—" : `$${n.toFixed(2)}`);
  return (
    <div className="grid md:grid-cols-2 gap-3">
      <div className="bg-white border border-slate-200 rounded-xl p-4">
        <div className="text-xs text-slate-500 uppercase">Twilio balance</div>
        {!p ? (
          <div className="skeleton h-7 w-24 mt-1" />
        ) : p.twilio.connected ? (
          <div className="text-2xl font-semibold text-slate-900">{usd(p.twilio.balanceUsd)}</div>
        ) : (
          <div className="text-sm text-amber-700 mt-1">Not connected — check the Twilio keys in Settings.</div>
        )}
        <div className="text-xs text-slate-500 mt-1">Buy numbers below: search an area code or state, then Buy. New numbers connect to VAPI automatically.</div>
      </div>
      <div className="bg-white border border-slate-200 rounded-xl p-4">
        <div className="text-xs text-slate-500 uppercase">VAPI — spent this month</div>
        {!p ? (
          <div className="skeleton h-7 w-24 mt-1" />
        ) : p.vapi.connected ? (
          <div className="text-2xl font-semibold text-slate-900">
            {usd(p.vapi.monthToDateUsd)} <span className="text-sm font-normal text-slate-500">· {p.vapi.monthToDateCalls ?? 0} calls</span>
          </div>
        ) : (
          <div className="text-sm text-amber-700 mt-1">{p.vapi.error ?? "Not connected"}</div>
        )}
        <div className="text-xs text-slate-500 mt-1">
          VAPI doesn't share the remaining credit balance through its API.{" "}
          <a href={p?.vapi.billingUrl ?? "https://dashboard.vapi.ai/org/billing"} target="_blank" rel="noreferrer" className="text-red-600 hover:underline">
            See balance in VAPI ↗
          </a>
        </div>
      </div>
    </div>
  );
}
