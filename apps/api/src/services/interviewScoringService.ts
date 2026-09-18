import { chatJson } from "./openaiService.js";

export interface InterviewEvaluation {
  overallScore: number;
  communicationScore: number;
  technicalScore: number | null;
  strengths: string[];
  weaknesses: string[];
  redFlags: string[];
  missingInformation: string[];
  recommendedAction: string;
  summary: string;
  perQuestion: Array<{ questionId: string; relevanceScore: number; analysis: string }>;
}

export async function evaluateInterview(params: {
  organizationId: string;
  jobTitle: string;
  qa: Array<{ questionId: string; question: string; answer: string }>;
}): Promise<InterviewEvaluation> {
  return chatJson<InterviewEvaluation>({
    organizationId: params.organizationId,
    system: `You evaluate AI phone-screening interview transcripts for a recruiting platform. Base every
judgment only on what the candidate actually said. Never evaluate based on accent, voice characteristics, or
any protected characteristic. This is decision support, not an infallible hiring decision — say so implicitly
by grounding claims in the transcript. JSON only.`,
    user: `Job: ${params.jobTitle}

Question/answer transcript:
${params.qa.map((x, i) => `Q${i + 1} (id=${x.questionId}): ${x.question}\nA${i + 1}: ${x.answer || "[no response captured]"}`).join("\n\n")}

Respond with JSON matching:
{
  "overallScore": number,
  "communicationScore": number,
  "technicalScore": number | null,
  "strengths": string[],
  "weaknesses": string[],
  "redFlags": string[],
  "missingInformation": string[],
  "recommendedAction": string,
  "summary": string,
  "perQuestion": [{ "questionId": string, "relevanceScore": number, "analysis": string }]
}`,
  });
}
