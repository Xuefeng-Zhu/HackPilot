/**
 * Server-side LLM calls for HackPilot actions.
 *
 * Provider chain (first configured provider wins, the next one takes over on
 * an error, 404/410 model-not-available, 429, or timeout):
 *
 *   1. NVIDIA build (integrate.api.nvidia.com, OpenAI-compatible)
 *      key `NVIDIA_API_KEY`; model `NVIDIA_MODEL` for fast structured calls,
 *      `NVIDIA_BUILD_MODEL` for code generation.
 *   2. OpenRouter
 *      key `OPENROUTER_API_KEY`; model `OPENROUTER_MODEL` for structured calls,
 *      `OPENROUTER_BUILD_MODEL` for code generation.
 *
 * Keys resolve through the framework secret store (user / org vault first,
 * deploy env fallback). Every caller has a deterministic or agent-driven
 * fallback, so the app works before any key is configured.
 */
import { fail } from "@agent-native/core/action";
import { AGENT_MODEL_CONFIG } from "@agent-native/core/agent/model-config";
import {
  readDeployCredentialEnv,
  resolveSecret,
} from "@agent-native/core/server";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateObject, type LanguageModel } from "ai";
import type { z } from "zod";

export const OPENROUTER_KEY = "OPENROUTER_API_KEY";
export const NVIDIA_KEY = "NVIDIA_API_KEY";
export const NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/** Benchmarked defaults (Nov 2026, see README "LLM providers"). */
export const DEFAULT_NVIDIA_MODEL = "nvidia/nemotron-3.5-super-vl-120b-a12b";
export const DEFAULT_NVIDIA_BUILD_MODEL = "nvidia/nemotron-3.5-super-vl-120b-a12b";
export const DEFAULT_OPENROUTER_BUILD_MODEL = "openai/gpt-6-luna";

export type ProviderId = "nvidia" | "openrouter";
export type Purpose = "fast" | "build";

interface ProviderTarget {
  provider: ProviderId;
  model: string;
  apiKey: string;
  baseURL: string;
}

async function resolveKey(name: string): Promise<string | null> {
  try {
    const value = await resolveSecret(name);
    if (value) return value;
  } catch {
    // Secret store unavailable (for example a bare CLI run): use deploy env.
  }
  return readDeployCredentialEnv(name) ?? process.env[name] ?? null;
}

const env = (name: string) => process.env[name]?.trim() || undefined;

export function modelFor(provider: ProviderId, purpose: Purpose): string {
  if (provider === "nvidia") {
    return purpose === "build"
      ? (env("NVIDIA_BUILD_MODEL") ?? DEFAULT_NVIDIA_BUILD_MODEL)
      : (env("NVIDIA_MODEL") ?? DEFAULT_NVIDIA_MODEL);
  }
  return purpose === "build"
    ? (env("OPENROUTER_BUILD_MODEL") ?? DEFAULT_OPENROUTER_BUILD_MODEL)
    : (env("OPENROUTER_MODEL") ?? AGENT_MODEL_CONFIG.aiSdk.openrouter.defaultModel);
}

/** Configured providers in priority order for a purpose. */
export async function providerChain(purpose: Purpose): Promise<ProviderTarget[]> {
  const chain: ProviderTarget[] = [];
  const disabled = new Set(
    (env("HACKPILOT_DISABLE_PROVIDERS") ?? "").split(",").map((s) => s.trim()),
  );
  const nv = disabled.has("nvidia") ? null : await resolveKey(NVIDIA_KEY);
  if (nv) {
    chain.push({ provider: "nvidia", model: modelFor("nvidia", purpose), apiKey: nv, baseURL: NVIDIA_BASE_URL });
  }
  const or = disabled.has("openrouter") ? null : await resolveKey(OPENROUTER_KEY);
  if (or) {
    chain.push({ provider: "openrouter", model: modelFor("openrouter", purpose), apiKey: or, baseURL: OPENROUTER_BASE_URL });
  }
  return chain;
}

/** Back-compat name used by callers and the UI status line. */
export function openRouterModelId(): string {
  return modelFor("openrouter", "fast");
}

export async function isLlmConfigured(): Promise<boolean> {
  return (await providerChain("fast")).length > 0;
}

function languageModel(t: ProviderTarget): LanguageModel {
  if (t.provider === "openrouter") {
    return createOpenRouter({
      apiKey: t.apiKey,
      appName: "HackPilot",
      appUrl: "https://www.agent-native.com",
    }).chat(t.model);
  }
  return createOpenAI({
    apiKey: t.apiKey,
    baseURL: t.baseURL,
    name: "nvidia",
    fetch: nvidiaFetch,
  }).chat(t.model);
}

/**
 * Nemotron models on NVIDIA build think before answering by default, which
 * multiplies latency for structured calls. Turn it off unless NVIDIA_THINKING=1.
 */
export function nvidiaExtraBody(): Record<string, unknown> {
  return env("NVIDIA_THINKING") === "1" ? {} : { chat_template_kwargs: { enable_thinking: false } };
}

const nvidiaFetch: typeof fetch = async (input, init) => {
  if (init?.body && typeof init.body === "string") {
    try {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      init = { ...init, body: JSON.stringify({ ...body, ...nvidiaExtraBody() }) };
    } catch {
      // not JSON: send as is
    }
  }
  return fetch(input, init);
};



const short = (e: unknown) =>
  (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 240);

/**
 * Generate a schema-validated object. Fails with `llm_not_configured` when no
 * key is set so callers (and the agent) can fall back.
 */
export async function generateStructured<T extends z.ZodType>(opts: {
  schema: T;
  system: string;
  prompt: string;
  timeoutMs?: number;
}): Promise<{ object: z.infer<T>; model: string; provider: ProviderId }> {
  const chain = await providerChain("fast");
  if (!chain.length) {
    fail(
      "No NVIDIA_API_KEY or OPENROUTER_API_KEY is configured for in-action AI. The chat agent can do this step itself: read the hackathon with get-hackathon and write results with the matching action.",
      { errorCode: "llm_not_configured", statusCode: 412 },
    );
  }
  const errors: string[] = [];
  for (const target of chain) {
    try {
      const result = await generateObject({
        model: languageModel(target),
        schema: opts.schema,
        // NIM accepts json_schema but not every model honours strict mode;
        // non-strict schema plus zod validation works on both providers.
        ...(target.provider === "nvidia" ? { providerOptions: { nvidia: { strictJsonSchema: false } } } : {}),
        system: opts.system,
        prompt: opts.prompt,
        abortSignal: AbortSignal.timeout(opts.timeoutMs ?? 90_000),
        maxRetries: 0,
      });
      return { object: result.object as z.infer<T>, model: target.model, provider: target.provider };
    } catch (error) {
      errors.push(`${target.provider}/${target.model}: ${short(error)}`);
      console.warn(`[llm] ${target.provider} failed, trying next provider: ${short(error)}`);
    }
  }
  fail(`The model call failed on every provider. ${errors.join(" | ")}`, {
    errorCode: "llm_failed",
    statusCode: 502,
  });
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatResult {
  text: string;
  provider: ProviderId;
  model: string;
  ms: number;
  completionTokens: number | null;
  /** USD, when the provider reports it (OpenRouter does). */
  cost: number | null;
  attempts: string[];
}

class ProviderError extends Error {}

/**
 * One streamed chat completion against an OpenAI-compatible endpoint. Streams
 * so long generations survive gateway idle timeouts (NVIDIA returns 504 on a
 * multi-minute non-streamed call).
 */
async function streamChat(
  t: ProviderTarget,
  messages: ChatMessage[],
  opts: { maxTokens: number; timeoutMs: number; firstTokenMs: number; jsonObject: boolean },
): Promise<Omit<ChatResult, "attempts">> {
  const started = Date.now();
  const ctrl = new AbortController();
  const total = setTimeout(() => ctrl.abort(new Error(`timed out after ${opts.timeoutMs} ms`)), opts.timeoutMs);
  let firstTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(
    () => ctrl.abort(new Error(`no output after ${opts.firstTokenMs} ms`)),
    opts.firstTokenMs,
  );
  try {
    const res = await fetch(`${t.baseURL}/chat/completions`, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        Authorization: `Bearer ${t.apiKey}`,
        "Content-Type": "application/json",
        ...(t.provider === "openrouter"
          ? { "HTTP-Referer": "https://www.agent-native.com", "X-Title": "HackPilot" }
          : {}),
      },
      body: JSON.stringify({
        model: t.model,
        messages,
        max_tokens: opts.maxTokens,
        temperature: 0.2,
        stream: true,
        ...(t.provider === "openrouter" ? { usage: { include: true } } : { stream_options: { include_usage: true } }),
        ...(opts.jsonObject ? { response_format: { type: "json_object" } } : {}),
        ...(t.provider === "nvidia" ? nvidiaExtraBody() : {}),
      }),
    });
    if (!res.ok || !res.body) {
      const body = (await res.text().catch(() => "")).slice(0, 200);
      throw new ProviderError(`HTTP ${res.status}${body ? `: ${body}` : ""}`);
    }
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
    let text = "";
    let completionTokens: number | null = null;
    let cost: number | null = null;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        let j: {
          choices?: { delta?: { content?: string | null; reasoning_content?: string | null; reasoning?: string | null } }[];
          usage?: { completion_tokens?: number; cost?: number };
          error?: { message?: string };
        };
        try {
          j = JSON.parse(data);
        } catch {
          continue;
        }
        if (j.error) throw new ProviderError(j.error.message ?? "stream error");
        const delta = j.choices?.[0]?.delta;
        if (delta && (delta.content || delta.reasoning_content || delta.reasoning) && firstTimer) {
          clearTimeout(firstTimer);
          firstTimer = undefined;
        }
        if (delta?.content) text += delta.content;
        if (j.usage) {
          completionTokens = j.usage.completion_tokens ?? completionTokens;
          if (typeof j.usage.cost === "number") cost = j.usage.cost;
        }
      }
    }
    if (!text.trim()) throw new ProviderError("empty response");
    return { text, provider: t.provider, model: t.model, ms: Date.now() - started, completionTokens, cost };
  } catch (error) {
    const reason = ctrl.signal.aborted ? short(ctrl.signal.reason) : short(error);
    throw new ProviderError(reason);
  } finally {
    clearTimeout(total);
    if (firstTimer) clearTimeout(firstTimer);
  }
}

/**
 * Chat completion with provider fallback. `purpose: "build"` uses the code
 * generation models. Throws when every provider fails.
 */
export async function chatWithFallback(
  messages: ChatMessage[],
  opts: {
    purpose: Purpose;
    maxTokens?: number;
    timeoutMs?: number;
    firstTokenMs?: number;
    jsonObject?: boolean;
    /** Skip providers, e.g. after one produced unusable output. */
    skip?: ProviderId[];
    onAttempt?: (target: { provider: ProviderId; model: string }) => void;
  },
): Promise<ChatResult> {
  const chain = (await providerChain(opts.purpose)).filter((t) => !opts.skip?.includes(t.provider));
  if (!chain.length) throw new Error("No LLM provider is configured (NVIDIA_API_KEY / OPENROUTER_API_KEY).");
  const attempts: string[] = [];
  for (const target of chain) {
    opts.onAttempt?.({ provider: target.provider, model: target.model });
    try {
      const r = await streamChat(target, messages, {
        maxTokens: opts.maxTokens ?? 4000,
        timeoutMs: opts.timeoutMs ?? 120_000,
        firstTokenMs: opts.firstTokenMs ?? 60_000,
        jsonObject: opts.jsonObject ?? false,
      });
      attempts.push(`${target.provider}: ${target.model} ok in ${Math.round(r.ms / 1000)}s`);
      return { ...r, attempts };
    } catch (error) {
      attempts.push(`${target.provider}: ${target.model} failed: ${short(error)}`);
      console.warn(`[llm] ${target.provider}/${target.model} failed: ${short(error)}`);
    }
  }
  throw new Error(`Every provider failed: ${attempts.join(" | ")}`);
}

/** Pull the first JSON object out of a model reply (handles ``` fences and prose). */
export function parseJsonObject(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [text.trim(), fenced?.[1]?.trim()];
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));
  for (const c of candidates) {
    if (!c) continue;
    try {
      return JSON.parse(c);
    } catch {
      // try next
    }
  }
  throw new Error("The model reply was not valid JSON.");
}
