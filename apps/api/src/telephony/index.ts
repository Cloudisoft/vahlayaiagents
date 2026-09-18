import { getOrgCredential } from "../services/credentialsService.js";
import { PlivoProvider } from "./PlivoProvider.js";
import { TwilioProvider } from "./TwilioProvider.js";
import { ProviderNotConfiguredError, type TelephonyProvider } from "./TelephonyProvider.js";
import { env } from "../config/env.js";

// Add new providers here (Exotel, Knowlarity, ...) without touching the HR
// interview engine or Voice AI call queue — they only import
// getTelephonyProvider() and the TelephonyProvider interface.
//
// Convention used throughout this app: Plivo carries India calling (HR AI
// interviews — interviewEngine.ts defaults org.settings.telephonyProvider to
// "plivo"), Twilio carries US calling (Voice AI campaigns — driven by
// whichever provider owns the DID assigned to the campaign, synced via
// Settings → Telephony / phoneNumbers.ts). Both are real, independent
// implementations of the same TelephonyProvider contract.
export async function getTelephonyProvider(
  organizationId: string,
  providerKey: string
): Promise<TelephonyProvider> {
  if (providerKey === "plivo") {
    const cred = await getOrgCredential(organizationId, "plivo");
    const authId = cred?.authId ?? env.plivo.authId;
    const authToken = cred?.authToken ?? env.plivo.authToken;
    if (!authId || !authToken) throw new ProviderNotConfiguredError("plivo");
    return new PlivoProvider(authId, authToken);
  }

  if (providerKey === "twilio") {
    const cred = await getOrgCredential(organizationId, "twilio");
    const accountSid = cred?.accountSid ?? env.twilio.accountSid;
    const authToken = cred?.authToken ?? env.twilio.authToken;
    if (!accountSid || !authToken) throw new ProviderNotConfiguredError("twilio");
    return new TwilioProvider(accountSid, authToken);
  }

  throw new ProviderNotConfiguredError(providerKey);
}

export type { TelephonyProvider } from "./TelephonyProvider.js";
