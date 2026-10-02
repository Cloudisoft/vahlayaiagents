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
  [/cellco|verizon wireless/i, "Verizon Wireless"],
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

export function npaNxx(e164: string): { npa: string; nxx: string } | null {
  const m = /^\+1([2-9]\d{2})([2-9]\d{2})\d{4}$/.exec(e164);
  return m ? { npa: m[1], nxx: m[2] } : null;
}
