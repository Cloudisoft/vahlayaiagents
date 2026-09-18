import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { getCoverageStats } from "../services/coverageService.js";

export const dashboardRouter = Router();
dashboardRouter.use(requireAuth);

// Every number here is a real aggregate query against this org's data —
// nothing here is a placeholder or a hard-coded sample figure.
dashboardRouter.get("/", async (req: AuthedRequest, res) => {
  const orgId = req.auth!.organizationId;

  const [hr, coverage, leadgen, voice, auditor] = await Promise.all([
    pool.query(
      `select
         (select count(*) from jobs where organization_id = $1 and status = 'published') as open_jobs,
         (select count(*) from applications where organization_id = $1) as applications,
         (select count(*) from applications where organization_id = $1 and status = 'qualified') as qualified,
         (select count(*) from applications where organization_id = $1 and status = 'rejected') as rejected,
         (select count(*) from interview_sessions where organization_id = $1) as interviews,
         (select round(avg(overall_score)) from candidate_scores cs join applications a on a.id = cs.application_id where a.organization_id = $1) as avg_score`,
      [orgId]
    ),
    getCoverageStats(orgId),
    pool.query(
      `select
         (select count(*) from leads where organization_id = $1) as leads_discovered,
         (select count(*) from leads where organization_id = $1 and business_email is not null) as leads_enriched,
         (select count(*) from leads where organization_id = $1 and (main_phone_e164 is not null or business_email is not null)) as valid_leads,
         (select round(avg(quality_score)) from leads where organization_id = $1) as avg_quality,
         (select count(*) from lead_lists where organization_id = $1) as lead_lists`,
      [orgId]
    ),
    pool.query(
      `select
         (select count(*) from calls where organization_id = $1 and created_at >= current_date) as calls_today,
         (select count(*) from calls where organization_id = $1 and created_at >= current_date - interval '7 days') as calls_week,
         (select count(*) from calls where organization_id = $1 and status = 'answered') as connected,
         (select round(avg(duration_seconds)) from calls where organization_id = $1 and duration_seconds is not null) as avg_duration,
         (select count(*) from calls c join call_dispositions cd on cd.id = c.disposition_id where c.organization_id = $1 and cd.key = 'appointment_booked') as appointments,
         (select count(*) from call_transfers ct join calls c on c.id = ct.call_id where c.organization_id = $1) as transfers,
         (select count(*) from calls c join call_dispositions cd on cd.id = c.disposition_id where c.organization_id = $1 and cd.key = 'interested') as interested,
         (select count(*) from calls where organization_id = $1 and status in ('queued','ringing','answered')) as active_calls`,
      [orgId]
    ),
    pool.query(
      `select
         (select count(*) from call_audits where organization_id = $1 and processing_status = 'completed') as audited,
         (select round(avg(overall_score)) from call_audits where organization_id = $1 and processing_status = 'completed') as avg_score
       `,
      [orgId]
    ),
  ]);

  res.json({
    hr: hr.rows[0],
    coverage,
    leadgen: leadgen.rows[0],
    voice: voice.rows[0],
    auditor: auditor.rows[0],
  });
});
