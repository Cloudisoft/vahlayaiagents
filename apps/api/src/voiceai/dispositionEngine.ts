// Every call ends with exactly one disposition, and that disposition decides
// whether the lead is retried (playbook §3). First matching rule wins.
// Pure function — no DB — so the whole table is unit-tested.

export interface CallFacts {
  dncRequested: boolean;
  voicemailDetected: boolean;
  transferStatus: "initiated" | "connected" | "failed" | null;
  endedReason: string | null;
  answered: boolean;
  customerSpoke: boolean;
  talkSeconds: number;
  aiOutcome: string | null;
}

export interface CampaignRetryRules {
  maxAttempts: number;
  retryDelayMinutes: number;
  retryOnVoicemail: boolean;
}

export interface DispositionDecision {
  key: string;
  retry: boolean;
  nextAttemptAt: Date | null;
}

// "A real conversation of meaningful length" (playbook §3).
export const MEANINGFUL_TALK_SECONDS = 10;

const NOT_IN_SERVICE = /invalid|not-in-service|number-not-found|unallocated|sip-?(404|410|484)|disconnected-number/i;
const TECHNICAL = /error|pipeline|failed|provider-closed|websocket|worker-shutdown|server-shutdown/i;

// Codes are Vahlay's dial statuses (see dispositionsService).
export function classifyCall(f: CallFacts): string {
  const reason = f.endedReason ?? "";

  if (f.dncRequested) return "DNC";
  if (f.voicemailDetected || reason === "voicemail") return "AA";

  if (f.transferStatus === "connected" || reason === "assistant-forwarded-call") return "XFER";
  if (f.transferStatus === "initiated" || f.transferStatus === "failed") return "DA";

  if (NOT_IN_SERVICE.test(reason)) return "ADC";

  // Never trust one signal: an unanswered call that a provider reports as
  // "no customer audio" is a no-answer, not a hang-up (playbook §10).
  if (!f.answered) {
    return reason.includes("busy") ? "AB" : "NA";
  }

  if (reason.includes("no-customer-audio") || (reason === "customer-ended-call" && !f.customerSpoke)) return "HangUp";
  if (reason.includes("silence-timed-out") && !f.customerSpoke) return "DA";
  if (TECHNICAL.test(reason) && f.talkSeconds < MEANINGFUL_TALK_SECONDS) return "DA";

  if (f.customerSpoke && f.talkSeconds >= MEANINGFUL_TALK_SECONDS) return f.aiOutcome ?? "PU";
  if (reason === "customer-ended-call") return "HangUp";
  return f.aiOutcome ?? (f.customerSpoke ? "PU" : "DA");
}

export function decideDisposition(
  f: CallFacts,
  rules: CampaignRetryRules,
  attemptsSoFar: number,
  callbackAt: Date | null,
  now: Date = new Date(),
  // A supervisor's manual disposition is never overwritten by the engine.
  manualKey: string | null = null
): DispositionDecision {
  const key = manualKey ?? classifyCall(f);
  const later = new Date(now.getTime() + rules.retryDelayMinutes * 60_000);
  const underMax = attemptsSoFar < rules.maxAttempts;

  const retryLater = { key, retry: underMax, nextAttemptAt: underMax ? later : null };
  switch (key) {
    case "NA":
    case "AB":
    case "DA":
    case "HangUp":
    case "NoAvl":
    case "ADCT":
      return retryLater;
    case "AA": {
      const retry = rules.retryOnVoicemail && underMax;
      return { key, retry, nextAttemptAt: retry ? later : null };
    }
    // A booked callback is a commitment: its time overrides cooldown and the
    // attempt cap.
    case "CALLBK":
    case "MNCB":
      return { key, retry: true, nextAttemptAt: callbackAt ?? later };
    default:
      return { key, retry: false, nextAttemptAt: null };
  }
}
