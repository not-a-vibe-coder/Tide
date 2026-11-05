/**
 * Cleans a model reply before it reaches the user, the same way Jasmine does:
 * no thinking out loud, no em/en dashes or " - " used as a pause.
 */

const THINK_BLOCK = /<(think|thinking|thought)>[\s\S]*?<\/\1>/gi;
const THINK_OPEN = /<(think|thinking|thought)>[\s\S]*$/i;
const UNICODE_DASH = /\s*[—–]\s*/g;
const HYPHEN_PAUSE = /([\p{L}\p{N}'")!?.])[ \t]+-[ \t]+([\p{L}\p{N}'"(])/gu;

export function replaceDashPauses(text: string): string {
  const parts = text.split("```");
  for (let i = 0; i < parts.length; i += 2) {
    let p = parts[i]!.replace(UNICODE_DASH, ", ");
    p = p.replace(HYPHEN_PAUSE, (m, a: string, b: string) => (/\d/.test(a) && /\d/.test(b) ? m : `${a}, ${b}`));
    p = p.replace(/, ,/g, ",").replace(/,,/g, ",").replace(/\., /g, ". ").replace(/^, /, "");
    parts[i] = p;
  }
  return parts.join("```");
}

/** Filler Jasmine never uses, removed wherever the model slips it in. */
const FILLER = /\b(absolutely|certainly|definitely|great question|i hear you|i understand)\b[,!.]?\s*/gi;

/**
 * Models drift back to sentence case. Force the texting voice: "i" not "I",
 * and a lowercase first letter at the start of each sentence or line. Words in
 * caps (tickers like SCOOP, SUI) and the middle of sentences are left alone.
 */
export function enforceVoice(text: string): string {
  const parts = text.split("```");
  for (let i = 0; i < parts.length; i += 2) {
    let p = parts[i]!;
    p = p.replace(FILLER, "");
    p = p.replace(/\bI(?=\b|'m|'ll|'d|'ve)/g, "i");
    p = p.replace(/\b(Sui|Solana|Walrus|Tatum|Telegram|Cetus|Raydium|Jupiter|Tide)\b/g, (w) => w.toLowerCase());
    p = p.replace(/(^|[.!?]\s+|\n\s*)([A-Z])(?=[a-z])/g, (_m, lead: string, c: string) => lead + c.toLowerCase());
    p = p.replace(/ {2,}/g, " ").replace(/ ([,.!?])/g, "$1");
    parts[i] = p;
  }
  return parts.join("```");
}

export function cleanReply(raw: string): string {
  let t = raw.replace(THINK_BLOCK, "").replace(THINK_OPEN, "");
  t = t.replace(/^\s*(tide|assistant)\s*:\s*/i, "");
  t = replaceDashPauses(t);
  t = enforceVoice(t);
  return t.replace(/\n{3,}/g, "\n\n").trim();
}

/** Telegram HTML only allows a few tags. Escape everything, then let b/i/code back in. */
export function toTelegramHtml(text: string): string {
  const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return escaped
    .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
    .replace(/(^|[\s(])_([^_\n]+)_(?=[\s.,!?)]|$)/g, "$1<i>$2</i>")
    .replace(/`([^`\n]+)`/g, "<code>$1</code>");
}
