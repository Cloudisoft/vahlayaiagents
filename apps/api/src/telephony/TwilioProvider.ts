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
import { normalizeUsE164 } from "../utils/phone.js";

const TWILIO_STATUS_MAP: Record<string, CallStatus["status"]> = {
  queued: "queued",
  ringing: "ringing",
  "in-progress": "answered",
  completed: "completed",
  failed: "failed",
  busy: "busy",
  "no-answer": "no_answer",
  canceled: "failed",
};

// Twilio is the US calling provider (spec: Twilio for USA, Plivo for India).
// Same TelephonyProvider contract as Plivo — the call queue and interview
// engine never know which one they're talking to.
export class TwilioProvider implements TelephonyProvider {
  readonly name = "twilio";

  constructor(
    private accountSid: string,
    private authToken: string
  ) {}

  private get authHeader() {
    return "Basic " + Buffer.from(`${this.accountSid}:${this.authToken}`).toString("base64");
  }

  private get baseUrl() {
    return `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}`;
  }

  private async request<T>(method: string, path: string, form?: Record<string, string>): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: this.authHeader,
        ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      },
      body: form ? new URLSearchParams(form).toString() : undefined,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Twilio API error (${res.status}): ${text}`);
    }
    if (res.status === 204) return {} as T;
    return (await res.json()) as T;
  }

  async createCall(params: CreateCallParams): Promise<{ providerCallId: string }> {
    const result = await this.request<{ sid: string }>("POST", "/Calls.json", {
      To: params.to,
      From: params.from,
      Url: params.answerUrl ?? params.webhookUrl,
      Method: "POST",
      StatusCallback: params.webhookUrl,
      StatusCallbackMethod: "POST",
      StatusCallbackEvent: "completed",
      Record: "true",
    });
    return { providerCallId: result.sid };
  }

  async endCall(providerCallId: string): Promise<void> {
    await this.request("POST", `/Calls/${providerCallId}.json`, { Status: "completed" });
  }

  async getCallStatus(providerCallId: string): Promise<CallStatus> {
    const result = await this.request<{ sid: string; status: string; duration?: string }>(
      "GET",
      `/Calls/${providerCallId}.json`
    );
    return {
      providerCallId,
      status: TWILIO_STATUS_MAP[result.status] ?? "unknown",
      durationSeconds: result.duration ? Number(result.duration) : undefined,
    };
  }

  async getRecording(providerCallId: string): Promise<RecordingInfo | null> {
    const result = await this.request<{ recordings: Array<{ sid: string; duration?: string }> }>(
      "GET",
      `/Calls/${providerCallId}/Recordings.json`
    );
    const first = result.recordings?.[0];
    if (!first) return null;
    return {
      url: `${this.baseUrl}/Recordings/${first.sid}.mp3`,
      durationSeconds: first.duration ? Number(first.duration) : undefined,
    };
  }

  async getCallDetails(providerCallId: string): Promise<CallDetails> {
    const result = await this.request<Record<string, any>>("GET", `/Calls/${providerCallId}.json`);
    return {
      providerCallId,
      from: result.from,
      to: result.to,
      startedAt: result.start_time,
      endedAt: result.end_time,
      durationSeconds: result.duration ? Number(result.duration) : undefined,
      cost: result.price ? Math.abs(Number(result.price)) : undefined,
      raw: result,
    };
  }

  async transferCall(providerCallId: string, transferTo: string): Promise<void> {
    // Redirect the live call to new TwiML that dials the transfer target —
    // Twilio has no separate "transfer" endpoint, this is the standard way.
    const twiml = `<Response><Dial>${transferTo}</Dial></Response>`;
    await this.request("POST", `/Calls/${providerCallId}.json`, { Twiml: twiml });
  }

  async getPhoneNumbers(): Promise<PhoneNumberInfo[]> {
    const result = await this.request<{ incoming_phone_numbers: Array<{ phone_number: string; friendly_name?: string; capabilities?: Record<string, boolean> }> }>(
      "GET",
      "/IncomingPhoneNumbers.json"
    );
    return (result.incoming_phone_numbers ?? []).map((n) => ({
      number: n.phone_number,
      friendlyName: n.friendly_name,
      capabilities: n.capabilities ? Object.entries(n.capabilities).filter(([, v]) => v).map(([k]) => k) : undefined,
    }));
  }

  async validateNumber(e164: string): Promise<boolean> {
    return Boolean(normalizeUsE164(e164));
  }

  normalizeNumber(raw: string): string | null {
    return normalizeUsE164(raw);
  }

  async getUsage(fromISO: string, toISO: string): Promise<UsageInfo> {
    const result = await this.request<Record<string, any>>(
      "GET",
      `/Usage/Records.json?StartDate=${encodeURIComponent(fromISO.slice(0, 10))}&EndDate=${encodeURIComponent(toISO.slice(0, 10))}`
    );
    return { periodStart: fromISO, periodEnd: toISO, raw: result };
  }

  async getBalance(): Promise<number | null> {
    const result = await this.request<{ balance?: string }>("GET", "/Balance.json");
    return result.balance ? Number(result.balance) : null;
  }

  verifyWebhookSignature(headers: Record<string, string>, rawBody: string, url: string): boolean {
    // Twilio signs the full request URL + sorted-by-key form params
    // (concatenated, no separators) with HMAC-SHA1 using the auth token,
    // base64-encoded, sent as X-Twilio-Signature.
    const signature = headers["x-twilio-signature"];
    if (!signature) return false;

    const params = new URLSearchParams(rawBody);
    const sortedKeys = Array.from(params.keys()).sort();
    const data = sortedKeys.reduce((acc, key) => acc + key + params.get(key), url);

    const expected = crypto.createHmac("sha1", this.authToken).update(data).digest("base64");
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  }
}
