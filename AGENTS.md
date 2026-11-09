# Chat — Agent Guide

Chat is the minimal chat-first agent-native app. `/` redirects to shared sign-in, then `/home`, the editable Get started page. Chat lives at `/chat`; new chats start there. Actions carry capabilities; screens exist only for durable workflows.

## Skills

Search with `rg --hidden --follow`; read the exact linked guide before deeper work. `.agents/skills/build-an-app/SKILL.md` — start here for vague requests to create a domain app. `.agents/skills/adding-a-feature/SKILL.md` — cross-area feature checklist. Data/integrations: `.agents/skills/actions/SKILL.md`, `.agents/skills/storing-data/SKILL.md`, `.agents/skills/security/SKILL.md`, `.agents/skills/secrets/SKILL.md`, `.agents/skills/sharing/SKILL.md`. UI: `.agents/skills/frontend-design/SKILL.md`, `.agents/skills/shadcn-ui/SKILL.md`, `.agents/skills/client-side-routing/SKILL.md`. Agent context/workflows: `.agents/skills/context-awareness/SKILL.md`, `.agents/skills/real-time-sync/SKILL.md`, `.agents/skills/reliable-mutations/SKILL.md`, `.agents/skills/performance/SKILL.md`, `.agents/skills/delegate-to-agent/SKILL.md`. Framework: `.agents/skills/agent-native-docs/SKILL.md`, `.agents/skills/agent-native-toolkit/SKILL.md`, `.agents/skills/customizing-agent-native/SKILL.md`.

Use local docs only (no web research): `pnpm action docs-search --query "<topic>"`, `pnpm action docs-search --slug "<slug>"`, `pnpm action docs-search --list`, `pnpm action source-search --query "<pattern>"`, `pnpm action source-search --path <path>`, or `pnpm action source-search --list`. For external-agent integrations, read `pnpm action docs-search --slug "external-agents"`.

## Core rules

- UI feedback: target 100 ms, never exceed 400 ms; acknowledge before network work.
- Normal app data must flow through actions. Keep actions deterministic and focused; use agent chat/AgentSidebar for AI work and follow-ups in the same thread. Keep structured state in SQL and large files in configured storage; persist references only.
- For external integrations, inspect the workspace/provider connection catalog first; reuse its scoped resolver. Never hardcode credentials, webhook URLs, or private/customer data.
- Never fabricate. Report failures and recover; verify writes by reading the row or screen. Navigation is in `<current-screen>`; use `view-screen` for fresh visible-record details.

For custom branding, keep `server/plugins/agent-native-email-branding.ts` aligned: `app.name` appears in transactional email and optional `app.logoUrl` must be an absolute HTTPS URL.

## Application state

- `navigation` describes the view and selected ids. Chat is `chat` at `/chat` and `/chat/<threadId>`; the Get started page is `home` at `/home`; `/` opens shared sign-in/signup.
- Use `navigate` when supported and `view-screen` for a fresh read of visible details; basic navigation is already in `<current-screen>`.

## Building a domain app

Choose the primary workflow and route before editing. Add a domain route under `app/routes/` and set `app.homePath` in `server/plugins/agent-native-email-branding.ts` with `defineAppConfig`. The default Get started page lives at `/home`, and Chat stays at `/chat`; edit `app/routes/home.tsx` when replacing that page with a domain-specific home. Add a static link in `app/components/layout/Sidebar.tsx` before `ChatThreadsSection`; `Header.tsx` uses `APP_TITLE` elsewhere. Shared sidebar and AgentInspector remain.

Use `adding-a-feature` for functional parity and `frontend-design` for a user-facing screen. Keep feature guidance here; do not rewrite `README.md` or `DESIGN.md`. After all edits, run one typecheck, one doctor check, and one browser smoke of the primary workflow, including overlap rejection, cancellation freeing the slot, and authenticated landing. Skip production build and extra test suites.

Before building common workspace or agent UI, read `agent-native-toolkit`; for supported customization, read `customizing-agent-native`.

- Guarded verification: run `pnpm agent-native:doctor`; fix findings before done.

## HackPilot actions worth knowing

- `plan-sprint` (fresh | rebalance) builds a milestone plan: Idea locked (~10% of the window from import to deadline), Core works (~55%), Demo-ready (~85%), Submitted (deadline). Targets scale with the event length, never land in the past, and rebalance re-slots missed milestones. Milestones live on `hackathons.milestones`; tasks carry `milestone` + `day`.
- `update-task` accepts `milestone` ("idea" | "core" | "demo" | "submit") to move a task; the due day is pulled inside the new milestone unless `day` is passed.
- `build-project` ("Build it") generates a Vite + React + TS starter, then runs npm install → tsc → vite build → smoke test with up to 3 model repair rounds. Use the returned ID to poll `get-build` and open its preview or ZIP. `design: "auto"` reads the current user's linked Design prototype and keeps the build private. If that draft cannot be read, report the failure and let the user choose to retry or use `design: "off"`. `mode: "template"` uses neither Design nor a model. Regular builds check off Core works tasks on success. Private Design builds leave shared tasks and checklist items for the user to update.
- LLM calls go through `server/lib/llm.ts`: fast calls try NVIDIA then OpenRouter. Build it uses OpenRouter (`OPENROUTER_API_KEY`) with `deepseek/deepseek-v4.1-flash-1017` by default; `OPENROUTER_BUILD_MODEL` overrides it. DeepSeek uses low reasoning effort and build calls omit `max_tokens`; provider limits and timeouts still apply. See `.env.example`.
- Companion apps: Ideas starts private Design drafts, Checklist starts Content and Slides drafts, and Pilot can create a hosted Plan snapshot on request. Use `get-companion-apps` for setup state and `companion-app-tool` for authorized discovery, creation, and read-back through personal MCP connections. Follow `.agents/skills/companion-apps/SKILL.md`.
- Design is optional after picking an idea. Pass the original selected idea ID as `linkToIdeaId` on the `companion-app-tool` call that verifies `get-design`. Confirm `prototypeLink.status` is `saved` before reporting that the private shortcut is available in Ideas and Plan.
- `attach-clips-proof` anonymously verifies a hosted Clips share URL and saves it to the selected demo video checklist item. Use it with `hackathonId`, `itemId`, and `url`. Confirm the returned proof link and leave the item's status to the user.
