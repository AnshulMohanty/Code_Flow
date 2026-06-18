// LLM access for AI pipeline stages, behind a tiny injectable interface so unit tests
// mock it and make ZERO real API calls. The model + key are configuration (owner's
// keys per the plan) — never hardcoded.

export interface LlmCompletionRequest {
  /** Optional system prompt. */
  system?: string;
  /** The user prompt. The stage assembles this from deterministic facts (bounded view). */
  prompt: string;
  /** Sampling temperature. AI stages use 0 so a given SHA's output is stable (eval set). */
  temperature?: number;
  /** Hard cap on output tokens. */
  maxTokens?: number;
}

/** A chat/synthesis provider identifier (part of the synthesis cache key, so switching
 *  providers never serves a completion from the wrong model). */
export type LlmProvider = "anthropic" | "gemini";

/** Returns the model's RAW text completion (the stage parses + validates it). */
export interface LlmClient {
  /** Vendor identifier — scopes the synthesis cache key (see synthesize.ts). */
  readonly provider: LlmProvider;
  readonly model: string;
  complete(request: LlmCompletionRequest): Promise<string>;
}

export interface AnthropicClientOptions {
  apiKey: string;
  model: string;
  /** Override for tests/proxies; defaults to the public API. */
  baseUrl?: string;
  maxTokens?: number;
}

/**
 * Minimal `fetch`-based Anthropic Messages client — no SDK dependency. This is the
 * production adapter wired in the worker's composition root when an API key is
 * configured; it is NOT exercised by unit tests (those inject a mock LlmClient), so it
 * is deliberately small and side-effect-only at call time.
 */
export function createAnthropicClient(options: AnthropicClientOptions): LlmClient {
  const baseUrl = options.baseUrl ?? "https://api.anthropic.com";
  const defaultMaxTokens = options.maxTokens ?? 2048;

  return {
    provider: "anthropic",
    model: options.model,
    async complete(request: LlmCompletionRequest): Promise<string> {
      const response = await fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": options.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: options.model,
          max_tokens: request.maxTokens ?? defaultMaxTokens,
          temperature: request.temperature ?? 0,
          ...(request.system ? { system: request.system } : {}),
          messages: [{ role: "user", content: request.prompt }],
        }),
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`Anthropic API error ${response.status}: ${detail.slice(0, 500)}`);
      }

      const json = (await response.json()) as { content?: Array<{ type: string; text?: string }> };
      const text = (json.content ?? [])
        .filter((block) => block.type === "text" && typeof block.text === "string")
        .map((block) => block.text)
        .join("");
      if (!text) {
        throw new Error("Anthropic API returned no text content.");
      }
      return text;
    },
  };
}

export interface GeminiClientOptions {
  apiKey: string;
  /** Defaults to "gemini-2.5-flash" (stable, strong structured output). NOTE: do NOT
   *  default to gemini-2.0-flash — it is shut down. */
  model?: string;
  /** Override for tests/proxies; defaults to the public API. */
  baseUrl?: string;
  maxTokens?: number;
}

const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";

/**
 * Minimal `fetch`-based Google Gemini (Generative Language API) client — no SDK,
 * mirroring `createAnthropicClient`. Behind the SAME `LlmClient` interface, so the
 * synthesize stage (fence-strip → parse → validate → ground) is unchanged.
 *
 * temperature 0 + responseMimeType "application/json" keeps the assembled-prompt →
 * output path deterministic (same property the Anthropic path relies on). The system
 * prompt rides Gemini's `systemInstruction` field so the JSON-schema instructions still
 * reach the model.
 */
export function createGeminiClient(options: GeminiClientOptions): LlmClient {
  const baseUrl = options.baseUrl ?? "https://generativelanguage.googleapis.com";
  const model = options.model ?? DEFAULT_GEMINI_MODEL;

  return {
    provider: "gemini",
    model,
    async complete(request: LlmCompletionRequest): Promise<string> {
      const response = await fetch(`${baseUrl}/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": options.apiKey,
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: request.prompt }] }],
          ...(request.system ? { systemInstruction: { parts: [{ text: request.system }] } } : {}),
          generationConfig: {
            temperature: request.temperature ?? 0,
            responseMimeType: "application/json",
            ...(request.maxTokens ? { maxOutputTokens: request.maxTokens } : {}),
          },
        }),
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`Gemini API error ${response.status}: ${detail.slice(0, 500)}`);
      }

      const json = (await response.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      };
      const text = (json.candidates?.[0]?.content?.parts ?? [])
        .map((part) => part.text)
        .filter((value): value is string => typeof value === "string")
        .join("");
      if (!text) {
        throw new Error("Gemini API returned no text content.");
      }
      return text;
    },
  };
}
