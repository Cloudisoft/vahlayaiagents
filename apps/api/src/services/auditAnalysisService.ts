import { chatJson } from "./openaiService.js";

export interface SpeakerTurn {
  speaker: "agent" | "customer" | "unknown";
  text: string;
}

// Best-effort speaker identification from a single-channel transcript using
// conversational cues (who asks vs. answers, greetings, sign-offs). This is
// not audio-based diarization — a real diarization model needs multi-channel
// audio or a dedicated model this phase doesn't integrate — so it's labeled
// as best-effort in the UI rather than presented as verified separation.
export async function identifySpeakers(params: { organizationId: string; rawTranscript: string }): Promise<SpeakerTurn[]> {
  const result = await chatJson<{ turns: SpeakerTurn[] }>({
    organizationId: params.organizationId,
    system: `You split a raw call transcript into turns and label each as "agent" or "customer" based on
conversational cues (who greets, who asks discovery questions, who answers). If genuinely ambiguous, use
"unknown" rather than guessing. Do not alter the wording. JSON only.`,
    user: `Transcript:\n${params.rawTranscript.slice(0, 15000)}\n\nRespond with JSON: { "turns": [{ "speaker": "agent"|"customer"|"unknown", "text": string }] }`,
  });
  return result.turns;
}

export interface CriterionScore {
  criterionId: string;
  criterionName: string;
  score: number;
  passed: boolean;
  notes: string;
}

export interface AuditResult {
  overallScore: number;
  criterionScores: CriterionScore[];
  strengths: string[];
  improvements: string[];
  missedOpportunities: string[];
  keyMoments: Array<{ timestampHint: string; description: string }>;
  scriptDeviations: string[];
  coachingNotes: string;
}

export async function evaluateCallAgainstCriteria(params: {
  organizationId: string;
  turns: SpeakerTurn[];
  criteria: Array<{ id: string; name: string; description: string; weight: number; passingScore: number; aiEvaluationInstructions: string | null }>;
}): Promise<AuditResult> {
  return chatJson<AuditResult>({
    organizationId: params.organizationId,
    system: `You are a call quality auditor. Score the agent's performance in this call transcript against
each provided criterion, 0-100. Base every score only on what's actually in the transcript — never invent
events that didn't happen. Then produce a coaching report: concrete strengths, concrete improvements, missed
opportunities, key moments, script deviations, and coaching notes an agent's manager could act on. JSON only.`,
    user: `Criteria:\n${params.criteria
      .map((c) => `- id=${c.id} name="${c.name}" weight=${c.weight} passingScore=${c.passingScore}${c.aiEvaluationInstructions ? ` instructions="${c.aiEvaluationInstructions}"` : ""}`)
      .join("\n")}

Transcript (turns):
${params.turns.map((t) => `${t.speaker}: ${t.text}`).join("\n")}

Respond with JSON matching:
{
  "overallScore": number,
  "criterionScores": [{ "criterionId": string, "criterionName": string, "score": number, "passed": boolean, "notes": string }],
  "strengths": string[],
  "improvements": string[],
  "missedOpportunities": string[],
  "keyMoments": [{ "timestampHint": string, "description": string }],
  "scriptDeviations": string[],
  "coachingNotes": string
}`,
  });
}
