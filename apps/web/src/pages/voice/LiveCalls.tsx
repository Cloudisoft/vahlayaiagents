import { useEffect, useRef, useState } from "react";
import { api } from "../../lib/api.js";
import { getAccessToken } from "../../lib/api.js";

interface ActiveCall {
  id: string;
  status: string;
  to_number: string;
  started_at: string | null;
  lead_name: string | null;
  agent_name: string | null;
}

interface TranscriptTurn {
  speaker: string;
  text: string;
}

export default function LiveCalls() {
  const [calls, setCalls] = useState<ActiveCall[]>([]);
  const [selectedCall, setSelectedCall] = useState<string | null>(null);
  const [transcripts, setTranscripts] = useState<Record<string, TranscriptTurn[]>>({});
  const [transferTo, setTransferTo] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  async function loadActive() {
    const { calls } = await api<{ calls: ActiveCall[] }>("/voice/calls/active");
    setCalls(calls);
  }

  useEffect(() => {
    loadActive();
    const interval = setInterval(loadActive, 5000);

    const token = getAccessToken();
    if (token) {
      const proto = window.location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${proto}://${window.location.host}/ws?token=${token}`);
      wsRef.current = ws;
      ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.type === "transcript_turn") {
          setTranscripts((prev) => ({
            ...prev,
            [data.callId]: [...(prev[data.callId] ?? []), { speaker: data.speaker, text: data.text }],
          }));
        } else if (data.type === "call_status") {
          loadActive();
        }
      };
    }

    return () => {
      clearInterval(interval);
      wsRef.current?.close();
    };
  }, []);

  async function transfer(callId: string) {
    if (!transferTo) return;
    setMessage(null);
    try {
      await api(`/voice/calls/${callId}/transfer`, { method: "POST", body: { transferTo } });
      setMessage("Transfer initiated.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Transfer failed.");
    }
  }

  async function endCall(callId: string) {
    setMessage(null);
    try {
      await api(`/voice/calls/${callId}/end`, { method: "POST" });
      setMessage("End call requested.");
      await loadActive();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "End call failed.");
    }
  }

  return (
    <div className="max-w-5xl space-y-6">
      <h1 className="text-2xl font-semibold text-slate-900">Live Calls</h1>
      <p className="text-sm text-slate-500">
        Real-time transcript streams over the platform's own connection. Listen/whisper (live audio bridging) require a
        media-streaming telephony integration and aren't implemented — transfer and end-call are real actions.
      </p>

      {message && <div className="text-sm text-slate-700 bg-slate-100 rounded-md p-2">{message}</div>}

      {calls.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-xl p-8 text-center text-sm text-slate-500">
          No active calls right now.
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4">
          {calls.map((c) => (
            <div key={c.id} className="bg-white border border-slate-200 rounded-xl p-4">
              <div className="flex justify-between items-center mb-2">
                <span className="font-medium text-slate-900">{c.lead_name ?? c.to_number}</span>
                <span className="text-xs bg-green-100 text-green-700 rounded-full px-2 py-0.5">{c.status}</span>
              </div>
              <div className="text-xs text-slate-500 mb-3">Agent: {c.agent_name ?? "—"}</div>
              <div className="bg-slate-50 rounded-md p-2 h-32 overflow-y-auto text-xs space-y-1 mb-3">
                {(transcripts[c.id] ?? []).map((t, i) => (
                  <div key={i}>
                    <span className="font-medium">{t.speaker}: </span>
                    {t.text}
                  </div>
                ))}
                {(transcripts[c.id] ?? []).length === 0 && <span className="text-slate-400">Waiting for transcript...</span>}
              </div>
              <div className="flex gap-2">
                <input
                  placeholder="Transfer to +1..."
                  value={selectedCall === c.id ? transferTo : ""}
                  onFocus={() => setSelectedCall(c.id)}
                  onChange={(e) => setTransferTo(e.target.value)}
                  className="flex-1 border border-slate-300 rounded-md px-2 py-1 text-xs"
                />
                <button onClick={() => transfer(c.id)} className="text-xs bg-slate-900 text-white rounded-md px-2 py-1">
                  Transfer
                </button>
                <button onClick={() => endCall(c.id)} className="text-xs bg-red-600 text-white rounded-md px-2 py-1">
                  End
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
