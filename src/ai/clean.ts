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

export function cleanReply(raw: string): string {
  let t = raw.replace(THINK_BLOCK, "").replace(THINK_OPEN, "");
  t = t.replace(/^\s*(tide|assistant)\s*:\s*/i, "");
  t = replaceDashPauses(t);
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
