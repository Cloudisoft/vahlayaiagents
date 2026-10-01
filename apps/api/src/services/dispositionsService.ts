import { pool } from "../db/pool.js";

export interface DispositionDef {
  key: string;
  label: string;
  color: "red" | "amber" | "green" | "blue" | "slate";
  retryable: boolean;
}

// Engine outcomes (playbook §3) + B2B telecom outcomes (playbook §11) +
// the AI's in-call outcomes. `retryable` means the dialer may call the lead
// again (subject to max attempts / delay / cooldown); voicemail retries are
// governed by the campaign's retry_on_voicemail flag instead.
export const DEFAULT_DISPOSITIONS: DispositionDef[] = [
  { key: "do_not_call", label: "DNC", color: "red", retryable: false },
  { key: "voicemail", label: "Voicemail", color: "amber", retryable: true },
  { key: "transferred", label: "Transferred", color: "green", retryable: false },
  { key: "disconnected_in_transfer", label: "Disconnected in transfer", color: "red", retryable: false },
  { key: "no_answer", label: "No answer", color: "slate", retryable: true },
  { key: "busy", label: "Busy", color: "slate", retryable: true },
  { key: "hung_up", label: "Hung up", color: "red", retryable: false },
  { key: "not_in_service", label: "Not in service", color: "red", retryable: false },
  { key: "disconnected", label: "Disconnected", color: "red", retryable: false },
  { key: "connected", label: "Call connected", color: "blue", retryable: false },
  { key: "interested", label: "Interested", color: "green", retryable: false },
  { key: "interested_transferred", label: "Interested – transferred", color: "green", retryable: false },
  { key: "not_interested", label: "Not interested", color: "slate", retryable: false },
  { key: "callback", label: "Callback", color: "blue", retryable: true },
  { key: "appointment_booked", label: "Appointment booked", color: "green", retryable: false },
  { key: "not_decision_maker", label: "Not decision maker", color: "amber", retryable: false },
  { key: "decision_maker_callback", label: "Decision maker callback", color: "blue", retryable: true },
  { key: "already_with_provider", label: "Already with this provider", color: "slate", retryable: false },
  { key: "contract_locked", label: "Contract locked", color: "amber", retryable: false },
  { key: "wrong_number", label: "Wrong number", color: "red", retryable: false },
];

// Outcomes the AI may report mid-call via the set_call_outcome tool. They
// only refine an otherwise "connected" call — engine facts (DNC, voicemail,
// transfer, no answer...) always win.
export const AI_OUTCOME_KEYS = [
  "interested",
  "not_interested",
  "callback",
  "appointment_booked",
  "not_decision_maker",
  "decision_maker_callback",
  "already_with_provider",
  "contract_locked",
  "wrong_number",
];

export async function ensureDefaultDispositions(organizationId: string): Promise<void> {
  for (const d of DEFAULT_DISPOSITIONS) {
    await pool.query(
      `insert into call_dispositions (organization_id, key, label, is_custom, color, retryable)
       values ($1, $2, $3, false, $4, $5)
       on conflict (organization_id, key) do update
         set color = excluded.color, retryable = excluded.retryable
         where call_dispositions.is_custom = false`,
      [organizationId, d.key, d.label, d.color, d.retryable]
    );
  }
}
