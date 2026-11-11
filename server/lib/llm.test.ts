import { afterEach, describe, expect, it, vi } from "vitest";

const mockSecrets = vi.hoisted(() => ({} as Record<string, string | undefined>));
vi.mock("@agent-native/core/server", () => ({
  resolveSecret: vi.fn(async (name: string) => mockSecrets[name] || null),
  getRequestUserEmail: vi.fn(() => undefined),
}));

import { resolveSecret } from "@agent-native/core/server";
import { chatWithFallback, providerChain } from "./llm";

const env = (key: string, value?: string) => {
  if (key.endsWith("_API_KEY")) mockSecrets[key] = value;
  vi.stubEnv(key, value);
};

function mockProviders() {
  env("NVIDIA_API_KEY", "nv-test");
  env("OPENROUTER_API_KEY", "or-test");
  env("HACKPILOT_DISABLE_PROVIDERS", "");
  env("OPENROUTER_BUILD_MODEL", "");
  env("OTARI_API_KEY", "");
}

const stream = (content = "output") => new Response(
  `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`,
);

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("build provider selection", () => {
  it("selects Claude Haiku 5.5 on OpenRouter for builds and leaves fast calls NVIDIA-first", async () => {
    mockProviders();
    expect((await providerChain("build")).map(({ provider, model }) => ({ provider, model }))).toEqual([
      { provider: "openrouter", model: "anthropic/claude-haiku-5.5" },
    ]);
    expect((await providerChain("fast")).map((t) => t.provider)).toEqual(["nvidia", "openrouter"]);
  });

  it("honors an explicit OpenRouter build model and treats blank as unset", async () => {
    mockProviders();
    env("OPENROUTER_BUILD_MODEL", "  z-ai/glm-5.3  ");
    expect((await providerChain("build")).map(({ provider, model }) => ({ provider, model }))).toEqual([
      { provider: "openrouter", model: "z-ai/glm-5.3" },
    ]);
    env("OPENROUTER_BUILD_MODEL", "  ");
    expect((await providerChain("build"))[0]?.model).toBe("anthropic/claude-haiku-5.5");
  });

  it("does not silently select NVIDIA when OpenRouter is missing or disabled", async () => {
    mockProviders();
    env("OPENROUTER_API_KEY", "");
    expect(await providerChain("build")).toEqual([]);
    await expect(chatWithFallback([], { purpose: "build" })).rejects.toThrow("OPENROUTER_API_KEY");
    env("OPENROUTER_API_KEY", "or-test");
    env("HACKPILOT_DISABLE_PROVIDERS", "openrouter");
    expect(await providerChain("build")).toEqual([]);
  });

  it("does not bypass the framework when it denies a deployment key", async () => {
    mockProviders();
    // OTARI_API_KEY is unset in these tests; then the framework denies OpenRouter.
    vi.mocked(resolveSecret).mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    expect(await providerChain("build")).toEqual([]);
  });
});

describe("streamed model requests", () => {
  it("uses low reasoning and no output-token cap for DeepSeek builds, including when a caller supplies a cap", async () => {
    mockProviders();
    env("OPENROUTER_BUILD_MODEL", "deepseek/deepseek-v4.1-flash-1017");
    const fetchMock = vi.fn(async () => new Response([
      'data: {"choices":[{"delta":{"reasoning":"private reasoning", "content":null}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"=== FILE: src/App.tsx ==="}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"\\nexport default 1"}}],"usage":{"completion_tokens":42,"cost":0.012}}\n\n',
      'data: [DONE]\n\n',
    ].join("")));
    vi.stubGlobal("fetch", fetchMock);

    const result = await chatWithFallback([{ role: "user", content: "Build" }], { purpose: "build", maxTokens: 123 });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(body).toMatchObject({ model: "deepseek/deepseek-v4.1-flash-1017", reasoning: { effort: "low" }, stream: true });
    expect(body).not.toHaveProperty("max_tokens");
    expect(result).toMatchObject({ provider: "openrouter", text: "=== FILE: src/App.tsx ===\nexport default 1", completionTokens: 42, cost: 0.012 });
  });

  it("keeps GLM override reasoning and omits the build cap", async () => {
    mockProviders();
    env("OPENROUTER_BUILD_MODEL", "z-ai/glm-5.3");
    const fetchMock = vi.fn(async () => stream());
    vi.stubGlobal("fetch", fetchMock);
    await chatWithFallback([], { purpose: "build" });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.reasoning).toEqual({ effort: "low" });
    expect(body).not.toHaveProperty("max_tokens");
  });

  it("rejects a reasoning-only response with no file content", async () => {
    mockProviders();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      'data: {"choices":[{"delta":{"reasoning":"thinking", "content":null}}]}\n\ndata: [DONE]\n\n',
    )));
    await expect(chatWithFallback([], { purpose: "build" })).rejects.toThrow("empty response");
  });

  it("does not change DeepSeek reasoning settings for fast calls", async () => {
    mockProviders();
    env("HACKPILOT_DISABLE_PROVIDERS", "nvidia");
    env("OPENROUTER_MODEL", "deepseek/deepseek-v4.1-flash-1017");
    const fetchMock = vi.fn(async () => stream());
    vi.stubGlobal("fetch", fetchMock);
    await chatWithFallback([], { purpose: "fast", maxTokens: 321 });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body).not.toHaveProperty("reasoning");
    expect(body.max_tokens).toBe(321);
  });

  it("preserves the fast-call token cap and NVIDIA-to-OpenRouter fallback", async () => {
    mockProviders();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(stream("fallback"));
    vi.stubGlobal("fetch", fetchMock);
    const result = await chatWithFallback([], { purpose: "fast", maxTokens: 321 });
    expect(result).toMatchObject({ provider: "openrouter", text: "fallback" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).max_tokens).toBe(321);
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body).max_tokens).toBe(321);
  });
});
