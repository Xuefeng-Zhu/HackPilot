# HackPilot

HackPilot turns a hackathon page into a workspace for picking an idea, planning the sprint, building a starter app, and preparing the submission. Work in the boards or ask Pilot to make a change in chat. Both use the same Agent-Native actions and workspace data.

## Workflow

1. **Overview.** Import a public hackathon URL to extract the deadline, prizes, judging criteria, and submission requirements. Review and edit the imported details before planning.
2. **Ideas.** Add your own ideas or brainstorm with Pilot. Compare scores and rationales against the event's weighted rubric, then pick an idea to build.
3. **Plan.** Generate a sprint with four milestones: Idea locked, Core works, Demo-ready, and Submitted. Move tasks on the board or ask Pilot to reschedule work around the remaining time.
4. **Build it.** In Plan, generate a Vite, React, and TypeScript starter from the selected idea. HackPilot installs dependencies, typechecks, builds, and runs a smoke test. Model builds can try up to three repair rounds. Open the preview from the build results and download the source ZIP when packaging succeeds.
5. **Checklist.** Track requirements and proof links, then run **Readiness check with Pilot** to see missing items and overdue tasks. Use **Record demo in Clips** to record a walkthrough, then verify and attach its public share link to the demo video item. Submit through the organizer's form.

### Design and Fusion

After picking an idea, connect Design from **Ideas** and select **Draft UI in Design**. When Pilot links the draft, **Open prototype** appears in Ideas and Plan. With **Use Design prototype** selected, **Build it** uses the linked draft as a visual reference. The resulting preview and ZIP stay private to the person who started the build.

To edit a passed idea-based starter in Fusion, download its source ZIP, unzip it into a GitHub repo connected to Fusion, and open the project in Fusion. After editing, choose **Download Code** in Fusion, then **Import & verify** in HackPilot's Plan tab. Keep the ZIP within 2 MiB and retain the original package manifest, TypeScript and Vite configuration, and smoke test. If the export includes a dependency lockfile, keep the original. HackPilot uses that lockfile to rerun the checks on the edited source. Open the edited preview in Fusion and download the verified ZIP in HackPilot.

From **Checklist**, you can also start private submission drafts in Content and Slides. Ask Pilot for a private Plan snapshot if you want a separate planning artifact. These handoffs use your personal app connections.

## Run locally

Use Node.js 22.22.0 or newer and pnpm 10.29.1. From a fresh checkout:

```sh
cp .env.example .env
pnpm install --frozen-lockfile
pnpm dev
```

Open the address printed by the dev server, then sign in to reach **Hackathons**. The local database uses PGlite by default. Starter builds also need `npm` and `zip` on the server's PATH. For Fusion verification, see the [verifier setup](DEVELOPING.md#fusion-verification).

### LLM providers

HackPilot routes its model calls through [Mozilla's Otari AI gateway](https://api.otari.ai) when `OTARI_API_KEY` is set, using open-weight models with a separate role for each kind of call. See [docs/OTARI.md](docs/OTARI.md) for the features it uses, where they live in the code, and the dashboard setup.

| Feature                          | Configuration                                                                                                                                                                                       |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Otari gateway (preferred)        | `OTARI_API_KEY` (a service key for per-user budgets) and optional `OTARI_BASE_URL`. `OTARI_MODELS_<ROLE>` sets an ordered fallback list or an Otari routing policy for each role.                 |
| Import (extract role)            | `alibaba/qwen3-235b-a22b-instruct-2507` → `deepseek/deepseek-v4-flash` → `alibaba/qwen3-30b-a3b-instruct-2507`. Pages are fetched with `otari_web_fetch` when enabled, then screened by `alibaba/qwen3guard-gen-8b`. |
| Ideas (ideas + research roles)   | `deepseek/deepseek-v4-flash` → `alibaba/qwen3-235b-a22b-instruct-2507` → `meta/llama-3.3-70b-instruct`. Research runs first through Otari-managed MCP (DeepWiki by default, `OTARI_MCP_URL`).          |
| Scoring (judge role)             | `deepseek/deepseek-v4-flash` → `alibaba/qwen3-235b-a22b-instruct-2507`. The weighted totals are computed in `otari_code_execution`.                                                                       |
| Build it generation and repair   | `alibaba/qwen3-coder-480b-a35b-instruct` → `alibaba/qwen3-coder-30b-a3b-instruct` on Otari, with OpenRouter (`OPENROUTER_API_KEY`, `OPENROUTER_BUILD_MODEL`) as the last resort.                       |
| Pilot chat                       | `AGENT_ENGINE=otari`, or choose **Otari** in **Settings → AI engine**. The default is `alibaba/qwen3-235b-a22b-instruct-2507` (`OTARI_MODELS_CHAT`). Other providers work as before.                   |
| Direct fallbacks                 | `NVIDIA_API_KEY` (`NVIDIA_MODEL`) and `OPENROUTER_API_KEY` (`OPENROUTER_MODEL`) are used only when Otari is not configured or every Otari model fails.                                                |

A regular build falls back to a deterministic starter when model generation is unavailable or fails. Design builds require the build model and access to the linked prototype. See [`.env.example`](.env.example) for configuration options. Run the live Otari smoke test with `npx vitest --run -c vitest.smoke.config.ts`.

## Demo walkthrough

Open **Builder.io Agent-Native Hackathon demo** from the Hackathons list. It loads the curated rubric, sample ideas, and checklist. Before recording, configure Pilot chat and complete a **Build it** run. Use a workspace with a future deadline if you need to generate a fresh sprint.

1. Open **Overview** and point to the deadline and weighted rubric.
2. Open **Ideas** and click **Why these scores?** on the HackPilot idea.
3. In **Plan**, ask Pilot to move a visible task to **Demo-ready**. Show the card move in the same workspace.
4. Open a completed **Build it** run, show the check results, and interact with the starter in **Preview**.
5. Run the readiness check in **Checklist** and point to one requirement still open.

See the [development guide](DEVELOPING.md) for architecture and local checks, and the [design guide](DESIGN.md) for workspace and chat conventions.
