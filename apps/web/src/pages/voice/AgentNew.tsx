import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError } from "../../lib/api.js";

const AGENT_TYPES = ["sales", "support", "front_desk", "appointment_setter", "lead_qualification", "recruitment_interviewer", "follow_up", "custom"];
const TONES = ["calm", "polite", "professional", "friendly", "conversational", "confident", "persuasive", "direct"];

export default function AgentNew() {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [agentType, setAgentType] = useState("sales");
  const [tone, setTone] = useState("professional");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [greeting, setGreeting] = useState("");
  const [voiceId, setVoiceId] = useState("");
  const [voices, setVoices] = useState<Array<{ id: string; name: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ voices: Array<{ id: string; name: string }> }>("/voice/voices").then((r) => setVoices(r.voices));
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api("/voice/agents", {
        method: "POST",
        body: { name, agentType, tone, systemPrompt, greeting, voiceId: voiceId || undefined },
      });
      navigate("/voice");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-semibold text-slate-900 mb-6">New AI Agent</h1>
      {error && <div className="mb-4 text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-2">{error}</div>}
      <form onSubmit={onSubmit} className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Name</label>
          <input required value={name} onChange={(e) => setName(e.target.value)} className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm" />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Agent type</label>
            <select value={agentType} onChange={(e) => setAgentType(e.target.value)} className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm">
              {AGENT_TYPES.map((t) => (
                <option key={t} value={t}>{t.replace(/_/g, " ")}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Tone</label>
            <select value={tone} onChange={(e) => setTone(e.target.value)} className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm">
              {TONES.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </div>
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Voice</label>
          <select value={voiceId} onChange={(e) => setVoiceId(e.target.value)} className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm">
            <option value="">No voice assigned yet</option>
            {voices.map((v) => (
              <option key={v.id} value={v.id}>{v.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Greeting</label>
          <input value={greeting} onChange={(e) => setGreeting(e.target.value)} className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm" />
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">System prompt / SOP</label>
          <textarea rows={6} value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm" />
        </div>
        <button type="submit" disabled={busy} className="bg-indigo-600 text-white text-sm font-medium rounded-md px-4 py-2 hover:bg-indigo-700 disabled:opacity-50">
          {busy ? "Creating..." : "Create agent"}
        </button>
      </form>
    </div>
  );
}
