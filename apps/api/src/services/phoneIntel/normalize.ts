export type LineType = "mobile" | "landline" | "voip" | "unknown";

// Historical files: W = wireless, L = landline, V = VoIP, U = unknown.
export function lineTypeFromHistorical(code: string | null | undefined, isWireless?: string | null): LineType {
  const c = String(code ?? "").trim().toUpperCase();
  if (c === "W" || c === "M" || c === "MOBILE" || c === "WIRELESS") return "mobile";
  if (c === "L" || c === "LANDLINE") return "landline";
  if (c === "V" || c === "VOIP") return "voip";
  if (String(isWireless ?? "").trim().toLowerCase() === "y") return "mobile";
  return "unknown";
}

// Twilio Lookup v2 line_type_intelligence.type values.
export function lineTypeFromTwilio(type: string | null | undefined): LineType {
  switch (String(type ?? "").trim()) {
    case "mobile":
      return "mobile";
    case "landline":
      return "landline";
    case "fixedVoip":
    case "nonFixedVoip":
      return "voip";
    default:
      // tollFree, premium, sharedCost, uan, voicemail, pager, personal, unknown
      return "unknown";
  }
}

// Carrier names arrive truncated and in many spellings ("Cellco
// Partnership dba Verizon", "Verizon Wireless"); statistics need one name
// per operating company. Order matters: first match wins.
const FAMILIES: Array<[RegExp, string]> = [
  [/cellcom/i, "Cellcom"],
  [/cellco partnership|verizon wireless/i, "Verizon Wireless"],
  [/new cingular|at&t wireless|at&t mobility|aerial comm|cricket/i, "AT&T Wireless"],
  [/t-?mobile|omnipoint|suncom|metropcs|powertel|voicestream/i, "T-Mobile"],
  [/sprint spectrum|sprintcom|nextel/i, "Sprint"],
  [/us cellular|united states cellular/i, "US Cellular"],
  [/google voice|google \(grand central\)/i, "Google Voice"],
  [/bandwidth/i, "Bandwidth"],
  [/onvoy|inteliquent|neutral tandem/i, "Onvoy / Inteliquent"],
  [/level 3|level3|centurylink|lumen|qwest|embarq|centel/i, "Lumen (CenturyLink / Level 3)"],
  [/time warner|twc|bright house|charter|spectrum|bresnan/i, "Charter / Spectrum"],
  [/comcast/i, "Comcast"],
  [/cox/i, "Cox"],
  [/sinch/i, "Sinch"],
  [/twilio/i, "Twilio"],
  [/telnyx/i, "Telnyx"],
  [/vonage/i, "Vonage"],
  [/ringcentral/i, "RingCentral"],
  [/teleport comm|tcg|at&t corp|at&t - pstn|at&t local|pacific bell|southwestern bell|bellsouth|ameritech|illinois bell|indiana bell|michigan bell|ohio bell|wisconsin bell|southern new england/i, "AT&T (wireline)"],
  [/mcimetro|mci worldcom|verizon (new york|new england|pennsylvania|new jersey|maryland|virginia|florida|california|north|south|delaware|washington)|verizon/i, "Verizon (wireline)"],
  [/frontier/i, "Frontier"],
  [/windstream/i, "Windstream"],
  [/consolidated comm/i, "Consolidated Communications"],
  [/cincinnati bell|altafiber/i, "Cincinnati Bell"],
  [/xo |xo$|xo comm/i, "XO / Verizon Business"],
  [/intermedia/i, "Intermedia"],
  [/telepacific|tpx/i, "TPx"],
  [/peerless/i, "Peerless Network"],
];

export function normalizeCarrier(raw: string | null | undefined): string | null {
  const s = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!s || /^unknown$/i.test(s) || /^n\/?a$/i.test(s)) return null;
  for (const [re, name] of FAMILIES) if (re.test(s)) return name;
  // Unmapped: strip legal suffixes and state tags so variants still group.
  return s
    .replace(/\b(inc|llc|l\.l\.c|corp|corporation|co|company|ltd|lp|l\.p)\b\.?/gi, "")
    .replace(/\s*-\s*[A-Z]{2}\b.*$/, "")
    .replace(/\s*\([^)]*\)?\s*$/, "")
    .replace(/[,.\s-]+$/, "")
    .trim() || null;
}

const SMALL_WORDS = new Set(["of", "the", "and", "dba", "de", "del"]);
const KEEP_UPPER = new Set(["PCS", "AT&T", "MCI", "TCG", "USA", "US", "XO", "TPX", "CLEC", "ILEC", "LEC", "TDS", "GTE", "SBC", "II", "III", "LP", "PR", "PSTN"]);

// The licensed company behind a number, as the carrier records name it:
// "NEW CINGULAR WIRELESS PCS, LLC - GA" -> "New Cingular Wireless PCS".
// Kept alongside the network family so sub-entities (AT&T's New Cingular,
// Pacific Bell, BellSouth...) are shown rather than merged away.
export function carrierEntity(raw: string | null | undefined): string | null {
  let s = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!s || /^unknown$/i.test(s) || /^n\/?a$/i.test(s)) return null;
  s = s
    .replace(/:\d+$/, "") // "Verizon Wireless:6006"
    .replace(/\s+-\s+[A-Za-z]{2}$/, "") // state tag "- GA"
    .replace(/,?\s*\b(inc|llc|l\.l\.c|corp|corporation|ltd|lp|l\.p)\b\.?(?=\s|$|,)/gi, "")
    .replace(/[,.\s-]+$/, "")
    .trim();
  if (!s) return null;
  const letters = s.replace(/[^A-Za-z]/g, "");
  const shouting = letters.length > 3 && letters === letters.toUpperCase();
  const words = s.split(" ").map((w, i) => {
    const bare = w.replace(/[^A-Za-z&]/g, "");
    if (KEEP_UPPER.has(bare.toUpperCase())) return w.toUpperCase();
    if (!shouting && /[a-z]/.test(w)) return w; // already mixed case
    const lower = w.toLowerCase();
    if (i > 0 && SMALL_WORDS.has(lower)) return lower;
    return lower.replace(/(^|[-/(])([a-z])/g, (_, p, c) => p + c.toUpperCase());
  });
  return words.join(" ");
}

// "New Cingular Wireless PCS (AT&T Wireless)"; just the family when the
// entity adds nothing.
export function carrierLabel(entity: string | null | undefined, family: string | null | undefined): string | null {
  // "AT&T (wireline)" -> "AT&T wireline", "Lumen (CenturyLink / Level 3)" -> "Lumen".
  const fam = family?.replace(/ \(wireline\)$/, " wireline").replace(/ \(.*\)$/, "") ?? null;
  if (!entity) return fam;
  if (!fam) return entity;
  const e = entity.toLowerCase().replace(/[^a-z0-9&]/g, "");
  const f = fam.toLowerCase().replace(/[^a-z0-9&]/g, "");
  if (e === f || e.startsWith(f)) return entity;
  if (f.startsWith(e)) return fam;
  return `${entity} (${fam})`;
}

export function npaNxx(e164: string): { npa: string; nxx: string } | null {
  const m = /^\+1([2-9]\d{2})([2-9]\d{2})\d{4}$/.exec(e164);
  return m ? { npa: m[1], nxx: m[2] } : null;
}
