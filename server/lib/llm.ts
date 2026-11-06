/**
 * Server-side structured LLM calls, routed through OpenRouter with the same
 * AI SDK provider the framework's `ai-sdk:openrouter` engine uses.
 *
 * Key: `OPENROUTER_API_KEY`, resolved through the framework secret store
 * (user / org vault first, deploy env fallback). Model: `OPENROUTER_MODEL`
 * (deploy config), else the framework's default OpenRouter model.
 *
 * Every caller has a deterministic or agent-driven fallback, so the app works
 * before a key is configured.
 */
import { fail } from "@agent-native/core/action";
import { AGENT_MODEL_CONFIG } from "@agent-native/core/agent/model-config";
import {
  readDeployCredentialEnv,
  resolveSecret,
} from "@agent-native/core/server";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateObject } from "ai";
import type { z } from "zod";

export const OPENROUTER_KEY = "OPENROUTER_API_KEY";

async function resolveOpenRouterKey(): Promise<string | null> {
  try {
    const value = await resolveSecret(OPENROUTER_KEY);
    if (value) return value;
  } catch {
    // Secret store unavailable (for example a bare CLI run): use deploy env.
  }
  return readDeployCredentialEnv(OPENROUTER_KEY) ?? null;
}

export function openRouterModelId(): string {
  const configured = process.env.OPENROUTER_MODEL?.trim();
  return configured || AGENT_MODEL_CONFIG.aiSdk.openrouter.defaultModel;
}

export async function isLlmConfigured(): Promise<boolean> {
  return Boolean(await resolveOpenRouterKey());
}

/**
 * Generate a schema-validated object. Fails with `llm_not_configured` when no
 * key is set so callers (and the agent) can fall back.
 */
export async function generateStructured<T extends z.ZodType>(opts: {
  schema: T;
  system: string;
  prompt: string;
  timeoutMs?: number;
}): Promise<{ object: z.infer<T>; model: string }> {
  const apiKey = await resolveOpenRouterKey();
  if (!apiKey) {
    fail(
      "No OPENROUTER_API_KEY is configured for in-action AI. The chat agent can do this step itself: read the hackathon with get-hackathon and write results with the matching action.",
      { errorCode: "llm_not_configured", statusCode: 412 },
    );
  }
  const model = openRouterModelId();
  const openrouter = createOpenRouter({
    apiKey,
    appName: "HackPilot",
    appUrl: "https://www.agent-native.com",
  });
  try {
    const result = await generateObject({
      model: openrouter.chat(model),
      schema: opts.schema,
      system: opts.system,
      prompt: opts.prompt,
      abortSignal: AbortSignal.timeout(opts.timeoutMs ?? 90_000),
      maxRetries: 1,
    });
    return { object: result.object as z.infer<T>, model };
  } catch (error) {
    fail(
      `The model call failed (${model}): ${error instanceof Error ? error.message.slice(0, 300) : "unknown error"}`,
      { errorCode: "llm_failed", statusCode: 502 },
    );
  }
}
