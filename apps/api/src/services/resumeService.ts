import { chatJson } from "./openaiService.js";

export interface ParsedResume {
  candidateName: string | null;
  email: string | null;
  phone: string | null;
  skills: string[];
  companies: string[];
  jobTitles: string[];
  yearsExperience: number | null;
  education: string[];
  certifications: string[];
  technologies: string[];
  industry: string | null;
  responsibilities: string[];
  achievements: string[];
  careerProgression: string | null;
}

export async function parseResume(params: { organizationId: string; resumeText: string }): Promise<ParsedResume> {
  return chatJson<ParsedResume>({
    organizationId: params.organizationId,
    system: `You extract structured candidate data from resumes for a recruiting platform. Extract only what
is actually present in the text — never invent skills, employers, or credentials that aren't stated. JSON only.`,
    user: `Resume text:\n${params.resumeText.slice(0, 12000)}\n\nRespond with JSON matching:
{
  "candidateName": string | null,
  "email": string | null,
  "phone": string | null,
  "skills": string[],
  "companies": string[],
  "jobTitles": string[],
  "yearsExperience": number | null,
  "education": string[],
  "certifications": string[],
  "technologies": string[],
  "industry": string | null,
  "responsibilities": string[],
  "achievements": string[],
  "careerProgression": string | null
}`,
  });
}

export interface CandidateScoreResult {
  overallScore: number;
  skillMatch: number;
  experienceMatch: number;
  educationMatch: number;
  industryMatch: number;
  responsibilityMatch: number;
  salaryCompatibility: number;
  missingRequirements: string[];
  strengths: string[];
  concerns: string[];
  explanation: string;
}

export async function scoreCandidateAgainstJob(params: {
  organizationId: string;
  job: {
    title: string;
    requiredSkills: string[];
    preferredSkills: string[];
    minExperienceYears: number | null;
    education: string | null;
    aiCriteria: Record<string, unknown>;
    salaryMin: number | null;
    salaryMax: number | null;
  };
  candidate: ParsedResume;
  expectedSalary: number | null;
}): Promise<CandidateScoreResult> {
  return chatJson<CandidateScoreResult>({
    organizationId: params.organizationId,
    system: `You are an unbiased recruiting AI. Score how well a candidate matches a job based only on
skills, experience, education, industry background, responsibilities and salary compatibility. Never factor in
age, gender, race, national origin, disability, religion or any other protected characteristic — you are not
given that information and must not infer or penalize based on it. Scores are 0-100. Be honest: this is a
decision-support signal, not an infallible verdict, so explain your reasoning. JSON only.`,
    user: `Job: ${params.job.title}
Required skills: ${params.job.requiredSkills.join(", ") || "none specified"}
Preferred skills: ${params.job.preferredSkills.join(", ") || "none specified"}
Minimum experience (years): ${params.job.minExperienceYears ?? "not specified"}
Education requirement: ${params.job.education ?? "not specified"}
Additional AI-derived criteria: ${JSON.stringify(params.job.aiCriteria)}
Salary range: ${params.job.salaryMin ?? "?"} - ${params.job.salaryMax ?? "?"}
Candidate expected salary: ${params.expectedSalary ?? "not provided"}

Candidate profile:
${JSON.stringify(params.candidate, null, 2)}

Respond with JSON matching:
{
  "overallScore": number,
  "skillMatch": number,
  "experienceMatch": number,
  "educationMatch": number,
  "industryMatch": number,
  "responsibilityMatch": number,
  "salaryCompatibility": number,
  "missingRequirements": string[],
  "strengths": string[],
  "concerns": string[],
  "explanation": string
}`,
  });
}
