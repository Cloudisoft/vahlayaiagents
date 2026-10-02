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
  const [numbers, setNumbers] = useState<Array<{ id: string; phone_e164: string; provider: string; vapi_phone_number_id: string | null }> | null>(null);
  const [pickedNumbers, setPickedNumbers] = useState<string[]>([]);
  const [catalog, setCatalog] = useState<Array<{ provider: string; label: string; models: string[] }> | null>(null);
  const [model, setModel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ agents: Array<{ id: string; name: string }> }>("/voice/agents").then((r) => setAgents(r.agents));
    api<{ templates: Template[] }>("/voice/agents/templates").then((r) => setTemplates(r.templates));
    api<{ phoneNumbers: NonNullable<typeof numbers> }>("/voice/phone-numbers")
      .then((r) => {
        const usable = r.phoneNumbers.filter((n) => n.provider !== "plivo");
        setNumbers(usable);
        setPickedNumbers(usable.filter((n) => n.vapi_phone_number_id).map((n) => n.id));
      })
      .catch(() => { setNumbers([]); setError("Couldn't load your phone numbers — refresh the page, or add numbers after creating the campaign."); });
    api<{ providers: Array<{ provider: string; label: string; models: string[] }> }>("/voice/agents/models").then((r) => setCatalog(r.providers)).catch(() => setCatalog([]));
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
      if (pickedNumbers.length) await api(`/voice/campaigns/${campaign.id}/numbers`, { method: "POST", body: { phoneNumberIds: pickedNumbers } });
      if (model) {
        const [llmProvider, ...m] = model.split("|");
        await api(`/voice/campaigns/${campaign.id}`, { method: "PATCH", body: { llmProvider, llmModel: m.join("|") } });
      }
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
          <label className="block text-sm font-medium text-slate-700 mb-1">Company name (intro)</label>
          <input value={introName} onChange={(e) => setIntroName(e.target.value)} className={inputCls} placeholder="Spectrum Business" />
          <p className="text-xs text-slate-500 mt-1">The company the agent calls from: "this is <em>agent name</em> with <em>Spectrum Business</em>". Put the company here, not the agent's name. You can change everything else on the next screen.</p>
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Calling numbers</label>
          {numbers === null ? (
            <p className="text-xs text-slate-500">Loading numbers…</p>
          ) : !numbers.length ? (
            <p className="text-xs text-slate-500">No numbers yet — add or buy one under Numbers. You can add them later too.</p>
          ) : (
            <div className="space-y-1">
              {numbers.map((n) => (
                <label key={n.id} className={`flex items-center gap-2 text-sm ${n.vapi_phone_number_id ? "" : "opacity-60"}`}>
                  <input type="checkbox" disabled={!n.vapi_phone_number_id} checked={pickedNumbers.includes(n.id)} onChange={(e) => setPickedNumbers(e.target.checked ? [...pickedNumbers, n.id] : pickedNumbers.filter((x) => x !== n.id))} />
                  <span className="tabular-nums">{n.phone_e164}</span>
                  <span className="text-[11px] text-slate-400 uppercase">{n.provider}</span>
                  {!n.vapi_phone_number_id && <span className="text-[11px] text-amber-700">not connected to VAPI</span>}
                </label>
              ))}
            </div>
          )}
          <p className="text-xs text-slate-500 mt-1">The Twilio numbers this campaign dials from.</p>
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">AI model (from VAPI)</label>
          <select value={model} onChange={(e) => setModel(e.target.value)} className={inputCls}>
            <option value="">Use the agent's model</option>
            {(catalog ?? []).map((p) => (
              <optgroup key={p.provider} label={p.provider === "anthropic" ? "Anthropic (Claude)" : p.label}>
                {p.models.map((m) => <option key={m} value={`${p.provider}|${m}`}>{m}</option>)}
              </optgroup>
            ))}
          </select>
          <p className="text-xs text-slate-500 mt-1">{catalog === null ? "Loading VAPI's model list…" : "Live list from VAPI, e.g. claude-haiku-4-5-20251001. Checked with VAPI when you save the campaign."}</p>
        </div>
        <button type="submit" disabled={busy} className={btnPrimary}>{busy ? "Creating…" : "Create and configure"}</button>
      </form>
    </div>
  );
}
