import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useNavigate } from "react-router-dom";
import { api, ApiError, getAccessToken } from "../../lib/api.js";
import { fetchCached } from "../../lib/useApi.js";
import {
  DispositionBadge,
  StatusPill,
  btnDark,
  btnGhost,
  btnPrimary,
  formatPhone,
  formatSeconds,
  inputCls,
  useCan,
  useOrgEvents,
} from "../../lib/voice.js";

interface CallingWindow {
  days: number[];
  start: string;
  end: string;
  useLeadTimeZone: boolean;
  lunchBreak: { start: string; end: string } | null;
}

interface Campaign {
  id: string;
  name: string;
  description: string | null;
  status: string;
  ai_agent_id: string | null;
  voice_id: string | null;
  transfer_number: string | null;
  concurrency: number;
  max_attempts: number;
  calling_hours: CallingWindow;
  time_zone: string;
  max_call_duration_seconds: number;
  intro_name: string | null;
  callback_number: string | null;
  script: string | null;
  knowledge_text: string | null;
  retry_on_voicemail: boolean;
  retry_delay_minutes: number;
  lead_cooldown_hours: number;
  dial_timeout_seconds: number;
  llm_model: string | null;
  transfer_targets: Record<string, string>;
  recording_disclosure: boolean;
  background_sound: boolean;
  published_version_id: string | null;
  published_at: string | null;
  has_unpublished_changes: boolean;
  paused_reason: string | null;
  scheduled_start_at: string | null;
  published_version: number | null;
  total_leads: number;
  leads_remaining: number;
  leads_dialing: number;
  total_calls: number;
  live_calls: number;
  connected_calls: number;
  interested_leads: number;
  appointments: number;
  transfers: number;
  voicemails: number;
  avg_talk_seconds: number | null;
}

interface PoolNumber {
  id: string;
  phone_e164: string;
  area_code: string | null;
  vapi_phone_number_id: string | null;
  last_used_at: string | null;
}

interface CampaignLead {
  id: string;
  status: string;
  attempts: number;
  last_disposition: string | null;
  next_attempt_at: string | null;
  business_name: string | null;
  first_name: string | null;
  last_name: string | null;
  main_phone_e164: string | null;
  state: string | null;
  is_dnc: boolean;
}

interface Version {
  id: string;
  version: number;
  created_at: string;
  published_by_name: string | null;
  calls: number;
}

type Tab = "settings" | "numbers" | "leads" | "versions";
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const TIME_ZONES = ["America/New_York", "America/Chicago", "America/Denver", "America/Phoenix", "America/Los_Angeles", "America/Anchorage", "Pacific/Honolulu"];

// Editable fields, API name -> campaign column.
const FIELDS = {
  name: "name",
  description: "description",
  aiAgentId: "ai_agent_id",
  voiceId: "voice_id",
  transferNumber: "transfer_number",
  concurrency: "concurrency",
  maxAttempts: "max_attempts",
  callingHours: "calling_hours",
  timeZone: "time_zone",
  maxCallDurationSeconds: "max_call_duration_seconds",
  introName: "intro_name",
  callbackNumber: "callback_number",
  script: "script",
  knowledgeText: "knowledge_text",
  retryOnVoicemail: "retry_on_voicemail",
  retryDelayMinutes: "retry_delay_minutes",
  leadCooldownHours: "lead_cooldown_hours",
  dialTimeoutSeconds: "dial_timeout_seconds",
  llmModel: "llm_model",
  llmProvider: "llm_provider",
  transferTargets: "transfer_targets",
  recordingDisclosure: "recording_disclosure",
  backgroundSound: "background_sound",
} as const;
type FieldKey = keyof typeof FIELDS;

export default function CampaignDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const can = useCan();
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [draft, setDraft] = useState<Partial<Record<FieldKey, any>>>({});
  const [numbers, setNumbers] = useState<PoolNumber[]>([]);
  const [agentChanged, setAgentChanged] = useState(false);
  const [tab, setTab] = useState<Tab>("settings");
  const [agents, setAgents] = useState<Array<{ id: string; name: string }>>([]);
  const [modelCatalog, setModelCatalog] = useState<Array<{ provider: string; label: string; models: string[] }> | null>(null);
  const [voices, setVoices] = useState<Array<{ id: string; name: string }>>([]);
  const [allNumbers, setAllNumbers] = useState<Array<{ id: string; phone_e164: string; provider: string; vapi_phone_number_id: string | null }>>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function load() {
    const r = await fetchCached<{ campaign: Campaign; numbers: PoolNumber[]; agentChangedSincePublish: boolean }>(`/voice/campaigns/${id}`);
    setCampaign(r.campaign);
    setNumbers(r.numbers);
    setAgentChanged(r.agentChangedSincePublish);
  }

  useEffect(() => {
    load().catch((err) => setError(err instanceof ApiError ? err.message : "Failed to load campaign."));
    api<{ agents: Array<{ id: string; name: string }> }>("/voice/agents").then((r) => setAgents(r.agents));
    api<{ providers: Array<{ provider: string; label: string; models: string[] }> }>("/voice/agents/models")
      .then((r) => setModelCatalog(r.providers))
      .catch(() => setModelCatalog([]));
    api<{ voices: Array<{ id: string; name: string }> }>("/voice/voices").then((r) => setVoices(r.voices));
    api<{ phoneNumbers: typeof allNumbers }>("/voice/phone-numbers").then((r) => setAllNumbers(r.phoneNumbers));
  }, [id]);

  useOrgEvents((e) => {
    if (e.campaignId === id && (e.type === "campaign_status" || e.type === "call_ended" || e.type === "campaign_published")) load();
    if (e.type === "call_status") load();
  });

  const dirty = Object.keys(draft).length > 0;

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  function value<K extends FieldKey>(key: K): any {
    if (key in draft) return draft[key];
    return campaign ? (campaign as any)[FIELDS[key]] : undefined;
  }
  function set<K extends FieldKey>(key: K, v: any) {
    setDraft((d) => {
      const next = { ...d, [key]: v };
      if (campaign && JSON.stringify((campaign as any)[FIELDS[key]]) === JSON.stringify(v)) delete next[key];
      return next;
    });
  }

  async function act(key: string, fn: () => Promise<string | void>) {
    setError(null);
    setMessage(null);
    setBusy(key);
    try {
      const msg = await fn();
      if (msg) setMessage(msg);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Request failed.");
    } finally {
      setBusy(null);
    }
  }

  async function saveDraft() {
    if (!dirty) return;
    await api(`/voice/campaigns/${id}`, { method: "PATCH", body: draft });
    setDraft({});
  }

  // One Save: stores the edits and makes them live for new calls at once.
  async function saveAndPublish() {
    await act("publish", async () => {
      await saveDraft();
      setWarnings([]);
      const r = await api<{ version: number; warnings: string[] }>(`/voice/campaigns/${id}/publish`, {
        method: "POST",
        body: { confirmAgentChange: true },
      });
      setWarnings(r.warnings);
      return `Saved — version ${r.version} is live. New calls use it now; calls already in progress finish on the previous version.`;
    });
  }

  async function control(action: string, extra: Record<string, unknown> = {}) {
    await act(action, async () => {
      await api(`/voice/campaigns/${id}/control`, { method: "POST", body: { action, ...extra } });
      return {
        start: "Campaign started.",
        resume: "Campaign resumed.",
        pause: "Campaign paused. Calls in progress will finish.",
        stop: "Campaign stopped.",
        restart: "Campaign restarted — leads were requeued.",
        schedule: "Campaign scheduled.",
      }[action];
    });
  }

  if (!campaign) {
    return error ? <div className="text-sm text-red-600">{error}</div> : (<div className="space-y-3 animate-fade-in" aria-busy="true" aria-label="Loading">
          <div className="skeleton h-5 w-1/3" />
          <div className="skeleton h-4 w-2/3" />
          <div className="skeleton h-24 w-full" />
        </div>);
  }

  const window_: CallingWindow = value("callingHours");
  const status = campaign.status;
  const canStart = can("campaign.start");

  return (
    <div className="max-w-6xl pb-24">
      <div className="flex flex-wrap items-start justify-between gap-4 mb-4">
        <div>
          <Link to="/voice/campaigns" className="text-xs text-slate-500 hover:text-slate-700">← Campaigns</Link>
          <div className="flex items-center gap-3 mt-1">
            <h1 className="text-2xl font-semibold text-slate-900">{campaign.name}</h1>
            <StatusPill status={status} />
          </div>
          <div className="text-xs text-slate-500 mt-1">
            {campaign.published_version ? `Live version v${campaign.published_version} · published ${new Date(campaign.published_at!).toLocaleString()}` : "Not published yet"}
            {status === "scheduled" && campaign.scheduled_start_at && ` · starts ${new Date(campaign.scheduled_start_at).toLocaleString()}`}
          </div>
        </div>
        {canStart && (
          <div className="flex flex-wrap gap-2">
            {(status === "draft" || status === "completed" || status === "stopped") && (
              <button disabled={busy !== null} onClick={() => control("start")} className={btnPrimary}>Start</button>
            )}
            {status === "paused" && <button disabled={busy !== null} onClick={() => control("resume")} className={btnPrimary}>Resume</button>}
            {status === "active" && <button disabled={busy !== null} onClick={() => control("pause")} className={btnDark}>Pause</button>}
            {(status === "active" || status === "paused" || status === "scheduled") && (
              <button
                disabled={busy !== null}
                onClick={() => {
                  const endLiveCalls = campaign.live_calls > 0 && confirm(`End the ${campaign.live_calls} call(s) in progress too? Cancel lets them finish.`);
                  control("stop", { endLiveCalls });
                }}
                className={btnGhost}
              >
                Stop
              </button>
            )}
            {(status === "completed" || status === "stopped") && (
              <button disabled={busy !== null} onClick={() => confirm("Requeue every lead (except DNC) and start over?") && control("restart")} className={btnGhost}>
                Restart
              </button>
            )}
            {status !== "active" && <ScheduleButton timeZone={campaign.time_zone} disabled={busy !== null} onSchedule={(at) => control("schedule", { scheduledStartAt: at })} />}
            {(status === "draft" || status === "stopped" || status === "completed") && (
              <button
                disabled={busy !== null}
                onClick={() =>
                  confirm("Delete this campaign? Call records are kept.") &&
                  act("delete", async () => {
                    await api(`/voice/campaigns/${id}`, { method: "DELETE" });
                    navigate("/voice");
                  })
                }
                className="text-sm text-slate-500 hover:text-red-600 px-2"
              >
                Delete
              </button>
            )}
          </div>
        )}
      </div>

      {campaign.paused_reason && <div className="mb-3 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-md p-2">Paused automatically: {campaign.paused_reason}</div>}
      {error && <div className="mb-3 text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-2">{error}</div>}
      {message && <div className="mb-3 text-sm text-green-700 bg-green-50 border border-green-200 rounded-md p-2">{message}</div>}
      {warnings.map((w) => <div key={w} className="mb-3 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-md p-2">{w}</div>)}

      <div className="grid grid-cols-3 md:grid-cols-6 lg:grid-cols-9 gap-2 mb-6">
        {[
          ["Leads", campaign.total_leads],
          ["Remaining", campaign.leads_remaining],
          ["Live", campaign.live_calls],
          ["Calls", campaign.total_calls],
          ["Connected", campaign.connected_calls],
          ["Voicemail", campaign.voicemails],
          ["Interested", campaign.interested_leads],
          ["Transfers", campaign.transfers],
          ["Avg talk", formatSeconds(campaign.avg_talk_seconds)],
        ].map(([label, v]) => (
          <div key={label as string} className="bg-white border border-slate-200 rounded-lg p-2">
            <div className="text-xs text-slate-500">{label}</div>
            <div className="text-lg font-semibold text-slate-900">{v}</div>
          </div>
        ))}
      </div>

      <div className="flex gap-1 border-b border-slate-200 mb-4">
        {(["settings", "numbers", "leads", "versions"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium capitalize border-b-2 ${tab === t ? "border-red-600 text-red-600" : "border-transparent text-slate-500 hover:text-slate-700"}`}
          >
            {t === "numbers" ? `Number pool (${numbers.length})` : t}
          </button>
        ))}
      </div>

      {tab === "settings" && (
        <div className="space-y-4">
          <CallingNumbers campaignId={id!} pool={numbers} all={allNumbers} onChange={() => act("numbers", async () => undefined)} onError={setError} />
          <Section title="Agent & identity">
            <div className="grid md:grid-cols-2 gap-4">
              <Field label="Campaign name"><input value={value("name") ?? ""} onChange={(e) => set("name", e.target.value)} className={inputCls} /></Field>
              <Field label="AI agent">
                <select value={value("aiAgentId") ?? ""} onChange={(e) => set("aiAgentId", e.target.value || null)} className={inputCls}>
                  <option value="">Choose an agent…</option>
                  {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
                {value("aiAgentId") && <Link to={`/voice/agents/${value("aiAgentId")}`} className="text-xs text-red-600 hover:underline">Edit agent →</Link>}
              </Field>
              <Field label="Intro name" hint={'Spoken as "this is Ray with …". Use exactly how you\'re allowed to identify yourselves (e.g. "an authorized Spectrum Business reseller").'}>
                <input value={value("introName") ?? ""} onChange={(e) => set("introName", e.target.value)} className={inputCls} />
              </Field>
              <Field label="Voice override" hint="Leave empty to use the agent's voice.">
                <select value={value("voiceId") ?? ""} onChange={(e) => set("voiceId", e.target.value || null)} className={inputCls}>
                  <option value="">Agent's voice</option>
                  {voices.map((v) => <option key={v.id} value={v.id}>{(v as { label?: string }).label ?? v.name}</option>)}
                </select>
              </Field>
              <Field label="Callback number" hint="Read out when a lead asks how to reach you.">
                <input value={value("callbackNumber") ?? ""} onChange={(e) => set("callbackNumber", e.target.value)} className={inputCls} placeholder="+13023423925" />
              </Field>
              <Field label="Recording disclosure">
                <label className="flex items-center gap-2 text-sm text-slate-700 py-2">
                  <input type="checkbox" checked={Boolean(value("recordingDisclosure"))} onChange={(e) => set("recordingDisclosure", e.target.checked)} />
                  Say "This call may be recorded for quality purposes." in the opening
                </label>
              </Field>
              <Field label="Office background sound">
                <label className="flex items-center gap-2 text-sm text-slate-700 py-2">
                  <input type="checkbox" checked={value("backgroundSound") !== false} onChange={(e) => set("backgroundSound", e.target.checked)} />
                  Soft office ambience behind the agent so calls sound like a real call center
                </label>
              </Field>
              <Field label="AI model (from VAPI)">
                {(() => {
                  const agent = agents.find((a) => a.id === value("aiAgentId")) as { llm_model?: string | null; llm_provider?: string | null } | undefined;
                  const prov = value("llmProvider") as string | null;
                  const model = value("llmModel") as string | null;
                  const current = prov ? `${prov}|${model}` : "";
                  const known = !prov || modelCatalog?.some((p) => p.provider === prov && p.models.includes(model ?? ""));
                  return (
                    <>
                      <select
                        value={current}
                        onChange={(e) => {
                          const [p, ...m] = e.target.value.split("|");
                          set("llmProvider", p || null);
                          if (p) set("llmModel", m.join("|"));
                        }}
                        className={inputCls}
                      >
                        <option value="">Use the agent's model{agent?.llm_model ? ` (${agent.llm_provider ?? "openai"} · ${agent.llm_model})` : ""}</option>
                        {!known && prov && <option value={current}>{prov} · {model} (not offered by VAPI anymore)</option>}
                        {(modelCatalog ?? []).map((p) => (
                          <optgroup key={p.provider} label={p.provider === "anthropic" ? "Anthropic (Claude)" : p.label}>
                            {p.models.map((m) => <option key={m} value={`${p.provider}|${m}`}>{m}</option>)}
                          </optgroup>
                        ))}
                      </select>
                      <span className="text-[11px] text-slate-400">
                        {modelCatalog === null ? "Loading VAPI's model list…" : modelCatalog.length ? "Live list from VAPI. Saving checks the model with VAPI before any call uses it." : "Couldn't load VAPI's model list right now."}
                      </span>
                    </>
                  );
                })()}
              </Field>
              <Field label="Max call length (minutes)">
                <input type="number" min={1} max={60} value={Math.round((value("maxCallDurationSeconds") ?? 600) / 60)} onChange={(e) => set("maxCallDurationSeconds", Number(e.target.value) * 60)} className={inputCls} />
              </Field>
            </div>
          </Section>

          <Section title="Transfer numbers">
            <p className="text-xs text-slate-500 -mt-1">
              When the caller agrees, the agent transfers them to the matching line. The main number is used for sales and for any team left
              empty. With no number set the agent books a callback instead. Any format works — it's saved as E.164 (+13025550100).
            </p>
            {!value("transferNumber") && !Object.values(value("transferTargets") ?? {}).some(Boolean) && (
              <div className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-md p-2">No transfer number set — this campaign can't transfer calls.</div>
            )}
            <div className="grid md:grid-cols-2 gap-4">
              <Field label="Main transfer number (sales)" hint="Pricing, availability, promotions, contracts, new sales.">
                <input value={value("transferNumber") ?? ""} onChange={(e) => set("transferNumber", e.target.value)} className={inputCls} placeholder="+13025550100" />
              </Field>
              {(["support", "retention", "manager"] as const).map((dept) => (
                <Field
                  key={dept}
                  label={dept[0].toUpperCase() + dept.slice(1)}
                  hint={
                    dept === "support"
                      ? "Technical issues, billing, outages, installation."
                      : dept === "retention"
                        ? "Cancellations, dissatisfied customers, competitor offers."
                        : "Legal concerns, threats, escalated complaints, media."
                  }
                >
                  <input
                    value={(value("transferTargets") ?? {})[dept] ?? ""}
                    onChange={(e) => set("transferTargets", { ...(value("transferTargets") ?? {}), [dept]: e.target.value })}
                    className={inputCls}
                    placeholder="+1…"
                  />
                </Field>
              ))}
            </div>
          </Section>

          <Section title="Script & knowledge">
            <Field label="Campaign script" hint="Talking points for this campaign, added on top of the agent's instructions. Placeholders like [first name] or {Company} are normalised on save.">
              <textarea rows={8} value={value("script") ?? ""} onChange={(e) => set("script", e.target.value)} className={`${inputCls} font-mono text-xs`} />
            </Field>
            <Field label="Knowledge base" hint="Facts the agent can look up mid-call (offers, coverage, pricing rules). Split topics with blank lines.">
              <textarea rows={6} value={value("knowledgeText") ?? ""} onChange={(e) => set("knowledgeText", e.target.value)} className={`${inputCls} font-mono text-xs`} />
            </Field>
          </Section>

          <Section title="Calling window & pacing">
            <div className="flex flex-wrap gap-2 mb-3">
              {DAYS.map((d, i) => {
                const on = window_.days.includes(i);
                return (
                  <button
                    type="button"
                    key={d}
                    onClick={() => set("callingHours", { ...window_, days: on ? window_.days.filter((x) => x !== i) : [...window_.days, i].sort() })}
                    className={`text-xs px-3 py-1.5 rounded-md border ${on ? "bg-red-600 text-white border-red-600" : "bg-white text-slate-600 border-slate-300"}`}
                  >
                    {d}
                  </button>
                );
              })}
            </div>
            <div className="grid md:grid-cols-4 gap-4">
              <Field label="From"><input type="time" value={window_.start} onChange={(e) => set("callingHours", { ...window_, start: e.target.value })} className={inputCls} /></Field>
              <Field label="Until"><input type="time" value={window_.end} onChange={(e) => set("callingHours", { ...window_, end: e.target.value })} className={inputCls} /></Field>
              <Field label="Campaign time zone">
                <select value={value("timeZone")} onChange={(e) => set("timeZone", e.target.value)} className={inputCls}>
                  {TIME_ZONES.map((t) => <option key={t}>{t}</option>)}
                </select>
              </Field>
              <Field label="Lunch break">
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={Boolean(window_.lunchBreak)}
                    onChange={(e) => set("callingHours", { ...window_, lunchBreak: e.target.checked ? { start: "12:00", end: "13:00" } : null })}
                  />
                  {window_.lunchBreak && (
                    <>
                      <input type="time" value={window_.lunchBreak.start} onChange={(e) => set("callingHours", { ...window_, lunchBreak: { ...window_.lunchBreak!, start: e.target.value } })} className={`${inputCls} py-1`} />
                      <input type="time" value={window_.lunchBreak.end} onChange={(e) => set("callingHours", { ...window_, lunchBreak: { ...window_.lunchBreak!, end: e.target.value } })} className={`${inputCls} py-1`} />
                    </>
                  )}
                </div>
              </Field>
            </div>
            <label className="flex items-center gap-2 text-sm text-slate-700 mt-3">
              <input type="checkbox" checked={window_.useLeadTimeZone} onChange={(e) => set("callingHours", { ...window_, useLeadTimeZone: e.target.checked })} />
              Use each lead's local time (from their time zone or state) instead of the campaign time zone
            </label>
            <div className="grid md:grid-cols-5 gap-4 mt-4">
              <Field label="Concurrent calls"><input type="number" min={1} max={50} value={value("concurrency")} onChange={(e) => set("concurrency", Number(e.target.value))} className={inputCls} /></Field>
              <Field label="Max attempts / lead"><input type="number" min={1} max={10} value={value("maxAttempts")} onChange={(e) => set("maxAttempts", Number(e.target.value))} className={inputCls} /></Field>
              <Field label="Retry delay (min)"><input type="number" min={5} value={value("retryDelayMinutes")} onChange={(e) => set("retryDelayMinutes", Number(e.target.value))} className={inputCls} /></Field>
              <Field label="Lead cooldown (h)" hint="Min gap between calls to the same lead."><input type="number" min={0} value={value("leadCooldownHours")} onChange={(e) => set("leadCooldownHours", Number(e.target.value))} className={inputCls} /></Field>
              <Field label="Ring timeout (s)"><input type="number" min={20} max={180} value={value("dialTimeoutSeconds")} onChange={(e) => set("dialTimeoutSeconds", Number(e.target.value))} className={inputCls} /></Field>
            </div>
          </Section>

          <Section title="Voicemail">
            <p className="text-sm text-slate-500">No voicemails are left: when an answering machine picks up, the agent hangs up right away and the call is marked Voicemail.</p>
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input type="checkbox" checked={Boolean(value("retryOnVoicemail"))} onChange={(e) => set("retryOnVoicemail", e.target.checked)} />
              Retry leads that went to voicemail (counts toward max attempts)
            </label>
          </Section>
        </div>
      )}

      {tab === "numbers" && (
        <NumberPool
          campaignId={id!}
          pool={numbers}
          all={allNumbers}
          onChange={() => act("numbers", async () => undefined)}
          onError={setError}
        />
      )}

      {tab === "leads" && <LeadsTab campaignId={id!} campaignActive={status === "active"} onChanged={load} />}

      {tab === "versions" && <VersionsTab campaignId={id!} publishedVersionId={campaign.published_version_id} />}

      {can("campaign.publish") && (
        <div className="fixed bottom-0 left-0 lg:left-60 right-0 z-20 border-t border-slate-200 bg-white/95 backdrop-blur">
          <div className="max-w-6xl mx-auto px-6 py-3 flex items-center justify-between gap-4">
            <div className="text-sm">
              {dirty ? (
                <span className="text-amber-700">Unsaved changes</span>
              ) : campaign.has_unpublished_changes || !campaign.published_version_id ? (
                <span className="text-amber-700">Changes not live yet — press Save to apply them</span>
              ) : agentChanged ? (
                <span className="text-amber-700">The agent changed since v{campaign.published_version} — press Save to use it</span>
              ) : (
                <span className="text-slate-500">Live calls use v{campaign.published_version}</span>
              )}
            </div>
            <div className="flex gap-2">
              {dirty && <button onClick={() => setDraft({})} className={btnGhost}>Discard</button>}
              <button disabled={busy !== null} onClick={saveAndPublish} className={btnPrimary}>
                {busy === "publish" ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-3">
      <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
      {children}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-medium text-slate-600 mb-1">{label}</label>
      {children}
      {hint && <p className="text-xs text-slate-400 mt-1">{hint}</p>}
    </div>
  );
}

function ScheduleButton({ timeZone, disabled, onSchedule }: { timeZone: string; disabled: boolean; onSchedule: (at: string) => void }) {
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState("");
  if (!open) return <button disabled={disabled} onClick={() => setOpen(true)} className={btnGhost}>Schedule…</button>;
  return (
    <div className="flex items-center gap-2">
      <input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} className={`${inputCls} py-1.5`} />
      <span className="text-xs text-slate-500">{timeZone}</span>
      <button disabled={disabled || !at} onClick={() => { onSchedule(at); setOpen(false); }} className={btnDark}>Set</button>
      <button onClick={() => setOpen(false)} className="text-xs text-slate-500">Cancel</button>
    </div>
  );
}

// Pick which Twilio numbers this campaign dials from — saved immediately.
function CallingNumbers(props: {
  campaignId: string;
  pool: PoolNumber[];
  all: Array<{ id: string; phone_e164: string; provider: string; vapi_phone_number_id: string | null }>;
  onChange: () => void;
  onError: (e: string) => void;
}) {
  const inPool = new Set(props.pool.map((n) => n.id));
  const usable = props.all.filter((n) => n.provider !== "plivo");
  const [busy, setBusy] = useState<string | null>(null);
  async function toggle(n: { id: string }, on: boolean) {
    setBusy(n.id);
    try {
      if (on) await api(`/voice/campaigns/${props.campaignId}/numbers`, { method: "POST", body: { phoneNumberIds: [n.id] } });
      else await api(`/voice/campaigns/${props.campaignId}/numbers/${n.id}`, { method: "DELETE" });
      props.onChange();
    } catch (err) {
      props.onError(err instanceof ApiError ? err.message : "Couldn't update the calling numbers.");
    } finally {
      setBusy(null);
    }
  }
  return (
    <Section title={`Calling numbers (${props.pool.length} selected)`}>
      <p className="text-xs text-slate-500 -mt-1">Twilio numbers this campaign dials from. The dialer prefers a number with the lead's area code, otherwise the least recently used one. Changes save immediately.</p>
      {!usable.length ? (
        <p className="text-sm text-slate-500">No numbers yet. Add or buy one under <Link to="/voice/numbers" className="text-red-600 hover:underline">Numbers</Link>.</p>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2">
          {usable.map((n) => {
            const on = inPool.has(n.id);
            const ready = Boolean(n.vapi_phone_number_id);
            return (
              <label key={n.id} className={`flex items-center gap-2.5 rounded-lg border px-3 py-2 text-sm cursor-pointer transition-colors ${on ? "border-red-300 bg-red-50/60" : "border-slate-200 hover:border-slate-300"} ${busy === n.id ? "opacity-60" : ""}`}>
                <input type="checkbox" checked={on} disabled={busy !== null || (!ready && !on)} onChange={(e) => toggle(n, e.target.checked)} />
                <span className="font-medium tabular-nums">{formatPhone(n.phone_e164)}</span>
                <span className="text-[11px] text-slate-400 uppercase">{n.provider}</span>
                {!ready && <span className="text-[11px] text-amber-700 ml-auto">not on VAPI — <Link to="/voice/numbers" className="underline">connect</Link></span>}
              </label>
            );
          })}
        </div>
      )}
      {props.pool.length === 0 && usable.length > 0 && <p className="text-xs text-amber-700">Select at least one number — the campaign can't dial without one.</p>}
    </Section>
  );
}

function NumberPool(props: {
  campaignId: string;
  pool: PoolNumber[];
  all: Array<{ id: string; phone_e164: string; provider: string; vapi_phone_number_id: string | null }>;
  onChange: () => void;
  onError: (e: string) => void;
}) {
  const inPool = new Set(props.pool.map((n) => n.id));
  const candidates = props.all.filter((n) => !inPool.has(n.id) && n.provider !== "plivo");
  const [selected, setSelected] = useState<string[]>([]);

  async function add() {
    try {
      await api(`/voice/campaigns/${props.campaignId}/numbers`, { method: "POST", body: { phoneNumberIds: selected } });
      setSelected([]);
      props.onChange();
    } catch (err) {
      props.onError(err instanceof ApiError ? err.message : "Failed to add numbers.");
    }
  }
  async function remove(numberId: string) {
    await api(`/voice/campaigns/${props.campaignId}/numbers/${numberId}`, { method: "DELETE" });
    props.onChange();
  }

  return (
    <div className="grid md:grid-cols-2 gap-4">
      <div className="bg-white border border-slate-200 rounded-xl p-4">
        <h2 className="text-sm font-semibold mb-1">In this campaign</h2>
        <p className="text-xs text-slate-500 mb-3">The dialer prefers a number with the lead's area code, otherwise the least recently used one.</p>
        <div className="space-y-1">
          {props.pool.map((n) => (
            <div key={n.id} className="flex items-center justify-between text-sm border-b border-slate-100 py-1.5">
              <span>
                {formatPhone(n.phone_e164)}
                {!n.vapi_phone_number_id && <span className="ml-2 text-xs text-amber-700">not connected to VAPI — won't dial</span>}
              </span>
              <span className="flex items-center gap-3">
                <span className="text-xs text-slate-400">{n.last_used_at ? `used ${new Date(n.last_used_at).toLocaleString()}` : "unused"}</span>
                <button onClick={() => remove(n.id)} className="text-xs text-slate-500 hover:text-red-600">Remove</button>
              </span>
            </div>
          ))}
          {props.pool.length === 0 && <div className="text-sm text-slate-500">No numbers yet. Add at least one VAPI-connected number before starting.</div>}
        </div>
      </div>
      <div className="bg-white border border-slate-200 rounded-xl p-4">
        <h2 className="text-sm font-semibold mb-3">Add numbers</h2>
        <div className="space-y-1 max-h-72 overflow-auto">
          {candidates.map((n) => (
            <label key={n.id} className="flex items-center gap-2 text-sm py-1">
              <input type="checkbox" checked={selected.includes(n.id)} onChange={(e) => setSelected(e.target.checked ? [...selected, n.id] : selected.filter((x) => x !== n.id))} />
              {formatPhone(n.phone_e164)}
              {!n.vapi_phone_number_id && <span className="text-xs text-amber-700">not on VAPI</span>}
            </label>
          ))}
          {candidates.length === 0 && (
            <div className="text-sm text-slate-500">
              No other numbers. <Link to="/voice/numbers" className="text-red-600 hover:underline">Buy or sync numbers</Link>.
            </div>
          )}
        </div>
        <button disabled={selected.length === 0} onClick={add} className={`${btnDark} mt-3`}>Add {selected.length || ""} to pool</button>
      </div>
    </div>
  );
}

const LEAD_STATUSES = ["", "queued", "retry_scheduled", "dialing", "done", "dnc"];
const LEAD_STATE_CODE: Record<string, string> = {
  queued: "QUEUE – Lead To Be Called",
  retry_scheduled: "RQXFER – Re-Queue",
  dialing: "INCALL – Lead Being Called",
  done: "Done",
  dnc: "DNC – Do Not Call",
};

function LeadsTab({ campaignId, campaignActive, onChanged }: { campaignId: string; campaignActive: boolean; onChanged: () => void }) {
  const [leads, setLeads] = useState<CampaignLead[]>([]);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [result, setResult] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [single, setSingle] = useState({ firstName: "", lastName: "", company: "", phone: "", state: "" });
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [dispositions, setDispositions] = useState<Record<string, { label: string; color: string }>>({});

  async function load() {
    const q = filter ? `?status=${filter}` : "";
    const r = await api<{ leads: CampaignLead[] }>(`/voice/campaigns/${campaignId}/leads${q}`);
    setLeads(r.leads);
  }
  useEffect(() => {
    load();
  }, [filter]);
  useEffect(() => {
    api<{ dispositions: Array<{ key: string; label: string; color: string }> }>("/voice/dispositions").then((r) =>
      setDispositions(Object.fromEntries(r.dispositions.map((d) => [d.key, d])))
    );
  }, []);

  async function upload(file: File) {
    setErr(null);
    setResult(null);
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`/api/voice/campaigns/${campaignId}/leads/import`, {
        method: "POST",
        credentials: "include",
        headers: { Authorization: `Bearer ${getAccessToken()}` },
        body: fd,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Import failed.");
      setResult(
        `Imported ${data.imported} lead(s)` +
          (data.duplicates ? `, skipped ${data.duplicates} duplicate(s)` : "") +
          (data.dncMarked ? `, ${data.dncMarked} on the DNC list (won't be called)` : "") +
          "." +
          (data.totalErrors ? ` ${data.totalErrors} row issue(s): ${data.errors.slice(0, 3).join(" ")}` : "")
      );
      await load();
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function addSingle() {
    setErr(null);
    try {
      await api(`/voice/campaigns/${campaignId}/leads/single`, { method: "POST", body: single });
      setSingle({ firstName: "", lastName: "", company: "", phone: "", state: "" });
      setResult("Lead added.");
      await load();
      onChanged();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Failed to add lead.");
    }
  }

  async function removeSelected() {
    if (!confirm(`Remove ${selected.length} lead(s) from this campaign?`)) return;
    const r = await api<{ removed: number }>(`/voice/campaigns/${campaignId}/leads/remove`, { method: "POST", body: { campaignLeadIds: selected } });
    setSelected([]);
    setResult(`Removed ${r.removed} lead(s). Leads mid-call are kept.`);
    await load();
    onChanged();
  }

  return (
    <div className="space-y-4">
      {err && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-2">{err}</div>}
      {result && <div className="text-sm text-green-700 bg-green-50 border border-green-200 rounded-md p-2">{result}</div>}
      <div className="grid md:grid-cols-2 gap-4">
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <h2 className="text-sm font-semibold mb-1">Import CSV / Excel</h2>
          <p className="text-xs text-slate-500 mb-3">
            Recognised columns: company, first/last name, phone, email, title, address, service address, city, state, zip, current provider, customer type (ALC / non-ALC), lines, locations, contract end date, time zone. Other columns become placeholders, e.g. a column "Account Rep" is usable as {"{{account_rep}}"}.
          </p>
          <input ref={fileRef} type="file" accept=".csv,.xlsx" disabled={uploading} onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} className="text-sm" />
          {uploading && <div className="text-xs text-slate-500 mt-2">Importing…</div>}
          {campaignActive && <p className="text-xs text-slate-500 mt-2">The campaign is running — new leads are picked up right away.</p>}
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <h2 className="text-sm font-semibold mb-3">Add one lead</h2>
          <div className="grid grid-cols-2 gap-2">
            <input placeholder="First name" value={single.firstName} onChange={(e) => setSingle({ ...single, firstName: e.target.value })} className={inputCls} />
            <input placeholder="Last name" value={single.lastName} onChange={(e) => setSingle({ ...single, lastName: e.target.value })} className={inputCls} />
            <input placeholder="Company" value={single.company} onChange={(e) => setSingle({ ...single, company: e.target.value })} className={inputCls} />
            <input placeholder="State (e.g. TX)" value={single.state} onChange={(e) => setSingle({ ...single, state: e.target.value })} className={inputCls} />
            <input placeholder="Phone" value={single.phone} onChange={(e) => setSingle({ ...single, phone: e.target.value })} className={`${inputCls} col-span-2`} />
          </div>
          <button disabled={!single.phone} onClick={addSingle} className={`${btnDark} mt-3`}>Add lead</button>
        </div>
      </div>

      <div className="flex items-center justify-between">
        <select value={filter} onChange={(e) => setFilter(e.target.value)} className={`${inputCls} w-48`}>
          {LEAD_STATUSES.map((s) => <option key={s} value={s}>{s ? LEAD_STATE_CODE[s] : "All statuses"}</option>)}
        </select>
        {selected.length > 0 && <button onClick={removeSelected} className={btnGhost}>Remove {selected.length} selected</button>}
      </div>

      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-500 text-xs uppercase">
            <tr>
              <th className="px-3 py-2 w-8">
                <input type="checkbox" checked={leads.length > 0 && selected.length === leads.length} onChange={(e) => setSelected(e.target.checked ? leads.map((l) => l.id) : [])} />
              </th>
              <th className="text-left px-3 py-2">Lead</th>
              <th className="text-left px-3 py-2">Phone</th>
              <th className="text-left px-3 py-2">State</th>
              <th className="text-left px-3 py-2">Status</th>
              <th className="text-left px-3 py-2">Attempts</th>
              <th className="text-left px-3 py-2">Last result</th>
              <th className="text-left px-3 py-2">Next attempt</th>
            </tr>
          </thead>
          <tbody>
            {leads.map((l) => {
              const d = l.last_disposition ? dispositions[l.last_disposition] : null;
              return (
                <tr key={l.id} className="border-t border-slate-100">
                  <td className="px-3 py-2"><input type="checkbox" checked={selected.includes(l.id)} onChange={(e) => setSelected(e.target.checked ? [...selected, l.id] : selected.filter((x) => x !== l.id))} /></td>
                  <td className="px-3 py-2">
                    <div className="font-medium text-slate-900">{[l.first_name, l.last_name].filter(Boolean).join(" ") || l.business_name}</div>
                    {(l.first_name || l.last_name) && <div className="text-xs text-slate-500">{l.business_name}</div>}
                  </td>
                  <td className="px-3 py-2 text-slate-600">{formatPhone(l.main_phone_e164)}{l.is_dnc && <span className="ml-1 text-xs text-red-600">DNC</span>}</td>
                  <td className="px-3 py-2 text-slate-500">{l.state ?? "—"}</td>
                  <td className="px-3 py-2 text-slate-600 whitespace-nowrap">{LEAD_STATE_CODE[l.status] ?? l.status}</td>
                  <td className="px-3 py-2 text-slate-600">{l.attempts}</td>
                  <td className="px-3 py-2">{d ? <DispositionBadge code={l.last_disposition} label={d.label} color={d.color} /> : l.last_disposition ?? "—"}</td>
                  <td className="px-3 py-2 text-xs text-slate-500">{l.next_attempt_at ? new Date(l.next_attempt_at).toLocaleString() : "—"}</td>
                </tr>
              );
            })}
            {leads.length === 0 && <tr><td colSpan={8} className="px-4 py-6 text-center text-slate-500">No leads{filter ? " with this status" : " yet"}.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function VersionsTab({ campaignId, publishedVersionId }: { campaignId: string; publishedVersionId: string | null }) {
  const [versions, setVersions] = useState<Version[]>([]);
  useEffect(() => {
    api<{ versions: Version[] }>(`/voice/campaigns/${campaignId}/versions`).then((r) => setVersions(r.versions));
  }, [campaignId, publishedVersionId]);
  const rows = useMemo(() => versions, [versions]);
  return (
    <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-slate-500 text-xs uppercase">
          <tr>
            <th className="text-left px-4 py-2">Version</th>
            <th className="text-left px-4 py-2">Published</th>
            <th className="text-left px-4 py-2">By</th>
            <th className="text-left px-4 py-2">Calls on this version</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((v) => (
            <tr key={v.id} className="border-t border-slate-100">
              <td className="px-4 py-2 font-medium">v{v.version} {v.id === publishedVersionId && <span className="ml-1 text-xs text-green-700">live</span>}</td>
              <td className="px-4 py-2 text-slate-600">{new Date(v.created_at).toLocaleString()}</td>
              <td className="px-4 py-2 text-slate-600">{v.published_by_name || "—"}</td>
              <td className="px-4 py-2 text-slate-600">{v.calls}</td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={4} className="px-4 py-6 text-center text-slate-500">Nothing published yet.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
