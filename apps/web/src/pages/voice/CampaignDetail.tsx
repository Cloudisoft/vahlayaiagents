import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api, ApiError } from "../../lib/api.js";

interface Campaign {
  id: string;
  name: string;
  status: string;
  concurrency: number;
  max_attempts: number;
  ai_agent_id: string | null;
}

interface CampaignLead {
  id: string;
  status: string;
  business_name: string;
  main_phone_e164: string;
}

export default function CampaignDetail() {
  const { id } = useParams();
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [leads, setLeads] = useState<CampaignLead[]>([]);
  const [lists, setLists] = useState<Array<{ id: string; name: string }>>([]);
  const [selectedList, setSelectedList] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const { campaign, leads } = await api<{ campaign: Campaign; leads: CampaignLead[] }>(`/voice/campaigns/${id}`);
    setCampaign(campaign);
    setLeads(leads);
    const { lists } = await api<{ lists: Array<{ id: string; name: string }> }>("/leadgen/lists");
    setLists(lists);
  }

  useEffect(() => {
    load();
  }, [id]);

  async function setStatus(status: string) {
    setError(null);
    setMessage(null);
    try {
      await api(`/voice/campaigns/${id}/status`, { method: "POST", body: { status } });
      await load();
      if (status === "active") setMessage("Campaign activated. Calls are placed by the queue worker (requires REDIS_URL and telephony credentials).");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
    }
  }

  async function addLeadsFromList() {
    if (!selectedList) return;
    const r = await api<{ added: number }>(`/voice/campaigns/${id}/leads`, { method: "POST", body: { leadListId: selectedList } });
    setMessage(`Added ${r.added} leads to the campaign.`);
    await load();
  }

  if (!campaign) return <div className="text-sm text-slate-500">Loading...</div>;

  return (
    <div className="max-w-4xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">{campaign.name}</h1>
          <span className="text-xs bg-slate-100 text-slate-600 rounded-full px-2 py-0.5">{campaign.status}</span>
        </div>
        <div className="flex gap-2">
          {campaign.status !== "active" && (
            <button onClick={() => setStatus("active")} className="text-sm bg-green-600 text-white rounded-md px-3 py-1.5 hover:bg-green-700">
              Start
            </button>
          )}
          {campaign.status === "active" && (
            <button onClick={() => setStatus("paused")} className="text-sm bg-amber-600 text-white rounded-md px-3 py-1.5 hover:bg-amber-700">
              Pause
            </button>
          )}
          <button onClick={() => setStatus("completed")} className="text-sm bg-slate-600 text-white rounded-md px-3 py-1.5 hover:bg-slate-700">
            Mark completed
          </button>
        </div>
      </div>

      {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-2">{error}</div>}
      {message && <div className="text-sm text-green-700 bg-green-50 border border-green-200 rounded-md p-2">{message}</div>}

      {!campaign.ai_agent_id && (
        <div className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-md p-3">
          No AI agent assigned yet — the campaign can't place calls until one is configured.
        </div>
      )}

      <div className="bg-white border border-slate-200 rounded-xl p-6">
        <h2 className="font-medium text-slate-900 mb-3">Add leads from a LeadGen list</h2>
        <div className="flex gap-2">
          <select value={selectedList} onChange={(e) => setSelectedList(e.target.value)} className="flex-1 border border-slate-300 rounded-md px-3 py-2 text-sm">
            <option value="">Select a list</option>
            {lists.map((l) => (
              <option key={l.id} value={l.id}>{l.name}</option>
            ))}
          </select>
          <button onClick={addLeadsFromList} className="text-sm bg-slate-900 text-white rounded-md px-4 py-2 hover:bg-slate-800">
            Add
          </button>
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-100 font-medium text-slate-900">Campaign leads ({leads.length})</div>
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-500 text-xs uppercase">
            <tr>
              <th className="text-left px-4 py-2">Business</th>
              <th className="text-left px-4 py-2">Phone</th>
              <th className="text-left px-4 py-2">Status</th>
            </tr>
          </thead>
          <tbody>
            {leads.map((l) => (
              <tr key={l.id} className="border-t border-slate-100">
                <td className="px-4 py-2">{l.business_name}</td>
                <td className="px-4 py-2 text-slate-500">{l.main_phone_e164}</td>
                <td className="px-4 py-2 text-slate-500">{l.status}</td>
              </tr>
            ))}
            {leads.length === 0 && (
              <tr>
                <td colSpan={3} className="px-4 py-6 text-center text-slate-500">No leads added yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
