# Developing HackPilot

Use Node.js 22.22.0 or newer and pnpm 10.29.1. Follow the
[README](./README.md) to install dependencies, configure the local environment,
and start the dev server.

## Architecture

HackPilot uses Agent-Native Core, AgentKit, and Toolkit with React Router 8,
React 19, Vite, and Nitro. React Router discovers files in `app/routes/` and
renders the shell on the server. Action hooks load workspace data on the client.

| Path                                                                            | Responsibility                                                                            |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `app/routes/_index.tsx`                                                         | Shared sign-in entry at `/`. Authenticated users land at `/hackathons`.                   |
| `app/routes/hackathons._index.tsx` and `app/routes/hackathons.$hackathonId.tsx` | Workspace list and detail. The detail route exposes Overview, Ideas, Plan, and Checklist. |
| `app/routes/chat._index.tsx` and `app/routes/chat.$threadId.tsx`                | Full-page chat under `/chat`.                                                             |
| `app/components/hackpilot/`                                                     | Workspace UI and contextual handoffs to Pilot in the agent sidebar.                       |
| `app/hooks/use-navigation-state.ts`                                             | Supplies the current workspace ID and tab to the agent.                                   |
| `actions/` and `server/plugins/agent-chat.ts`                                   | Shared action contracts and the Pilot agent configuration.                                |
| `server/db/schema.ts` and `server/plugins/db.ts`                                | Drizzle schema and database migrations.                                                   |
| `server/lib/builder.ts` and `server/lib/fusion-runner.ts`                       | Starter build pipeline and isolated Fusion checks.                                        |
| `shared/`                                                                       | Schemas and logic used by both client and server.                                         |

Use `defineAction` for normal reads and writes so the UI and Pilot operate on
the same records. Mark reads with `http: { method: "GET" }` and call them with
`useActionQuery`. Use `useActionMutation` for writes. The workspace subscribes to
database changes so agent and teammate edits show up on the board. Keep
workspace access checks in actions and reuse the sharing helpers in
`server/lib/workspace.ts`.

Use `server/routes/api/` for route-specific protocols, such as serving build
previews and ZIP files. The framework already exposes actions under
`/_agent-native/actions/:name`. To render an action result in chat, declare its
`chatUI.renderer` on the action. Search the installed framework docs for
AgentKit and framework Extensions, which are sandboxed widgets.

```sh
pnpm action docs-search --list
pnpm action docs-search --query "extensions"
pnpm action get-hackathon --id "$hackathon_id"
pnpm action get-build --buildId "$build_id"
```

Set `hackathon_id` and `build_id` to the record IDs you want to inspect. Run
workspace actions with a context that has access to those records.

## Environment and storage

See [`.env.example`](./.env.example) for supported settings. Local development
uses PGlite in `data/pglite`. Set `DATABASE_URL` to persistent PostgreSQL for
production and shared environments. Auth is enabled by default. Standalone
production deployments need a stable `BETTER_AUTH_SECRET`.

Fast structured actions try NVIDIA first and fall back to OpenRouter when
configured. Model-generated builds and repairs use OpenRouter with
`OPENROUTER_API_KEY`. Set `OPENROUTER_BUILD_MODEL` to override
`anthropic/claude-haiku-5.5`. Template mode runs without a model. Provider
credentials resolve through the scoped secret store with a deployment
environment fallback. Pilot chat uses the framework's separate AI engine
configuration. Keep credential values in the local environment, deployment
configuration, or scoped secret store.

Build metadata lives in SQL. Generated files, previews, and ZIPs live on the
server filesystem under `data/builds` by default. Set `HACKPILOT_BUILD_DIR` to use
another writable directory. A build host needs local `npm`, `npx`, and `zip`
commands. Hosts that need to retain downloads and previews across restarts also
need persistent storage for that directory.

## Fusion verification

Start with a passed idea-based HackPilot starter, add its source to a GitHub
repository connected to Fusion, and edit it there. Import Fusion's
**Download Code** ZIP in Plan with
**Import & verify**. The limit is 2 MiB before base64 encoding.

Keep `package.json`, `tsconfig.json`, `vite.config.ts`, and `smoke.test.ts` from
the original starter. Keep the original `package-lock.json` if the ZIP includes
it. The verifier uses that lockfile for dependency install, then runs
typecheck, Vite build, and the smoke test.
View the edited preview in Fusion and download verified source from HackPilot
after the checks pass.

The default runner needs a local Docker daemon at `/var/run/docker.sock`. Pull
`node:22-bookworm-slim` before the first run.

```sh
docker pull node:22-bookworm-slim
```

## Verify changes

```sh
pnpm typecheck
pnpm agent-native:doctor
pnpm test server/lib/build-project.test.ts
```

Use the targeted Vitest file for build behavior changes and the matching test
file for other areas. Follow [AGENTS.md](./AGENTS.md) for the required browser
smoke. Sign in and confirm the landing page opens the hackathon list. Exercise
the affected workflow with the curated demo workspace and read back any writes.
For build changes, check that overlapping requests start at most one worker and
that canceling a pending start frees the slot. Use a passed starter and a real
Fusion export to exercise the ZIP handoff, verification log, and download.
