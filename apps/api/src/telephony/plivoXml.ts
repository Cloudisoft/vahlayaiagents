function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export interface InterviewXmlParams {
  greeting: string;
  questions: Array<{ id: string; text: string }>;
  closing: string;
  recordingActionBaseUrl: string; // .../recording/:sessionId?questionId=...
}

// Builds the Plivo XML call flow for one interview: greeting, then each
// question spoken followed by a recording of the candidate's answer, then a
// closing statement. Plivo executes these elements sequentially within a
// single response — no per-question webhook round trip is required for the
// conversation to proceed, only for us to be notified once each recording
// is ready (handled by the `action` callback on each <Record>).
//
// This is a turn-based IVR-style interview, not full-duplex streaming voice
// AI with mid-sentence barge-in — that requires a media-streaming
// integration (Plivo/Twilio media streams) which is a documented follow-on,
// not something faked here.
export function buildInterviewXml(params: InterviewXmlParams): string {
  const parts: string[] = ["<Response>"];
  parts.push(`<Speak voice="WOMAN" language="en-IN">${escapeXml(params.greeting)}</Speak>`);

  for (const q of params.questions) {
    parts.push(`<Speak voice="WOMAN" language="en-IN">${escapeXml(q.text)}</Speak>`);
    const actionUrl = `${params.recordingActionBaseUrl}?questionId=${encodeURIComponent(q.id)}`;
    parts.push(
      `<Record action="${escapeXml(actionUrl)}" method="POST" maxLength="120" timeout="8" playBeep="true" finishOnKey="#"/>`
    );
  }

  parts.push(`<Speak voice="WOMAN" language="en-IN">${escapeXml(params.closing)}</Speak>`);
  parts.push("<Hangup/>");
  parts.push("</Response>");
  return parts.join("");
}
