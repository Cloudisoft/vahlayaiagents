import PDFDocument from "pdfkit";
import type { QcReport, Evidence, Finding } from "./analyze.js";
import { fmt, type Segment } from "./transcribe.js";

// Built-in PDF fonts only cover Windows-1252; anything else would render as
// garbage, so it's transliterated or replaced instead.
function safe(t: unknown): string {
  return String(t ?? "")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF]/g, "?");
}

const COLORS = { green: "#15803d", yellow: "#b45309", red: "#b91c1c", ink: "#0f172a", muted: "#64748b", line: "#e2e8f0" };

export interface PdfInput {
  id: string;
  fileName: string | null;
  agentName: string | null;
  businessName: string | null;
  createdAt: Date;
  originalDurationSec: number;
  transcriptCoverage: number;
  report: QcReport;
  transcript: Segment[];
}

// Renders the PDF entirely from saved report data. Text flows across pages
// automatically, so a long transcript simply produces more pages.
export function renderQcPdf(input: PdfInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "LETTER", margins: { top: 50, bottom: 50, left: 50, right: 50 }, bufferPages: true, info: { Title: `QC report ${input.fileName ?? input.id}` } });
    const chunks: Buffer[] = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    const r = input.report;
    const width = doc.page.width - 100;

    const h1 = (t: string) => doc.font("Helvetica-Bold").fontSize(18).fillColor(COLORS.ink).text(safe(t));
    const h2 = (t: string) => {
      doc.moveDown(0.8);
      doc.font("Helvetica-Bold").fontSize(12).fillColor(COLORS.ink).text(safe(t));
      doc.moveTo(50, doc.y + 2).lineTo(50 + width, doc.y + 2).strokeColor(COLORS.line).stroke();
      doc.moveDown(0.4);
    };
    const p = (t: string, color = COLORS.ink, size = 10) => doc.font("Helvetica").fontSize(size).fillColor(color).text(safe(t), { width });
    const ev = (list: Evidence[]) => {
      for (const e of list) {
        doc.font("Helvetica-Oblique").fontSize(9).fillColor(COLORS.muted).text(safe(`${e.timestamp ? `[${e.timestamp}] ` : ""}"${e.quote}"${e.verified ? "" : " (quote not found verbatim)"}`), { width, indent: 12 });
      }
    };
    const finding = (f: Finding) => {
      const color = COLORS[f.rating];
      doc.font("Helvetica-Bold").fontSize(10).fillColor(color).text(safe(`- ${f.title}`), { width });
      if (f.detail) p(f.detail, COLORS.ink, 9.5);
      ev(f.evidence);
      doc.moveDown(0.2);
    };

    // Header
    h1("Call QC Report");
    p(`${r.callType}${r.callTypeTags.length ? ` | ${r.callTypeTags.join(" | ")}` : ""}`, COLORS.muted);
    doc.moveDown(0.5);
    const meta: Array<[string, string]> = [
      ["File", input.fileName ?? "-"],
      ["Agent", r.agentName ?? input.agentName ?? "Not stated"],
      ["Customer", r.customerName ?? "Not stated"],
      ["Business", r.businessName ?? input.businessName ?? "-"],
      ["Recording duration", fmt(input.originalDurationSec)],
      ["Transcript coverage", `${Math.round(input.transcriptCoverage * 100)}%`],
      ["Audited", input.createdAt.toLocaleString("en-US", { timeZone: "America/New_York" }) + " ET"],
      ["Report ID", input.id],
    ];
    for (const [k, v] of meta) doc.font("Helvetica-Bold").fontSize(9.5).fillColor(COLORS.muted).text(`${k}: `, { continued: true }).font("Helvetica").fillColor(COLORS.ink).text(safe(v));

    // Scores
    h2("Scores");
    doc.font("Helvetica-Bold").fontSize(22).fillColor(r.pass ? COLORS.green : COLORS.red).text(`${r.scores.overall}/100  ${r.pass ? "PASS" : "FAIL"}`);
    if (r.needsReview) p("Flagged for review", COLORS.yellow);
    const rows: Array<[string, number | null, number]> = [
      ["Communication", r.scores.communication, r.categoryWeights.communication],
      ["Resolution", r.scores.resolution, r.categoryWeights.resolution],
      ["Customer experience", r.scores.customerExperience, r.categoryWeights.customer_experience],
      ["Compliance", r.scores.compliance, r.categoryWeights.compliance],
      ["Sales", r.scores.sales, r.categoryWeights.sales],
      ["Sales compliance checks", r.scores.rules, r.rulesWeight],
    ];
    for (const [label, score, w] of rows) {
      const color = score === null ? COLORS.muted : score >= 80 ? COLORS.green : score >= 60 ? COLORS.yellow : COLORS.red;
      doc.font("Helvetica").fontSize(10).fillColor(COLORS.ink).text(`${label} (${Math.round(w * 100)}% weight): `, { continued: true }).fillColor(color).text(score === null ? "n/a" : `${score}%`);
    }
    p(`Sentiment - customer: ${r.sentiment.customer}; agent: ${r.sentiment.agent}. ${r.sentiment.trajectory}`, COLORS.muted, 9.5);

    h2("Sales compliance checks");
    for (const rule of r.rules) {
      const color = rule.result === "PASS" ? COLORS.green : rule.result === "PARTIAL" ? COLORS.yellow : rule.result === "FAIL" ? COLORS.red : COLORS.muted;
      doc.font("Helvetica-Bold").fontSize(10).fillColor(color).text(safe(`${rule.result}  ${rule.rule}${rule.mandatory ? " (mandatory)" : ""}`), { width });
      if (rule.explanation) p(rule.explanation, COLORS.ink, 9.5);
      if (rule.evidence.length) ev(rule.evidence);
      else p("Not found in transcript", COLORS.muted, 9);
      doc.moveDown(0.3);
    }

    h2("Compliance results");
    if (!r.complianceChecks.length) p("No compliance checks applied.", COLORS.muted);
    for (const c of r.complianceChecks) {
      const color = c.result === "PASS" ? COLORS.green : c.result === "PARTIAL" ? COLORS.yellow : c.result === "FAIL" ? COLORS.red : COLORS.muted;
      doc.font("Helvetica-Bold").fontSize(10).fillColor(color).text(safe(`${c.result}  ${c.check} (${c.severity})`), { width });
      ev(c.evidence);
    }
    if (r.callTypeRules.length) {
      h2("Call-type rules");
      for (const c of r.callTypeRules) {
        const color = c.result === "PASS" ? COLORS.green : c.result === "PARTIAL" ? COLORS.yellow : c.result === "FAIL" ? COLORS.red : COLORS.muted;
        doc.font("Helvetica-Bold").fontSize(10).fillColor(color).text(safe(`${c.result}  ${c.rule}`), { width });
        ev(c.evidence);
      }
    }

    h2("Executive summary");
    p(r.executiveSummary);

    h2(`Findings - green (${r.findings.green.length}), yellow (${r.findings.yellow.length}), red (${r.findings.red.length})`);
    for (const f of [...r.findings.red, ...r.findings.yellow, ...r.findings.green]) finding(f);

    h2("QC dimensions");
    for (const d of r.dimensions) {
      const color = d.rating === "na" ? COLORS.muted : COLORS[d.rating];
      doc.font("Helvetica-Bold").fontSize(10).fillColor(color).text(safe(`${d.label}: ${d.score === null ? "n/a" : d.score}`), { width });
      if (d.finding) p(d.finding, COLORS.ink, 9.5);
      ev(d.evidence);
    }

    h2("What went well");
    for (const f of r.wentWell) finding(f);
    h2("Areas to improve");
    for (const f of r.toImprove) finding(f);

    h2("Coaching recommendations");
    for (const c of r.coaching) {
      doc.font("Helvetica-Bold").fontSize(10).fillColor(COLORS.ink).text(safe(`- ${c.recommendation}`), { width });
      if (c.why) p(c.why, COLORS.muted, 9.5);
      if (c.example) p(`Try: "${c.example}"`, COLORS.green, 9.5);
    }

    h2("Risks");
    if (!r.risks.length) p("No risks identified.", COLORS.muted);
    for (const k of r.risks) {
      const color = k.level === "high" ? COLORS.red : k.level === "medium" ? COLORS.yellow : COLORS.muted;
      doc.font("Helvetica-Bold").fontSize(10).fillColor(color).text(safe(`${k.level.toUpperCase()}: ${k.description}`), { width });
      ev(k.evidence);
    }

    h2("Key moments");
    for (const k of r.keyMoments) {
      p(`${k.timestamp ? `[${k.timestamp}] ` : ""}${k.description}`, COLORS.ink, 9.5);
      ev(k.evidence);
    }

    // Full transcript, never truncated.
    doc.addPage();
    h1("Full transcript");
    p(`${input.transcript.length} segments, ${fmt(input.originalDurationSec)} recording.`, COLORS.muted, 9);
    doc.moveDown(0.5);
    for (const s of input.transcript) {
      doc.font("Helvetica-Bold").fontSize(9).fillColor(s.role === "Agent" ? COLORS.red : COLORS.ink).text(`[${fmt(s.start)}] ${s.role}: `, { continued: true, width }).font("Helvetica").fillColor(COLORS.ink).text(safe(s.text), { width });
    }

    // Page numbers.
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      // Writing inside the bottom margin would otherwise start a blank page.
      const bottom = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.font("Helvetica").fontSize(8).fillColor(COLORS.muted).text(`Page ${i + 1} of ${range.count}`, 50, doc.page.height - 35, { width, align: "right", lineBreak: false });
      doc.page.margins.bottom = bottom;
    }
    doc.end();
  });
}
