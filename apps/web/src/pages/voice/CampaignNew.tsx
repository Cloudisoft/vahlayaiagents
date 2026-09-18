import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError } from "../../lib/api.js";

export default function CampaignNew() {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [agentId, setAgentId] = useState("");
  const [leadListId, setLeadListId] = useState("");
  const [concurrency, setConcurrency] = useState(1);
  const [agents, setAgents] = useState<Array<{ id: string; name: string }>>([]);
  const [lists, setLists] = useState<Array<{ id: string; name: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ agents: Array<{ id: string; name: string }> }>("/voice/agents").then((r) => setAgents(r.agents));
    api<{ lists: Array<{ id: string; name: string }> }>("/leadgen/lists").then((r) => setLists(r.lists));
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const { campaign } = await api<{ campaign: { id: string } }>("/voice/campaigns", {
        method: "POST",
        body: { name, aiAgentId: agentId || undefined, leadListId: leadListId || undefined, concurrency },
      });
      navigate(`/voice/campaigns/${campaign.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-semibold text-slate-900 mb-6">New Campaign</h1>
      {error && <div className="mb-4 text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-2">{error}</div>}
      <form onSubmit={onSubmit} className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Campaign name</label>
          <input required value={name} onChange={(e) => setName(e.target.value)} className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm" />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">AI Agent</label>
            <select value={agentId} onChange={(e) => setAgentId(e.target.value)} className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm">
              <option value="">Select later</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Lead list</label>
            <select value={leadListId} onChange={(e) => setLeadListId(e.target.value)} className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm">
              <option value="">None yet</option>
              {lists.map((l) => (
                <option key={l.id} value={l.id}>{l.name}</option>
              ))}
            </select>
          </div>
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Concurrency</label>
          <input type="number" min={1} max={50} value={concurrency} onChange={(e) => setConcurrency(Number(e.target.value))} className="w-32 border border-slate-300 rounded-md px-3 py-2 text-sm" />
        </div>
        <button type="submit" disabled={busy} className="bg-indigo-600 text-white text-sm font-medium rounded-md px-4 py-2 hover:bg-indigo-700 disabled:opacity-50">
          {busy ? "Creating..." : "Create campaign"}
        </button>
      </form>
    </div>
  );
}
