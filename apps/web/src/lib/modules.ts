export interface ModuleDef {
  key: string;
  title: string;
  subtitle: string;
  description: string;
  icon: string;
  route: string;
}

export const MODULES: ModuleDef[] = [
  {
    key: "hr",
    title: "VahlaySmartHR",
    subtitle: "AI-Driven Hiring & Workforce Intelligence",
    description: "Automatically screen resumes, score candidates, schedule interviews, and conduct AI-powered first-round phone screens.",
    icon: "🧑‍💼",
    route: "/hr",
  },
  {
    key: "coverage",
    title: "Vahlay Coverage Intelligence",
    subtitle: "Real-Time Phone Number Coverage & Compliance Intelligence",
    description: "Evaluate phone number serviceability, carrier, and line type using internal intelligence plus verified lookups.",
    icon: "🌐",
    route: "/coverage",
  },
  {
    key: "leadgen",
    title: "Vahlay Lead Discovery",
    subtitle: "B2B Business Discovery & Enrichment",
    description: "Identify, filter, and generate high-quality B2B business data across industries using intelligent data discovery.",
    icon: "🔍",
    route: "/leadgen",
  },
  {
    key: "voice_agents",
    title: "Vahlay AI Agents",
    subtitle: "Unified Voice Agent Platform",
    description: "Access all Vahlay AI calling agents — outbound sales, follow-ups, and qualification — from a single dedicated workspace.",
    icon: "📞",
    route: "/voice",
  },
  {
    key: "call_auditor",
    title: "Vahlay QCs",
    subtitle: "AI Call Quality & Compliance Analyst",
    description: "Vahlay QCs evaluates recorded sales calls for quality, compliance, and closing accuracy — delivering objective scores and coaching feedback.",
    icon: "🎧",
    route: "/voice/auditor",
  },
];
