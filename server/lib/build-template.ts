/**
 * Deterministic starter app used when no model is configured, every provider
 * fails, or the caller asks for mode "template". It always passes the same
 * install -> typecheck -> build -> smoke test pipeline, so a live demo never
 * ends empty-handed.
 */
export interface StarterInput {
  title: string;
  pitch: string;
  tags: string[];
  hackathon: string;
  tasks: string[];
}

export type GenFile = { path: string; content: string };

export const PINNED_DEPS: Record<string, string> = {
  react: "^18.3.1",
  "react-dom": "^18.3.1",
};
export const PINNED_DEV_DEPS: Record<string, string> = {
  "@types/node": "^22.10.0",
  "@types/react": "^18.3.12",
  "@types/react-dom": "^18.3.1",
  "@vitejs/plugin-react": "^4.3.4",
  tsx: "^4.19.2",
  typescript: "~5.6.3",
  vite: "^5.4.11",
};

export const DEFAULT_TSCONFIG = JSON.stringify(
  {
    compilerOptions: {
      target: "ES2020",
      useDefineForClassFields: true,
      lib: ["ES2020", "DOM", "DOM.Iterable"],
      module: "ESNext",
      skipLibCheck: true,
      moduleResolution: "bundler",
      resolveJsonModule: true,
      isolatedModules: true,
      noEmit: true,
      jsx: "react-jsx",
      strict: true,
      noFallthroughCasesInSwitch: true,
      types: ["node"],
    },
    include: ["src", "smoke.test.ts"],
  },
  null,
  2,
);

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "starter-app";

export function packageJson(name: string, extraDeps: Record<string, string> = {}, extraDev: Record<string, string> = {}) {
  return JSON.stringify(
    {
      name: slug(name),
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
      dependencies: { ...extraDeps, ...PINNED_DEPS },
      devDependencies: { ...extraDev, ...PINNED_DEV_DEPS },
    },
    null,
    2,
  );
}

export function templateFiles(input: StarterInput): GenFile[] {
  const json = (v: unknown) => JSON.stringify(v, null, 2);
  const tasks = (input.tasks.length ? input.tasks : ["Scaffold the app", "Build the core workflow", "Record the demo"]).slice(0, 12);
  return [
    { path: "package.json", content: packageJson(input.title) },
    { path: "tsconfig.json", content: DEFAULT_TSCONFIG },
    {
      path: "vite.config.ts",
      content: `import { defineConfig } from "vite";\nimport react from "@vitejs/plugin-react";\n\nexport default defineConfig({ plugins: [react()] });\n`,
    },
    {
      path: "index.html",
      content: `<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n    <title>${input.title.replace(/[<>&]/g, "")}</title>\n  </head>\n  <body>\n    <div id="root"></div>\n    <script type="module" src="/src/main.tsx"></script>\n  </body>\n</html>\n`,
    },
    {
      path: "src/main.tsx",
      content: `import { StrictMode } from "react";\nimport { createRoot } from "react-dom/client";\nimport App from "./App";\nimport "./styles.css";\n\nconst root = document.getElementById("root");\nif (!root) throw new Error("missing #root");\ncreateRoot(root).render(\n  <StrictMode>\n    <App />\n  </StrictMode>,\n);\n`,
    },
    {
      path: "src/logic.ts",
      content: `export interface Task {
  id: string;
  title: string;
  done: boolean;
}

export const IDEA = ${json({ title: input.title, pitch: input.pitch, tags: input.tags, hackathon: input.hackathon })} as const;

export const SEED_TASKS: Task[] = ${json(tasks.map((t, i) => ({ id: `t${i + 1}`, title: t, done: false })))};

export function toggle(tasks: Task[], id: string): Task[] {
  return tasks.map((t) => (t.id === id ? { ...t, done: !t.done } : t));
}

export function addTask(tasks: Task[], title: string): Task[] {
  const clean = title.trim();
  if (!clean) return tasks;
  return [...tasks, { id: \`t\${tasks.length + 1}-\${clean.length}\`, title: clean, done: false }];
}

export function progress(tasks: Task[]): number {
  if (tasks.length === 0) return 0;
  return Math.round((tasks.filter((t) => t.done).length / tasks.length) * 100);
}

export function nextTask(tasks: Task[]): Task | null {
  return tasks.find((t) => !t.done) ?? null;
}
`,
    },
    {
      path: "src/App.tsx",
      content: `import { useState } from "react";
import { IDEA, SEED_TASKS, addTask, nextTask, progress, toggle, type Task } from "./logic";

export default function App() {
  const [tasks, setTasks] = useState<Task[]>(SEED_TASKS);
  const [draft, setDraft] = useState("");
  const pct = progress(tasks);
  const next = nextTask(tasks);
  return (
    <main className="wrap">
      <header>
        <p className="eyebrow">{IDEA.hackathon}</p>
        <h1>{IDEA.title}</h1>
        <p className="pitch">{IDEA.pitch}</p>
        <div className="tags">{IDEA.tags.map((t) => <span key={t}>{t}</span>)}</div>
      </header>
      <section className="card">
        <div className="bar" aria-label={\`\${pct}% done\`}><div style={{ width: \`\${pct}%\` }} /></div>
        <p className="next">{next ? <>Next: <strong>{next.title}</strong></> : "Everything is done. Ship it!"}</p>
        <ul>
          {tasks.map((t) => (
            <li key={t.id}>
              <label>
                <input type="checkbox" checked={t.done} onChange={() => setTasks((ts) => toggle(ts, t.id))} />
                <span className={t.done ? "done" : ""}>{t.title}</span>
              </label>
            </li>
          ))}
        </ul>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setTasks((ts) => addTask(ts, draft));
            setDraft("");
          }}
        >
          <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Add a task" aria-label="New task" />
          <button type="submit">Add</button>
        </form>
      </section>
    </main>
  );
}
`,
    },
    {
      path: "src/styles.css",
      content: `:root { font-family: system-ui, sans-serif; color: #111; background: #f6f6f4; }
* { box-sizing: border-box; }
body { margin: 0; }
.wrap { max-width: 720px; margin: 0 auto; padding: 48px 20px; }
.eyebrow { text-transform: uppercase; letter-spacing: .08em; font-size: 12px; color: #c2410c; margin: 0; }
h1 { font-size: 40px; margin: 8px 0; }
.pitch { color: #444; line-height: 1.5; }
.tags { display: flex; gap: 6px; flex-wrap: wrap; }
.tags span { background: #fff; border: 1px solid #ddd; border-radius: 999px; padding: 2px 10px; font-size: 12px; }
.card { background: #fff; border: 1px solid #e5e5e5; border-radius: 16px; padding: 20px; margin-top: 24px; }
.bar { height: 8px; background: #eee; border-radius: 999px; overflow: hidden; }
.bar div { height: 100%; background: #f97316; transition: width .2s; }
ul { list-style: none; padding: 0; }
li { padding: 6px 0; border-bottom: 1px solid #f0f0f0; }
.done { text-decoration: line-through; color: #888; }
form { display: flex; gap: 8px; }
form input { flex: 1; padding: 8px 10px; border: 1px solid #ddd; border-radius: 8px; }
button { padding: 8px 14px; border: 0; border-radius: 8px; background: #111; color: #fff; cursor: pointer; }
`,
    },
    {
      path: "smoke.test.ts",
      content: `import assert from "node:assert/strict";
import { SEED_TASKS, addTask, nextTask, progress, toggle } from "./src/logic";

assert.equal(progress([]), 0);
assert.equal(progress(SEED_TASKS), 0);
const first = SEED_TASKS[0];
assert.ok(first, "seed has tasks");
const toggled = toggle(SEED_TASKS, first.id);
assert.equal(toggled[0]?.done, true);
assert.ok(progress(toggled) > 0);
assert.notEqual(nextTask(toggled)?.id, first.id);
assert.equal(addTask(SEED_TASKS, "  ").length, SEED_TASKS.length);
assert.equal(addTask(SEED_TASKS, "Ship").length, SEED_TASKS.length + 1);
console.log("SMOKE OK");
`,
    },
    {
      path: "README.md",
      content: `# ${input.title}\n\n${input.pitch}\n\nStarter generated by HackPilot "Build it" (deterministic template) for ${input.hackathon}.\n\n\`\`\`bash\nnpm install\nnpm run dev      # local dev server\nnpm run build    # typecheck + production build\nnpm test         # smoke test for src/logic.ts\n\`\`\`\n`,
    },
  ];
}
