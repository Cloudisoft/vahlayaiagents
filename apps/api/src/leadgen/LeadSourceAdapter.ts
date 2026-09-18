// Source-adapter architecture (spec §24): each lead data source implements
// this interface. LeadGen's discovery pipeline only talks to this contract,
// so adding a new source (a licensed directory API, a user upload, another
// search API) never touches the pipeline itself.

export interface LeadSearchQuery {
  keywords: string; // e.g. "roofing companies"
  state?: string;
  city?: string;
  zip?: string;
  radiusMeters?: number;
}

export interface RawLeadResult {
  businessName: string;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  website: string | null;
  phone: string | null;
  category: string | null;
  source: string;
  sourceUrl: string | null;
}

export interface LeadSourceAdapter {
  readonly key: string;
  search(query: LeadSearchQuery): Promise<RawLeadResult[]>;
}

export class LeadSourceNotConfiguredError extends Error {
  constructor(source: string) {
    super(`Lead source "${source}" is not configured. Add credentials in Settings → Lead Sources.`);
    this.name = "LeadSourceNotConfiguredError";
  }
}
