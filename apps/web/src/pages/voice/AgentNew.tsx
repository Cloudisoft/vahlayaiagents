import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, ApiError } from "../../lib/api.js";
import { btnGhost, btnPrimary, inputCls } from "../../lib/voice.js";

const AGENT_TYPES = ["sales", "support", "front_desk", "appointment_setter", "lead_qualification", "recruitment_interviewer", "follow_up", "custom"];
const TONES = ["calm", "polite", "professional", "friendly", "conversational", "confident", "persuasive", "direct"];
const MODELS = ["", "gpt-4o-mini", "gpt-4o", "gpt-4.1-mini", "gpt-4.1"];

interface Form {
  name: string;
  agentType: string;
  tone: string;
  voiceId: string;
  greeting: string;
  systemPrompt: string;
  llmModel: string;
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

  useEffect(() => {
    api<{ voices: Array<{ id: string; name: string }> }>("/voice/voices").then((r) => setVoices(r.voices));
    if (!id) return;
    api<{ agent: any }>(`/voice/agents/${id}`).then(({ agent: a }) => {
      setVapiId(a.vapi_assistant_id);
      setForm({
        name: a.name,
        agentType: a.agent_type,
        tone: a.tone,
        voiceId: a.voice_id ?? "",
        greeting: a.greeting ?? "",
        systemPrompt: a.system_prompt ?? "",
        llmModel: a.llm_model ?? "",
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
      temperature: form.temperature,
      fallbackBehavior: form.fallbackBehavior || null,
      endingBehavior: form.endingBehavior || undefined,
      transferRules: { transferNumber: form.transferNumber || null },
      maxCallDurationSeconds: form.maxCallDurationSeconds,
      faqs: form.faqs.filter((f) => f.question.trim() && f.answer.trim()),
      objectionHandling: form.objectionHandling.filter((o) => o.objection.trim() && o.response.trim()),
    };
    try {
      if (id) {
        await api(`/voice/agents/${id}`, { method: "PATCH", body });
        setSaved("Saved. Campaigns using this agent pick up the change on their next Save & publish.");
      } else {
        const r = await api<{ agent: { id: string } }>("/voice/agents", { method: "POST", body });
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
      {vapiId && (
        <div className="mb-4 text-xs text-slate-600 bg-slate-50 border border-slate-200 rounded-md p-2">
          Imported from VAPI assistant <span className="font-mono">{vapiId}</span>. Calls use this copy; re-run "Import from VAPI" to pull changes made in the VAPI dashboard.
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
              {voices.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
          </div>
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Opening line</label>
          <input value={form.greeting} onChange={(e) => set("greeting", e.target.value)} className={inputCls} />
          <p className="text-xs text-slate-500 mt-1">Placeholders: {"{{first_name}} {{agent_name}} {{intro_name}} {{company_name}} {{current_provider}}"} — unknown ones are dropped, never read aloud.</p>
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Instructions / SOP</label>
          <textarea rows={12} value={form.systemPrompt} onChange={(e) => set("systemPrompt", e.target.value)} className={`${inputCls} font-mono text-xs`} />
          <p className="text-xs text-slate-500 mt-1">Platform call rules (one question per turn, no interrupting, voicemail, DNC, callbacks) are added automatically.</p>
        </div>
        <div className="grid grid-cols-3 gap-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Model</label>
            <select value={form.llmModel} onChange={(e) => set("llmModel", e.target.value)} className={inputCls}>
              {MODELS.map((m) => <option key={m} value={m}>{m || "Campaign default"}</option>)}
            </select>
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
