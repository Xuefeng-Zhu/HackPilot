/**
 * `otari` agent engine: Pilot chat through the Otari gateway.
 *
 * Uses the framework's AI SDK engine with the OpenAI provider pointed at
 * Otari's OpenAI-compatible endpoint (chat completions + streamed tool calls),
 * and a request fetch that adds the signed-in user as `user` (per-end-user
 * budgets) and any OTARI_GUARDRAILS to every request.
 *
 * Select it with AGENT_ENGINE=otari (deployment) or in Settings > AI engine.
 */
import { createAISDKEngine, registerAgentEngine } from "@agent-native/core/agent/engine";

import { absorbOtariError, classifyOtariError, DEFAULT_ROLE_MODELS, otariBaseUrl, otariBodyExtras, otariModels } from "./otari.js";

export const OTARI_ENGINE_NAME = "otari";

/**
 * Wrap fetch so each JSON request body names the end user and guardrails, and
 * keep requests on the Otari origin. A key that is not a service key refuses
 * foreign `user` ids; that one refusal is absorbed and the request resent.
 */
export function createOtariRequestFetch(baseFetch: typeof fetch = fetch): typeof fetch {
  const origin = new URL(otariBaseUrl()).origin;
  const send = async (input: Parameters<typeof fetch>[0], init: RequestInit | undefined, attempt: number): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (new URL(url).origin !== origin) throw new Error(`Blocked: Otari engine request left ${origin}`);
    let next = init;
    let model = "";
    let endUser = false;
    if (init?.body && typeof init.body === "string") {
      try {
        const body = JSON.parse(init.body) as Record<string, unknown>;
        const extras = otariBodyExtras();
        model = typeof body.model === "string" ? body.model : "";
        endUser = "user" in extras;
        next = { ...init, body: JSON.stringify({ ...body, ...extras }) };
      } catch {
        // not JSON: send as is
      }
    }
    const started = Date.now();
    const res = await baseFetch(input, next);
    if (res.ok && model) {
      const servedBy = [res.headers.get("otari-provider"), res.headers.get("otari-model")].filter(Boolean).join(":");
      console.info(
        `[otari] chat ${model}${servedBy ? ` (${servedBy})` : ""} req=${res.headers.get("otari-request-id") ?? "?"}${endUser ? " user=yes" : ""} ${Date.now() - started}ms`,
      );
    }
    if (!res.ok && attempt < 2 && (res.status === 400 || res.status === 403)) {
      const text = await res.clone().text().catch(() => "");
      if (absorbOtariError(classifyOtariError(res.status, text, res.headers))) return send(input, init, attempt + 1);
    }
    return res;
  };
  return (input, init) => send(input, init, 0);
}

let registered = false;

export function registerOtariEngine(): void {
  if (registered) return;
  registered = true;
  const chatModels = otariModels("chat");
  registerAgentEngine({
    name: OTARI_ENGINE_NAME,
    label: "Otari (Mozilla AI gateway)",
    description:
      "Open-weight models (Qwen, DeepSeek, Llama, Kimi, Nemotron, gpt-oss) through Mozilla's Otari gateway, with routing, budgets and guardrails. Requires OTARI_API_KEY.",
    capabilities: { thinking: false, promptCaching: false, vision: false, computerUse: false, parallelToolCalls: true },
    defaultModel: chatModels[0] ?? DEFAULT_ROLE_MODELS.chat[0]!,
    supportedModels: [
      ...new Set([
        ...chatModels,
        "alibaba/qwen3-235b-a22b-instruct-2507",
        "deepseek/deepseek-v4-flash",
        "moonshotai/kimi-k2.6",
        "meta/llama-3.3-70b-instruct",
      ]),
    ],
    acceptsCustomModels: true,
    requiredEnvVars: ["OTARI_API_KEY"],
    create: (config) => {
      // The framework withholds deployment env keys from engines with a custom
      // base URL; for this app-owned engine the operator chose Otari, so the
      // deployment key is the intended fallback.
      // guard:allow-env-credential — operator-configured Otari key for the app-owned engine
      const apiKey = (typeof config.apiKey === "string" && config.apiKey) || process.env.OTARI_API_KEY?.trim() || undefined;
      return createAISDKEngine("openai", {
        ...config,
        name: OTARI_ENGINE_NAME,
        label: "Otari",
        model: typeof config.model === "string" && config.model ? config.model : chatModels[0],
        acceptsCustomModels: true,
        baseUrl: otariBaseUrl(),
        ...(apiKey ? { apiKey } : {}),
        requestFetch: createOtariRequestFetch(),
      });
    },
  });
}
