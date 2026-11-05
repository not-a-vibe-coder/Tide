import { log } from "../log.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface Provider {
  name: "groq" | "gemini";
  url: string;
  key: string;
  model: string;
}

export interface LlmOptions {
  groqKey?: string;
  geminiKey?: string;
  groqModels?: string[];
  geminiModels?: string[];
}

export const DEFAULT_GROQ_MODELS = ["qwen/qwen3.8-27b", "openai/gpt-oss-20b"];
export const DEFAULT_GEMINI_MODELS = ["gemini-3.5-flash", "gemini-flash-latest"];

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";

/**
 * The same provider chain Jasmine uses: Groq first, then Gemini. Both speak the
 * OpenAI chat format. Each model is tried in order until one gives a reply.
 */
export class Llm {
  readonly providers: Provider[];

  constructor(opts: LlmOptions) {
    const groq = (opts.groqModels?.length ? opts.groqModels : DEFAULT_GROQ_MODELS).map(
      (model): Provider => ({ name: "groq", url: GROQ_URL, key: opts.groqKey ?? "", model }),
    );
    const gemini = (opts.geminiModels?.length ? opts.geminiModels : DEFAULT_GEMINI_MODELS).map(
      (model): Provider => ({ name: "gemini", url: GEMINI_URL, key: opts.geminiKey ?? "", model }),
    );
    this.providers = [...(opts.groqKey ? groq : []), ...(opts.geminiKey ? gemini : [])];
  }

  get enabled(): boolean {
    return this.providers.length > 0;
  }

  async chat(messages: ChatMessage[], maxTokens = 400): Promise<string | null> {
    for (const p of this.providers) {
      try {
        const text = await this.call(p, messages, maxTokens);
        if (text) return text;
      } catch (err) {
        log.warn(`${p.name}/${p.model} failed: ${err instanceof Error ? err.message : err}`);
      }
    }
    return null;
  }

  private async call(p: Provider, messages: ChatMessage[], maxTokens: number): Promise<string | null> {
    const res = await fetch(p.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${p.key}` },
      body: JSON.stringify({ model: p.model, messages, temperature: 0.8, max_tokens: maxTokens, ...reasoningSettings(p) }),
      signal: AbortSignal.timeout(25_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { choices?: { message?: { content?: string | null } }[] };
    const text = body.choices?.[0]?.message?.content?.trim();
    return text || null;
  }
}

/** Hide reasoning so replies are fast and the model never thinks out loud. Mirrors Jasmine. */
export function reasoningSettings(p: Provider): Record<string, unknown> {
  const model = p.model.toLowerCase();
  if (p.name === "groq") {
    if (model.includes("gpt-oss")) return { reasoning_effort: "low", include_reasoning: false };
    return { reasoning_format: "hidden", reasoning_effort: model.includes("qwen") ? "none" : "low" };
  }
  // Gemini: Flash Lite rejects "none", so it gets the lowest level it accepts.
  return { reasoning_effort: model.includes("lite") ? "low" : "none" };
}
