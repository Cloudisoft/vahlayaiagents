import { pool } from "../db/pool.js";

const DEFAULT_CRITERIA: Array<{ name: string; description: string; weight: number }> = [
  { name: "Greeting", description: "Did the agent open the call professionally and clearly?", weight: 1 },
  { name: "Introduction", description: "Did the agent introduce themselves and the company/purpose?", weight: 1 },
  { name: "Script Adherence", description: "Did the agent follow the configured script/SOP where applicable?", weight: 1 },
  { name: "Product Knowledge", description: "Did the agent answer questions accurately?", weight: 1 },
  { name: "Discovery", description: "Did the agent ask relevant questions to understand the customer's needs?", weight: 1 },
  { name: "Objection Handling", description: "Were objections addressed effectively and respectfully?", weight: 1 },
  { name: "Accuracy", description: "Was all information provided to the customer accurate?", weight: 1.5 },
  { name: "Compliance", description: "Did the call follow required disclosures/compliance rules?", weight: 1.5 },
  { name: "Tone", description: "Was the agent's tone appropriate throughout the call?", weight: 1 },
  { name: "Empathy", description: "Did the agent show empathy for the customer's situation?", weight: 1 },
  { name: "Closing", description: "Did the call end with clear next steps?", weight: 1 },
  { name: "Call Control", description: "Did the agent keep the conversation on track?", weight: 1 },
  { name: "Transfer Handling", description: "If transferred, was it handled smoothly?", weight: 0.5 },
  { name: "Appointment Setting", description: "If applicable, was an appointment/next step confirmed clearly?", weight: 1 },
];

export async function ensureDefaultAuditCriteria(organizationId: string): Promise<void> {
  const existing = await pool.query("select count(*) from audit_criteria where organization_id = $1", [organizationId]);
  if (Number(existing.rows[0].count) > 0) return;
  for (const c of DEFAULT_CRITERIA) {
    await pool.query(
      `insert into audit_criteria (organization_id, name, description, weight, passing_score, is_required)
       values ($1,$2,$3,$4,70,true)`,
      [organizationId, c.name, c.description, c.weight]
    );
  }
}
