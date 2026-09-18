import { getOrgCredential } from "../services/credentialsService.js";
import { PlivoProvider } from "./PlivoProvider.js";
import { ProviderNotConfiguredError, type TelephonyProvider } from "./TelephonyProvider.js";
import { env } from "../config/env.js";

// Add new providers here (Twilio, Exotel, Knowlarity, ...) without touching
// the HR interview engine or Voice AI call queue — they only import
// getTelephonyProvider() and the TelephonyProvider interface.
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

  throw new ProviderNotConfiguredError(providerKey);
}

export type { TelephonyProvider } from "./TelephonyProvider.js";
