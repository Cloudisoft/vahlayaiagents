import { pool } from "../db/pool.js";
import { sendEmail } from "./emailService.js";

const DEFAULT_TEMPLATE = {
  subject: "Update on your application for {{jobTitle}}",
  body: `<p>Hi {{firstName}},</p>
<p>Thank you for applying for the {{jobTitle}} role. After reviewing your application, we've
decided to move forward with other candidates at this time.</p>
<p>We appreciate the time you took to apply and wish you the best in your search.</p>
<p>— {{organizationName}}</p>`,
};

function renderTemplate(template: string, vars: Record<string, string>): string {
  return Object.entries(vars).reduce((acc, [key, value]) => acc.replaceAll(`{{${key}}}`, value), template);
}

// Sends (or records the failure of) an automatic rejection email for an
// application. Idempotent — a rejection_emails row is unique per application,
// so this is safe to call more than once.
export async function sendRejectionEmail(applicationId: string): Promise<void> {
  const existing = await pool.query("select id, status from rejection_emails where application_id = $1", [
    applicationId,
  ]);
  if (existing.rows.length > 0 && existing.rows[0].status === "sent") {
    return; // already sent — never send twice
  }

  const appResult = await pool.query(
    `select a.id, c.first_name, c.email, j.title as job_title, o.name as org_name, o.settings
     from applications a
     join candidates c on c.id = a.candidate_id
     join jobs j on j.id = a.job_id
     join organizations o on o.id = a.organization_id
     where a.id = $1`,
    [applicationId]
  );
  if (appResult.rows.length === 0) throw new Error("Application not found.");
  const row = appResult.rows[0];

  const template = row.settings?.rejectionEmailTemplate ?? DEFAULT_TEMPLATE;
  const vars = {
    firstName: row.first_name ?? "there",
    jobTitle: row.job_title,
    organizationName: row.org_name,
  };
  const subject = renderTemplate(template.subject, vars);
  const body = renderTemplate(template.body, vars);

  const recordId = existing.rows[0]?.id;
  if (!recordId) {
    await pool.query(
      `insert into rejection_emails (application_id, template_used, subject, body, status)
       values ($1, 'default', $2, $3, 'pending')`,
      [applicationId, subject, body]
    );
  }

  try {
    const result = await sendEmail({ to: row.email, subject, html: body });
    await pool.query(
      `update rejection_emails set status = 'sent', provider_message_id = $1, sent_at = now() where application_id = $2`,
      [result.messageId, applicationId]
    );
  } catch (err) {
    await pool.query(`update rejection_emails set status = 'failed', error = $1 where application_id = $2`, [
      (err as Error).message,
      applicationId,
    ]);
    throw err;
  }
}
