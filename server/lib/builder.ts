/**
 * "Build it": turn the picked idea + sprint plan into a runnable starter app.
 *
 *   generate -> install -> typecheck -> build -> smoke test -> (repair x3)
 *
 * Runs in the background of the server process. Every step is written to the
 * `hackathon_builds` row so the UI (and the agent, via get-build) can poll it.
 * Generated apps live under data/builds/<buildId>/app; nothing there is ever
 * executed with app secrets in its environment.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { and, desc, eq, inArray } from "drizzle-orm";

import {
  MAX_REPAIR_ROUNDS,
  type BuildFile,
  type BuildMeta,
  type BuildStage,
  type BuildStep,
} from "../../shared/build.js";
import { isMilestoneId, milestoneForPhase } from "../../shared/milestones.js";
import { getDb, schema } from "../db/index.js";
import {
  DEFAULT_TSCONFIG,
  PINNED_DEPS,
  PINNED_DEV_DEPS,
  type GenFile,
  type StarterInput,
  templateFiles,
} from "./build-template.js";
import { parseFileBlocks } from "./file-blocks.js";
import { chatWithFallback, type ChatMessage, providerChain } from "./llm.js";
import { nowIso } from "./workspace.js";

export const BUILD_ROOT = path.resolve(
  process.env.HACKPILOT_BUILD_DIR?.trim() || path.join(process.cwd(), "data", "builds"),
);

const MAX_FILES = 40;
const VITE_CONFIG = `import { defineConfig } from "vite";\nimport react from "@vitejs/plugin-react";\n\nexport default defineConfig({ plugins: [react()] });\n`;
const MAX_FILE_BYTES = 120_000;
const running = new Map<string, Promise<void>>();

export function isBuildRunning(buildId: string) {
  return running.has(buildId);
}

export function waitForBuild(buildId: string, timeoutMs: number) {
  const p = running.get(buildId);
  if (!p) return Promise.resolve();
  return Promise.race([p, new Promise<void>((r) => setTimeout(r, timeoutMs))]);
}

// ---------------------------------------------------------------- progress

class Progress {
  steps: BuildStep[] = [];
  meta: BuildMeta = { calls: [] };
  rounds = 0;
  private started = Date.now();
  constructor(private id: string) {}

  private async save(patch: Partial<typeof schema.builds.$inferInsert> = {}) {
    await getDb()
      .update(schema.builds)
      .set({
        steps: this.steps,
        meta: { ...this.meta, durationMs: Date.now() - this.started },
        rounds: this.rounds,
        updatedAt: nowIso(),
        ...patch,
      })
      .where(eq(schema.builds.id, this.id));
  }

  async begin(stage: BuildStage, label: string, detail?: string) {
    this.steps.push({ at: nowIso(), stage, label, status: "running", ...(detail ? { detail } : {}) });
    await this.save({ stage });
    return Date.now();
  }

  async end(t0: number, status: "ok" | "fail", detail?: string) {
    const last = this.steps[this.steps.length - 1];
    if (last) {
      last.status = status;
      last.ms = Date.now() - t0;
      if (detail !== undefined) last.detail = detail;
    }
    await this.save();
  }

  async info(stage: BuildStage, label: string, detail?: string) {
    this.steps.push({ at: nowIso(), stage, label, status: "info", ...(detail ? { detail } : {}) });
    await this.save();
  }

  async finish(status: "passed" | "failed", patch: Partial<typeof schema.builds.$inferInsert>) {
    await this.save({ status, stage: status === "passed" ? "done" : "failed", finishedAt: nowIso(), ...patch });
  }
}

// ---------------------------------------------------------------- processes

/** Child env without app secrets (keys, tokens) but with proxy + PATH. */
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/KEY|TOKEN|SECRET|PASSWORD|DATABASE_URL|COOKIE/i.test(k)) continue;
    if (k === "NODE_OPTIONS" || k === "NODE_USE_ENV_PROXY" || k.startsWith("VITE_") || k === "PORT") continue;
    env[k] = v;
  }
  env.CI = "1";
  env.NODE_ENV = "development";
  env.npm_config_update_notifier = "false";
  return env;
}

interface RunResult {
  ok: boolean;
  code: number | null;
  output: string;
  ms: number;
  timedOut: boolean;
}

function run(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<RunResult> {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: childEnv(), stdio: ["ignore", "pipe", "pipe"], detached: true });
    let out = "";
    const add = (b: Buffer) => {
      out += b.toString();
      if (out.length > 60_000) out = out.slice(-40_000);
    };
    child.stdout.on("data", add);
    child.stderr.on("data", add);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, code: null, output: `${out}\n${e.message}`, ms: Date.now() - t0, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const clean = out
        .split("\n")
        .filter((l) => !/UNDICI-EHPA|--trace-warnings|ExperimentalWarning/.test(l))
        .join("\n");
      resolve({ ok: code === 0 && !timedOut, code, output: clean, ms: Date.now() - t0, timedOut });
    });
  });
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n…(truncated)` : s);
const tail = (s: string, n: number) => (s.length > n ? `…${s.slice(-n)}` : s);

// ---------------------------------------------------------------- files

function safeRelPath(p: string): string | null {
  const clean = p.replace(/\\/g, "/").replace(/^\.\/+/, "").trim();
  if (!clean || clean.startsWith("/") || clean.split("/").some((s) => s === ".." || s === "")) return null;
  if (/^(node_modules|dist|\.git)\//.test(clean) || clean === "package-lock.json") return null;
  if (!/^[\w@.\-/ ]+$/.test(clean)) return null;
  return clean;
}

/** Force the toolchain versions we know pass, keep any extra deps the model chose. */
function normalizePackageJson(raw: string | undefined, title: string): string {
  let pkg: Record<string, unknown> = {};
  try {
    pkg = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    pkg = {};
  }
  const asRecord = (v: unknown) =>
    v && typeof v === "object" ? Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([, x]) => typeof x === "string")) as Record<string, string> : {};
  const deps = asRecord(pkg.dependencies);
  const dev = asRecord(pkg.devDependencies);
  for (const k of [...Object.keys(PINNED_DEPS), ...Object.keys(PINNED_DEV_DEPS), "vitest"]) {
    delete deps[k];
    delete dev[k];
  }
  return JSON.stringify(
    {
      name: typeof pkg.name === "string" && /^[a-z0-9-]+$/.test(pkg.name) ? pkg.name : title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "starter-app",
      private: true,
      version: "0.1.0",
      type: "module",
      scripts: {
        dev: "vite",
        build: "tsc --noEmit && vite build",
        typecheck: "tsc --noEmit",
        test: "tsx smoke.test.ts",
        preview: "vite preview",
      },
      dependencies: { ...deps, ...PINNED_DEPS },
      devDependencies: { ...dev, ...PINNED_DEV_DEPS },
    },
    null,
    2,
  );
}

/**
 * Deterministic fixes for the slips models make most often, applied before
 * every check so repair rounds go to real bugs: a missing default export on
 * App, and an entry file that doesn't match it.
 */
async function autofix(dir: string): Promise<string[]> {
  const fixed: string[] = [];
  const appPath = path.join(dir, "src", "App.tsx");
  if (existsSync(appPath)) {
    const app = await fs.readFile(appPath, "utf8");
    if (!/export\s+default\b/.test(app) && /\b(function|const)\s+App\b/.test(app)) {
      await fs.writeFile(appPath, `${app.trimEnd()}\n\nexport default App;\n`);
      fixed.push("added `export default App`");
    }
  }
  const mainPath = path.join(dir, "src", "main.tsx");
  const css = existsSync(path.join(dir, "src", "styles.css")) ? 'import "./styles.css";\n' : existsSync(path.join(dir, "src", "index.css")) ? 'import "./index.css";\n' : "";
  const main = `import { StrictMode } from "react";\nimport { createRoot } from "react-dom/client";\nimport App from "./App";\n${css}\nconst root = document.getElementById("root");\nif (!root) throw new Error("missing #root");\ncreateRoot(root).render(\n  <StrictMode>\n    <App />\n  </StrictMode>,\n);\n`;
  const current = existsSync(mainPath) ? await fs.readFile(mainPath, "utf8") : "";
  if (current !== main) {
    await fs.mkdir(path.dirname(mainPath), { recursive: true });
    await fs.writeFile(mainPath, main);
    if (current) fixed.push("normalized src/main.tsx");
  }
  return fixed;
}

async function writeFiles(dir: string, files: GenFile[], title: string): Promise<{ written: string[]; pkgChanged: boolean }> {
  const written: string[] = [];
  let pkgChanged = false;
  for (const f of files.slice(0, MAX_FILES)) {
    const rel = safeRelPath(f.path);
    if (!rel) continue;
    let content = f.content.slice(0, MAX_FILE_BYTES);
    if (rel === "tsconfig.json") content = DEFAULT_TSCONFIG;
    if (rel === "vite.config.ts") content = VITE_CONFIG;
    if (rel === "package.json") {
      const prev = existsSync(path.join(dir, rel)) ? await fs.readFile(path.join(dir, rel), "utf8") : "";
      content = normalizePackageJson(content, title);
      pkgChanged = prev !== content;
    }
    const abs = path.join(dir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
    written.push(rel);
  }
  return { written, pkgChanged };
}

async function listFiles(dir: string, base = dir): Promise<BuildFile[]> {
  const out: BuildFile[] = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    if (["node_modules", "dist", ".git"].includes(e.name)) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await listFiles(abs, base)));
    else if (e.name !== "package-lock.json") out.push({ path: path.relative(base, abs), bytes: (await fs.stat(abs)).size });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

async function readSources(dir: string): Promise<string> {
  const files = await listFiles(dir);
  const parts: string[] = [];
  for (const f of files) {
    if (f.bytes > 40_000 || f.path === "README.md") continue;
    parts.push(`=== FILE: ${f.path} ===\n${await fs.readFile(path.join(dir, f.path), "utf8")}\n=== END FILE ===`);
  }
  return parts.join("\n");
}

// ---------------------------------------------------------------- prompts

const SYSTEM_PROMPT = `You are a senior engineer building a hackathon MVP starter app that a judge can run in one minute.
Stack: Vite 5 + React 18 + TypeScript (strict). It must pass, with no edits:
  npm install && npx tsc --noEmit && npx vite build && npx tsx smoke.test.ts
Write these files: package.json (dependencies: react, react-dom; devDependencies: @types/node, @types/react, @types/react-dom, typescript, vite, @vitejs/plugin-react, tsx), tsconfig.json (one file, no project references, "types":["node"], "include":["src","smoke.test.ts"]), vite.config.ts, index.html, src/main.tsx, src/App.tsx, src/styles.css, src/logic.ts (pure, framework-free core logic of the idea, with realistic seed/demo data so the app works offline with no API key), smoke.test.ts (imports from "./src/logic", uses \`import assert from "node:assert/strict"\`, checks the core logic on 3-6 concrete cases, prints "SMOKE OK" last), README.md (what it is + how to run).
Rules: src/App.tsx must \`export default function App()\` and src/main.tsx imports it as default. Plain CSS, no UI or state libraries, no network calls, no environment variables. Strict mode clean: no unused locals, handle possibly-null values. Keep it focused: the core workflow of the idea working end-to-end in the UI.
Output format, nothing else: every file as
=== FILE: relative/path ===
<file content verbatim, no markdown fences>
=== END FILE ===
then one final line: NOTES: <one sentence on what works>`;

const REPAIR_SYSTEM = `You fix a Vite + React 18 + TypeScript (strict) starter app so that
  npx tsc --noEmit && npx vite build && npx tsx smoke.test.ts
all pass. You get the failing step's output and every source file. Fix the root cause (prefer fixing the code over weakening the test unless the test expectation is clearly wrong). Return ONLY the files you change, each complete, as
=== FILE: relative/path ===
<full new content>
=== END FILE ===
then one final line: NOTES: <one sentence on the fix>`;

function ideaPrompt(input: StarterInput & { rubric: string; requirements: string[] }) {
  return [
    `Hackathon: ${input.hackathon}`,
    input.rubric ? `Judging rubric: ${input.rubric}` : "",
    `Idea: ${input.title}`,
    `Pitch: ${input.pitch}`,
    input.tags.length ? `Tags: ${input.tags.join(", ")}` : "",
    input.tasks.length ? `Sprint plan (build what these need first):\n- ${input.tasks.slice(0, 10).join("\n- ")}` : "",
    input.requirements.length ? `Submission requirements: ${input.requirements.join("; ")}` : "",
    "Build the starter app for this idea now.",
  ]
    .filter(Boolean)
    .join("\n");
}

// ---------------------------------------------------------------- pipeline

type CheckStage = "typechecking" | "building" | "testing";
const CHECKS: { stage: CheckStage; label: string; cmd: string; args: string[]; timeoutMs: number }[] = [
  { stage: "typechecking", label: "Typecheck (tsc --noEmit)", cmd: "npx", args: ["--no-install", "tsc", "--noEmit", "-p", "."], timeoutMs: 120_000 },
  { stage: "building", label: "Production build (vite build)", cmd: "npx", args: ["--no-install", "vite", "build", "--logLevel", "warn"], timeoutMs: 120_000 },
  { stage: "testing", label: "Smoke test (tsx smoke.test.ts)", cmd: "npx", args: ["--no-install", "tsx", "smoke.test.ts"], timeoutMs: 60_000 },
];

async function install(dir: string, p: Progress, label = "Install dependencies (npm install)"): Promise<boolean> {
  const t0 = await p.begin("installing", label);
  const r = await run("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error", "--prefer-offline"], dir, 240_000);
  await p.end(t0, r.ok ? "ok" : "fail", r.ok ? undefined : tail(r.output, 1500) || (r.timedOut ? "timed out" : "failed"));
  return r.ok;
}

/** "nemotron-3.5-super-vl-120b-a12b on NVIDIA" — model ids often already carry the vendor prefix. */
function modelLabel(provider?: string, model?: string): string {
  const name = (model ?? "model").split("/").pop() ?? "model";
  const where = provider === "nvidia" ? "NVIDIA" : provider === "openrouter" ? "OpenRouter" : provider;
  return where ? `${name} on ${where}` : name;
}

async function generateLlm(input: Parameters<typeof ideaPrompt>[0], p: Progress) {
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: ideaPrompt(input) },
  ];
  const skip: ("nvidia" | "openrouter")[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await chatWithFallback(messages, {
      purpose: "build",
      maxTokens: 16_000,
      timeoutMs: 240_000,
      firstTokenMs: 60_000,
      skip,
    });
    p.meta.calls?.push(...r.attempts);
    p.meta.provider = r.provider;
    p.meta.model = r.model;
    if (r.cost != null) p.meta.cost = (p.meta.cost ?? 0) + r.cost;
    if (r.completionTokens != null) p.meta.completionTokens = (p.meta.completionTokens ?? 0) + r.completionTokens;
    const parsed = parseFileBlocks(r.text);
    const paths = new Set(parsed.files.map((f) => f.path));
    if (parsed.files.length >= 4 && paths.has("src/App.tsx")) return parsed;
    p.meta.calls?.push(`${modelLabel(r.provider, r.model)}: unusable output (${parsed.files.length} files)`);
    skip.push(r.provider);
  }
  throw new Error("No provider produced a usable set of files.");
}

async function repair(dir: string, failing: { label: string; output: string }, round: number, p: Progress) {
  const sources = await readSources(dir);
  const messages: ChatMessage[] = [
    { role: "system", content: REPAIR_SYSTEM },
    {
      role: "user",
      content: `Failing step: ${failing.label}\nOutput:\n${clip(failing.output, 6000)}\n\nCurrent files (tsconfig.json, vite.config.ts and package.json toolchain versions are fixed; change source files):\n${clip(sources, 60_000)}`,
    },
  ];
  // Rounds 2+ escalate to the fallback provider (a stronger paid model).
  const skip: ("nvidia" | "openrouter")[] = round >= 2 ? ["nvidia"] : [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const chain = await providerChain("build");
    if (!chain.some((t) => !skip.includes(t.provider))) skip.length = 0;
    const r = await chatWithFallback(messages, { purpose: "build", maxTokens: 12_000, timeoutMs: 180_000, firstTokenMs: 60_000, skip });
    p.meta.calls?.push(...r.attempts.map((a) => `repair ${round}: ${a}`));
    if (r.cost != null) p.meta.cost = (p.meta.cost ?? 0) + r.cost;
    if (r.completionTokens != null) p.meta.completionTokens = (p.meta.completionTokens ?? 0) + r.completionTokens;
    const parsed = parseFileBlocks(r.text);
    if (parsed.files.length) return { ...parsed, model: modelLabel(r.provider, r.model) };
    p.meta.calls?.push(`repair ${round}: ${modelLabel(r.provider, r.model)} returned no files`);
    skip.push(r.provider);
  }
  return { files: [] as GenFile[], notes: "", model: "" };
}

async function loadInput(buildId: string) {
  const db = getDb();
  const [b] = await db.select().from(schema.builds).where(eq(schema.builds.id, buildId)).limit(1);
  if (!b) throw new Error("build not found");
  const [h] = await db.select().from(schema.hackathons).where(eq(schema.hackathons.id, b.hackathonId)).limit(1);
  if (!h) throw new Error("hackathon not found");
  const [idea] = b.ideaId
    ? await db.select().from(schema.ideas).where(eq(schema.ideas.id, b.ideaId)).limit(1)
    : [];
  const tasks = await db
    .select({ title: schema.tasks.title, phase: schema.tasks.phase })
    .from(schema.tasks)
    .where(eq(schema.tasks.hackathonId, h.id))
    .orderBy(schema.tasks.day, schema.tasks.position)
    .limit(60);
  const items = await db
    .select({ label: schema.submissionItems.label })
    .from(schema.submissionItems)
    .where(eq(schema.submissionItems.hackathonId, h.id))
    .limit(20);
  return {
    build: b,
    hackathon: h,
    input: {
      title: idea?.title ?? b.ideaTitle,
      pitch: idea?.pitch ?? "",
      tags: idea?.tags ?? [],
      hackathon: h.name,
      tasks: tasks.filter((t) => t.phase === "build" || t.phase === "polish").map((t) => t.title),
      rubric: (h.rubric ?? []).map((c) => `${c.name} (${c.weight}%)`).join(", "),
      requirements: items.map((i) => i.label),
    },
  };
}

/** Mark plan tasks the starter covers as done; move the repo checklist item forward. */
async function markProgress(hackathonId: string, buildId: string) {
  const db = getDb();
  const tasks = await db
    .select({ id: schema.tasks.id, title: schema.tasks.title, done: schema.tasks.done, milestone: schema.tasks.milestone, phase: schema.tasks.phase })
    .from(schema.tasks)
    .where(eq(schema.tasks.hackathonId, hackathonId))
    .limit(500);
  // Everything under the "Core works" milestone: the starter proves the core runs.
  const covered = tasks.filter(
    (t) => !t.done && (isMilestoneId(t.milestone) ? t.milestone : milestoneForPhase(t.phase)) === "core",
  );
  const note = `Done by Build it (build ${buildId.slice(0, 8)}): starter app passed typecheck, build, and smoke test.`;
  if (covered.length) {
    await db
      .update(schema.tasks)
      .set({ done: true, notes: note, updatedAt: nowIso() })
      .where(and(eq(schema.tasks.hackathonId, hackathonId), inArray(schema.tasks.id, covered.map((t) => t.id))));
  }
  const items = await db
    .select()
    .from(schema.submissionItems)
    .where(eq(schema.submissionItems.hackathonId, hackathonId))
    .limit(100);
  const target = items.filter(
    (i) => i.status === "todo" && (i.kind === "repo" || /working app|source code|repo/i.test(i.label)),
  );
  if (target.length) {
    await db
      .update(schema.submissionItems)
      .set({ status: "in_progress", updatedAt: nowIso() })
      .where(and(eq(schema.submissionItems.hackathonId, hackathonId), inArray(schema.submissionItems.id, target.map((i) => i.id))));
  }
  await db.update(schema.hackathons).set({ updatedAt: nowIso() }).where(eq(schema.hackathons.id, hackathonId));
  return { tasks: covered.map((t) => t.title), items: target.map((i) => i.label) };
}

async function pipeline(buildId: string) {
  const p = new Progress(buildId);
  const { build, hackathon, input } = await loadInput(buildId);
  const root = path.join(BUILD_ROOT, buildId);
  const dir = path.join(root, "app");
  await fs.mkdir(dir, { recursive: true });
  await getDb().update(schema.builds).set({ dir: root }).where(eq(schema.builds.id, buildId));

  // 1. Generate
  let mode = build.mode;
  let notes = "";
  let files: GenFile[] = [];
  const hasLlm = (await providerChain("build")).length > 0;
  if (mode === "llm" && !hasLlm) {
    await p.info("generating", "No model configured", "Using the deterministic starter template instead.");
    mode = "template";
  }
  if (mode === "llm") {
    const t0 = await p.begin("generating", "Generate the app from the idea + plan", "Asking the build model for a Vite + React + TypeScript starter…");
    try {
      const g = await generateLlm(input, p);
      files = g.files;
      notes = g.notes;
      await p.end(t0, "ok", `${modelLabel(p.meta.provider, p.meta.model)} wrote ${files.length} files`);
    } catch (error) {
      await p.end(t0, "fail", error instanceof Error ? error.message.slice(0, 600) : "generation failed");
      await p.info("generating", "Falling back to the starter template", "Every model call failed; the template still gives you a running app.");
      mode = "template";
    }
  }
  if (mode === "template") {
    const t0 = await p.begin("generating", "Write the deterministic starter template");
    files = templateFiles(input);
    notes = "Deterministic HackPilot starter: idea header, seeded plan checklist with progress logic and a smoke test.";
    await p.end(t0, "ok", `${files.length} files`);
  }
  if (!files.some((f) => f.path === "tsconfig.json")) files.push({ path: "tsconfig.json", content: DEFAULT_TSCONFIG });
  if (!files.some((f) => f.path === "vite.config.ts")) files.push({ path: "vite.config.ts", content: VITE_CONFIG });
  if (!files.some((f) => f.path === "package.json")) files.push({ path: "package.json", content: "{}" });
  if (!files.some((f) => f.path === "smoke.test.ts")) {
    files.push({ path: "smoke.test.ts", content: `import "./src/logic";\nconsole.log("SMOKE OK");\n` });
  }
  await writeFiles(dir, files, input.title);
  await getDb().update(schema.builds).set({ mode, notes, files: await listFiles(dir) }).where(eq(schema.builds.id, buildId));

  // 2. Install
  if (!(await install(dir, p))) {
    await p.finish("failed", { error: "npm install failed. See the install step output." });
    return;
  }

  // 3. Check + repair loop
  for (let round = 0; ; round++) {
    const fixes = await autofix(dir);
    if (fixes.length) await p.info("repairing", "Auto-fixed common slips", fixes.join(" · "));
    let failing: { label: string; output: string } | null = null;
    for (const c of CHECKS) {
      const t0 = await p.begin(c.stage, round ? `${c.label} · after repair ${round}` : c.label);
      const r = await run(c.cmd, c.args, dir, c.timeoutMs);
      const passed = r.ok && (c.stage !== "testing" || /SMOKE OK/.test(r.output));
      await p.end(t0, passed ? "ok" : "fail", passed ? tail(r.output.trim(), 300) || undefined : tail(r.output.trim(), 2500) || (r.timedOut ? "timed out" : `exit ${r.code}`));
      if (!passed) {
        failing = { label: c.label, output: r.output.trim() || (r.timedOut ? "timed out" : `exit code ${r.code}`) };
        break;
      }
    }
    if (!failing) break;
    if (round >= MAX_REPAIR_ROUNDS || mode === "template" || !hasLlm) {
      await p.finish("failed", {
        files: await listFiles(dir),
        error: `${failing.label} still fails after ${round} repair round${round === 1 ? "" : "s"}.`,
      });
      return;
    }
    p.rounds = round + 1;
    const t0 = await p.begin("repairing", `Repair round ${round + 1} of ${MAX_REPAIR_ROUNDS}`, `Sending the ${failing.label} errors back to the model…`);
    try {
      const fix = await repair(dir, failing, round + 1, p);
      if (!fix.files.length) throw new Error("the model returned no file changes");
      const { written, pkgChanged } = await writeFiles(dir, fix.files, input.title);
      await p.end(t0, "ok", `${fix.model}: changed ${written.join(", ")}${fix.notes ? ` — ${fix.notes}` : ""}`);
      if (pkgChanged && !(await install(dir, p, "Reinstall changed dependencies"))) {
        await p.finish("failed", { files: await listFiles(dir), error: "npm install failed after a repair." });
        return;
      }
    } catch (error) {
      await p.end(t0, "fail", error instanceof Error ? error.message.slice(0, 600) : "repair failed");
      await p.finish("failed", { files: await listFiles(dir), error: "The repair call failed." });
      return;
    }
  }

  // 4. Package + mark progress
  const t0 = await p.begin("packaging", "Package the source as a zip and update the plan");
  const zipPath = path.join(root, "starter.zip");
  await fs.rm(zipPath, { force: true });
  const z = await run("zip", ["-qr", zipPath, ".", "-x", "node_modules/*", "dist/*", "package-lock.json"], dir, 60_000);
  if (z.ok) p.meta.zipBytes = (await fs.stat(zipPath)).size;
  const marked = await markProgress(hackathon.id, buildId);
  p.meta.tasksCompleted = marked.tasks;
  p.meta.checklistUpdated = marked.items;
  await p.end(
    t0,
    z.ok ? "ok" : "fail",
    [
      z.ok ? `starter.zip (${Math.round((p.meta.zipBytes ?? 0) / 1024)} KB)` : `zip failed: ${tail(z.output, 300)}`,
      marked.tasks.length ? `checked off ${marked.tasks.length} plan task${marked.tasks.length === 1 ? "" : "s"}` : "",
      marked.items.length ? `moved ${marked.items.length} checklist item${marked.items.length === 1 ? "" : "s"} to in progress` : "",
    ]
      .filter(Boolean)
      .join(" · "),
  );
  await p.finish("passed", { files: await listFiles(dir), error: null });
}

/** Start a build in the background; resolves immediately. */
export function startBuild(buildId: string) {
  const job = pipeline(buildId)
    .catch(async (error) => {
      console.error(`[build ${buildId}] crashed`, error);
      await getDb()
        .update(schema.builds)
        .set({
          status: "failed",
          stage: "failed",
          error: error instanceof Error ? error.message.slice(0, 500) : "build crashed",
          finishedAt: nowIso(),
          updatedAt: nowIso(),
        })
        .where(eq(schema.builds.id, buildId))
        .catch(() => undefined);
    })
    .finally(() => running.delete(buildId));
  running.set(buildId, job);
}

/** A row still "running" that this process is not running was interrupted (restart). */
export async function reapInterrupted(hackathonId: string) {
  const db = getDb();
  const rows = await db
    .select({ id: schema.builds.id })
    .from(schema.builds)
    .where(and(eq(schema.builds.hackathonId, hackathonId), eq(schema.builds.status, "running")))
    .orderBy(desc(schema.builds.createdAt))
    .limit(20);
  const stale = rows.filter((r) => !running.has(r.id)).map((r) => r.id);
  if (stale.length) {
    await db
      .update(schema.builds)
      .set({ status: "failed", stage: "failed", error: "Interrupted (the server restarted). Start a new build.", finishedAt: nowIso() })
      .where(inArray(schema.builds.id, stale));
  }
  return rows.find((r) => running.has(r.id))?.id ?? null;
}

export function zipPathFor(dir: string | null) {
  return dir ? path.join(dir, "starter.zip") : null;
}

export async function readBuildFile(dir: string | null, rel: string) {
  const clean = safeRelPath(rel);
  if (!dir || !clean) return null;
  const abs = path.join(dir, "app", clean);
  try {
    const content = await fs.readFile(abs, "utf8");
    return clip(content, 40_000);
  } catch {
    return null;
  }
}
