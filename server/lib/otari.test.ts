import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockSecrets = vi.hoisted(() => ({} as Record<string, string | undefined>));
const mockUser = vi.hoisted(() => ({ email: "builder@example.com" as string | undefined }));
vi.mock("@agent-native/core/server", () => ({
  resolveSecret: vi.fn(async (name: string) => mockSecrets[name] || null),
  getRequestUserEmail: vi.fn(() => mockUser.email),
}));

import { chatWithFallback, generateStructured, providerChain } from "./llm";
import {
  classifyOtariError,
  otariChat,
  otariModels,
  otariRunPython,
  parseGuardVerdict,
  resetOtariState,
} from "./otari";
import { createOtariRequestFetch } from "./otari-engine";
import { z } from "zod";

const json = (body: unknown, init: ResponseInit & { headers?: Record<string, string> } = {}) =>
  new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
const completion = (content: string, extra: Record<string, unknown> = {}) =>
  json(
    { id: "chatcmpl-test", choices: [{ message: { content } }], usage: { cost_usd: "0.0001" }, ...extra },
    { headers: { "otari-request-id": "req-1", "otari-model": "Qwen/Test", "otari-provider": "deepinfra" } },
  );
const bodyOf = (call: unknown[]) => JSON.parse((call[1] as RequestInit).body as string);

beforeEach(() => {
  resetOtariState();
  mockSecrets.OTARI_API_KEY = "otari-test";
  mockSecrets.NVIDIA_API_KEY = undefined;
  mockSecrets.OPENROUTER_API_KEY = undefined;
  mockUser.email = "builder@example.com";
  vi.stubEnv("HACKPILOT_DISABLE_PROVIDERS", "");
  vi.stubEnv("OTARI_END_USER", "");
  vi.stubEnv("OTARI_GUARDRAILS", "");
  vi.stubEnv("OTARI_BASE_URL", "");
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("role models", () => {
  it("uses distinct open-weight defaults per role and honors env overrides", () => {
    expect(otariModels("extract")[0]).toBe("alibaba/qwen3-235b-a22b-instruct-2507");
    expect(otariModels("ideas")[0]).toBe("deepseek/deepseek-v4-flash");
    expect(otariModels("build")[0]).toBe("alibaba/qwen3-coder-480b-a35b-instruct");
    expect(otariModels("guard")[0]).toBe("alibaba/qwen3guard-gen-8b");
    vi.stubEnv("OTARI_MODELS_BUILD", " my-routing-policy , openai/gpt-oss-120b ");
    expect(otariModels("build")).toEqual(["my-routing-policy", "openai/gpt-oss-120b"]);
  });

  it("puts Otari first in the build chain, one target per fallback model", async () => {
    mockSecrets.OPENROUTER_API_KEY = "or-test";
    const chain = await providerChain("build");
    expect(chain.map((t) => t.provider)).toEqual(["otari", "otari", "openrouter"]);
    expect(chain[0]).toMatchObject({ model: "alibaba/qwen3-coder-480b-a35b-instruct", baseURL: "https://api.otari.ai/api/v1" });
  });
});

describe("error classification", () => {
  it("recognizes guardrail, budget, user mismatch and unconfigured guardrails", () => {
    expect(classifyOtariError(403, JSON.stringify({ detail: "flagged", code: "guardrail_violation" })).kind).toBe("guardrail");
    const budget = classifyOtariError(403, JSON.stringify({ detail: "Budget exceeded" }), new Headers({ "otari-error-code": "budget_exceeded", "otari-request-id": "r9" }));
    expect(budget).toMatchObject({ kind: "budget", requestId: "r9", fatal: true });
    expect(classifyOtariError(429, JSON.stringify({ detail: "rule budget" })).kind).toBe("budget");
    expect(classifyOtariError(402, "{}").kind).toBe("budget");
    expect(classifyOtariError(403, JSON.stringify({ detail: "'user' field does not match the authenticated API key's user" })).kind).toBe("user_mismatch");
    expect(classifyOtariError(400, JSON.stringify({ detail: "guardrail profile 'x' requested but no guardrails service is configured." })).kind).toBe("guardrails_unconfigured");
    expect(classifyOtariError(503, "upstream down").fatal).toBe(false);
  });
});

describe("otariChat", () => {
  it("sends the signed-in user and guardrails, and records the request id", async () => {
    vi.stubEnv("OTARI_GUARDRAILS", "prompt-injection:block");
    const fetchMock = vi.fn(async () => completion("hi"));
    vi.stubGlobal("fetch", fetchMock);
    const r = await otariChat({ role: "ideas", messages: [{ role: "user", content: "x" }] });
    const body = bodyOf(fetchMock.mock.calls[0]!);
    expect(body).toMatchObject({ model: "deepseek/deepseek-v4-flash", user: "builder@example.com", guardrails: [{ profile: "prompt-injection", mode: "block" }] });
    expect(r).toMatchObject({ text: "hi", requestId: "req-1", servedBy: "deepinfra:Qwen/Test", costUsd: 0.0001 });
  });

  it("falls back to the next model on an upstream error", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("down", { status: 503 }))
      .mockResolvedValueOnce(completion("ok"));
    vi.stubGlobal("fetch", fetchMock);
    const r = await otariChat({ role: "extract", messages: [] });
    expect(r.model).toBe("deepseek/deepseek-v4-flash");
    expect(r.fallback).toBe(true);
  });

  it("drops `user` when the key is not a service key, then retries the same model", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ detail: "'user' field does not match the authenticated API key's user" }, { status: 403 }))
      .mockResolvedValueOnce(completion("ok"));
    vi.stubGlobal("fetch", fetchMock);
    await otariChat({ role: "extract", messages: [] });
    expect(bodyOf(fetchMock.mock.calls[0]!).user).toBe("builder@example.com");
    expect(bodyOf(fetchMock.mock.calls[1]!)).not.toHaveProperty("user");
    expect(bodyOf(fetchMock.mock.calls[1]!).model).toBe(bodyOf(fetchMock.mock.calls[0]!).model);
  });

  it("stops on a budget refusal instead of trying other models", async () => {
    const fetchMock = vi.fn(async () => json({ detail: "budget exceeded" }, { status: 403, headers: { "otari-error-code": "budget_exceeded" } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(otariChat({ role: "extract", messages: [] })).rejects.toMatchObject({ kind: "budget" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("structured calls", () => {
  it("returns a schema-validated object from Otari with a json_schema response format", async () => {
    const fetchMock = vi.fn(async () => completion('{"name":"Otari Hack"}'));
    vi.stubGlobal("fetch", fetchMock);
    const r = await generateStructured({ role: "extract", schema: z.object({ name: z.string() }), system: "s", prompt: "p" });
    expect(r).toMatchObject({ object: { name: "Otari Hack" }, provider: "otari", otariRequestId: "req-1" });
    expect(bodyOf(fetchMock.mock.calls[0]!).response_format.type).toBe("json_schema");
  });

  it("surfaces a guardrail block as a clear action error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ detail: "blocked", code: "guardrail_violation" }, { status: 403 })));
    await expect(generateStructured({ schema: z.object({ a: z.string() }), system: "s", prompt: "p" })).rejects.toThrow(/guardrail blocked/);
  });
});

describe("build streaming", () => {
  it("streams Build it through the coder model with the end user", async () => {
    const fetchMock = vi.fn(async () => new Response(
      `data: ${JSON.stringify({ choices: [{ delta: { content: "=== FILE: a ===" } }] })}\n\ndata: [DONE]\n\n`,
      { headers: { "otari-request-id": "req-build" } },
    ));
    vi.stubGlobal("fetch", fetchMock);
    const r = await chatWithFallback([{ role: "user", content: "build" }], { purpose: "build" });
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toBe("https://api.otari.ai/api/v1/chat/completions");
    expect(bodyOf(fetchMock.mock.calls[0]!)).toMatchObject({ model: "alibaba/qwen3-coder-480b-a35b-instruct", user: "builder@example.com", stream: true });
    expect(r).toMatchObject({ provider: "otari", requestId: "req-build" });
  });
});

describe("tools", () => {
  it("runs Python through otari_code_execution and returns stdout", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ data: [{ id: "otari_code_execution", available: true, reason: null }] }))
      .mockResolvedValueOnce(completion("{}", { otari_tool_calls: [{ type: "code_execution", status: "completed", stdout: '{"weighted": 7.4}\n' }] }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await otariRunPython("print(1)", "math");
    expect(r).toMatchObject({ stdout: '{"weighted": 7.4}\n', requestId: "req-1" });
    expect(bodyOf(fetchMock.mock.calls[1]!).tools).toEqual([{ type: "otari_code_execution" }]);
  });

  it("returns null when the workspace disabled the tool", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ data: [{ id: "otari_code_execution", available: false, reason: "workspace_disabled" }] })));
    expect(await otariRunPython("print(1)", "math")).toBeNull();
  });
});

describe("guard verdicts", () => {
  it("parses Qwen3Guard and Llama Guard output", () => {
    expect(parseGuardVerdict("Safety: Controversial\nCategories: Jailbreak")).toMatchObject({ flagged: true, categories: ["Jailbreak"] });
    expect(parseGuardVerdict("Safety: Safe\nCategories: None")).toMatchObject({ flagged: false, categories: [] });
    expect(parseGuardVerdict("\n\nunsafe\nS8")).toMatchObject({ flagged: true, categories: ["S8"] });
    expect(parseGuardVerdict("safe")).toMatchObject({ flagged: false });
  });
});

describe("Pilot chat engine fetch", () => {
  it("adds the end user to engine requests and blocks other origins", async () => {
    const base = vi.fn(async () => new Response("{}"));
    const f = createOtariRequestFetch(base as unknown as typeof fetch);
    await f("https://api.otari.ai/api/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "m", stream: true }) });
    expect(JSON.parse((base.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toMatchObject({ model: "m", user: "builder@example.com" });
    await expect(f("https://evil.example.com/x", {})).rejects.toThrow(/Blocked/);
  });
});
