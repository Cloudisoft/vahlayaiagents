// Provider-agnostic telephony interface (spec §11). VahlayHR's interview
// engine and Vahlay Voice AI's call queue both talk to this interface only —
// never to a specific provider SDK directly — so providers can be added
// (Twilio, Exotel, Knowlarity, ...) without touching business logic.

export interface CreateCallParams {
  to: string; // E.164
  from: string; // E.164, must be a number owned by the provider account
  webhookUrl: string;
  answerUrl?: string;
  metadata?: Record<string, unknown>;
}

export interface CallStatus {
  providerCallId: string;
  status: "queued" | "ringing" | "answered" | "completed" | "failed" | "no_answer" | "busy" | "unknown";
  durationSeconds?: number;
}

export interface RecordingInfo {
  url: string;
  durationSeconds?: number;
}

export interface CallDetails {
  providerCallId: string;
  from: string;
  to: string;
  startedAt?: string;
  endedAt?: string;
  durationSeconds?: number;
  cost?: number;
  raw: unknown;
}

export interface PhoneNumberInfo {
  number: string; // E.164
  friendlyName?: string;
  capabilities?: string[];
}

export interface UsageInfo {
  periodStart: string;
  periodEnd: string;
  totalCost?: number;
  totalCalls?: number;
  raw: unknown;
}

export interface TelephonyProvider {
  readonly name: string;

  createCall(params: CreateCallParams): Promise<{ providerCallId: string }>;
  endCall(providerCallId: string): Promise<void>;
  getCallStatus(providerCallId: string): Promise<CallStatus>;
  getRecording(providerCallId: string): Promise<RecordingInfo | null>;
  getCallDetails(providerCallId: string): Promise<CallDetails>;
  transferCall(providerCallId: string, transferTo: string): Promise<void>;
  getPhoneNumbers(): Promise<PhoneNumberInfo[]>;
  validateNumber(e164: string): Promise<boolean>;
  normalizeNumber(raw: string): string | null;
  getUsage(fromISO: string, toISO: string): Promise<UsageInfo>;
  getBalance(): Promise<number | null>; // null when provider doesn't expose this
  verifyWebhookSignature(headers: Record<string, string>, rawBody: string, url: string): boolean;
}

export class ProviderNotConfiguredError extends Error {
  constructor(provider: string) {
    super(`Telephony provider "${provider}" is not configured. Add credentials in Settings → Telephony.`);
    this.name = "ProviderNotConfiguredError";
  }
}
