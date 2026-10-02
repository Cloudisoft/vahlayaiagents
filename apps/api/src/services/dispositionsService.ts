import { pool } from "../db/pool.js";

export type DispositionColor = "red" | "amber" | "green" | "blue" | "slate" | "purple" | "teal";

export interface DispositionDef {
  key: string; // the dialer status code, e.g. "NA", "CALLBK"
  label: string;
  color: DispositionColor;
  // The dialer may call the lead again (subject to max attempts, delay and
  // cooldown). AA additionally obeys the campaign's retry_on_voicemail flag.
  retryable: boolean;
  // "active" codes describe a lead that is still in play (VICIdial's Active
  // Dial Statuses); "final" codes close the attempt.
  group: "final" | "active";
  // When the AI may choose this outcome, what it means — shown to the model.
  ai?: string;
}

// Vahlay's dial status codes. Codes the engine can't produce on VAPI
// (survey routing, inbound queue drops…) are kept so imported history and
// manual dispositions keep their meaning.
export const DEFAULT_DISPOSITIONS: DispositionDef[] = [
  // Automatic, set by the engine from call facts.
  { key: "AA", label: "Answering Machine Auto", color: "amber", retryable: true, group: "final" },
  { key: "AB", label: "Busy Auto", color: "slate", retryable: true, group: "final" },
  { key: "ADC", label: "Disconnected Number Auto", color: "red", retryable: false, group: "final" },
  { key: "ADCT", label: "Disconnected Number Temporary", color: "amber", retryable: true, group: "final" },
  { key: "AFAX", label: "Fax Machine Auto", color: "red", retryable: false, group: "final" },
  { key: "NA", label: "No Answer AutoDial", color: "slate", retryable: true, group: "final" },
  { key: "PU", label: "Call Picked Up", color: "blue", retryable: false, group: "final" },
  { key: "XFER", label: "Call Transferred", color: "green", retryable: false, group: "final" },
  { key: "DA", label: "DEAD CALL", color: "red", retryable: true, group: "final" },
  { key: "HangUp", label: "Hang Up", color: "red", retryable: true, group: "active" },
  { key: "DNC", label: "DO NOT CALL", color: "red", retryable: false, group: "final", ai: "The person asked not to be called again (use mark_do_not_call)." },

  // Outcomes the AI agent records with set_call_outcome.
  { key: "NI", label: "Not Interested", color: "slate", retryable: false, group: "final", ai: "Not interested, before or without hearing the offer." },
  { key: "DEC", label: "Declined Sale", color: "slate", retryable: false, group: "final", ai: "Heard the offer and declined it." },
  { key: "CALLBK", label: "Call Back", color: "blue", retryable: true, group: "final", ai: "A callback/appointment was booked (use book_callback)." },
  { key: "FL", label: "Follow-up", color: "green", retryable: false, group: "final", ai: "Interested; next step pending (e.g. sending bill copy, reviewing options)." },
  { key: "PROPO", label: "Proposal", color: "green", retryable: false, group: "final", ai: "Asked for a proposal/quote to be sent." },
  { key: "ALC", label: "Already Cx", color: "slate", retryable: false, group: "final", ai: "Already has all Spectrum services; nothing to offer." },
  { key: "CORPO", label: "Corporate Business", color: "purple", retryable: false, group: "final", ai: "Large/corporate business handled by a corporate team." },
  { key: "NoQua", label: "Not qualified", color: "slate", retryable: false, group: "final", ai: "Not qualified (e.g. residential, no service at address, locked contract)." },
  { key: "WN", label: "Wrong Number", color: "red", retryable: false, group: "final", ai: "Wrong number / business not at this number." },
  { key: "LNG", label: "Language Barrier", color: "amber", retryable: false, group: "final", ai: "Couldn't communicate because of language." },
  { key: "SU", label: "Support Call", color: "teal", retryable: false, group: "final", ai: "Existing customer needing support/billing help; routed to support." },
  { key: "NoAvl", label: "Cx Not Available", color: "amber", retryable: true, group: "active", ai: "Decision maker not available right now and no callback time given." },
  { key: "CBNG", label: "Call back number given to Cx", color: "blue", retryable: false, group: "final", ai: "Gave our callback number; customer will call back." },
  { key: "NP", label: "No Pitch No Price", color: "slate", retryable: false, group: "final", ai: "Call ended before any pitch could be made." },

  // Manual / imported only.
  { key: "SALE", label: "Sale Made", color: "green", retryable: false, group: "final" },
  { key: "DS", label: "Decline Sale", color: "slate", retryable: false, group: "final" },
  { key: "DC", label: "Disconnected Number", color: "red", retryable: false, group: "final" },
  { key: "DN", label: "Disconnected Number", color: "red", retryable: false, group: "final" },
  { key: "FAX", label: "Fax Tone", color: "red", retryable: false, group: "final" },
  { key: "MNCB", label: "E_B_R-C Manual Call Back", color: "blue", retryable: true, group: "final" },
  { key: "DNCC", label: "DO NOT CALL Camp Match", color: "red", retryable: false, group: "final" },
  { key: "DNCL", label: "DO NOT CALL Hopper Match", color: "red", retryable: false, group: "final" },
  { key: "NDNC", label: "National Do Not Call", color: "red", retryable: false, group: "final" },
  { key: "AL", label: "Answering Machine Msg Played", color: "amber", retryable: true, group: "final" },
  { key: "AM", label: "Answering Machine Sent to Msg", color: "amber", retryable: true, group: "final" },
  { key: "AFTHRS", label: "Inbound After Hours Drop", color: "slate", retryable: false, group: "final" },
  { key: "IVRXFR", label: "Outbound drop to Call Menu", color: "slate", retryable: true, group: "final" },
  { key: "LSMERG", label: "Agent lead search old lead merge", color: "slate", retryable: false, group: "final" },
  { key: "MLINAT", label: "Multi-Lead auto-all-dial lead", color: "slate", retryable: false, group: "final" },
  { key: "NANQUE", label: "Inbound No Agent no Queue Drop", color: "slate", retryable: false, group: "final" },
  { key: "PDROP", label: "Outbound Pre-Routing Drop", color: "slate", retryable: true, group: "final" },
  { key: "PM", label: "Played Message", color: "slate", retryable: false, group: "final" },
  { key: "QCFAIL", label: "QC_FAIL_CALLBACK", color: "amber", retryable: true, group: "final" },
  { key: "QVMAIL", label: "Queue Abandon Voicemail Left", color: "slate", retryable: false, group: "final" },
  { key: "SVYCLM", label: "Survey sent to Call Menu", color: "slate", retryable: false, group: "final" },
  { key: "SVYEXT", label: "Survey sent to Extension", color: "slate", retryable: false, group: "final" },
  { key: "SVYHU", label: "Survey Hungup", color: "slate", retryable: false, group: "final" },
  { key: "SVYREC", label: "Survey sent to Record", color: "slate", retryable: false, group: "final" },
  { key: "SVYVM", label: "Survey sent to Voicemail", color: "slate", retryable: false, group: "final" },
  { key: "XDROP", label: "Agent Not Available IN", color: "slate", retryable: false, group: "final" },

  // Active dial statuses (lead still in play).
  { key: "A", label: "Answering Machine", color: "amber", retryable: true, group: "active" },
  { key: "B", label: "Busy", color: "slate", retryable: true, group: "active" },
  { key: "N", label: "No Answer", color: "slate", retryable: true, group: "active" },
  { key: "AH", label: "Auto Hang-Up", color: "red", retryable: true, group: "active" },
  { key: "DROP", label: "Agent Not Available", color: "slate", retryable: true, group: "active" },
  { key: "ERI", label: "Agent Error", color: "red", retryable: true, group: "active" },
  { key: "MAXCAL", label: "Inbound Max Calls Drop", color: "slate", retryable: true, group: "active" },
  { key: "TIMEOT", label: "Inbound Queue Timeout Drop", color: "slate", retryable: true, group: "active" },
  { key: "RQXFER", label: "Re-Queue", color: "blue", retryable: true, group: "active" },
  { key: "RING", label: "Ringing", color: "blue", retryable: true, group: "active" },
  { key: "INCALL", label: "Lead Being Called", color: "blue", retryable: true, group: "active" },
  { key: "QUEUE", label: "Lead To Be Called", color: "slate", retryable: true, group: "active" },
  { key: "NEW", label: "New Lead", color: "slate", retryable: true, group: "active" },
];

export const AI_OUTCOMES = DEFAULT_DISPOSITIONS.filter((d) => d.ai && d.key !== "DNC");
export const AI_OUTCOME_KEYS = AI_OUTCOMES.map((d) => d.key);

export const DNC_CODES = ["DNC", "DNCC", "DNCL", "NDNC"];
export const CALLBACK_CODES = ["CALLBK", "MNCB"];
// "Positive" for reporting: the lead is moving forward.
export const POSITIVE_CODES = ["SALE", "XFER", "CALLBK", "FL", "PROPO"];

const ensured = new Set<string>();

// One bulk upsert per organisation per process; cheap enough to call before
// any lookup by code (the call finalizer relies on the codes existing).
export async function ensureDefaultDispositions(organizationId: string): Promise<void> {
  if (ensured.has(organizationId)) return;
  await pool.query(
    `insert into call_dispositions (organization_id, key, label, is_custom, color, retryable)
     select $1, d.key, d.label, false, d.color, d.retryable
     from unnest($2::text[], $3::text[], $4::text[], $5::boolean[]) as d(key, label, color, retryable)
     on conflict (organization_id, key) do update
       set label = excluded.label, retryable = excluded.retryable,
         -- rows created by the code-switch migration still carry label = key and no colour choice
         color = case when call_dispositions.label = call_dispositions.key then excluded.color else call_dispositions.color end
       where call_dispositions.is_custom = false`,
    [
      organizationId,
      DEFAULT_DISPOSITIONS.map((d) => d.key),
      DEFAULT_DISPOSITIONS.map((d) => d.label),
      DEFAULT_DISPOSITIONS.map((d) => d.color),
      DEFAULT_DISPOSITIONS.map((d) => d.retryable),
    ]
  );
  ensured.add(organizationId);
}
