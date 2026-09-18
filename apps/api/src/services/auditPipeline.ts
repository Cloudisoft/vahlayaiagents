import { pool } from "../db/pool.js";
import { getStorageDriver } from "./storageService.js";
import { transcribeLongAudio } from "./audioProcessingService.js";
import { identifySpeakers, evaluateCallAgainstCriteria } from "./auditAnalysisService.js";
import { ensureDefaultAuditCriteria } from "./auditCriteriaService.js";

// RECORDING -> FILE VALIDATION -> AUDIO PROCESSING -> TRANSCRIPTION ->
// SPEAKER IDENTIFICATION -> AI ANALYSIS -> CRITERIA EVALUATION -> SCORE ->
// COACHING REPORT -> SAVE AUDIT (spec §42)
export async function processCallAudit(auditId: string): Promise<void> {
  const auditResult = await pool.query(
    `select ca.id, ca.organization_id, ca.source_file_id, ca.call_id, f.file_path, f.file_type
     from call_audits ca
     left join files f on f.id = ca.source_file_id
     where ca.id = $1`,
    [auditId]
  );
  if (auditResult.rows.length === 0) throw new Error("Audit not found.");
  const audit = auditResult.rows[0];

  await pool.query("update call_audits set processing_status = 'transcribing' where id = $1", [auditId]);

  try {
    let filePath = audit.file_path;
    let fileType = audit.file_type;

    if (!filePath && audit.call_id) {
      const recording = await pool.query(
        `select f.file_path, f.file_type from call_recordings cr join files f on f.id = cr.file_id where cr.call_id = $1`,
        [audit.call_id]
      );
      if (recording.rows.length === 0) throw new Error("No recording available for this call yet.");
      filePath = recording.rows[0].file_path;
      fileType = recording.rows[0].file_type;
    }
    if (!filePath) throw new Error("No audio source for this audit.");

    const buffer = await readFileBuffer(filePath);
    const { fullText } = await transcribeLongAudio({
      organizationId: audit.organization_id,
      buffer,
      fileExt: fileType || "mp3",
    });

    await pool.query("update call_audits set processing_status = 'analyzing' where id = $1", [auditId]);

    const turns = await identifySpeakers({ organizationId: audit.organization_id, rawTranscript: fullText });

    await ensureDefaultAuditCriteria(audit.organization_id);
    const criteriaResult = await pool.query(
      "select id, name, description, weight, passing_score, ai_evaluation_instructions from audit_criteria where organization_id = $1",
      [audit.organization_id]
    );
    const criteria = criteriaResult.rows.map((c) => ({
      id: c.id,
      name: c.name,
      description: c.description,
      weight: Number(c.weight),
      passingScore: c.passing_score,
      aiEvaluationInstructions: c.ai_evaluation_instructions,
    }));

    const evaluation = await evaluateCallAgainstCriteria({ organizationId: audit.organization_id, turns, criteria });

    await pool.query(
      `update call_audits set
         overall_score = $1, criterion_scores = $2, strengths = $3, improvements = $4, missed_opportunities = $5,
         key_moments = $6, script_deviations = $7, coaching_notes = $8, processing_status = 'completed'
       where id = $9`,
      [
        evaluation.overallScore,
        JSON.stringify(evaluation.criterionScores),
        evaluation.strengths,
        evaluation.improvements,
        evaluation.missedOpportunities,
        JSON.stringify(evaluation.keyMoments),
        evaluation.scriptDeviations,
        evaluation.coachingNotes,
        auditId,
      ]
    );

    await pool.query(
      `insert into notifications (organization_id, type, title, body) values ($1, 'audit_completed', 'Call audit completed', $2)`,
      [audit.organization_id, `Audit scored ${evaluation.overallScore}/100.`]
    );
  } catch (err) {
    await pool.query("update call_audits set processing_status = 'failed' where id = $1", [auditId]);
    await pool.query(
      `insert into system_logs (organization_id, level, source, message) values ($1,'error','call_audit_pipeline',$2)`,
      [audit.organization_id, (err as Error).message]
    );
    throw err;
  }
}

async function readFileBuffer(key: string): Promise<Buffer> {
  const driver = getStorageDriver() as any;
  if (typeof driver.readStream === "function") {
    const stream = driver.readStream(key);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  }
  const url = await getStorageDriver().getSignedUrl(key);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to read stored file (${res.status}).`);
  return Buffer.from(await res.arrayBuffer());
}
