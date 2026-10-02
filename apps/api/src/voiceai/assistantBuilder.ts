import { AI_OUTCOME_KEYS, AI_OUTCOMES } from "../services/dispositionsService.js";
import { cleanIntroName, leadTemplateVars, renderTemplate, spokenAgentName } from "./placeholders.js";
import { vapiServerUrl, vapiWebhookSecret } from "./vapiClient.js";

// Frozen at "Save & publish" (playbook §4). The dialer only ever builds
// calls from a published snapshot, never from live, half-edited settings.
export interface CampaignSnapshot {
  campaignId: string;
  version: number;
  introName: string;
  callbackNumber: string | null;
  script: string;
  knowledgeText: string;
  transferNumber: string | null;
  // Department lines from the escalation matrix; optional on older versions.
  transferTargets?: Partial<Record<TransferDept, string>>;
  recordingDisclosure?: boolean;
  maxCallDurationSeconds: number;
  llmModel: string;
  agent: {
    id: string;
    name: string;
    systemPrompt: string;
    personality: string | null;
    tone: string;
    greeting: string | null;
    endingMessage?: string | null;
    faqs: Array<{ question: string; answer: string }>;
    objectionHandling: Array<{ objection: string; response: string }>;
    fallbackBehavior: string | null;
    transferNumber: string | null;
    temperature: number;
    voice: { provider: string; providerVoiceId: string; name: string } | null;
  };
}

// VAPI's real limits (playbook §10), not the SDK docs': check interval
// must be ≥ 2.5 s and the beep wait ≤ 30 s or the API rejects the call.
export const VOICEMAIL_FREQUENCY_MIN_SECONDS = 2.5;
// No voicemails are left: hang up as soon as a machine is detected.
export const VOICEMAIL_BEEP_MAX_SECONDS = 0;
export const SILENCE_TIMEOUT_SECONDS = 20;
export const QUIET_CALLER_CHECKIN_SECONDS = 7;

export const DEFAULT_GREETING = "Hi {{first_name}}, this is {{agent_name}} with {{intro_name}}. How are you today?";

export function platformRules(vars: { agentName: string; introName: string; callbackNumber: string | null }): string {
  return `## Call rules — always follow
- You are on a live phone call. Speak in short, natural sentences. Ask ONE question at a time, then stop and listen.
- React to what the caller just said before moving on. If they ask a question, answer it first, then continue.
- Follow the script step by step, adapting to their answers. NEVER read headings, step numbers, labels, brackets or placeholders out loud.
- For facts (prices, promotions, speeds, availability) call search_knowledge_base. If the answer isn't there, say a specialist will confirm — never guess or invent prices, promotions or guarantees.
- Your name is ${vars.agentName}. You are calling on behalf of ${vars.introName}; introduce the company exactly that way and never claim to be a different company. If sincerely asked whether you are an AI, say yes.
- Receptionist, gatekeeper or call screener: in ONE sentence give your name, company and reason for calling, then wait. Ask for whoever handles the business's phone and internet services, or the best time to reach them.
- Automated phone menu: choose only the option that reaches a live person (operator, sales, front desk). Never explain yourself to a menu.
- Voicemail greeting or answering machine: never leave a message — end the call immediately without speaking.
- If they ask not to be called again: apologise briefly, call mark_do_not_call, say goodbye and end the call.
- Before ending or transferring, record the result with set_call_outcome. Book any agreed callback with book_callback.
- Only transfer when the caller agrees: say "Let me connect you now" and use the transfer tool.
- When the conversation is done (goodbye, not interested, wrong number, callback booked), say a short goodbye and end the call right away.${
    vars.callbackNumber ? `\n- If asked for a callback number, give ${vars.callbackNumber}, read digit by digit.` : ""
  }`;
}

function describeLead(lead: Record<string, any>, localTime: string): string {
  const lines = [
    `Business: ${lead.business_name ?? "unknown"}`,
    lead.first_name || lead.last_name ? `Contact: ${[lead.first_name, lead.last_name].filter(Boolean).join(" ")}${lead.contact_title ? `, ${lead.contact_title}` : ""}` : null,
    lead.current_provider ? `Current provider: ${lead.current_provider}` : null,
    lead.customer_type === "alc"
      ? "Customer type: ALC — already a Spectrum customer (goal: lower their bill with a new bundle/promotion, price lock)."
      : lead.customer_type === "non_alc"
        ? "Customer type: Non-ALC — uses another provider (goal: switch them with better bundle pricing, free installation, no contract)."
        : null,
    lead.lines_count ? `Phone lines: ${lead.lines_count}` : null,
    lead.locations_count ? `Locations: ${lead.locations_count}` : null,
    lead.contract_end_date ? `Contract ends: ${lead.contract_end_date}` : null,
    lead.service_address || lead.city ? `Location: ${lead.service_address ?? [lead.city, lead.state].filter(Boolean).join(", ")}` : null,
    ...Object.entries(lead.custom_fields ?? {})
      .filter(([, v]) => v === null || typeof v !== "object")
      .map(([k, v]) => `${k}: ${v}`),
    lead.custom_fields?.call_details
      ? `Learned on earlier calls (confirm, don't re-ask): ${Object.entries(lead.custom_fields.call_details)
          .map(([k, v]) => `${k.replace(/_/g, " ")}: ${Array.isArray(v) ? v.join(", ") : v}`)
          .join("; ")}`
      : null,
    `Caller's local date/time: ${localTime}`,
  ];
  return lines.filter(Boolean).join("\n");
}

export type TransferDept = "sales" | "support" | "retention" | "manager";

const DEPT_WHEN: Record<TransferDept, string> = {
  sales: "pricing, availability, promotions, contract questions or a new sale the caller agreed to",
  support: "technical issues, billing concerns, outages or installation problems",
  retention: "cancellation requests, dissatisfied customers or competitor comparisons",
  manager: "legal concerns, threats, escalated complaints, media inquiries or repeated unresolved issues",
};

export function transferDestinations(primary: string | null, targets: Partial<Record<TransferDept, string>>) {
  const out: Array<Record<string, unknown>> = [];
  const sales = targets.sales || primary;
  const all: Array<[TransferDept, string | null | undefined]> = [
    ["sales", sales],
    ["support", targets.support],
    ["retention", targets.retention],
    ["manager", targets.manager],
  ];
  for (const [dept, number] of all) {
    if (!number) continue;
    out.push({
      type: "number",
      number,
      message: "Please hold while I connect you.",
      description: `${dept[0].toUpperCase()}${dept.slice(1)} team — transfer for ${DEPT_WHEN[dept]}.`,
    });
  }
  return out;
}

// "Hi Sam, this is Hari with X. How are you?" ->
// "Hi Sam, this is Hari with X. This call may be recorded for quality purposes. How are you?"
export function withDisclosure(greeting: string, enabled: boolean): string {
  if (!enabled) return greeting;
  const line = "This call may be recorded for quality purposes.";
  const m = greeting.match(/^(.*[.!])\s+([^.!?]*\?)$/);
  return m ? `${m[1]} ${line} ${m[2]}` : `${greeting} ${line}`;
}

export interface BuiltCall {
  payload: Record<string, any>;
  optionalPaths: string[][];
}

export function buildVapiCall(params: {
  snapshot: CampaignSnapshot;
  lead: Record<string, any>;
  customerNumber: string;
  vapiPhoneNumberId: string;
  leadTimeZone: string;
  metadata: Record<string, string>;
  now?: Date;
}): BuiltCall {
  const { snapshot: s, lead } = params;
  const agentName = spokenAgentName(s.agent.voice?.name) || spokenAgentName(s.agent.name);
  const introName = cleanIntroName(s.introName);
  const vars = leadTemplateVars({ lead, agentName, introName, callbackNumber: s.callbackNumber });
  const localTime = new Intl.DateTimeFormat("en-US", {
    timeZone: params.leadTimeZone,
    dateStyle: "full",
    timeStyle: "short",
  }).format(params.now ?? new Date());

  const systemPrompt = [
    renderTemplate(s.agent.systemPrompt || "", vars),
    s.agent.personality ? `## Personality\n${s.agent.personality}. Tone: ${s.agent.tone}.` : `Tone: ${s.agent.tone}.`,
    s.script ? `## Campaign script\n${renderTemplate(s.script, vars)}` : null,
    s.agent.objectionHandling.length
      ? `## Objection handling\n${s.agent.objectionHandling.map((o) => `- "${o.objection}": ${o.response}`).join("\n")}`
      : null,
    s.agent.fallbackBehavior ? `## If unsure\n${renderTemplate(s.agent.fallbackBehavior, vars)}` : null,
    `## Who you're calling\n${describeLead(lead, localTime)}`,
    platformRules({ agentName, introName, callbackNumber: s.callbackNumber }),
  ]
    .filter(Boolean)
    .join("\n\n");

  const transferNumber = s.transferNumber || s.agent.transferNumber;
  const tools: any[] = [
    { type: "endCall" },
    {
      type: "function",
      function: {
        name: "mark_do_not_call",
        description: "The caller asked not to be called again. Puts the number on the Do Not Call list.",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "set_call_outcome",
        description: "Record the result of the conversation before ending or transferring.",
        parameters: {
          type: "object",
          properties: {
            outcome: {
              type: "string",
              enum: AI_OUTCOME_KEYS,
              description: AI_OUTCOMES.map((o) => `${o.key}: ${o.ai}`).join(" | "),
            },
            call_category: {
              type: "string",
              enum: ["business", "residential", "existing_customer", "new_prospect", "technical_support", "billing", "retention", "survey"],
            },
            notes: { type: "string" },
            current_provider: { type: "string" },
            customer_type: { type: "string", enum: ["alc", "non_alc"] },
            contract_end_date: { type: "string", description: "YYYY-MM-DD if mentioned" },
          },
          required: ["outcome"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "book_callback",
        description: "Book a callback at a time the caller agreed to, in the caller's local time.",
        parameters: {
          type: "object",
          properties: {
            callback_local_datetime: { type: "string", description: "YYYY-MM-DDTHH:MM in the caller's local time" },
            with_decision_maker: { type: "boolean" },
            notes: { type: "string" },
          },
          required: ["callback_local_datetime"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "save_lead_details",
        description:
          "Save details the caller gives you as soon as you hear them (email, current bill, services, contract, decision maker, install time). Call it again whenever you learn more.",
        parameters: {
          type: "object",
          properties: {
            email: { type: "string", description: "Spell-checked email address the caller confirmed" },
            current_provider: { type: "string" },
            current_services: { type: "array", items: { type: "string", enum: ["internet", "phone", "tv", "mobile"] } },
            services_with_other_provider: { type: "array", items: { type: "string", enum: ["internet", "phone", "tv", "mobile"] } },
            current_monthly_bill: { type: "number", description: "USD per month" },
            contract_months_left: { type: "number" },
            early_termination_fee: { type: "number", description: "USD" },
            decision_maker_name: { type: "string" },
            direct_number: { type: "string" },
            business_address_confirmed: { type: "boolean" },
            best_install_time: { type: "string" },
            bill_copy_requested: { type: "boolean", description: "Caller agreed to email a copy of their current bill" },
            notes: { type: "string" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "record_survey",
        description: "Record survey answers when the caller agrees to a short satisfaction survey.",
        parameters: {
          type: "object",
          properties: {
            satisfaction: { type: "number", description: "1 (very unsatisfied) to 5 (very satisfied)" },
            would_recommend: { type: "boolean" },
            improvement: { type: "string", description: "What we can improve, in the caller's words" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "search_knowledge_base",
        description: "Look up facts about plans, pricing, promotions, features and availability. Use instead of guessing.",
        parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      },
    },
  ];
  const destinations = transferDestinations(transferNumber, s.transferTargets ?? {});
  if (destinations.length) {
    tools.push({
      type: "transferCall",
      destinations,
    });
  }

  const greeting = withDisclosure(renderTemplate(s.agent.greeting || DEFAULT_GREETING, vars), Boolean(s.recordingDisclosure));

  const assistant: Record<string, any> = {
    name: `${introName} – ${agentName}`.slice(0, 40),
    firstMessage: greeting,
    firstMessageMode: "assistant-speaks-first",
    model: {
      provider: "openai",
      model: s.llmModel,
      temperature: s.agent.temperature,
      messages: [{ role: "system", content: systemPrompt }],
      tools,
    },
    transcriber: { provider: "deepgram", model: "nova-3", language: "en" },
    // Caller can cut the AI off instantly; short backchannels don't.
    stopSpeakingPlan: {
      numWords: 0,
      voiceSeconds: 0.2,
      backoffSeconds: 1,
      acknowledgementPhrases: ["uh-huh", "mm-hmm", "yeah", "okay", "right", "got it", "sure"],
    },
    // Wait for the caller to finish before replying.
    startSpeakingPlan: { waitSeconds: 0.4, smartEndpointingPlan: { provider: "livekit" } },
    hooks: [
      {
        on: "customer.speech.timeout",
        options: { timeoutSeconds: QUIET_CALLER_CHECKIN_SECONDS, triggerMaxCount: 2, triggerResetMode: "onUserSpeech" },
        do: [{ type: "say", exact: ["Are you still with me?", "Sorry — did I lose you there?"] }],
      },
    ],
    silenceTimeoutSeconds: SILENCE_TIMEOUT_SECONDS,
    maxDurationSeconds: s.maxCallDurationSeconds,
    backgroundSound: "office",
    endCallMessage: renderTemplate(s.agent.endingMessage || "Thanks for your time. Have a great day!", vars),
    voicemailDetection: {
      provider: "vapi",
      backoffPlan: { startAtSeconds: 2.5, frequencySeconds: VOICEMAIL_FREQUENCY_MIN_SECONDS, maxRetries: 5 },
      beepMaxAwaitSeconds: VOICEMAIL_BEEP_MAX_SECONDS,
    },
    monitorPlan: { listenEnabled: true, controlEnabled: true },
    artifactPlan: { recordingEnabled: true },
    analysisPlan: {
      summaryPlan: { enabled: true },
      successEvaluationPlan: { enabled: true, rubric: "NumericScale" },
    },
    server: { url: vapiServerUrl(), headers: { "x-vapi-secret": vapiWebhookSecret() } },
    serverMessages: ["status-update", "transcript", "tool-calls", "end-of-call-report", "transfer-update", "hang"],
    metadata: params.metadata,
  };

  if (s.agent.voice) {
    assistant.voice = {
      provider: s.agent.voice.provider,
      voiceId: s.agent.voice.providerVoiceId,
      ...(s.agent.voice.provider === "cartesia" ? { model: "sonic-3" } : {}),
    };
  }

  const name = [lead.first_name, lead.last_name].filter(Boolean).join(" ") || lead.business_name || undefined;

  return {
    payload: {
      phoneNumberId: params.vapiPhoneNumberId,
      customer: { number: params.customerNumber, ...(name ? { name: String(name).slice(0, 40) } : {}) },
      assistant,
      metadata: params.metadata,
    },
    optionalPaths: [
      ["assistant", "hooks"],
      ["assistant", "backgroundSound"],
      ["assistant", "stopSpeakingPlan", "acknowledgementPhrases"],
      ["assistant", "startSpeakingPlan", "smartEndpointingPlan"],
      ["assistant", "analysisPlan"],
      ["assistant", "serverMessages"],
      ["assistant", "transcriber"],
      ["assistant", "voice", "model"],
      ["assistant", "endCallMessage"],
    ],
  };
}
