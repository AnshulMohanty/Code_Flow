// LLM access for AI pipeline stages, behind a tiny injectable interface so unit tests
// mock it and make ZERO real API calls. The model + key are configuration (owner's
// keys per the plan) — never hardcoded.

import type { TokenUsage } from "@codeflow/shared-types";
import { estimatedUsage, measuredUsage, usageNumber } from "../util/tokens.js";

export interface LlmCompletionRequest {
  /** Optional system prompt. */
  system?: string;
  /** The user prompt. The stage assembles this from deterministic facts (bounded view). */
  prompt: string;
  /** Sampling temperature. AI stages use 0 so a given SHA's output is stable (eval set). */
  temperature?: number;
  /** Hard cap on output tokens. */
  maxTokens?: number;
  /**
   * Mark the STABLE PREFIX of this call for the provider's prompt cache (V3-P0). The
   * synthesize/answer prompts are built as [stable deterministic facts][volatile tail], so
   * caching the prefix cuts the input cost of every repeat call on the same repo.
   *
   * Providers differ in how it is requested — Anthropic needs an explicit `cache_control`
   * breakpoint, Gemini caches implicitly — so this is a HINT, not a guarantee. Whether it
   * actually hit is reported back in `TokenUsage.cacheReadTokens`, never assumed.
   */
  cachePrefix?: string;
  /**
   * MODEL-ROUTING hint (V3-P5). States the KIND of work this call is doing, and for community work
   * the P4 complexity score, so a router can pick a tier.
   *
   * It lives on the REQUEST contract rather than on a separate router interface for one reason: it
   * lets `createRoutedLlmClient` BE an `LlmClient`, so routing can be added at the composition root
   * without editing a single call site. A provider adapter ignores this field — the router strips it
   * before delegating.
   */
  routing?: RoutingHint;
}

/** The kind of work a completion is doing. Named after the CALL SITE, not after a model capability,
 *  so a new model tier never requires renaming the tasks. */
export type ModelTask =
  | "specialist"
  | "supervisor"
  | "synthesis"
  | "agent-turn"
  | "judge"
  | "classification";

export interface RoutingHint {
  task: ModelTask;
  /** 0..1 from V3-P4's `complexityOf`. Only meaningful for `specialist`. */
  complexity?: number;
}

/**
 * A completion plus what it actually cost. Widened from a bare `string` in V3-P0: the old
 * shape made "cost is measured, not estimated" impossible, because the only number
 * available at the call site was a character-count guess.
 */
export interface LlmCompletionResult {
  /** The model's RAW text completion (the stage parses + validates it). */
  text: string;
  /** Provider-reported usage where available; `measured: false` when it had to be estimated. */
  usage: TokenUsage;
}

/** A chat/synthesis provider identifier (part of the synthesis cache key, so switching
 *  providers never serves a completion from the wrong model). */
export type LlmProvider = "anthropic" | "gemini" | "openai";

/** Returns the model's raw completion + its real token cost. */
export interface LlmClient {
  /** Vendor identifier — scopes the synthesis cache key (see synthesize.ts). */
  readonly provider: LlmProvider;
  readonly model: string;
  complete(request: LlmCompletionRequest): Promise<LlmCompletionResult>;
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
    async complete(request: LlmCompletionRequest): Promise<LlmCompletionResult> {
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
          // PROMPT CACHING: Anthropic needs an explicit breakpoint, so the stable prefix
          // becomes its own system block marked `cache_control: ephemeral` and the
          // volatile instructions follow it. Blocks before the breakpoint are cached; a
          // hit shows up as `cache_read_input_tokens` in the usage below.
          ...anthropicSystem(request),
          messages: [{ role: "user", content: request.prompt }],
        }),
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`Anthropic API error ${response.status}: ${detail.slice(0, 500)}`);
      }

      const json = (await response.json()) as {
        content?: Array<{ type: string; text?: string }>;
        usage?: {
          input_tokens?: unknown;
          output_tokens?: unknown;
          cache_read_input_tokens?: unknown;
          cache_creation_input_tokens?: unknown;
        };
      };
      const text = (json.content ?? [])
        .filter((block) => block.type === "text" && typeof block.text === "string")
        .map((block) => block.text)
        .join("");
      if (!text) {
        throw new Error("Anthropic API returned no text content.");
      }

      const inputTokens = usageNumber(json.usage?.input_tokens);
      const outputTokens = usageNumber(json.usage?.output_tokens);
      const usage =
        inputTokens !== undefined && outputTokens !== undefined
          ? measuredUsage(inputTokens, outputTokens, {
              read: usageNumber(json.usage?.cache_read_input_tokens),
              write: usageNumber(json.usage?.cache_creation_input_tokens),
            })
          : // Should not happen (Anthropic always reports usage), but a missing counter must
            // not silently record 0 tokens against the wallet.
            estimatedUsage(`${request.cachePrefix ?? ""}${request.system ?? ""}\n${request.prompt}`, text);

      return { text, usage };
    },
  };
}

/**
 * Build Anthropic's `system` field. With a `cachePrefix` it becomes a two-block array so a
 * `cache_control` breakpoint can sit after the stable part; without one it stays the plain
 * string the previous implementation sent (no behaviour change for uncached callers).
 */
function anthropicSystem(request: LlmCompletionRequest): Record<string, unknown> {
  if (request.cachePrefix) {
    const blocks: Array<Record<string, unknown>> = [
      { type: "text", text: request.cachePrefix, cache_control: { type: "ephemeral" } },
    ];
    if (request.system) blocks.push({ type: "text", text: request.system });
    return { system: blocks };
  }
  return request.system ? { system: request.system } : {};
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
    async complete(request: LlmCompletionRequest): Promise<LlmCompletionResult> {
      const response = await fetch(`${baseUrl}/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": options.apiKey,
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: request.prompt }] }],
          // PROMPT CACHING: Gemini caches implicitly on a shared leading prefix, so there
          // is no breakpoint to declare. The stable facts are prepended to the system
          // instruction (rather than the user prompt) to keep that prefix byte-identical
          // across calls, which is the precondition for an implicit cache hit. A hit is
          // reported as `cachedContentTokenCount` below — read, never assumed.
          ...geminiSystemInstruction(request),
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
        usageMetadata?: {
          promptTokenCount?: unknown;
          candidatesTokenCount?: unknown;
          cachedContentTokenCount?: unknown;
        };
      };
      const text = (json.candidates?.[0]?.content?.parts ?? [])
        .map((part) => part.text)
        .filter((value): value is string => typeof value === "string")
        .join("");
      if (!text) {
        throw new Error("Gemini API returned no text content.");
      }

      const promptTokens = usageNumber(json.usageMetadata?.promptTokenCount);
      const candidateTokens = usageNumber(json.usageMetadata?.candidatesTokenCount);
      const usage =
        promptTokens !== undefined
          ? measuredUsage(promptTokens, candidateTokens ?? 0, {
              read: usageNumber(json.usageMetadata?.cachedContentTokenCount),
            })
          : estimatedUsage(`${request.cachePrefix ?? ""}${request.system ?? ""}\n${request.prompt}`, text);

      return { text, usage };
    },
  };
}

/** Gemini has no cache breakpoint — the stable prefix simply leads the system instruction
 *  so the cached prefix stays byte-identical between calls. */
function geminiSystemInstruction(request: LlmCompletionRequest): Record<string, unknown> {
  const parts = [request.cachePrefix, request.system].filter((value): value is string => Boolean(value));
  if (!parts.length) return {};
  return { systemInstruction: { parts: parts.map((text) => ({ text })) } };
}

export interface OpenAiClientOptions {
  apiKey: string;
  /** Defaults to "gpt-4.1" — see DEFAULT_OPENAI_MODEL for why that tier and not a cheaper one. */
  model?: string;
  /** Override for tests/proxies, and for an Azure/OpenRouter-compatible gateway. */
  baseUrl?: string;
  maxTokens?: number;
  /** Sent as `OpenAI-Organization` when present. Some accounts require it; most do not. */
  organization?: string;
}

/**
 * The frontier default. Chosen to match what `SYNTHESIS_MODEL` means for Anthropic (the model whose
 * output a user reads), not the cheapest one that answers — `FAST_MODEL` is where cheap belongs.
 */
const DEFAULT_OPENAI_MODEL = "gpt-4.1";
/** Rows per completion when `maxTokens` is unset. Same number the Anthropic adapter defaults to. */
const OPENAI_DEFAULT_MAX_TOKENS = 2048;

/**
 * Minimal `fetch`-based OpenAI Chat Completions client — no SDK, mirroring the Anthropic and Gemini
 * adapters. Behind the SAME `LlmClient` interface, so every stage (synthesize, the specialist
 * fan-out, the agent turns, the judge) is unchanged and the grounding/citation path cannot tell the
 * difference. Selected by `LLM_PROVIDER=openai` — see providers.ts.
 *
 *   POST {baseUrl}/v1/chat/completions   header authorization: Bearer <key>
 *   body { model, messages: [{role, content}], temperature, max_completion_tokens,
 *          response_format: { type: "json_object" } }
 *   → { choices: [{ message: { content } }], usage: { prompt_tokens, completion_tokens,
 *       prompt_tokens_details: { cached_tokens } } }
 *
 * `response_format: json_object` is the counterpart of Gemini's `responseMimeType` and of the
 * fence-stripping the Anthropic path relies on: every AI stage here parses JSON, and asking the
 * provider for JSON is cheaper and more reliable than repairing prose. OpenAI requires the word
 * "JSON" to appear in the conversation for that mode, which the stages' own schema instructions
 * already satisfy — and `completionText` still strips a fence if one arrives anyway.
 *
 * PROMPT CACHING is AUTOMATIC on OpenAI (prefixes over ~1024 tokens), so like Gemini there is no
 * breakpoint to declare; the stable prefix leads the system message to keep that prefix
 * byte-identical between calls. A hit comes back as `prompt_tokens_details.cached_tokens` and is
 * REPORTED, never assumed. Note OpenAI counts cached tokens INSIDE `prompt_tokens`, which is the
 * same convention `measuredUsage` already applies to Anthropic's `cache_read_input_tokens`.
 *
 * REASONING MODELS (the o-series) are deliberately NOT the default: they reject `temperature: 0`,
 * and temperature 0 is what makes a given SHA's output stable for the eval set. Setting
 * `OPENAI_MODEL` to one is therefore a supported-provider/unsupported-model combination, and it
 * fails loudly at the first call rather than quietly producing non-reproducible analyses.
 */
export function createOpenAiClient(options: OpenAiClientOptions): LlmClient {
  const baseUrl = options.baseUrl ?? "https://api.openai.com";
  const model = options.model ?? DEFAULT_OPENAI_MODEL;
  const defaultMaxTokens = options.maxTokens ?? OPENAI_DEFAULT_MAX_TOKENS;

  return {
    provider: "openai",
    model,
    async complete(request: LlmCompletionRequest): Promise<LlmCompletionResult> {
      const system = [request.cachePrefix, request.system].filter((value): value is string => Boolean(value));
      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${options.apiKey}`,
          ...(options.organization ? { "openai-organization": options.organization } : {}),
        },
        body: JSON.stringify({
          model,
          messages: [
            ...(system.length ? [{ role: "system", content: system.join("\n\n") }] : []),
            { role: "user", content: request.prompt },
          ],
          temperature: request.temperature ?? 0,
          max_completion_tokens: request.maxTokens ?? defaultMaxTokens,
          response_format: { type: "json_object" },
        }),
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`OpenAI API error ${response.status}: ${detail.slice(0, 500)}`);
      }

      const json = (await response.json()) as {
        choices?: Array<{ message?: { content?: string | null } }>;
        usage?: {
          prompt_tokens?: unknown;
          completion_tokens?: unknown;
          prompt_tokens_details?: { cached_tokens?: unknown };
        };
      };
      const text = (json.choices ?? [])
        .map((choice) => choice.message?.content)
        .filter((value): value is string => typeof value === "string" && value.length > 0)
        .join("");
      if (!text) {
        throw new Error("OpenAI API returned no text content.");
      }

      const inputTokens = usageNumber(json.usage?.prompt_tokens);
      const outputTokens = usageNumber(json.usage?.completion_tokens);
      const usage =
        inputTokens !== undefined
          ? measuredUsage(inputTokens, outputTokens ?? 0, {
              read: usageNumber(json.usage?.prompt_tokens_details?.cached_tokens),
            })
          : // OpenAI always reports usage on a non-streaming call, but a missing counter must not
            // silently record 0 tokens against the wallet — same rule as the Anthropic adapter.
            estimatedUsage(`${request.cachePrefix ?? ""}${request.system ?? ""}\n${request.prompt}`, text);

      return { text, usage };
    },
  };
}
