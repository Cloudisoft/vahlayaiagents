// Placeholders like {{first_name}} in scripts, greetings and voicemail
// scripts (playbook §1, §4). Normalised on save so "{First Name}",
// "[first name]" or "{{ First_Name }}" all become {{first_name}}; at render
// time unknown placeholders are removed, never read out literally.

export const BUILT_IN_PLACEHOLDERS = [
  "first_name",
  "last_name",
  "full_name",
  "agent_name",
  "intro_name",
  "callback_number",
  "company_name",
  "contact_title",
  "current_provider",
  "service_address",
  "city",
  "state",
] as const;

function canonical(raw: string): string {
  return raw.trim().toLowerCase().replace(/[\s-]+/g, "_").replace(/[^a-z0-9_]/g, "");
}

export function normalizePlaceholders(text: string, customKeys: string[] = []): string {
  const known = new Set<string>([...BUILT_IN_PLACEHOLDERS, ...customKeys.map(canonical)]);
  const swap = (whole: string, inner: string) => {
    const key = canonical(inner);
    return known.has(key) ? `{{${key}}}` : whole;
  };
  return text
    .replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (w, inner) => swap(w, inner))
    .replace(/(?<!\{)\{\s*([A-Za-z][A-Za-z0-9 _-]*?)\s*\}(?!\})/g, (w, inner) => swap(w, inner))
    .replace(/\[\s*([A-Za-z][A-Za-z0-9 _-]*?)\s*\]/g, (w, inner) => swap(w, inner));
}

export function renderTemplate(text: string, vars: Record<string, string | null | undefined>): string {
  return text
    .replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_w, inner) => {
      const value = vars[canonical(inner)];
      return value == null ? "" : String(value);
    })
    .replace(/\s+([,.!?])/g, "$1")
    .replace(/ {2,}/g, " ")
    .trim();
}

// "Ray - Conversationalist" -> "Ray"; agents say only the voice's own name.
export function spokenAgentName(voiceName: string | null | undefined): string {
  if (!voiceName) return "";
  return voiceName.split(/\s[-–—|(]\s?|\(/)[0].trim();
}

// Campaign intro names often carry copy markers from duplication
// ("MVA copy", "Spectrum (2)") — strip them so they're never spoken.
export function cleanIntroName(name: string | null | undefined): string {
  if (!name) return "";
  return name
    .replace(/\s*\((copy|\d+)\)\s*$/i, "")
    .replace(/\s+copy(\s*\d+)?\s*$/i, "")
    .trim();
}

export function leadTemplateVars(params: {
  lead: Record<string, any>;
  agentName: string;
  introName: string;
  callbackNumber: string | null;
}): Record<string, string | null> {
  const l = params.lead;
  const first = l.first_name ?? (l.decision_maker_name ?? l.owner_name ?? "").split(" ")[0] ?? null;
  const vars: Record<string, string | null> = {
    first_name: first || null,
    last_name: l.last_name ?? null,
    full_name: [l.first_name, l.last_name].filter(Boolean).join(" ") || null,
    agent_name: params.agentName,
    intro_name: params.introName,
    callback_number: params.callbackNumber,
    company_name: l.business_name ?? null,
    contact_title: l.contact_title ?? null,
    current_provider: l.current_provider ?? null,
    service_address: l.service_address ?? l.address ?? null,
    city: l.city ?? null,
    state: l.state ?? null,
  };
  for (const [k, v] of Object.entries(l.custom_fields ?? {})) {
    vars[canonical(k)] = v == null ? null : String(v);
  }
  return vars;
}
