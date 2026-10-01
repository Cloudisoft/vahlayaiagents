// Backup voicemail detector (playbook §2): if the other side's first 3
// lines within 45 s match a greeting, the call is Voicemail — regardless of
// whether VAPI's audio detector fired.

const GREETING_PATTERNS = [
  /leave (a|your) (message|name)/i,
  /at the (tone|beep)/i,
  /after the (tone|beep)/i,
  /not available/i,
  /unavailable/i,
  /mailbox/i,
  /automated voice messaging system/i,
  /record your message/i,
  /voice ?mail/i,
  /please leave/i,
  /can'?t (take|come to) (your|the) (call|phone)/i,
];

export interface TranscriptLine {
  role: string; // "user" (the callee) | "assistant" | ...
  text: string;
  secondsFromStart: number;
}

export function looksLikeVoicemail(lines: TranscriptLine[]): boolean {
  const callee = lines.filter((l) => l.role === "user" || l.role === "customer").slice(0, 3);
  return callee.some((l) => l.secondsFromStart <= 45 && GREETING_PATTERNS.some((p) => p.test(l.text)));
}
