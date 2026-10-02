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

// Events raised in the API process (webhooks) reach its own browsers at
// once; the NOTIFY round trip is only for the other processes.
const ORIGIN = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
let localDelivery: ((organizationId: string, event: { type: string; [key: string]: unknown }) => void) | null = null;
export function setLocalDelivery(fn: typeof localDelivery) {
  localDelivery = fn;
}
export function isOwnEvent(origin: unknown) {
  return origin === ORIGIN;
}

export async function publishEvent(organizationId: string, event: { type: string; [key: string]: unknown }) {
  if (localDelivery) localDelivery(organizationId, event);
  const payload = JSON.stringify({ organizationId, event, origin: localDelivery ? ORIGIN : undefined });
  // NOTIFY payloads cap at 8000 bytes; trim oversized text fields rather than drop the event.
  const safe =
    payload.length > 7500
      ? JSON.stringify({ organizationId, event: { ...event, text: String(event.text ?? "").slice(0, 2000) }, origin: localDelivery ? ORIGIN : undefined })
      : payload;
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
