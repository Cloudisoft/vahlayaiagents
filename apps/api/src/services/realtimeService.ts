import type { Server as HttpServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { verifyAccessToken } from "./authService.js";

// Minimal per-organization broadcast bus for the Live Call Panel (spec §37).
// Not a general pub/sub system — just enough to push call_status and
// transcript_turn events to every connected browser in an org.
const orgSockets = new Map<string, Set<WebSocket>>();

export function initRealtime(server: HttpServer) {
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (socket, req) => {
    const url = new URL(req.url ?? "", "http://localhost");
    const token = url.searchParams.get("token");
    if (!token) {
      socket.close(4001, "Missing token");
      return;
    }
    let organizationId: string;
    try {
      organizationId = verifyAccessToken(token).org;
    } catch {
      socket.close(4001, "Invalid token");
      return;
    }

    if (!orgSockets.has(organizationId)) orgSockets.set(organizationId, new Set());
    orgSockets.get(organizationId)!.add(socket);

    socket.on("close", () => {
      orgSockets.get(organizationId)?.delete(socket);
    });
  });

  return wss;
}

export function broadcastToOrg(organizationId: string, event: { type: string; [key: string]: unknown }) {
  const sockets = orgSockets.get(organizationId);
  if (!sockets) return;
  const payload = JSON.stringify(event);
  for (const socket of sockets) {
    if (socket.readyState === WebSocket.OPEN) socket.send(payload);
  }
}
