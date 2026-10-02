import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError } from "../../lib/api.js";
import { btnPrimary, inputCls } from "../../lib/voice.js";

interface Template {
  key: string;
  name: string;
  suggestedCampaign: { introName: string; callbackNumber: string; knowledgeText?: string };
}

export default function CampaignNew() {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [agentId, setAgentId] = useState("");
  const [introName, setIntroName] = useState("");
  const [agents, setAgents] = useState<Array<{ id: string; name: string }>>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ agents: Array<{ id: string; name: string }> }>("/voice/agents").then((r) => setAgents(r.agents));
    api<{ templates: Template[] }>("/voice/agents/templates").then((r) => setTemplates(r.templates));
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      let aiAgentId = agentId || undefined;
      let callbackNumber: string | undefined;
      let knowledgeText: string | undefined;
      let intro = introName || undefined;
      if (agentId.startsWith("template:")) {
        const key = agentId.slice("template:".length);
        const r = await api<{ agent: { id: string }; suggestedCampaign: Template["suggestedCampaign"] }>(`/voice/agents/templates/${key}`, { method: "POST" });
        aiAgentId = r.agent.id;
        callbackNumber = r.suggestedCampaign.callbackNumber;
        knowledgeText = r.suggestedCampaign.knowledgeText;
        intro = intro ?? r.suggestedCampaign.introName;
      }
      const { campaign } = await api<{ campaign: { id: string } }>("/voice/campaigns", {
        method: "POST",
        body: { name, aiAgentId, introName: intro, callbackNumber, knowledgeText },
      });
      navigate(`/voice/campaigns/${campaign.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-xl">
      <h1 className="text-2xl font-semibold text-slate-900 mb-6">New Campaign</h1>
      {error && <div className="mb-4 text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-2">{error}</div>}
      <form onSubmit={onSubmit} className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Campaign name</label>
          <input required value={name} onChange={(e) => setName(e.target.value)} className={inputCls} placeholder="Spectrum Business – Dallas" />
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">AI agent</label>
          <select required value={agentId} onChange={(e) => setAgentId(e.target.value)} className={inputCls}>
            <option value="">Choose an agent…</option>
            {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            {templates.map((t) => <option key={t.key} value={`template:${t.key}`}>New from template: {t.name}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Intro name</label>
          <input value={introName} onChange={(e) => setIntroName(e.target.value)} className={inputCls} placeholder="Who the agent says it's calling for" />
          <p className="text-xs text-slate-500 mt-1">Spoken as "this is Ray with <em>intro name</em>". You can change everything else on the next screen.</p>
        </div>
        <button type="submit" disabled={busy} className={btnPrimary}>{busy ? "Creating…" : "Create and configure"}</button>
      </form>
    </div>
  );
}
