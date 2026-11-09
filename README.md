# Chat

The minimal agent-native starter app — a clean, ChatGPT-style shell with chat at
the center, durable threads, standard app navigation, auth, live sync, and
actions. Start here when you want a real browser app to build on without
committing to a domain template.

**Live app: [chat.agent-native.com](https://chat.agent-native.com?utm_source=github&utm_medium=referral&utm_content=chat-readme)**

Chat is the basic agent-native app starting point. It gives you the app-agent
loop wired end to end and one example action, so you can add your own UI, data,
and actions on top.

## Features

- ChatGPT-style shell with a threads list and durable chat history.
- Auth, live sync, and application state wired out of the box.
- The action surface the agent and UI share, plus one example action to copy.
- A minimal, brandable base for any domain app.

## Develop locally

Scaffold your own copy and run it:

```bash
npx --yes @agent-native/core@latest create my-app --standalone --template chat
cd my-app
corepack enable
pnpm install
pnpm dev
```

Full docs: [agent-native.com/docs/template-chat](https://agent-native.com/docs/template-chat?utm_source=github&utm_medium=referral&utm_content=chat-readme).

## LLM providers

Fast in-action AI uses NVIDIA (`integrate.api.nvidia.com`, OpenAI-compatible) first and falls back to OpenRouter on errors or timeouts. Build it uses OpenRouter with `deepseek/deepseek-v4.1-flash-1017` by default; configure `OPENROUTER_API_KEY` and optionally set `OPENROUTER_BUILD_MODEL` to select another model. DeepSeek V4.1 Flash 1017 and GLM 5.3 use low reasoning effort. Build generation and repair omit the output-token limit; provider limits and request timeouts still apply. If the build model is unavailable or generation fails, Build it reports the failure and uses its deterministic template.

| Purpose | Default | Env |
| --- | --- | --- |
| Fast structured calls | `nvidia/nemotron-3.5-super-vl-120b-a12b` (reasoning off) | `NVIDIA_MODEL` |
| Fast structured fallback | Framework OpenRouter default | `OPENROUTER_MODEL` |
| Build it generation / repair | `deepseek/deepseek-v4.1-flash-1017` on OpenRouter | `OPENROUTER_BUILD_MODEL` (optional override) |

Benchmarks (Nov 2026, Frank's key): nemotron-3.5-super-vl structured JSON ~1 s, full 9-file app ~31–93 s; nemotron-3-ultra-550b structured ~4–6 s, full app 184 s with more type errors; kimi-k2.6 and nemotron-3-super-120b return 404 for this account; deepseek-v4.1-flash and glm-5.3-flash timed out; gpt-oss-120b and llama-3.3-70b are retired (410); gpt-oss-20b ~23–35 s for a tiny reply.

Agent chat: the framework can run chat on NVIDIA through its OpenAI-compatible engine (`ai-sdk:openai` with a custom base URL; NVIDIA tool calling verified), but it refuses to send a deploy-env `OPENAI_API_KEY` to a custom endpoint. To switch chat to NVIDIA, save the NVIDIA key with base URL `https://integrate.api.nvidia.com/v1` as an OpenAI-compatible key in Settings → AI engine and pick `nvidia/nemotron-3.5-super-vl-120b-a12b`. Until then chat stays on OpenRouter (there is no automatic chat fallback between engines).
