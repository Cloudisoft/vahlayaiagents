import { chatJson } from "../services/openaiService.js";

export interface AgentTurnResult {
  agentReply: string;
  shouldEndCall: boolean;
  disposition: string | null; // matches a call_dispositions.key when the agent judges the call resolved
}

export interface ConversationTurn {
  speaker: "agent" | "customer";
  text: string;
}

// Generates the AI agent's next line given the conversation so far. This
// drives the turn-based Plivo call flow (speak -> record -> transcribe ->
// generate next line -> speak again) — a real LLM-driven conversation, just
// not full-duplex/barge-in capable, which needs a media-streaming
// integration this phase doesn't build.
export async function generateAgentTurn(params: {
  organizationId: string;
  agent: {
    name: string;
    purpose: string | null;
    systemPrompt: string | null;
    tone: string;
    greeting: string | null;
    faqs: Array<{ question: string; answer: string }>;
    objectionHandling: Array<{ objection: string; response: string }>;
  };
  leadBusinessName: string;
  history: ConversationTurn[];
  availableDispositions: string[];
}): Promise<AgentTurnResult> {
  const system = `You are ${params.agent.name}, an AI voice agent for a business calling platform, speaking with
${params.leadBusinessName} on a phone call right now. Tone: ${params.agent.tone}. Purpose: ${params.agent.purpose ?? "general outreach"}.
${params.agent.systemPrompt ? `Instructions: ${params.agent.systemPrompt}` : ""}
Known FAQs: ${JSON.stringify(params.agent.faqs)}
Objection handling guidance: ${JSON.stringify(params.agent.objectionHandling)}

Rules: stay in character, be concise (1-3 sentences, this is a phone call), never invent pricing, guarantees,
or facts not given to you, and remain professional and respectful at all times. If the person asks to not be
called again, acknowledge it and end the call. Decide when the call is naturally over.
Respond with JSON only: { "agentReply": string, "shouldEndCall": boolean, "disposition": one of ${JSON.stringify(params.availableDispositions)} or null }`;

  const user = `Conversation so far:\n${params.history.map((t) => `${t.speaker}: ${t.text}`).join("\n") || "[call just connected]"}\n\nGenerate the agent's next line.`;

  return chatJson<AgentTurnResult>({ organizationId: params.organizationId, system, user });
}
