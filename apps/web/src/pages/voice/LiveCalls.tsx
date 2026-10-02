import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError, getAccessToken } from "../../lib/api.js";
import { btnDark, btnGhost, formatPhone, formatSeconds, inputCls, useCan, useOrgEvents } from "../../lib/voice.js";

interface LiveCall {
  id: string;
  status: string;
  direction: string;
  to_number: string | null;
  from_number: string | null;
  created_at: string;
  answered_at: string | null;
  campaign_id: string | null;
  campaign_name: string | null;
  agent_name: string | null;
  lead_name: string | null;
  business_name: string | null;
  can_listen: boolean;
  can_control: boolean;
  turns: Array<{ speaker: string; text: string; role?: string }> | null;
  transfer_number: string | null;
  transfer_targets: Record<string, string> | null;
}

interface Line {
  role: string;
  speaker: string;
  text: string;
  partial: boolean;
}

const AUTO_LISTEN_KEY = "vahlay.liveMonitor.autoListen";
const GAIN = 2.5;

function readAutoListen(): boolean {
  try {
    return localStorage.getItem(AUTO_LISTEN_KEY) === "1";
  } catch {
    return false;
  }
}

// Plays the raw 16-bit PCM stream relayed from VAPI. Gain lifts quiet phone
// audio; the compressor acts as a limiter so the boost never clips.
class PcmPlayer {
  private ctx: AudioContext;
  private gain: GainNode;
  private nextTime = 0;
  private pending: Uint8Array[] = [];
  format: { sampleRate: number; channels: number } | null = null;

  constructor() {
    this.ctx = new AudioContext();
    const limiter = this.ctx.createDynamicsCompressor();
    limiter.threshold.value = -3;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.1;
    this.gain = this.ctx.createGain();
    this.gain.gain.value = GAIN;
    this.gain.connect(limiter).connect(this.ctx.destination);
  }

  setFormat(sampleRate: number, channels: number) {
    this.format = { sampleRate, channels };
    const queued = this.pending;
    this.pending = [];
    for (const c of queued) this.push(c);
  }

  push(chunk: Uint8Array) {
    if (!this.format) {
      this.pending.push(chunk);
      return;
    }
    const { sampleRate, channels } = this.format;
    const samples = new Int16Array(chunk.buffer, chunk.byteOffset, Math.floor(chunk.byteLength / 2));
    const frames = Math.floor(samples.length / channels);
    if (frames === 0) return;
    const buffer = this.ctx.createBuffer(1, frames, sampleRate);
    const out = buffer.getChannelData(0);
    for (let i = 0; i < frames; i++) {
      let sum = 0;
      for (let c = 0; c < channels; c++) sum += samples[i * channels + c];
      out[i] = sum / channels / 32768;
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.gain);
    const now = this.ctx.currentTime;
    // Re-anchor if we fell behind (network hiccup) instead of piling up delay.
    if (this.nextTime < now || this.nextTime - now > 1.5) this.nextTime = now + 0.08;
    src.start(this.nextTime);
    this.nextTime += buffer.duration;
  }

  resume() {
    return this.ctx.resume();
  }

  close() {
    this.ctx.close().catch(() => undefined);
  }
}

export default function LiveCalls() {
  const can = useCan();
  const [calls, setCalls] = useState<LiveCall[]>([]);
  const [lines, setLines] = useState<Record<string, Line[]>>({});
  const [focus, setFocus] = useState<string | null>(null);
  const [listening, setListening] = useState<string | null>(null);
  const [listenState, setListenState] = useState<string | null>(null);
  const [autoListen, setAutoListen] = useState(readAutoListen);
  const [connected, setConnected] = useState(true);
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [text, setText] = useState("");
  const [transferTo, setTransferTo] = useState("");
  const [now, setNow] = useState(Date.now());
  const playerRef = useRef<PcmPlayer | null>(null);
  const listenWs = useRef<WebSocket | null>(null);

  const load = useCallback(async () => {
    const r = await api<{ calls: LiveCall[] }>("/voice/calls/active");
    setCalls(r.calls);
    setLines((prev) => {
      const next = { ...prev };
      for (const c of r.calls) {
        if (!next[c.id] && c.turns?.length) {
          next[c.id] = c.turns.map((t) => ({ role: t.role ?? (t.speaker === "Customer" ? "user" : "assistant"), speaker: t.speaker, text: t.text, partial: false }));
        }
      }
      return next;
    });
  }, []);

  useEffect(() => {
    load();
    const poll = setInterval(load, 15000);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [load]);

  useOrgEvents((e) => {
    if (e.type === "connected") {
      setConnected(true);
      load();
    } else if (e.type === "disconnected") setConnected(false);
    else if (e.type === "transcript" && e.callId) {
      const callId = e.callId;
      setLines((prev) => {
        const list = [...(prev[callId] ?? [])];
        const last = list[list.length - 1];
        const line: Line = { role: String(e.role), speaker: String(e.speaker), text: String(e.text), partial: Boolean(e.partial) };
        // A partial replaces the previous partial from the same side.
        if (last && last.partial && last.role === line.role) list[list.length - 1] = line;
        else list.push(line);
        return { ...prev, [callId]: list.slice(-200) };
      });
    } else if (e.type === "call_status" || e.type === "call_ended") {
      load();
      if (e.type === "call_ended" && e.callId === listening) stopListening();
    }
  });

  const stopListening = useCallback(() => {
    listenWs.current?.close();
    listenWs.current = null;
    playerRef.current?.close();
    playerRef.current = null;
    setListening(null);
    setListenState(null);
  }, []);

  const startListening = useCallback(
    (callId: string) => {
      stopListening();
      const token = getAccessToken();
      if (!token) return;
      const player = new PcmPlayer();
      player.resume().catch(() => undefined);
      playerRef.current = player;
      const proto = window.location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${proto}://${window.location.host}/ws/listen?token=${encodeURIComponent(token)}&callId=${callId}`);
      ws.binaryType = "arraybuffer";
      listenWs.current = ws;
      setListening(callId);
      setFocus(callId);
      setListenState("Connecting…");
      ws.onmessage = (m) => {
        if (m.data instanceof ArrayBuffer) {
          player.push(new Uint8Array(m.data));
          return;
        }
        try {
          const msg = JSON.parse(m.data);
          if (msg.type === "format") {
            player.setFormat(msg.sampleRate, msg.channels);
            setListenState(`Listening · ${msg.sampleRate / 1000} kHz ${msg.channels === 2 ? "stereo" : "mono"}${msg.ambiguous ? " (auto-detected)" : ""}`);
          }
        } catch {
          // ignore
        }
      };
      ws.onopen = () => setListenState("Buffering audio…");
      ws.onclose = (ev) => {
        if (listenWs.current !== ws) return;
        setListenState(ev.code === 1000 ? "Call ended" : ev.reason || "Listen stream closed");
        playerRef.current?.close();
        playerRef.current = null;
        listenWs.current = null;
        setListening(null);
      };
    },
    [stopListening]
  );

  useEffect(() => () => stopListening(), [stopListening]);

  // Auto-listen: follow the newest answered call when nothing is playing.
  useEffect(() => {
    if (!autoListen || listening || !can("calls.listen")) return;
    const next = calls.find((c) => c.status === "answered" && c.can_listen);
    if (next) startListening(next.id);
  }, [autoListen, listening, calls, startListening, can]);

  function toggleAuto(v: boolean) {
    setAutoListen(v);
    try {
      localStorage.setItem(AUTO_LISTEN_KEY, v ? "1" : "0");
    } catch {
      // storage unavailable — setting just won't persist
    }
  }

  async function control(kind: "whisper" | "barge" | "transfer" | "end", to?: string) {
    if (!focus) return;
    if (kind === "end" && !confirm("Hang up this call now?")) return;
    const target = to ?? transferTo;
    if (kind === "transfer" && !confirm(`Transfer this call to ${formatPhone(target)} now?`)) return;
    setNotice(null);
    try {
      const body = kind === "transfer" ? { transferTo: target } : kind === "end" ? {} : { message: text };
      await api(`/voice/calls/${focus}/${kind}`, { method: "POST", body });
      setNotice({
        kind: "ok",
        text: { whisper: "Instruction sent to the agent (caller can't hear it).", barge: "The agent is saying your message now.", transfer: "Transfer started.", end: "Hang-up sent." }[kind],
      });
      if (kind === "whisper" || kind === "barge") setText("");
    } catch (err) {
      setNotice({ kind: "err", text: err instanceof ApiError ? err.message : "Request failed." });
    }
  }

  const focused = calls.find((c) => c.id === focus) ?? null;
  const focusLines = focus ? lines[focus] ?? [] : [];

  return (
    <div className="max-w-7xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Live Monitor</h1>
        </div>
        <div className="flex items-center gap-4 text-sm">
          {!connected && <span className="text-amber-700">Reconnecting to live updates…</span>}
          {can("calls.listen") && (
            <label className="flex items-center gap-2 text-slate-700">
              <input type="checkbox" checked={autoListen} onChange={(e) => toggleAuto(e.target.checked)} />
              Auto-listen to new calls
            </label>
          )}
          {listening && <button onClick={stopListening} className={btnGhost}>Stop listening</button>}
        </div>
      </div>

      <div className="grid lg:grid-cols-[380px_1fr] gap-4">
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-4 py-2 text-xs uppercase text-slate-500 bg-slate-50">{calls.length} live call(s)</div>
          {calls.map((c) => {
            const started = new Date(c.answered_at ?? c.created_at).getTime();
            return (
              <div
                key={c.id}
                onClick={() => setFocus(c.id)}
                className={`px-4 py-3 border-t border-slate-100 cursor-pointer ${focus === c.id ? "bg-red-50" : "hover:bg-slate-50"}`}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    {can("calls.listen") && (
                      <input
                        type="checkbox"
                        title="Listen"
                        disabled={!c.can_listen}
                        checked={listening === c.id}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => (e.target.checked ? startListening(c.id) : stopListening())}
                      />
                    )}
                    <span className="font-medium text-slate-900">{c.lead_name ?? formatPhone(c.direction === "inbound" ? c.from_number : c.to_number)}</span>
                  </div>
                  <span className={`text-xs rounded-full px-2 py-0.5 ${c.status === "answered" ? "bg-green-100 text-green-700" : "bg-slate-100 text-slate-600"}`}>
                    {c.status === "answered" ? formatSeconds((now - started) / 1000) : c.status}
                  </span>
                </div>
                <div className="text-xs text-slate-500 mt-0.5">
                  {c.direction === "inbound" ? "Inbound · " : ""}
                  {formatPhone(c.direction === "inbound" ? c.from_number : c.to_number)} · {c.agent_name ?? "agent"} · {c.campaign_name ?? "—"}
                </div>
                {listening === c.id && listenState && <div className="text-xs text-red-600 mt-1">🔊 {listenState}</div>}
              </div>
            );
          })}
          {calls.length === 0 && <div className="px-4 py-8 text-sm text-center text-slate-500">No calls in progress.</div>}
        </div>

        <div className="bg-white border border-slate-200 rounded-xl flex flex-col min-h-[520px]">
          {focused ? (
            <>
              <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
                <div>
                  <div className="font-medium text-slate-900">{focused.lead_name ?? "Unknown lead"}</div>
                  <div className="text-xs text-slate-500">{focused.business_name} · {formatPhone(focused.to_number)}</div>
                </div>
                {can("calls.listen") && focused.can_listen && listening !== focused.id && (
                  <button onClick={() => startListening(focused.id)} className={btnDark}>Listen</button>
                )}
              </div>
              <div className="flex-1 overflow-auto px-4 py-3 space-y-2">
                {focusLines.map((l, i) => (
                  <div key={i} className={`flex ${l.role === "user" ? "justify-start" : "justify-end"}`}>
                    <div className={`max-w-[75%] rounded-lg px-3 py-2 text-sm ${l.role === "user" ? "bg-slate-100 text-slate-800" : "bg-red-50 text-slate-800"} ${l.partial ? "opacity-60 italic" : ""}`}>
                      <div className="text-[10px] uppercase text-slate-400 mb-0.5">{l.speaker}</div>
                      {l.text}
                    </div>
                  </div>
                ))}
                {focusLines.length === 0 && <div className="text-sm text-slate-400 text-center mt-12">Waiting for the conversation…</div>}
              </div>
              {focused.can_control && (
                <div className="border-t border-slate-100 p-3 space-y-2">
                  {notice && <div className={`text-xs ${notice.kind === "ok" ? "text-green-700" : "text-red-600"}`}>{notice.text}</div>}
                  {(can("calls.whisper") || can("calls.barge")) && (
                    <div className="flex gap-2">
                      <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Message for the agent…" className={inputCls} />
                      {can("calls.whisper") && <button disabled={!text.trim()} onClick={() => control("whisper")} className={btnGhost} title="Private instruction to the AI — the caller doesn't hear it">Whisper</button>}
                      {can("calls.barge") && <button disabled={!text.trim()} onClick={() => control("barge")} className={btnGhost} title="The agent says this to the caller now">Barge</button>}
                    </div>
                  )}
                  {can("calls.transfer") && (focused.transfer_number || Object.keys(focused.transfer_targets ?? {}).length > 0) && (
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="text-slate-500">Transfer to:</span>
                      {[
                        ...(focused.transfer_number ? [["Sales", focused.transfer_number] as const] : []),
                        ...Object.entries(focused.transfer_targets ?? {})
                          .filter(([dept, n]) => n && !(dept === "sales" && focused.transfer_number))
                          .map(([dept, n]) => [dept[0].toUpperCase() + dept.slice(1), n] as const),
                      ].map(([label, n]) => (
                        <button key={label} onClick={() => control("transfer", n)} className="rounded-full border border-slate-300 px-2.5 py-1 hover:border-red-400 hover:text-red-700">
                          {label} · {formatPhone(n)}
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="flex gap-2">
                    {can("calls.transfer") && (
                      <>
                        <input value={transferTo} onChange={(e) => setTransferTo(e.target.value)} placeholder="Transfer to another number" className={inputCls} />
                        <button disabled={!transferTo.trim()} onClick={() => control("transfer")} className={btnGhost}>Transfer</button>
                      </>
                    )}
                    {can("calls.end") && <button onClick={() => control("end")} className="bg-red-600 text-white text-sm rounded-md px-4 py-2 hover:bg-red-700 whitespace-nowrap">End call</button>}
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="m-auto text-sm text-slate-500">Select a call to see its live transcript.</div>
          )}
        </div>
      </div>
    </div>
  );
}
