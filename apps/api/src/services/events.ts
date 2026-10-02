import pg from "pg";
import { env } from "../config/env.js";
import { pool } from "../db/pool.js";
import { pgConfig } from "../db/config.js";

// Cross-process signalling over Postgres LISTEN/NOTIFY. The worker (dialer)
// and the API (webhooks, browsers' WebSockets) are separate processes:
//  - vahlay_events: realtime UI events, fanned out to org sockets by the API
//  - vahlay_dialer: "a campaign slot just freed" — the dialer refills now,
//    not on its next tick (playbook §3)
export const EVENTS_CHANNEL = "vahlay_events";
export const DIALER_CHANNEL = "vahlay_dialer";

export async function publishEvent(organizationId: string, event: { type: string; [key: string]: unknown }) {
  const payload = JSON.stringify({ organizationId, event });
  // NOTIFY payloads cap at 8000 bytes; trim oversized text fields rather than drop the event.
  const safe = payload.length > 7500 ? JSON.stringify({ organizationId, event: { ...event, text: String(event.text ?? "").slice(0, 2000) } }) : payload;
  await pool.query("select pg_notify($1, $2)", [EVENTS_CHANNEL, safe]);
}

export async function signalSlotFreed(campaignId: string) {
  await pool.query("select pg_notify($1, $2)", [DIALER_CHANNEL, campaignId]);
}

// Dedicated connection that LISTENs and reconnects on failure.
export function subscribe(channel: string, onMessage: (payload: string) => void) {
  let client: pg.Client | null = null;
  let stopped = false;

  async function connect() {
    if (stopped) return;
    client = new pg.Client({ ...pgConfig(env.databaseDirectUrl), keepAlive: true });
    client.on("notification", (msg) => {
      if (msg.channel === channel && msg.payload) onMessage(msg.payload);
    });
    client.on("error", () => reconnect());
    client.on("end", () => reconnect());
    try {
      await client.connect();
      await client.query(`listen ${channel}`);
    } catch {
      reconnect();
    }
  }

  let reconnecting = false;
  function reconnect() {
    if (stopped || reconnecting) return;
    reconnecting = true;
    client?.removeAllListeners();
    client?.end().catch(() => undefined);
    setTimeout(() => {
      reconnecting = false;
      connect();
    }, 2000);
  }

  connect();
  return () => {
    stopped = true;
    client?.end().catch(() => undefined);
  };
}
