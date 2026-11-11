/**
 * Server-side LLM calls for HackPilot actions.
 *
 * Fast structured calls use the first configured provider and fall back on an
 * error, 404/410 model-not-available, 429, or timeout. Order:
 *
 *   0. Mozilla Otari gateway (server/lib/otari.ts), when OTARI_API_KEY is set.
 *      Open-weight models per role (extract / ideas / judge for structured
 *      calls, build for Build it), each with its own ordered fallback list.
 *      Guardrail and budget refusals stop the chain with a clear message.
 *   1. NVIDIA (integrate.api.nvidia.com, OpenAI-compatible)
 *      key `NVIDIA_API_KEY`; model `NVIDIA_MODEL` for fast structured calls.
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
import { resolveSecret } from "@agent-native/core/server";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateObject, type LanguageModel } from "ai";
import { z } from "zod";

import {
  absorbOtariError,
  classifyOtariError,
  isOtariConfigured,
  otariApiKey,
  otariBaseUrl,
  otariBodyExtras,
  otariChat,
  OtariError,
  otariModels,
  type OtariRole,
  otariUserMessage,
} from "./otari.js";

export const OPENROUTER_KEY = "OPENROUTER_API_KEY";
export const NVIDIA_KEY = "NVIDIA_API_KEY";
export const NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/** Benchmarked defaults (Nov 2026, see README "LLM providers"). */
export const DEFAULT_NVIDIA_MODEL = "nvidia/nemotron-3.5-super-vl-120b-a12b";
export const DEFAULT_NVIDIA_BUILD_MODEL = "nvidia/nemotron-3.5-super-vl-120b-a12b";
export const DEFAULT_OPENROUTER_BUILD_MODEL = "anthropic/claude-haiku-5.5";

export type ProviderId = "otari" | "nvidia" | "openrouter";
export type Purpose = "fast" | "build";

interface ProviderTarget {
  provider: ProviderId;
  model: string;
  apiKey: string;
  baseURL: string;
}

async function resolveKey(name: string): Promise<string | null> {
  return resolveSecret(name);
}

// guard:allow-env-credential — only nonsecret model and behavior settings use this helper
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
  const otariKey = await otariApiKey();
  if (otariKey) {
    for (const model of otariModels(purpose === "build" ? "build" : "extract")) {
      chain.push({ provider: "otari", model, apiKey: otariKey, baseURL: otariBaseUrl() });
    }
  }
  const useOpenRouterBuild = purpose === "build";
  const nv = useOpenRouterBuild || disabled.has("nvidia") ? null : await resolveKey(NVIDIA_KEY);
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
  return (await isOtariConfigured()) || (await providerChain("fast")).length > 0;
}

/** Turn a guardrail / budget refusal into an action failure the UI shows as is. */
export function failOtari(e: OtariError): never {
  fail(otariUserMessage(e), {
    errorCode: e.kind === "guardrail" ? "otari_guardrail_blocked" : e.kind === "budget" ? "otari_budget_exceeded" : "otari_auth",
    statusCode: e.kind === "guardrail" ? 403 : e.kind === "budget" ? 402 : 401,
    details: { kind: e.kind, ...(e.requestId ? { otariRequestId: e.requestId } : {}) },
  });
}

function jsonSchemaFor(schema: z.ZodType): Record<string, unknown> {
  const js = z.toJSONSchema(schema) as Record<string, unknown>;
  delete js.$schema;
  return js;
}

/**
 * Structured output through Otari: json_schema response format, zod
 * validation, next model in the role's list on a bad reply.
 */
async function otariStructured<T extends z.ZodType>(opts: {
  role: OtariRole;
  schema: T;
  system: string;
  prompt: string;
  timeoutMs?: number | undefined;
}): Promise<{ object: z.infer<T>; model: string; requestId?: string }> {
  let parsed: z.infer<T> | undefined;
  const r = await otariChat({
    role: opts.role,
    messages: [
      { role: "system", content: `${opts.system}\n\nReply with one JSON object only.` },
      { role: "user", content: opts.prompt },
    ],
    responseFormat: {
      type: "json_schema",
      json_schema: { name: "result", strict: false, schema: jsonSchemaFor(opts.schema) },
    },
    maxTokens: 8000,
    timeoutMs: opts.timeoutMs ?? 90_000,
    validate: (res) => {
      parsed = opts.schema.parse(parseJsonObject(res.text)) as z.infer<T>;
    },
  });
  return { object: parsed as z.infer<T>, model: r.model, ...(r.requestId ? { requestId: r.requestId } : {}) };
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
  /** Otari model role; default "extract". */
  role?: OtariRole;
}): Promise<{ object: z.infer<T>; model: string; provider: ProviderId; otariRequestId?: string }> {
  const errors: string[] = [];
  if (await isOtariConfigured()) {
    try {
      const r = await otariStructured({ ...opts, role: opts.role ?? "extract" });
      return { object: r.object, model: r.model, provider: "otari", ...(r.requestId ? { otariRequestId: r.requestId } : {}) };
    } catch (error) {
      if (error instanceof OtariError && error.fatal) failOtari(error);
      errors.push(short(error));
      console.warn(`[llm] Otari failed, trying direct providers: ${short(error)}`);
    }
  }
  const chain = (await providerChain("fast")).filter((t) => t.provider !== "otari");
  if (!chain.length) {
    if (errors.length) {
      fail(`The model call failed on Otari. ${errors.join(" | ")}`, { errorCode: "llm_failed", statusCode: 502 });
    }
    fail(
      "No OTARI_API_KEY, NVIDIA_API_KEY or OPENROUTER_API_KEY is configured for in-action AI. The chat agent can do this step itself: read the hackathon with get-hackathon and write results with the matching action.",
      { errorCode: "llm_not_configured", statusCode: 412 },
    );
  }
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
      errors.push(`${target.provider}: ${target.model}: ${short(error)}`);
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
  /** USD, when the provider reports it (OpenRouter and Otari do). */
  cost: number | null;
  /** Otari-Request-Id when served through Otari. */
  requestId?: string;
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
  opts: { purpose: Purpose; maxTokens: number; timeoutMs: number; firstTokenMs: number; jsonObject: boolean },
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
      // Otari: per-end-user budgets (`user`) and request guardrails.
      body: JSON.stringify({
        model: t.model,
        messages,
        ...(opts.purpose === "fast" ? { max_tokens: opts.maxTokens } : {}),
        temperature: 0.2,
        stream: true,
        ...(t.provider === "openrouter" ? { usage: { include: true } } : { stream_options: { include_usage: true } }),
        ...(opts.jsonObject ? { response_format: { type: "json_object" } } : {}),
        ...(t.provider === "nvidia" ? nvidiaExtraBody() : {}),
        ...(t.provider === "otari" ? otariBodyExtras() : {}),
        // The tested build models support low-effort reasoning. DeepSeek
        // keeps reasoning enabled, while leaving room to emit the app files.
        ...(t.provider === "openrouter" && (t.model.toLowerCase().replace(/:.*$/, "") === "z-ai/glm-5.3" ||
          (opts.purpose === "build" && t.model.toLowerCase().replace(/:.*$/, "") === "deepseek/deepseek-v4.1-flash-1017"))
          ? { reasoning: { effort: "low" } }
          : {}),
      }),
    });
    if (!res.ok && t.provider === "otari") {
      throw classifyOtariError(res.status, await res.text().catch(() => ""), res.headers);
    }
    const requestId = t.provider === "otari" ? (res.headers.get("otari-request-id") ?? undefined) : undefined;
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
          usage?: { completion_tokens?: number; cost?: number; cost_usd?: string | number };
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
          else if (j.usage.cost_usd != null && Number.isFinite(Number(j.usage.cost_usd))) cost = Number(j.usage.cost_usd);
        }
      }
    }
    if (!text.trim()) throw new ProviderError("empty response");
    if (requestId) console.info(`[otari] build ${t.model} req=${requestId} ${Date.now() - started}ms`);
    return { text, provider: t.provider, model: t.model, ms: Date.now() - started, completionTokens, cost, ...(requestId ? { requestId } : {}) };
  } catch (error) {
    if (error instanceof OtariError) throw error;
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
  if (!chain.length) {
    if (opts.purpose === "build" && !opts.skip?.includes("openrouter")) {
      throw new Error("Build it requires OTARI_API_KEY or an enabled OpenRouter provider and OPENROUTER_API_KEY.");
    }
    throw new Error("No LLM provider is configured or available (OTARI_API_KEY / NVIDIA_API_KEY / OPENROUTER_API_KEY).");
  }
  const attempts: string[] = [];
  for (const target of chain) {
    opts.onAttempt?.({ provider: target.provider, model: target.model });
    for (let retry = 0; retry < 3; retry++) {
      try {
        const r = await streamChat(target, messages, {
          purpose: opts.purpose,
          maxTokens: opts.maxTokens ?? 4000,
          timeoutMs: opts.timeoutMs ?? 120_000,
          firstTokenMs: opts.firstTokenMs ?? 60_000,
          jsonObject: opts.jsonObject ?? false,
        });
        attempts.push(`${target.provider}: ${target.model} ok in ${Math.round(r.ms / 1000)}s${r.requestId ? ` (${r.requestId})` : ""}`);
        return { ...r, attempts };
      } catch (error) {
        if (error instanceof OtariError) {
          if (absorbOtariError(error)) continue;
          // A guardrail block or spent budget refuses every model the same way.
          if (error.fatal) throw new Error(otariUserMessage(error));
        }
        attempts.push(`${target.provider}: ${target.model} failed: ${short(error)}`);
        console.warn(`[llm] ${target.provider}: ${target.model} failed: ${short(error)}`);
        break;
      }
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
