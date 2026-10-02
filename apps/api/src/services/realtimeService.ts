import type { Server as HttpServer, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import { verifyAccessToken } from "./authService.js";
import { subscribe, EVENTS_CHANNEL, isOwnEvent, setLocalDelivery } from "./events.js";
import { hasPermission } from "../middleware/permissions.js";
import { canUseTab, loadAccess } from "./accessService.js";
import { pool } from "../db/pool.js";

// Two WebSocket endpoints on the API server:
//  /ws         per-organisation event stream (call status, live transcript,
//              campaign status) — fed from Postgres NOTIFY so events from
//              the worker process reach browsers too.
//  /ws/listen  authenticated audio relay for one live call (Live Monitor).
//              The browser never sees VAPI's listen URL.
const orgSockets = new Map<string, Set<WebSocket>>();
const alive = new WeakMap<WebSocket, boolean>();
const HEARTBEAT_MS = 25_000;

function authenticate(req: IncomingMessage): { org: string; role: string; sub: string; url: URL } | null {
  const url = new URL(req.url ?? "", "http://localhost");
  const token = url.searchParams.get("token");
  if (!token) return null;
  try {
    const p = verifyAccessToken(token);
    return { org: p.org, role: p.role, sub: p.sub, url };
  } catch {
    return null;
  }
}

function track(socket: WebSocket) {
  alive.set(socket, true);
  socket.on("pong", () => alive.set(socket, true));
}

export function initRealtime(server: HttpServer) {
  const events = new WebSocketServer({ noServer: true });
  const listen = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = new URL(req.url ?? "", "http://localhost").pathname;
    const target = path === "/ws" ? events : path === "/ws/listen" ? listen : null;
    if (!target) {
      socket.destroy();
      return;
    }
    target.handleUpgrade(req, socket, head, (ws) => target.emit("connection", ws, req));
  });

  events.on("connection", (socket: WebSocket, req: IncomingMessage) => {
    const auth = authenticate(req);
    if (!auth) return socket.close(4001, "Invalid token");
    track(socket);
    if (!orgSockets.has(auth.org)) orgSockets.set(auth.org, new Set());
    orgSockets.get(auth.org)!.add(socket);
    socket.send(JSON.stringify({ type: "hello" }));
    socket.on("close", () => orgSockets.get(auth.org)?.delete(socket));
  });

  listen.on("connection", (socket: WebSocket, req: IncomingMessage) => {
    handleListen(socket, req).catch(() => socket.close(1011, "Listen failed"));
  });

  // Heartbeat: drop dead sockets so clients reconnect instead of hanging.
  setInterval(() => {
    for (const wss of [events, listen]) {
      for (const ws of wss.clients) {
        if (alive.get(ws) === false) {
          ws.terminate();
          continue;
        }
        alive.set(ws, false);
        ws.ping();
      }
    }
  }, HEARTBEAT_MS);

  setLocalDelivery(broadcastToOrg);
  subscribe(EVENTS_CHANNEL, (payload) => {
    try {
      const { organizationId, event, origin } = JSON.parse(payload);
      if (isOwnEvent(origin)) return; // already delivered in-process
      broadcastToOrg(organizationId, event);
    } catch {
      // malformed notification — ignore
    }
  });
}

async function handleListen(socket: WebSocket, req: IncomingMessage) {
  const auth = authenticate(req);
  if (!auth) return socket.close(4001, "Invalid token");
  if (!hasPermission(auth.role, "calls.listen")) return socket.close(4003, "Missing permission: calls.listen");
  if (!canUseTab(await loadAccess(auth.sub, auth.role), "voice_agents", "live")) return socket.close(4003, "No access to Live Monitor");
  const callId = auth.url.searchParams.get("callId");
  const r = await pool.query(
    "select monitor_listen_url from calls where id = $1 and organization_id = $2 and status in ('queued','ringing','answered')",
    [callId, auth.org]
  );
  const listenUrl: string | undefined = r.rows[0]?.monitor_listen_url;
  if (!listenUrl) return socket.close(4004, "Call is not live or has no listen stream");
  track(socket);

  const upstream = new WebSocket(listenUrl);
  let bytes = 0;
  const startedAt = Date.now();
  let formatSent = false;

  upstream.on("message", (data, isBinary) => {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (!isBinary) {
      socket.send(JSON.stringify({ type: "upstream", data: data.toString() }));
      return;
    }
    const buf = data as Buffer;
    bytes += buf.length;
    // Detect the stream's format from its byte rate after ~1.5 s of audio
    // (16-bit PCM) so the browser plays it at the right speed.
    if (!formatSent && Date.now() - startedAt > 1500) {
      formatSent = true;
      socket.send(JSON.stringify({ type: "format", ...detectPcmFormat(bytes / ((Date.now() - startedAt) / 1000)) }));
    }
    socket.send(buf, { binary: true });
  });
  upstream.on("close", () => socket.close(1000, "Call ended"));
  upstream.on("error", () => socket.close(1011, "Listen stream error"));
  socket.on("close", () => upstream.close());
}

export function detectPcmFormat(bytesPerSecond: number): { sampleRate: number; channels: number; ambiguous: boolean } {
  const options: Array<{ sampleRate: number; channels: number }> = [];
  for (const sampleRate of [8000, 16000, 24000, 32000, 44100, 48000]) {
    for (const channels of [1, 2]) options.push({ sampleRate, channels });
  }
  const scored = options
    .map((o) => ({ ...o, diff: Math.abs(o.sampleRate * o.channels * 2 - bytesPerSecond) }))
    .sort((a, b) => a.diff - b.diff || b.channels - a.channels);
  const best = scored[0];
  const ambiguous = scored.length > 1 && scored[1].diff === best.diff;
  return { sampleRate: best.sampleRate, channels: best.channels, ambiguous };
}

export function broadcastToOrg(organizationId: string, event: { type: string; [key: string]: unknown }) {
  const sockets = orgSockets.get(organizationId);
  if (!sockets) return;
  const payload = JSON.stringify(event);
  for (const socket of sockets) {
    if (socket.readyState === WebSocket.OPEN) socket.send(payload);
  }
}
