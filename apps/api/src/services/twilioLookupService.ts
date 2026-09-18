import { env } from "../config/env.js";
import { getOrgCredential } from "./credentialsService.js";

export class ProviderNotConfiguredError extends Error {
  constructor(provider: string) {
    super(`${provider} is not configured. Add credentials in Settings → Telephony.`);
    this.name = "ProviderNotConfiguredError";
  }
}

export interface TwilioCarrierResult {
  carrierName: string | null;
  lineType: string | null;
  mobileCountryCode: string | null;
  mobileNetworkCode: string | null;
  raw: unknown;
}

// Twilio Lookup v2 carrier verification cost is ~$0.008/lookup (line_type_intelligence).
export const TWILIO_LOOKUP_COST_USD = 0.008;

export async function lookupCarrier(organizationId: string, e164: string): Promise<TwilioCarrierResult> {
  const cred = await getOrgCredential(organizationId, "twilio");
  const accountSid = cred?.accountSid ?? env.twilio.accountSid;
  const authToken = cred?.authToken ?? env.twilio.authToken;
  if (!accountSid || !authToken) throw new ProviderNotConfiguredError("Twilio");

  const auth = Buffer.from(`${accountSid}:${authToken}`).toString("base64");
  const res = await fetch(
    `https://lookups.twilio.com/v2/PhoneNumbers/${encodeURIComponent(e164)}?Fields=line_type_intelligence`,
    { headers: { Authorization: `Basic ${auth}` } }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Twilio Lookup error (${res.status}): ${text}`);
  }

  const data = (await res.json()) as any;
  const intel = data.line_type_intelligence ?? {};
  return {
    carrierName: intel.carrier_name ?? null,
    lineType: intel.type ?? null,
    mobileCountryCode: intel.mobile_country_code ?? null,
    mobileNetworkCode: intel.mobile_network_code ?? null,
    raw: data,
  };
}
