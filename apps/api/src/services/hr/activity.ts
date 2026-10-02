import { pool } from "../../db/pool.js";

export const STAGES = [
  "APPLIED",
  "SCREENING",
  "SHORTLISTED",
  "INTERVIEW_INVITED",
  "SCHEDULED",
  "AI_INTERVIEW",
  "EVALUATED",
  "NEXT_ROUND",
  "HOLD",
  "REJECTED",
  "HIRED",
] as const;
export type Stage = (typeof STAGES)[number];

export const STAGE_LABEL: Record<Stage, string> = {
  APPLIED: "Applied",
  SCREENING: "Screening",
  SHORTLISTED: "Shortlisted",
  INTERVIEW_INVITED: "Interview invited",
  SCHEDULED: "Scheduled",
  AI_INTERVIEW: "AI interview",
  EVALUATED: "Evaluated",
  NEXT_ROUND: "Next round",
  HOLD: "Hold / HR review",
  REJECTED: "Rejected",
  HIRED: "Hired",
};

// One timeline per application: every AI step, HR action and message.
export async function logActivity(params: {
  organizationId: string;
  applicationId: string;
  kind: string;
  title: string;
  detail?: Record<string, unknown>;
  actorUserId?: string | null;
}) {
  await pool.query(
    `insert into candidate_activity (organization_id, application_id, actor_user_id, kind, title, detail)
     values ($1,$2,$3,$4,$5,$6)`,
    [params.organizationId, params.applicationId, params.actorUserId ?? null, params.kind, params.title, JSON.stringify(params.detail ?? {})]
  );
}

// Moves an application to a stage and records who/what moved it and why.
export async function setStage(params: {
  organizationId: string;
  applicationId: string;
  stage: Stage;
  actorUserId?: string | null;
  reason?: string | null;
}) {
  const r = await pool.query<{ id: string }>(
    `update applications set stage = $3, stage_changed_at = now(), updated_at = now(),
       status = case $3 when 'REJECTED' then 'rejected' when 'HIRED' then 'hired' when 'SHORTLISTED' then 'qualified'
                        when 'AI_INTERVIEW' then 'interviewing' else status end
     where id = $1 and organization_id = $2
     returning id`,
    [params.applicationId, params.organizationId, params.stage]
  );
  if (!r.rows[0]) throw new Error("Application not found.");
  await logActivity({
    organizationId: params.organizationId,
    applicationId: params.applicationId,
    actorUserId: params.actorUserId,
    kind: "stage",
    title: `Moved to ${STAGE_LABEL[params.stage]}`,
    detail: { stage: params.stage, reason: params.reason ?? null },
  });
}

// AI decisions and HR overrides also go to the org-wide audit log.
export async function auditDecision(params: {
  organizationId: string;
  actorUserId: string | null;
  action: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
}) {
  await pool.query(
    `insert into audit_logs (organization_id, actor_user_id, action, entity_type, entity_id, metadata)
     values ($1,$2,$3,'application',$4,$5)`,
    [params.organizationId, params.actorUserId, params.action, params.entityId, JSON.stringify({ before: params.before ?? null, after: params.after ?? null })]
  ).catch(() => undefined);
}
