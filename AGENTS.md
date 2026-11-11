# HackPilot — Agent Guide

HackPilot is an Agent-Native workspace for hackathon ideas, sprint plans, starter builds, and submission readiness. `/` uses the shared sign-in flow, then lands on `/hackathons`. Pilot chat and the workspace use the same actions.

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

- `navigation` describes the view and selected ids. The list is `hackathons` at `/hackathons`. The `hackathon` view at `/hackathons/<hackathonId>` includes the active `tab`. Full-page chat is `chat` at `/chat` and `/chat/<threadId>`. The framework's Get started page is at `/home`.
- Use `navigate` when supported and `view-screen` for a fresh read of visible details; basic navigation is already in `<current-screen>`.

## Changing HackPilot

Workspace routes live under `app/routes/hackathons*` and the UI lives in `app/components/hackpilot/`. The authenticated landing path is configured in `server/plugins/agent-native-email-branding.ts`. Keep navigation in the shared sidebar and pass workspace context through `askPilot`.

Use `adding-a-feature` for functional parity and `frontend-design` for a user-facing screen. Keep feature guidance here; do not rewrite `README.md` or `DESIGN.md`. After all edits, run one typecheck, one doctor check, and one browser smoke of the primary workflow, including overlap rejection, cancellation freeing the slot, and authenticated landing. Skip production build and extra test suites.

Before building common workspace or agent UI, read `agent-native-toolkit`; for supported customization, read `customizing-agent-native`.

- Guarded verification: run `pnpm agent-native:doctor`; fix findings before done.

## HackPilot actions worth knowing

- `plan-sprint` (fresh | rebalance) builds a milestone plan: Idea locked (~10% of the window from import to deadline), Core works (~55%), Demo-ready (~85%), Submitted (deadline). Targets scale with the event length, never land in the past, and rebalance re-slots missed milestones. Milestones live on `hackathons.milestones`; tasks carry `milestone` + `day`.
- `update-task` accepts `milestone` ("idea" | "core" | "demo" | "submit") to move a task; the due day is pulled inside the new milestone unless `day` is passed.
- `build-project` ("Build it") generates a Vite + React + TS starter, then runs npm install → tsc → vite build → smoke test with up to 3 model repair rounds. Use the returned ID to poll `get-build` and open its preview or ZIP. `design: "auto"` reads the current user's linked Design prototype and keeps the build private. If that draft cannot be read, report the failure and let the user choose to retry or use `design: "off"`. `mode: "template"` uses neither Design nor a model. Regular builds check off Core works tasks on success. Private Design builds leave shared tasks and checklist items for the user to update.
- `verify-fusion-build` takes a passed build ID and the Fusion Download Code ZIP as base64 (2 MiB ZIP limit). Open in Fusion uses the starter ZIP and a GitHub repo the user has connected. Use a private repo for a Design starter. The verification run and its ZIP stay private to the original Design build owner. Import & verify restores the original dependency lockfile and checks the build configuration and smoke test before rerunning the checks. The default verifier uses local Docker with `node:22-bookworm-slim` pre-pulled. A development session can use the operator-managed verifier described in `.env.example`. Poll `get-build` for the log and verified ZIP. View the edited preview in Fusion.
- LLM calls go through `server/lib/llm.ts`: with `OTARI_API_KEY` set, every call goes through the Otari gateway (`server/lib/otari.ts`) with open-weight models per role (extract, ideas, judge, build, guard, research, chat) and per-role fallback; see `docs/OTARI.md`. Without Otari, or after every Otari model fails, fast calls try NVIDIA then OpenRouter. Build it uses OpenRouter (`OPENROUTER_API_KEY`) with `anthropic/claude-haiku-5.5` by default; `OPENROUTER_BUILD_MODEL` overrides it. Build calls omit `max_tokens`; provider limits and timeouts still apply. Pilot chat defaults to `anthropic/claude-haiku-5.5` when the deployment OpenRouter key is configured. See `.env.example`.
- Companion apps: Ideas starts private Design drafts, Checklist starts Content and Slides drafts, and Pilot can create a hosted Plan snapshot on request. Use `get-companion-apps` for setup state and `companion-app-tool` for authorized discovery, creation, and read-back through personal MCP connections. Follow `.agents/skills/companion-apps/SKILL.md`.
- Design is optional after picking an idea. Pass the original selected idea ID as `linkToIdeaId` on the `companion-app-tool` call that verifies `get-design`. Confirm `prototypeLink.status` is `saved` before reporting that the private shortcut is available in Ideas and Plan.
- `attach-clips-proof` anonymously verifies a hosted Clips share URL and saves it to the selected demo video checklist item. Use it with `hackathonId`, `itemId`, and `url`. Confirm the returned proof link and leave the item's status to the user.
