import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, ApiError } from "../../lib/api.js";
import { btnGhost, btnPrimary, inputCls } from "../../lib/voice.js";

const AGENT_TYPES = ["sales", "support", "front_desk", "appointment_setter", "lead_qualification", "recruitment_interviewer", "follow_up", "custom"];
const TONES = ["calm", "polite", "professional", "friendly", "conversational", "confident", "persuasive", "direct"];
interface Catalog {
  providers: Array<{ provider: string; label: string; models: string[] }>;
}

interface Form {
  name: string;
  agentType: string;
  tone: string;
  voiceId: string;
  greeting: string;
  systemPrompt: string;
  llmModel: string;
  llmProvider: string;
  temperature: number;
  fallbackBehavior: string;
  endingBehavior: string;
  transferNumber: string;
  maxCallDurationSeconds: number;
  faqs: Array<{ question: string; answer: string }>;
  objectionHandling: Array<{ objection: string; response: string }>;
}

const EMPTY: Form = {
  name: "",
  agentType: "sales",
  tone: "conversational",
  voiceId: "",
  greeting: "Hi {{first_name}}, this is {{agent_name}} with {{intro_name}}. How are you today?",
  systemPrompt: "",
  llmModel: "",
  llmProvider: "openai",
  temperature: 0.4,
  fallbackBehavior: "",
  endingBehavior: "",
  transferNumber: "",
  maxCallDurationSeconds: 600,
  faqs: [],
  objectionHandling: [],
};

export default function AgentNew() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [form, setForm] = useState<Form>(EMPTY);
  const [voices, setVoices] = useState<Array<{ id: string; name: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [vapiId, setVapiId] = useState<string | null>(null);
  const [vapiSync, setVapiSync] = useState<{ at: string | null; error: string | null }>({ at: null, error: null });
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);

  useEffect(() => {
    api<{ voices: Array<{ id: string; name: string }> }>("/voice/voices").then((r) => setVoices(r.voices));
    api<Catalog>("/voice/agents/models")
      .then(setCatalog)
      .catch((err) => setCatalogError(err instanceof ApiError ? err.message : "Couldn't load VAPI's model list."));
    if (!id) return;
    api<{ agent: any }>(`/voice/agents/${id}`).then(({ agent: a }) => {
      setVapiId(a.vapi_assistant_id);
      setVapiSync({ at: a.vapi_synced_at, error: a.vapi_sync_error });
      setForm({
        name: a.name,
        agentType: a.agent_type,
        tone: a.tone,
        voiceId: a.voice_id ?? "",
        greeting: a.greeting ?? "",
        systemPrompt: a.system_prompt ?? "",
        llmModel: a.llm_model ?? "",
        llmProvider: a.llm_provider ?? "openai",
        temperature: Number(a.temperature ?? 0.4),
        fallbackBehavior: a.fallback_behavior ?? "",
        endingBehavior: a.ending_behavior ?? "",
        transferNumber: a.transfer_rules?.transferNumber ?? "",
        maxCallDurationSeconds: a.max_call_duration_seconds ?? 600,
        faqs: a.faqs ?? [],
        objectionHandling: a.objection_handling ?? [],
      });
    });
  }, [id]);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(null);
    setBusy(true);
    const body = {
      name: form.name,
      agentType: form.agentType,
      tone: form.tone,
      voiceId: form.voiceId || undefined,
      greeting: form.greeting,
      systemPrompt: form.systemPrompt,
      llmModel: form.llmModel || null,
      llmProvider: form.llmProvider,
      temperature: form.temperature,
      fallbackBehavior: form.fallbackBehavior || null,
      endingBehavior: form.endingBehavior || undefined,
      transferRules: { transferNumber: form.transferNumber || null },
      maxCallDurationSeconds: form.maxCallDurationSeconds,
      faqs: form.faqs.filter((f) => f.question.trim() && f.answer.trim()),
      objectionHandling: form.objectionHandling.filter((o) => o.objection.trim() && o.response.trim()),
    };
    try {
      type SaveResult = { agent: { id: string; vapi_assistant_id: string | null }; vapiSync: { assistantId: string | null; error: string | null } };
      if (id) {
        const r = await api<SaveResult>(`/voice/agents/${id}`, { method: "PATCH", body });
        setVapiId(r.vapiSync.assistantId);
        setVapiSync({ at: r.vapiSync.error ? vapiSync.at : new Date().toISOString(), error: r.vapiSync.error });
        setSaved(
          r.vapiSync.error
            ? "Saved here. Campaigns using this agent pick it up on their next Save."
            : "Saved and updated in VAPI. Campaigns using this agent pick it up on their next Save."
        );
      } else {
        const r = await api<SaveResult>("/voice/agents", { method: "POST", body });
        navigate(`/voice/agents/${r.agent.id}`, { replace: true });
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!id || !confirm("Delete this agent? Campaigns using it will need a new agent before they can publish.")) return;
    await api(`/voice/agents/${id}`, { method: "DELETE" });
    navigate("/voice/agents");
  }

  return (
    <div className="max-w-3xl">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold text-slate-900">{id ? form.name || "Agent" : "New AI Agent"}</h1>
        {id && <button onClick={remove} className="text-sm text-slate-500 hover:text-red-600">Delete agent</button>}
      </div>
      {id && (
        <div
          className={`mb-4 text-xs rounded-md p-2 border flex items-center justify-between gap-3 ${
            vapiSync.error ? "text-amber-800 bg-amber-50 border-amber-200" : "text-slate-600 bg-slate-50 border-slate-200"
          }`}
        >
          <span>
            {vapiSync.error ? (
              <>VAPI not updated: {vapiSync.error}</>
            ) : vapiId ? (
              <>
                Synced to VAPI assistant <span className="font-mono">{vapiId}</span>
                {vapiSync.at && <> · {new Date(vapiSync.at).toLocaleString()}</>}. Every save updates it.
              </>
            ) : (
              <>Not in VAPI yet — saving creates the assistant there.</>
            )}
          </span>
          <button
            type="button"
            className="shrink-0 underline hover:text-slate-900"
            onClick={async () => {
              try {
                const r = await api<{ assistantId: string }>(`/voice/agents/${id}/sync-vapi`, { method: "POST" });
                setVapiId(r.assistantId);
                setVapiSync({ at: new Date().toISOString(), error: null });
              } catch (err) {
                setVapiSync((v) => ({ ...v, error: err instanceof ApiError ? err.message : "Sync failed." }));
              }
            }}
          >
            Sync now
          </button>
        </div>
      )}
      {error && <div className="mb-4 text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-2">{error}</div>}
      {saved && <div className="mb-4 text-sm text-green-700 bg-green-50 border border-green-200 rounded-md p-2">{saved}</div>}
      <form onSubmit={onSubmit} className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Name</label>
          <input required value={form.name} onChange={(e) => set("name", e.target.value)} className={inputCls} />
        </div>
        <div className="grid grid-cols-3 gap-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Agent type</label>
            <select value={form.agentType} onChange={(e) => set("agentType", e.target.value)} className={inputCls}>
              {AGENT_TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, " ")}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Tone</label>
            <select value={form.tone} onChange={(e) => set("tone", e.target.value)} className={inputCls}>
              {TONES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Voice (Cartesia)</label>
            <select value={form.voiceId} onChange={(e) => set("voiceId", e.target.value)} className={inputCls}>
              <option value="">No voice assigned</option>
              {voices.map((v) => <option key={v.id} value={v.id}>{(v as { label?: string }).label ?? v.name}</option>)}
            </select>
          </div>
        </div>
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">
          <div className="font-medium text-slate-700 mb-1">Opening line (same on every outbound call)</div>
          <div className="text-slate-700">“Hi, am I speaking with <em>first name</em>? This is <em>agent name</em> from <em>campaign’s company</em>. How are you doing today?”</div>
          <div className="text-xs text-slate-500 mt-1">
            Leads without a name get: “Hi, this is <em>agent name</em> from <em>company</em>. How are you doing today?” The agent then confirms the name,
            business, email and phone on file, and before closing captures the best time to call, an alternate number, email and availability.
          </div>
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">SOP / instructions — the agent's source of truth</label>
          <textarea rows={12} value={form.systemPrompt} onChange={(e) => set("systemPrompt", e.target.value)} className={`${inputCls} font-mono text-xs`} />
          <p className="text-xs text-slate-500 mt-1">The agent follows this SOP and the campaign script exactly; they override its personality, FAQs and its own judgement. Only the call-safety rules (Do Not Call, AI honesty, no voicemails) come before it.</p>
        </div>
        <div className="grid grid-cols-[2fr_1fr_1fr] gap-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">AI model (from VAPI)</label>
            <div className="flex gap-2">
              <select
                value={form.llmProvider}
                onChange={(e) => setForm((f) => ({ ...f, llmProvider: e.target.value, llmModel: "" }))}
                className={`${inputCls} w-28`}
                aria-label="Model provider"
              >
                {(catalog?.providers ?? [{ provider: "openai", label: "OpenAI", models: [] }]).map((p) => (
                  <option key={p.provider} value={p.provider}>{p.label}</option>
                ))}
              </select>
              <select value={form.llmModel} onChange={(e) => set("llmModel", e.target.value)} className={inputCls} aria-label="Model">
                <option value="">Campaign default (gpt-4o-mini)</option>
                {form.llmModel && !catalog?.providers.find((p) => p.provider === form.llmProvider)?.models.includes(form.llmModel) && (
                  <option value={form.llmModel}>{form.llmModel}</option>
                )}
                {catalog?.providers
                  .find((p) => p.provider === form.llmProvider)
                  ?.models.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
            {catalogError && <p className="text-xs text-amber-700 mt-1">{catalogError}</p>}
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Temperature: {form.temperature.toFixed(1)}</label>
            <input type="range" min={0} max={1} step={0.1} value={form.temperature} onChange={(e) => set("temperature", Number(e.target.value))} className="w-full" />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Max call length (min)</label>
            <input type="number" min={1} max={60} value={Math.round(form.maxCallDurationSeconds / 60)} onChange={(e) => set("maxCallDurationSeconds", Number(e.target.value) * 60)} className={inputCls} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Transfer number</label>
            <input value={form.transferNumber} onChange={(e) => set("transferNumber", e.target.value)} className={inputCls} placeholder="+13025550100" />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">When unsure, the agent should…</label>
            <input value={form.fallbackBehavior} onChange={(e) => set("fallbackBehavior", e.target.value)} className={inputCls} placeholder="Offer a callback from a specialist" />
          </div>
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Closing statement</label>
          <input value={form.endingBehavior} onChange={(e) => set("endingBehavior", e.target.value)} className={inputCls} placeholder="Thank you for your time today. We appreciate the opportunity to assist you. Have a wonderful day." />
          <p className="text-xs text-slate-500 mt-1">Spoken right before the agent hangs up.</p>
        </div>

        <ListEditor
          title="FAQs"
          items={form.faqs}
          a="question"
          b="answer"
          onChange={(v) => set("faqs", v)}
        />
        <ListEditor
          title="Objection handling"
          items={form.objectionHandling}
          a="objection"
          b="response"
          onChange={(v) => set("objectionHandling", v)}
        />

        <button type="submit" disabled={busy} className={btnPrimary}>
          {busy ? "Saving…" : id ? "Save agent" : "Create agent"}
        </button>
      </form>
    </div>
  );
}

function ListEditor<A extends string, B extends string>(props: {
  title: string;
  items: Array<Record<A | B, string>>;
  a: A;
  b: B;
  onChange: (items: Array<Record<A | B, string>>) => void;
}) {
  const { items, a, b, onChange } = props;
  const update = (i: number, key: A | B, value: string) => onChange(items.map((it, j) => (j === i ? { ...it, [key]: value } : it)));
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <label className="text-sm font-medium text-slate-700">{props.title}</label>
        <button type="button" onClick={() => onChange([...items, { [a]: "", [b]: "" } as Record<A | B, string>])} className={`${btnGhost} py-1 text-xs`}>+ Add</button>
      </div>
      <div className="space-y-2">
        {items.map((it, i) => (
          <div key={i} className="grid grid-cols-[1fr_2fr_auto] gap-2">
            <input value={it[a]} onChange={(e) => update(i, a, e.target.value)} placeholder={a} className={inputCls} />
            <input value={it[b]} onChange={(e) => update(i, b, e.target.value)} placeholder={b} className={inputCls} />
            <button type="button" onClick={() => onChange(items.filter((_, j) => j !== i))} className="text-slate-400 hover:text-red-600 px-2">×</button>
          </div>
        ))}
        {items.length === 0 && <div className="text-xs text-slate-400">None yet.</div>}
      </div>
    </div>
  );
}
