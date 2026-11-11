# HackPilot on Mozilla Otari

HackPilot sends its model calls through [Otari](https://api.otari.ai/api/v1), Mozilla's OpenAI-compatible AI gateway. Each kind of call has its own open-weight model and an ordered fallback list. The app also uses Otari's built-in tools, managed MCP, guardrails, and per-user budgets.

- Client: [`server/lib/otari.ts`](../server/lib/otari.ts) (introduced in commit `a4c0ce4` "Introduce Otari gateway")
- Wiring into model calls: [`server/lib/llm.ts`](../server/lib/llm.ts)
- Pilot chat engine: [`server/lib/otari-engine.ts`](../server/lib/otari-engine.ts) and [`server/plugins/otari-engine.ts`](../server/plugins/otari-engine.ts)
- Unit tests: [`server/lib/otari.test.ts`](../server/lib/otari.test.ts)
- Live smoke test: [`scripts/otari-smoke.ts`](../scripts/otari-smoke.ts). Run it with `npx vitest --run -c vitest.smoke.config.ts`. Results go to [`docs/otari-smoke-results.json`](otari-smoke-results.json).

## Open-weight models by role

| Role | Used by | Models, in fallback order | Env override |
| --- | --- | --- | --- |
| extract | import-hackathon (page → JSON), web fetch/search tool calls | `alibaba/qwen3-30b-a3b-instruct-2507` → `nvidia/nemotron-3-nano-30b-a3b` → `openai/gpt-oss-20b` | `OTARI_MODELS_EXTRACT` |
| ideas | generate-ideas | `alibaba/qwen3-235b-a22b-instruct-2507` → `deepseek/deepseek-v4-flash` → `meta/llama-3.3-70b-instruct` | `OTARI_MODELS_IDEAS` |
| judge | score-idea (auto), driving `otari_code_execution` | `deepseek/deepseek-v4-flash` → `alibaba/qwen3-235b-a22b-instruct-2507` | `OTARI_MODELS_JUDGE` |
| build | Build it generation and repair (streamed) | `alibaba/qwen3-coder-480b-a35b-instruct` → `alibaba/qwen3-coder-30b-a3b-instruct` | `OTARI_MODELS_BUILD` |
| guard | prompt-injection screen of imported pages | `alibaba/qwen3guard-gen-8b` → `meta/llama-guard-4-12b` | `OTARI_MODELS_GUARD` |
| research | managed-MCP research before brainstorming | `alibaba/qwen3-235b-a22b-instruct-2507` → `moonshotai/kimi-k2.6` | `OTARI_MODELS_RESEARCH` |
| chat | Pilot chat (`otari` agent engine) | `alibaba/qwen3-235b-a22b-instruct-2507` | `OTARI_MODELS_CHAT` |

Any entry can also be the name of an Otari routing policy, for example `OTARI_MODELS_BUILD=hackpilot-build`. Then the gateway handles fallback on its side, and HackPilot still falls back to the next entry if that fails.

## Feature evidence

Request ids come from the live smoke run on 2026-11-10 against `api.otari.ai`. You can look them up under **Requests** in the Otari dashboard.

| Feature | Code location | How to demo | Sample Otari request id |
| --- | --- | --- | --- |
| Multiple open-weight models in distinct roles | `server/lib/otari.ts:32` (`DEFAULT_ROLE_MODELS`), `server/lib/ai-ideas.ts:52,69` (`role: "ideas"` / `"judge"`), `server/lib/llm.ts:89` (build chain) | Import a hackathon, generate ideas, auto-score one, then Build it. Each action reports the model it used. | extract `781c4815-8237-4c63-9374-85424ed281af` (qwen3-30b) · ideas `599f3f88-9d72-4b56-9b46-06a400bef34a` (qwen3-235b) · judge `06d1765f-5c7f-48bb-8c30-302a3ac00bff` (deepseek-v4-flash) · build `52ce7ff0-5399-4ffb-851e-3b668d2bfd4e` (qwen3-coder-480b) · guard `83c67a33-d7e3-40da-b577-982cb194d4bd` (qwen3guard-gen-8b) |
| Routing and fallbacks | `server/lib/otari.ts:406-437` (`otariChat`: next model on error, stop on guardrail or budget), `server/lib/otari.ts:66` (`OTARI_MODELS_<ROLE>`, accepts routing-policy names), `server/lib/llm.ts:212-225` (Otari, then NVIDIA/OpenRouter as last resort) | Set `OTARI_MODELS_EXTRACT=bogus/model,alibaba/qwen3-30b-a3b-instruct-2507` and import. The log shows the first model failing and the second serving the request. Unit test: "falls back to the next model on an upstream error". | The `Otari-Fallback` / `Otari-Model` headers are recorded on each call in `docs/otari-smoke-results.json` (`calls[].fallback`, `servedBy`) |
| MCP (managed, inline `mcp_servers`) | `server/lib/otari.ts:631` (`otariMcpServer`, default DeepWiki, `OTARI_MCP_URL`), `server/lib/ai-ideas.ts:84-122` (`researchHackathonTech`), `actions/generate-ideas.ts:70` | Generate ideas for a hackathon. The result's `research.toolsUsed` lists the MCP tools the gateway ran, and the message says "after researching the sponsor tech via deepwiki MCP on Otari". | `163c2522-dcf5-4032-a23e-373412377a85` (3 × `deepwiki.read_wiki_structure`) |
| Web search / fetch | `server/lib/otari.ts:487` (`otariWebFetch`), `server/lib/otari.ts:513` (`otariWebSearch`), `actions/import-hackathon.ts:147-163` | Import a hackathon URL. `fetchedVia` is `otari_web_fetch` when the workspace allows it. Otherwise it is `direct` (local fetch), or `otari_web_search` when the site blocks direct fetches. | Not run live yet: this key reports both tools as `workspace_disabled`, so the app took the local-fetch fallback (`importPipeline.fetchedVia: "direct"`). Turn them on in the dashboard (below) and run the smoke test again. |
| Code execution | `server/lib/otari.ts:542` (`otariRunPython`), `server/lib/ai-ideas.ts:134-186` (`scoreMathProgram`, `otariScoreMath`), `actions/score-idea.ts:103` | Score an idea with `auto: true` or `verify: true`. `math.computedBy` is `otari_code_execution`, with the weighted total, per-criterion contributions, the criterion with most headroom, and hours left. | `18b465bf-22b2-48c4-a95b-a219a3efee3e` (weighted 8.1, 14.6 h left) |
| Guardrails | Request `guardrails` from `OTARI_GUARDRAILS` (`server/lib/otari.ts:117`). Block detection: `classifyOtariError` `server/lib/otari.ts:193-196`. User-facing error: `server/lib/llm.ts:115` (`otari_guardrail_blocked`, 403) and `actions/import-hackathon.ts:178`. App-side guard model on untrusted page text: `server/lib/otari.ts:610`, `actions/import-hackathon.ts:168-176` | Import a page containing "IGNORE ALL PREVIOUS INSTRUCTIONS…". The guard model flags it as Jailbreak, the import skips the LLM, and you get a warning. With a mandated guardrail in block mode, the gateway's 403 shows up as "Otari's guardrail blocked this request…". | Guard flagged injection: `83c67a33-d7e3-40da-b577-982cb194d4bd`. Request with `guardrails` field: `a8f47986-36de-48ec-bc74-51c3f00286a6` (this gateway has no guardrails service yet, so the app dropped the field after the 400 and resent) |
| Budgets / spend limits | `classifyOtariError` budget branch `server/lib/otari.ts:197-205` (403 `budget_exceeded`, 402, 429 budget, `user_blocked`). Stops the fallback chain (`fatal`). Message: `server/lib/otari.ts:162` and `server/lib/llm.ts:115` (`otari_budget_exceeded`, 402). Build path: `server/lib/llm.ts:429` | Set a tiny workspace budget and run any AI action. The action fails with "Your AI budget on the Otari gateway is used up for now…" and does not retry other models. Unit test: "stops on a budget refusal". | Not triggered live (it would mean spending the budget) |
| Per-user budgets | `otariEndUser` `server/lib/otari.ts:82` (signed-in user from the request context, sent as `user` on every request), `otariBodyExtras` used by structured calls, streamed builds (`server/lib/llm.ts:317`) and Pilot chat (`server/lib/otari-engine.ts:31`). Mismatch handling: `server/lib/otari.ts:317` | With a service key that has end-user budgets, each HackPilot user appears under **API keys → End users**. | Sent on every smoke call. The current personal key answers `403 'user' field does not match`. The app logs it, resends without `user`, and stops sending it for 10 minutes. |
| Pilot chat through Otari | `server/lib/otari-engine.ts:52` (`registerAgentEngine` named `otari`, AI SDK OpenAI provider on the Otari base URL) | Set `AGENT_ENGINE=otari` or pick **Otari** in Settings → AI engine, then ask Pilot to list hackathons. | Registered engine streamed a `list-hackathons` tool call (`agentEngine` in results). AI SDK tool loop: `9ba8b132-9379-4b2d-8a24-9b0684381a7f` |

## What Frank configures in the Otari dashboard

1. **Tools**: in the workspace's **Tools** settings, turn on **Web search** and **Web fetch**. Code execution is already available. HackPilot checks `GET /api/v1/tools` (cached for 5 minutes) and starts using them automatically.
2. **Routing policy** (optional, scores routing): create a **Fallback** policy, for example `hackpilot-build` with main `alibaba/qwen3-coder-480b-a35b-instruct` and fallback `alibaba/qwen3-coder-30b-a3b-instruct`. Then set `OTARI_MODELS_BUILD=hackpilot-build,alibaba/qwen3-coder-480b-a35b-instruct`. Do the same for other roles if you like.
3. **Guardrail**: mandate a `prompt-injection` guardrail in **block** mode for the workspace or the key. This needs a guardrails service; right now the gateway answers "no guardrails service is configured". Optionally set `OTARI_GUARDRAILS=prompt-injection:block` so the app asks for it on every request. Until the service exists, the app drops the field and relies on its own guard-model screen.
4. **Workspace budget**: in **Spend & budgets**, set a workspace budget or spend ceiling (for example $5/day).
5. **Service key with end-user budgets**: create an end-user budget (for example `hackpilot-user`, $0.50/day). Then go to **API keys → Create key → Advanced**, tick **Service key**, add that budget as the default end-user budget, and use this key as `OTARI_API_KEY`. Each signed-in HackPilot user is then billed and capped separately.
6. **MCP** (optional): inline `mcp_servers` need `request_mcp_servers_allowed` on the workspace. It is on for this key, since the DeepWiki call succeeded. Alternatively, register DeepWiki (`https://mcp.deepwiki.com/mcp`) as a workspace MCP server.

## Env vars

See `.env.example` for: `OTARI_API_KEY`, `OTARI_BASE_URL`, `OTARI_MODELS_<ROLE>`, `OTARI_END_USER=off`, `OTARI_GUARDRAILS`, `OTARI_GUARD=off`, `OTARI_MCP_URL` / `OTARI_MCP_TOKEN` / `OTARI_MCP_NAME` / `OTARI_MCP_TOOLS`, `OTARI_DISABLE_TOOLS`, and `AGENT_ENGINE=otari`.

## Notes

- The framework does not give engines with a custom base URL access to deployment env keys. The app-owned `otari` engine therefore falls back to `OTARI_API_KEY` itself (the operator chose Otari). A key saved in Settings still wins.
- If every Otari model fails for a non-fatal reason, the direct NVIDIA and OpenRouter providers are used when configured. Guardrail and budget refusals never fall through to another provider.
- Node does not use `HTTPS_PROXY` by default. In a proxied sandbox, run the smoke test with `NODE_USE_ENV_PROXY=1` (and `NODE_EXTRA_CA_CERTS` if needed).
