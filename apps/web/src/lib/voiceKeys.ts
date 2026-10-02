// Request paths shared by pages and the sidebar's hover-prefetch, so a
// prefetched response is exactly what the page asks for.
export const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

export function summaryKey(days: number, campaignId = "") {
  const q = new URLSearchParams({ days: String(days), tz: TZ });
  if (campaignId) q.set("campaignId", campaignId);
  return `/voice/insights/summary?${q}`;
}

export const K = {
  campaigns: "/voice/campaigns",
  agents: "/voice/agents",
  voices: "/voice/voices",
  numbers: "/voice/phone-numbers",
  dnc: "/voice/calls/dnc/list",
  dispositions: "/voice/dispositions",
  templates: "/voice/agents/templates",
  active: "/voice/calls/active",
  callbacks: (scope: "upcoming" | "done" = "upcoming") => `/voice/insights/callbacks?scope=${scope}`,
  calls: (q = "page=1&pageSize=50") => `/voice/calls?${q}`,
  leads: (q = "page=1") => `/voice/insights/leads?${q}`,
  campaign: (id: string) => `/voice/campaigns/${id}`,
};

// What each sidebar destination needs on first paint.
export const ROUTE_DATA: Record<string, () => string[]> = {
  "/voice": () => [K.campaigns, K.callbacks(), summaryKey(1), summaryKey(7)],
  "/voice/campaigns": () => [K.campaigns, K.templates],
  "/voice/callbacks": () => [K.callbacks()],
  "/voice/leads": () => [K.leads(), K.dispositions],
  "/voice/history": () => [K.calls(), K.dispositions, K.campaigns],
  "/voice/analytics": () => [summaryKey(7), K.campaigns],
  "/voice/dispositions": () => [K.dispositions],
  "/voice/agents": () => [K.agents, K.templates],
  "/voice/voices": () => [K.voices],
  "/voice/numbers": () => [K.numbers],
  "/voice/dnc": () => [K.dnc],
};
