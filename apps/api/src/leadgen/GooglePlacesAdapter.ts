import { env } from "../config/env.js";
import { getOrgCredential } from "../services/credentialsService.js";
import type { LeadSearchQuery, LeadSourceAdapter, RawLeadResult } from "./LeadSourceAdapter.js";
import { LeadSourceNotConfiguredError } from "./LeadSourceAdapter.js";

interface PlaceTextSearchResult {
  places?: Array<{
    id: string;
    displayName?: { text: string };
    formattedAddress?: string;
    nationalPhoneNumber?: string;
    websiteUri?: string;
    primaryType?: string;
    addressComponents?: Array<{ longText: string; types: string[] }>;
  }>;
}

export class GooglePlacesAdapter implements LeadSourceAdapter {
  readonly key = "google_places";

  constructor(private apiKey: string) {}

  async search(query: LeadSearchQuery): Promise<RawLeadResult[]> {
    const textQuery = [query.keywords, query.city, query.state, query.zip].filter(Boolean).join(" ");

    const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": this.apiKey,
        "X-Goog-FieldMask":
          "places.id,places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.websiteUri,places.primaryType,places.addressComponents",
      },
      body: JSON.stringify({ textQuery, ...(query.radiusMeters ? {} : {}) }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Google Places API error (${res.status}): ${text}`);
    }

    const data = (await res.json()) as PlaceTextSearchResult;

    return (data.places ?? []).map((p) => {
      const component = (type: string) =>
        p.addressComponents?.find((c) => c.types.includes(type))?.longText ?? null;
      return {
        businessName: p.displayName?.text ?? "Unknown business",
        address: p.formattedAddress ?? null,
        city: component("locality"),
        state: component("administrative_area_level_1"),
        zip: component("postal_code"),
        website: p.websiteUri ?? null,
        phone: p.nationalPhoneNumber ?? null,
        category: p.primaryType ?? null,
        source: "google_places",
        sourceUrl: `https://www.google.com/maps/place/?q=place_id:${p.id}`,
      };
    });
  }
}

export async function getGooglePlacesAdapter(organizationId: string): Promise<GooglePlacesAdapter> {
  const cred = await getOrgCredential(organizationId, "google_places");
  const apiKey = cred?.apiKey ?? env.googlePlacesApiKey;
  if (!apiKey) throw new LeadSourceNotConfiguredError("Google Places");
  return new GooglePlacesAdapter(apiKey);
}
