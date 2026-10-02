import { googlePlacesSource } from "./googlePlaces.js";
import { osmSource } from "./osm.js";
import type { SourceAdapter } from "./types.js";

// Register new data sources here.
export const SOURCES: SourceAdapter[] = [googlePlacesSource, osmSource];
export const sourceByKey = (k: string) => SOURCES.find((s) => s.key === k) ?? null;

export async function sourceStatus(organizationId: string) {
  return Promise.all(SOURCES.map(async (s) => ({ key: s.key, label: s.label, attribution: s.attribution ?? null, available: await s.available(organizationId).catch(() => false) })));
}
