import { chatJson } from "./openaiService.js";

export interface AiJobCriteria {
  requiredSkills: string[];
  preferredSkills: string[];
  experienceYears: number | null;
  education: string | null;
  certifications: string[];
  responsibilities: string[];
  industry: string | null;
  technologies: string[];
  salaryNotes: string | null;
  otherCriteria: string[];
}

const SYSTEM_PROMPT = `You analyze job descriptions for a recruiting platform. Extract structured
hiring criteria as JSON only. Do not invent requirements that are not stated or reasonably implied
by the text. If a field is not determinable, use null or an empty array.`;

export async function analyzeJobDescription(params: {
  organizationId: string;
  title: string;
  description: string;
}): Promise<AiJobCriteria> {
  return chatJson<AiJobCriteria>({
    organizationId: params.organizationId,
    system: SYSTEM_PROMPT,
    user: `Job title: ${params.title}\n\nJob description:\n${params.description}\n\nRespond with JSON matching this shape exactly:
{
  "requiredSkills": string[],
  "preferredSkills": string[],
  "experienceYears": number | null,
  "education": string | null,
  "certifications": string[],
  "responsibilities": string[],
  "industry": string | null,
  "technologies": string[],
  "salaryNotes": string | null,
  "otherCriteria": string[]
}`,
  });
}
