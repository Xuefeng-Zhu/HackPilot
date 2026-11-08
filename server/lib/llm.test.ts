import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@agent-native/core/server", () => ({
  resolveSecret: async () => null,
  readDeployCredentialEnv: () => null,
}));

import { chatWithFallback, providerChain } from "./llm";

const env = (key: string, value?: string) => vi.stubEnv(key, value);

function mockProviders() {
  env("NVIDIA_API_KEY", "nv-test");
  env("OPENROUTER_API_KEY", "or-test");
  env("HACKPILOT_DISABLE_PROVIDERS", "");
  env("OPENROUTER_BUILD_MODEL", "");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("build provider selection", () => {
  it("keeps NVIDIA first by default and for fast calls", async () => {
    mockProviders();
    expect((await providerChain("build")).map((t) => t.provider)).toEqual(["nvidia", "openrouter"]);
    env("OPENROUTER_BUILD_MODEL", "z-ai/glm-5.3");
    expect((await providerChain("fast")).map((t) => t.provider)).toEqual(["nvidia", "openrouter"]);
  });

  it("selects only the explicit OpenRouter model for builds", async () => {
    mockProviders();
    env("OPENROUTER_BUILD_MODEL", "  z-ai/glm-5.3  ");
    expect((await providerChain("build")).map(({ provider, model }) => ({ provider, model })))
      .toEqual([{ provider: "openrouter", model: "z-ai/glm-5.3" }]);
  });

  it("treats a blank build model as unset", async () => {
    mockProviders();
    env("OPENROUTER_BUILD_MODEL", "  ");
    expect((await providerChain("build")).map((t) => t.provider)).toEqual(["nvidia", "openrouter"]);
  });

  it("does not silently select NVIDIA if OpenRouter is missing or disabled", async () => {
    mockProviders();
    env("OPENROUTER_BUILD_MODEL", "z-ai/glm-5.3");
    env("OPENROUTER_API_KEY", "");
    expect(await providerChain("build")).toEqual([]);
    await expect(chatWithFallback([], { purpose: "build" })).rejects.toThrow("OPENROUTER_BUILD_MODEL requires");
    env("OPENROUTER_API_KEY", "or-test");
    env("HACKPILOT_DISABLE_PROVIDERS", "openrouter");
    expect(await providerChain("build")).toEqual([]);
  });
});

describe("OpenRouter GLM build completions", () => {
  it("requests low reasoning and returns content, not reasoning", async () => {
    mockProviders();
    env("OPENROUTER_BUILD_MODEL", "z-ai/glm-5.3");
    const fetchMock = vi.fn(async () => new Response([
      'data: {"choices":[{"delta":{"reasoning":"private reasoning"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"=== FILE: src/App.tsx ==="}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"\\nexport default 1"}}],"usage":{"completion_tokens":42,"cost":0.012}}\n\n',
      'data: [DONE]\n\n',
    ].join(""), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await chatWithFallback([{ role: "user", content: "Build" }], { purpose: "build" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(JSON.parse(init.body as string)).toMatchObject({ model: "z-ai/glm-5.3", reasoning: { effort: "low" }, stream: true });
    expect(result).toMatchObject({ provider: "openrouter", text: "=== FILE: src/App.tsx ===\nexport default 1", completionTokens: 42, cost: 0.012 });
  });

  it("rejects a reasoning-only response with no file content", async () => {
    mockProviders();
    env("OPENROUTER_BUILD_MODEL", "z-ai/glm-5.3");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      'data: {"choices":[{"delta":{"reasoning":"thinking", "content":null}}]}\n\ndata: [DONE]\n\n',
    )));
    await expect(chatWithFallback([], { purpose: "build" })).rejects.toThrow("empty response");
  });

  it("retains NVIDIA-to-OpenRouter fallback when the build model is unset", async () => {
    mockProviders();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response('data: {"choices":[{"delta":{"content":"fallback"}}]}\n\ndata: [DONE]\n\n'));
    vi.stubGlobal("fetch", fetchMock);

    const result = await chatWithFallback([{ role: "user", content: "Build" }], { purpose: "build" });
    expect(result.provider).toBe("openrouter");
    expect(result.text).toBe("fallback");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body)).not.toHaveProperty("reasoning");
  });
});
