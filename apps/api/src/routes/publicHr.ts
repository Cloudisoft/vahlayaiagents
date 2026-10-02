import { Router } from "express";
import express from "express";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { env } from "../config/env.js";
import { getOrgCredential } from "../services/credentialsService.js";
import { availableSlots, bookInterview, interviewSettings, sessionByToken } from "../services/hr/interview.js";
import { advanceStatus, verifyTwilioSignature } from "../services/hr/messaging.js";
import { xmlEscape } from "../services/hr/jd.js";

export const publicHrRouter = Router();

// Candidate scheduling page data. The token is the only key; it reveals the
// candidate's first name, the role and times — nothing else.
publicHrRouter.get("/interview/:token", async (req, res) => {
  const s = await sessionByToken(req.params.token);
  if (!s || s.scheduling_status === "cancelled" || ["REJECTED", "HIRED"].includes(s.stage)) return res.status(404).json({ error: "This interview link is not valid or has expired." });
  const cfg = interviewSettings(s);
  const done = s.call_status !== "pending";
  res.json({
    firstName: s.first_name || null,
    jobTitle: s.title,
    company: s.org_settings?.hr?.companyName || s.org_name,
    durationMinutes: cfg.durationMinutes,
    phoneLast4: String(s.candidate_phone ?? "").replace(/\D/g, "").slice(-4) || null,
    status: done ? "completed_or_in_progress" : s.scheduling_status,
    scheduledAt: s.scheduled_at,
    timeZone: s.time_zone,
    hiringTimeZone: cfg.timeZone,
    slotMinutes: cfg.slotMinutes,
    slots: done ? [] : await availableSlots(s.org_id, s, 14, s.id),
  });
});

publicHrRouter.post("/interview/:token/book", express.json(), async (req, res) => {
  const p = z.object({ slot: z.string(), timeZone: z.string().max(60) }).safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: "Choose a time." });
  try {
    res.json(await bookInterview(req.params.token, p.data.slot, p.data.timeZone));
  } catch (err) {
    res.status(409).json({ error: (err as Error).message });
  }
});

// Email open pixel.
const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
publicHrRouter.get("/o/:token.gif", async (req, res) => {
  if (/^[0-9a-f]{32}$/.test(req.params.token)) await advanceStatus({ openToken: req.params.token }, "opened").catch(() => undefined);
  res.setHeader("Content-Type", "image/gif");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.end(GIF);
});

async function twilioTokenFor(organizationId: string) {
  const cred = await getOrgCredential(organizationId, "twilio");
  return cred?.authToken ?? env.twilio.authToken ?? null;
}

function publicUrl(req: express.Request) {
  return `${env.apiUrl.replace(/\/$/, "")}${req.originalUrl}`;
}

// Twilio SMS delivery callbacks (signed).
publicHrRouter.post("/sms-status", express.urlencoded({ extended: false }), async (req, res) => {
  const sid = String(req.body?.MessageSid ?? "");
  const m = sid ? (await pool.query("select organization_id from candidate_messages where provider_message_id = $1", [sid])).rows[0] : null;
  if (!m) return res.status(200).end();
  const token = await twilioTokenFor(m.organization_id);
  if (!token || !verifyTwilioSignature(token, req.header("x-twilio-signature"), publicUrl(req), req.body)) return res.status(403).end();
  const st = String(req.body.MessageStatus ?? "");
  if (st === "delivered") await advanceStatus({ providerMessageId: sid }, "delivered");
  else if (st === "undelivered" || st === "failed") await advanceStatus({ providerMessageId: sid }, "failed");
  res.status(200).end();
});

// Inbound SMS (set as the HR number's messaging webhook if wanted): marks
// the latest SMS to that candidate as replied and logs the reply.
publicHrRouter.post("/sms-inbound", express.urlencoded({ extended: false }), async (req, res) => {
  const from = String(req.body?.From ?? "");
  const to = String(req.body?.To ?? "");
  const m = (
    await pool.query(
      `select m.id, m.organization_id, m.application_id from candidate_messages m
       where m.channel = 'sms' and m.to_address = $1 and m.status in ('sent','delivered') order by m.sent_at desc limit 1`,
      [from]
    )
  ).rows[0];
  res.type("text/xml").send("<Response></Response>");
  if (!m) return;
  const token = await twilioTokenFor(m.organization_id);
  if (!token || !verifyTwilioSignature(token, req.header("x-twilio-signature"), publicUrl(req), req.body)) return;
  await advanceStatus({ id: m.id }, "replied");
  await pool.query(
    "insert into candidate_activity (organization_id, application_id, kind, title, detail) values ($1,$2,'message_reply','Candidate replied by SMS',$3)",
    [m.organization_id, m.application_id, JSON.stringify({ text: String(req.body?.Body ?? "").slice(0, 1600), to })]
  );
});

// XML job feed (Indeed-style) of an organization's published jobs.
publicHrRouter.get("/feed/:slug.xml", async (req, res) => {
  const o = (await pool.query("select id, name, settings from organizations where slug = $1", [req.params.slug])).rows[0];
  if (!o) return res.status(404).end();
  const jobs = await pool.query("select * from jobs where organization_id = $1 and status = 'published' order by published_at desc limit 500", [o.id]);
  const base = env.appUrl.replace(/\/$/, "");
  const company = o.settings?.hr?.companyName || o.name;
  const items = jobs.rows
    .map(
      (j) => `  <job>
    <title><![CDATA[${j.title}]]></title>
    <date><![CDATA[${new Date(j.published_at ?? j.created_at).toUTCString()}]]></date>
    <referencenumber><![CDATA[${j.id}]]></referencenumber>
    <url><![CDATA[${base}/apply/${j.public_slug}]]></url>
    <company><![CDATA[${company}]]></company>
    <city><![CDATA[${j.location ?? ""}]]></city>
    <description><![CDATA[${String(j.description ?? "").replace(/]]>/g, "")}]]></description>
    <jobtype><![CDATA[${j.employment_type ?? ""}]]></jobtype>
    ${j.salary_min || j.salary_max ? `<salary><![CDATA[${xmlEscape(j.salary_currency)} ${[j.salary_min, j.salary_max].filter(Boolean).join("-")} per year]]></salary>` : ""}
  </job>`
    )
    .join("\n");
  res.type("application/xml").send(`<?xml version="1.0" encoding="utf-8"?>\n<source>\n  <publisher>${xmlEscape(company)}</publisher>\n  <publisherurl>${xmlEscape(base)}</publisherurl>\n${items}\n</source>`);
});
