// The contract every data source implements. The engine only talks to this,
// so a new source (a licensed directory, a CRM, an enrichment API) is one
// new file registered in registry.ts.

export interface SourceLocation {
  country?: string; // ISO-2, default "US"
  state?: string;
  city?: string;
  zip?: string;
}

export interface SourceQuery {
  industry: string | null; // taxonomy key
  keywords: string; // free-text keywords / services / products
  location: SourceLocation;
}

// Normalizable fields a source may provide. Only what the source really
// returned — never guessed.
export interface SourceFields {
  businessName: string;
  category?: string | null;
  description?: string | null;
  website?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  country?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  socialUrls?: string[];
  companySize?: string | null;
  businessStatus?: string | null;
}

export interface SourceRecord {
  sourceRef: string; // stable id within the source
  sourceUrl: string | null;
  raw: unknown; // exactly what the source returned for this record
  fields: SourceFields;
}

export interface SourcePage {
  records: SourceRecord[];
  nextPageToken?: string | null;
}

export interface SourceAdapter {
  key: string;
  label: string;
  attribution?: string;
  // Throws SourceUnavailableError when it can't be used (e.g. no API key).
  prepare(organizationId: string): Promise<{ search: (q: SourceQuery, pageToken?: string | null) => Promise<SourcePage> }>;
  available(organizationId: string): Promise<boolean>;
}

// Errors the job runner understands.
export class SourceUnavailableError extends Error {}
export class RateLimitedError extends Error {
  constructor(msg: string, public retryAfterSec = 30) {
    super(msg);
  }
}
export class TransientSourceError extends Error {}
export class PermanentSourceError extends Error {}
