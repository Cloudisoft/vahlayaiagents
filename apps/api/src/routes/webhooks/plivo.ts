import { Router } from "express";
import crypto from "node:crypto";
import { pool } from "../../db/pool.js";
import { buildInterviewXml } from "../../telephony/plivoXml.js";
import { env } from "../../config/env.js";
import { transcribeAudio } from "../../services/openaiService.js";
import { evaluateInterview } from "../../services/interviewScoringService.js";
import { getStorageDriver, recordFile } from "../../services/storageService.js";
import { getTelephonyProvider } from "../../telephony/index.js";
import { Readable } from "node:stream";

export const plivoWebhookRouter = Router();

// Plivo POSTs form-encoded webhook bodies by default; index.ts mounts
// urlencoded parsing for this router specifically (see routes registration).

plivoWebhookRouter.all("/answer/:sessionId", async (req, res) => {
  const sessionResult = await pool.query(
    `select s.id, s.organization_id, s.application_id, s.ai_behavior, a.job_id,
            j.title as job_title, o.name as org_name
     from interview_sessions s
     join applications a on a.id = s.application_id
     join jobs j on j.id = a.job_id
     join organizations o on o.id = a.organization_id
     where s.id = $1`,
    [req.params.sessionId]
  );
  if (sessionResult.rows.length === 0) {
    return res.status(404).type("text/xml").send("<Response><Speak>Session not found.</Speak><Hangup/></Response>");
  }
  const session = sessionResult.rows[0];

  const questions = await pool.query(
    "select id, question from interview_questions where job_id = $1 order by order_index",
    [session.job_id]
  );

  if (questions.rows.length === 0) {
    return res
      .status(200)
      .type("text/xml")
      .send(
        "<Response><Speak voice=\"WOMAN\">This role has no configured interview questions yet. Please contact the recruiter.</Speak><Hangup/></Response>"
      );
  }

  await pool.query("update interview_sessions set status = 'in_progress' where id = $1", [session.id]);

  for (const q of questions.rows) {
    await pool.query(
      `insert into interview_answers (interview_session_id, interview_question_id, question_text, order_index)
       select $1, $2, $3, count(*) from interview_answers where interview_session_id = $1`,
      [session.id, q.id, q.question]
    );
  }

  const greeting = `Hello, this is the AI recruiting assistant for ${session.org_name}, calling about your application for the ${session.job_title} position. This call will be recorded for evaluation. I'll now ask you a few questions — please answer after the beep, and press pound when you're done with each answer.`;
  const closing = `That's the end of the interview questions. Thank you for your time — our team will review your responses and follow up soon. Goodbye.`;

  const xml = buildInterviewXml({
    greeting,
    questions: questions.rows.map((q) => ({ id: q.id, text: q.question })),
    closing,
    recordingActionBaseUrl: `${env.apiUrl.replace(/\/$/, "")}/api/webhooks/plivo/recording/${session.id}`,
  });

  res.type("text/xml").send(xml);
});

plivoWebhookRouter.post("/recording/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  const questionId = req.query.questionId as string | undefined;
  const recordingUrl = req.body.RecordUrl as string | undefined;

  if (questionId && recordingUrl) {
    // Fire-and-forget: acknowledge Plivo immediately, process asynchronously
    // so the call flow (already moved to the next <Speak>/<Record>) isn't
    // blocked on transcription latency.
    res.status(200).end();
    processAnswerRecording(sessionId, questionId, recordingUrl).catch((err) =>
      pool.query(
        `insert into system_logs (level, source, message, metadata) values ('error','plivo.recording',$1,$2)`,
        [(err as Error).message, JSON.stringify({ sessionId, questionId })]
      )
    );
    return;
  }
  res.status(200).end();
});

async function processAnswerRecording(sessionId: string, questionId: string, recordingUrl: string) {
  const sessionResult = await pool.query(
    "select organization_id from interview_sessions where id = $1",
    [sessionId]
  );
  if (sessionResult.rows.length === 0) return;
  const organizationId = sessionResult.rows[0].organization_id;

  const audioRes = await fetch(recordingUrl);
  if (!audioRes.ok) throw new Error(`Failed to download recording (${audioRes.status}).`);
  const buffer = Buffer.from(await audioRes.arrayBuffer());

  const { text } = await transcribeAudio({ organizationId, audio: buffer, filename: "answer.mp3" });

  await pool.query(
    `update interview_answers set answer_text = $1
     where interview_session_id = $2 and interview_question_id = $3`,
    [text, sessionId, questionId]
  );
}

plivoWebhookRouter.post("/hangup/:sessionId", async (req, res) => {
  res.status(200).end();
  finalizeInterview(req.params.sessionId, req.body).catch((err) =>
    pool.query(`insert into system_logs (level, source, message, metadata) values ('error','plivo.hangup',$1,$2)`, [
      (err as Error).message,
      JSON.stringify({ sessionId: req.params.sessionId }),
    ])
  );
});

async function finalizeInterview(sessionId: string, hangupBody: Record<string, string>) {
  const sessionResult = await pool.query(
    `select s.id, s.organization_id, s.application_id, s.telephony_provider, s.provider_call_id,
            a.job_id, j.title as job_title
     from interview_sessions s
     join applications a on a.id = s.application_id
     join jobs j on j.id = a.job_id
     where s.id = $1`,
    [sessionId]
  );
  if (sessionResult.rows.length === 0) return;
  const session = sessionResult.rows[0];

  await pool.query(
    `update interview_sessions set status = 'completed', ended_at = now(),
       duration_seconds = $1, processing_status = 'processing'
     where id = $2`,
    [hangupBody.Duration ? Number(hangupBody.Duration) : null, sessionId]
  );

  let recordingFileId: string | null = null;
  try {
    const provider = await getTelephonyProvider(session.organization_id, session.telephony_provider);
    const recording = session.provider_call_id ? await provider.getRecording(session.provider_call_id) : null;
    if (recording) {
      const audioRes = await fetch(recording.url);
      if (audioRes.ok) {
        const buffer = Buffer.from(await audioRes.arrayBuffer());
        const key = `${session.organization_id}/interviews/${sessionId}.mp3`;
        const stored = await getStorageDriver().put(key, Readable.from(buffer), "audio/mpeg");
        recordingFileId = await recordFile({
          organizationId: session.organization_id,
          key: stored.key,
          fileName: `interview-${sessionId}.mp3`,
          fileType: "mp3",
          mimeType: "audio/mpeg",
          size: stored.size,
        });
        await pool.query("update interview_sessions set recording_file_id = $1 where id = $2", [
          recordingFileId,
          sessionId,
        ]);
      }
    }
  } catch (err) {
    await pool.query(`insert into system_logs (organization_id, level, source, message) values ($1,'warn','plivo.recording_fetch',$2)`, [
      session.organization_id,
      (err as Error).message,
    ]);
  }

  const answers = await pool.query(
    "select interview_question_id, question_text, answer_text from interview_answers where interview_session_id = $1 order by order_index",
    [sessionId]
  );

  const evaluation = await evaluateInterview({
    organizationId: session.organization_id,
    jobTitle: session.job_title,
    qa: answers.rows.map((a) => ({
      questionId: a.interview_question_id,
      question: a.question_text,
      answer: a.answer_text ?? "",
    })),
  });

  for (const pq of evaluation.perQuestion) {
    await pool.query(
      "update interview_answers set relevance_score = $1, analysis = $2 where interview_session_id = $3 and interview_question_id = $4",
      [pq.relevanceScore, pq.analysis, sessionId, pq.questionId]
    );
  }

  await pool.query(
    `update interview_sessions set
       overall_score = $1, communication_score = $2, technical_score = $3,
       red_flags = $4, recommended_action = $5, summary = $6,
       transcript = $7, processing_status = 'completed'
     where id = $8`,
    [
      evaluation.overallScore,
      evaluation.communicationScore,
      evaluation.technicalScore,
      evaluation.redFlags,
      evaluation.recommendedAction,
      evaluation.summary,
      answers.rows.map((a) => `Q: ${a.question_text}\nA: ${a.answer_text ?? ""}`).join("\n\n"),
      sessionId,
    ]
  );

  await pool.query(
    `insert into notifications (organization_id, type, title, body)
     values ($1, 'interview_completed', 'AI interview completed', $2)`,
    [session.organization_id, `Interview for application ${session.application_id} scored ${evaluation.overallScore}/100.`]
  );
}
