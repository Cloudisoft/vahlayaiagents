import crypto from "node:crypto";
import type {
  CallDetails,
  CallStatus,
  CreateCallParams,
  PhoneNumberInfo,
  RecordingInfo,
  TelephonyProvider,
  UsageInfo,
} from "./TelephonyProvider.js";
import { normalizeIndiaE164, normalizeUsE164 } from "../utils/phone.js";

const PLIVO_STATUS_MAP: Record<string, CallStatus["status"]> = {
  queued: "queued",
  ringing: "ringing",
  "in-progress": "answered",
  completed: "completed",
  failed: "failed",
  busy: "busy",
  "no-answer": "no_answer",
};

export class PlivoProvider implements TelephonyProvider {
  readonly name = "plivo";

  constructor(
    private authId: string,
    private authToken: string
  ) {}

  private get authHeader() {
    return "Basic " + Buffer.from(`${this.authId}:${this.authToken}`).toString("base64");
  }

  private async request<T>(method: string, path: string, body?: Record<string, unknown>): Promise<T> {
    const res = await fetch(`https://api.plivo.com/v1/Account/${this.authId}${path}`, {
      method,
      headers: { Authorization: this.authHeader, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Plivo API error (${res.status}): ${text}`);
    }
    if (res.status === 204) return {} as T;
    return (await res.json()) as T;
  }

  async createCall(params: CreateCallParams): Promise<{ providerCallId: string }> {
    const result = await this.request<{ request_uuid: string }>("POST", "/Call/", {
      from: params.from,
      to: params.to,
      answer_url: params.answerUrl ?? params.webhookUrl,
      answer_method: "POST",
      hangup_url: params.webhookUrl,
      hangup_method: "POST",
    });
    return { providerCallId: result.request_uuid };
  }

  async endCall(providerCallId: string): Promise<void> {
    await this.request("DELETE", `/Call/${providerCallId}/`);
  }

  async getCallStatus(providerCallId: string): Promise<CallStatus> {
    const result = await this.request<{ call_uuid: string; call_state: string; call_duration?: string }>(
      "GET",
      `/Call/${providerCallId}/`
    );
    return {
      providerCallId,
      status: PLIVO_STATUS_MAP[result.call_state?.toLowerCase()] ?? "unknown",
      durationSeconds: result.call_duration ? Number(result.call_duration) : undefined,
    };
  }

  async getRecording(providerCallId: string): Promise<RecordingInfo | null> {
    const result = await this.request<{ objects: Array<{ recording_url: string; recording_duration_ms?: number }> }>(
      "GET",
      `/Recording/?call_uuid=${providerCallId}`
    );
    const first = result.objects?.[0];
    if (!first) return null;
    return {
      url: first.recording_url,
      durationSeconds: first.recording_duration_ms ? Math.round(first.recording_duration_ms / 1000) : undefined,
    };
  }

  async getCallDetails(providerCallId: string): Promise<CallDetails> {
    const result = await this.request<Record<string, any>>("GET", `/Call/${providerCallId}/`);
    return {
      providerCallId,
      from: result.from,
      to: result.to,
      startedAt: result.initiation_time,
      endedAt: result.end_time,
      durationSeconds: result.call_duration ? Number(result.call_duration) : undefined,
      cost: result.total_amount ? Number(result.total_amount) : undefined,
      raw: result,
    };
  }

  async transferCall(providerCallId: string, transferTo: string): Promise<void> {
    await this.request("POST", `/Call/${providerCallId}/`, {
      legs: "aleg",
      aleg_url: `https://api.plivo.com/xml/transfer?to=${encodeURIComponent(transferTo)}`,
      aleg_method: "GET",
    });
  }

  async getPhoneNumbers(): Promise<PhoneNumberInfo[]> {
    const result = await this.request<{ objects: Array<{ number: string; alias?: string }> }>(
      "GET",
      "/Number/"
    );
    return (result.objects ?? []).map((n) => ({ number: `+${n.number}`, friendlyName: n.alias }));
  }

  async validateNumber(e164: string): Promise<boolean> {
    return Boolean(normalizeIndiaE164(e164) ?? normalizeUsE164(e164));
  }

  normalizeNumber(raw: string): string | null {
    return normalizeIndiaE164(raw) ?? normalizeUsE164(raw);
  }

  async getUsage(fromISO: string, toISO: string): Promise<UsageInfo> {
    const result = await this.request<Record<string, any>>(
      "GET",
      `/PricingCDR/?start_time=${encodeURIComponent(fromISO)}&end_time=${encodeURIComponent(toISO)}`
    );
    return { periodStart: fromISO, periodEnd: toISO, raw: result };
  }

  async getBalance(): Promise<number | null> {
    const result = await this.request<{ cash_credits?: string }>("GET", "/");
    return result.cash_credits ? Number(result.cash_credits) : null;
  }

  verifyWebhookSignature(headers: Record<string, string>, rawBody: string, url: string): boolean {
    // Plivo signs with X-Plivo-Signature-V3 + X-Plivo-Signature-V3-Nonce using the auth token.
    const signature = headers["x-plivo-signature-v3"];
    const nonce = headers["x-plivo-signature-v3-nonce"];
    if (!signature || !nonce) return false;
    const expected = crypto
      .createHmac("sha256", this.authToken)
      .update(`${url}${nonce}`)
      .digest("base64");
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  }
}
