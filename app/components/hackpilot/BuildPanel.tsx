import {
  actionErrorMessage,
  useActionMutation,
  useActionQuery,
} from "@agent-native/core/client/hooks";
import {
  IconAlertTriangle,
  IconCheck,
  IconChevronDown,
  IconCircleDashed,
  IconDownload,
  IconExternalLink,
  IconEye,
  IconFile,
  IconHammer,
  IconInfoCircle,
  IconLoader2,
  IconRobot,
  IconUpload,
  IconX,
} from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState, type ChangeEvent } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { buildDownloadUrl, MAX_FUSION_ARCHIVE_BYTES, type BuildOut, type BuildStep } from "@shared/build";
import type { WorkspaceOut } from "@shared/outputs";

import { askPilot } from "./ask-pilot";
import { workspaceKey } from "./workspace-cache";

const STAGE_LABEL: Record<string, string> = {
  queued: "Queued",
  generating: "Generating code",
  importing: "Importing ZIP",
  installing: "Installing",
  typechecking: "Typechecking",
  building: "Building",
  testing: "Smoke testing",
  repairing: "Repairing",
  packaging: "Packaging",
  done: "Passed",
  failed: "Failed",
};
const CHECK_STAGES = ["installing", "typechecking", "building", "testing", "packaging"] as const;

const secs = (ms?: number) => (ms == null ? "" : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`);

function readZipArchive(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const data = typeof reader.result === "string" ? reader.result : "";
      const start = data.indexOf(",");
      if (start < 0) reject(new Error("Could not read the ZIP."));
      else resolve(data.slice(start + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.onabort = () => reject(new Error("ZIP reading was interrupted."));
    reader.readAsDataURL(file);
  });
}

function StepIcon({ status }: { status: BuildStep["status"] }) {
  if (status === "running") return <IconLoader2 className="size-4 text-signal motion-safe:animate-spin" />;
  if (status === "ok") return <IconCheck className="size-4 text-emerald-600" />;
  if (status === "fail") return <IconX className="size-4 text-rose-600" />;
  return <IconInfoCircle className="size-4 text-muted-foreground" />;
}

/** Ticks locally between polls; the server's durationMs re-anchors it on every poll. */
function Elapsed({ baseMs, running }: { baseMs: number; running: boolean }) {
  const [anchor, setAnchor] = useState(() => ({ base: baseMs, at: Date.now() }));
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => setAnchor({ base: baseMs, at: Date.now() }), [baseMs]);
  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [running]);
  return <span className="hp-tabular">{Math.max(0, Math.round((anchor.base + Math.max(0, now - anchor.at)) / 1000))}s</span>;
}

function Pipeline({ build }: { build: BuildOut }) {
  const stages = [build.mode === "fusion" ? "importing" : "generating", ...CHECK_STAGES];
  const reached = new Set(build.steps.map((s) => s.stage));
  const failedStage = build.status === "failed" ? [...build.steps].reverse().find((s) => s.status === "fail")?.stage : undefined;
  return (
    <ol className="flex flex-wrap items-center gap-1.5 text-xs" aria-label="Build pipeline">
      {stages.map((stage, i) => {
        const active = build.status === "running" && (build.stage === stage || (i === 0 && build.stage === "queued"));
        const repairing = build.status === "running" && build.stage === "repairing" && stage === "testing";
        const done = build.status === "passed" || (reached.has(stage) && !active && failedStage !== stage);
        const failed = failedStage === stage;
        return (
          <li key={stage} className="flex items-center gap-1.5">
            {i ? <span className="h-px w-3 bg-border" aria-hidden /> : null}
            <span
              className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 ${
                failed
                  ? "border-rose-300 bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300"
                  : active || repairing
                    ? "border-signal/60 bg-signal-soft text-foreground"
                    : done
                      ? "border-emerald-300/70 bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300"
                      : "border-border text-muted-foreground"
              }`}
            >
              {active || repairing ? (
                <IconLoader2 className="size-3 motion-safe:animate-spin" />
              ) : done ? (
                <IconCheck className="size-3" />
              ) : failed ? (
                <IconX className="size-3" />
              ) : (
                <IconCircleDashed className="size-3" />
              )}
              {STAGE_LABEL[stage]}
            </span>
          </li>
        );
      })}
      {build.rounds ? (
        <li className="ml-1 rounded-full bg-amber-100 px-2 py-0.5 text-amber-900 dark:bg-amber-950/50 dark:text-amber-200">
          {build.rounds} repair round{build.rounds === 1 ? "" : "s"}
        </li>
      ) : null}
    </ol>
  );
}

export function BuildPanel({ ws, hasDesignPrototype }: { ws: WorkspaceOut; hasDesignPrototype: boolean }) {
  const h = ws.hackathon;
  const selected = ws.ideas.find((i) => i.selected) ?? null;
  const designCheckboxId = useId();
  const [ideasWithoutDesign, setIdeasWithoutDesign] = useState<ReadonlySet<string>>(() => new Set());
  const useDesign = !selected || !ideasWithoutDesign.has(selected.id);
  const queryClient = useQueryClient();
  const [showLog, setShowLog] = useState(false);
  const [showFiles, setShowFiles] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [previewNonce, setPreviewNonce] = useState(0);
  const [readingArchive, setReadingArchive] = useState(false);
  const archiveInput = useRef<HTMLInputElement>(null);

  const { data } = useActionQuery(
    "get-build",
    { hackathonId: h.id },
    { refetchInterval: (q) => ((q.state.data as { build: BuildOut | null } | undefined)?.build?.status === "running" ? 1500 : false) },
  );
  const build = data?.build ?? null;
  const running = build?.status === "running";
  const designBuild = build?.meta.source === "design";
  const fusion = build?.mode === "fusion";
  const passedBuildId = build?.status === "passed" && build.downloadUrl ? build.id : undefined;
  const fusionSourceId = passedBuildId ?? (fusion ? build.meta.sourceBuildId : undefined);
  const originalZip = fusionSourceId ? buildDownloadUrl(fusionSourceId) : null;
  const downloadUrl = build?.downloadUrl ?? originalZip;

  // Regular builds can update the plan and checklist.
  const lastStatus = useRef(build?.status);
  useEffect(() => {
    if (lastStatus.current === "running" && build && build.status !== "running") {
      if (build.meta.source !== "design" && build.mode !== "fusion") {
        void queryClient.invalidateQueries({ queryKey: workspaceKey(h.id) });
      }
      if (build.status === "passed") {
        toast.success(build.mode === "fusion" ? "The Fusion ZIP passed verification." : `“${build.ideaTitle}” builds and passes its smoke test.`);
      } else {
        toast.error(build.mode === "fusion" ? "Fusion verification failed. Open the log to see why." : "The build didn't pass. Open the log to see why.");
      }
    }
    lastStatus.current = build?.status;
  }, [build, h.id, queryClient]);

  function showRun(nextBuild: BuildOut) {
    queryClient.setQueryData(["action", "get-build", { hackathonId: h.id }], { build: nextBuild, file: null });
    setShowLog(true);
  }

  const start = useActionMutation("build-project", {
    onSuccess: showRun,
    onError: (e) => toast.error(actionErrorMessage(e) ?? "Could not start the build."),
  });
  const verify = useActionMutation("verify-fusion-build", {
    onSuccess: (nextBuild) => {
      setShowPreview(false);
      showRun(nextBuild);
    },
    onError: (e) => toast.error(actionErrorMessage(e) ?? "Could not start Fusion verification."),
  });
  const importing = readingArchive || verify.isPending;

  async function importArchive(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file || !fusionSourceId || running || start.isPending || importing) return;
    if (!file.name.toLowerCase().endsWith(".zip") || file.size === 0) {
      toast.error("Choose a nonempty ZIP downloaded from Fusion.");
      return;
    }
    if (file.size > MAX_FUSION_ARCHIVE_BYTES) {
      toast.error(`Choose a ZIP of ${MAX_FUSION_ARCHIVE_BYTES / (1024 * 1024)} MiB or less.`);
      return;
    }
    setReadingArchive(true);
    try {
      const archive = await readZipArchive(file);
      verify.mutate({ buildId: fusionSourceId, archive });
    } catch {
      toast.error("Could not read the ZIP. Choose the file again.");
    } finally {
      setReadingArchive(false);
    }
  }

  const lastStep = build?.steps[build.steps.length - 1];
  const retryInstructions = designBuild
    ? 'If the same idea still has its linked Design prototype and the issue can be retried, retry with mode "llm" and design "auto" using that idea ID. If Design cannot be used, explain how to reconnect or choose a regular build. Keep the retry Design-based.'
    : 'Start a new build-project run for the same idea with design "off" (use mode "template" if the model keeps failing).';

  return (
    <section aria-label="Build it" className="rounded-xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-signal-soft text-signal">
          <IconHammer className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">Build it</h2>
          <p className="text-xs text-muted-foreground">
            {selected
              ? <>Turn <span className="font-medium text-foreground">{selected.title}</span> and this plan into a running Vite + React + TypeScript starter: generated, installed, typechecked, built, and smoke-tested, with up to 3 repair rounds.</>
              : "Pick an idea on the Ideas tab first, then build a running starter app from it."}
          </p>
          {selected && hasDesignPrototype ? (
            <div className="mt-3 space-y-1">
              <div className="flex items-center gap-2">
                <Checkbox
                  id={designCheckboxId}
                  checked={useDesign}
                  disabled={running || start.isPending || importing}
                  aria-describedby={`${designCheckboxId}-privacy`}
                  onCheckedChange={(checked) => {
                    setIdeasWithoutDesign((previous) => {
                      const next = new Set(previous);
                      if (checked === true) next.delete(selected.id);
                      else next.add(selected.id);
                      return next;
                    });
                  }}
                />
                <label htmlFor={designCheckboxId} className="text-sm font-medium">
                  Use Design prototype
                </label>
              </div>
              <p id={`${designCheckboxId}-privacy`} className="pl-6 text-xs text-muted-foreground">
                Only you can open a build that uses Design.
              </p>
            </div>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            disabled={!selected || running || start.isPending || importing}
            onClick={() => {
              if (selected) {
                start.mutate({
                  hackathonId: h.id,
                  ideaId: selected.id,
                  mode: "llm",
                  design: useDesign ? "auto" : "off",
                });
              }
            }}
          >
            {running || start.isPending ? <IconLoader2 className="size-4 motion-safe:animate-spin" /> : <IconHammer className="size-4" />}
            {running ? (fusion ? "Verifying…" : "Building…") : build ? "Build again" : "Build it"}
          </Button>
          {build?.previewUrl ? (
            <Button
              variant={showPreview ? "secondary" : "outline"}
              aria-pressed={showPreview}
              onClick={() => {
                setShowPreview((v) => !v);
                setPreviewNonce((n) => n + 1);
              }}
            >
              <IconEye className="size-4" /> {showPreview ? "Hide preview" : "Preview"}
            </Button>
          ) : null}
          {downloadUrl ? (
            <Button variant="outline" asChild>
              <a href={downloadUrl} download>
                <IconDownload className="size-4" /> {build?.downloadUrl ? "Download zip" : "Download starter ZIP"}
              </a>
            </Button>
          ) : null}
          {build?.status === "failed" && !fusion ? (
            <Button
              variant="ghost"
              onClick={() =>
                askPilot(
                  `The last Build it run for this hackathon failed (build ${build.id}). Read it with get-build and explain the failure in two sentences. ${retryInstructions} Report the result.`,
                  { id: h.id, name: h.name, tab: "plan" },
                )
              }
            >
              <IconRobot className="size-4" /> Ask Pilot to fix
            </Button>
          ) : null}
        </div>
      </div>

      {originalZip ? (
        <div className="mt-4 space-y-2 border-t border-border pt-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" asChild>
              <a href="https://builder.io/app/projects" target="_blank" rel="noopener noreferrer">
                <IconExternalLink className="size-4" /> Open in Fusion
              </a>
            </Button>
            <Button
              size="sm"
              variant="outline"
              aria-busy={importing}
              disabled={running || start.isPending || importing}
              onClick={() => archiveInput.current?.click()}
            >
              {importing ? <IconLoader2 className="size-4 motion-safe:animate-spin" /> : <IconUpload className="size-4" />}
              {importing ? "Importing ZIP…" : "Import & verify"}
            </Button>
            <input ref={archiveInput} type="file" aria-label="Fusion ZIP" accept=".zip,application/zip" hidden onChange={importArchive} />
          </div>
          {designBuild ? (
            <p className="text-xs text-muted-foreground">
              Use a private GitHub repository connected to Fusion. Only you can access the verified ZIP in HackPilot.
            </p>
          ) : null}
          <details className="text-xs text-muted-foreground">
            <summary className="w-fit cursor-pointer hover:text-foreground">How to edit this starter in Fusion</summary>
            <p className="mt-1.5 max-w-prose leading-relaxed">
              <a className="underline underline-offset-2" href={originalZip} download>Download the original starter ZIP</a>, unzip it, and add the files to a GitHub repository connected to Fusion. Edit the project in Fusion, then use <span className="font-medium">Download Code</span> and import that ZIP here to rerun the checks.
            </p>
          </details>
        </div>
      ) : null}

      {build ? (
        <div className="mt-4 space-y-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <Pipeline build={build} />
            <span className="ml-auto text-xs text-muted-foreground">
              {designBuild ? "Private Design build · " : null}
              {running ? (
                <>
                  {STAGE_LABEL[build.stage] ?? build.stage} · <Elapsed baseMs={build.meta.durationMs ?? 0} running />
                </>
              ) : (
                <>
                  {build.status === "passed" ? "Passed" : "Failed"} in {secs(build.meta.durationMs)}
                  {fusion ? " · Fusion verification" : build.meta.model ? <> · {build.meta.model.split("/").pop()}</> : build.mode === "template" ? " · template" : null}
                  {build.meta.cost ? <> · ${build.meta.cost.toFixed(4)}</> : null}
                </>
              )}
            </span>
          </div>

          {running && lastStep ? (
            <p className="flex items-center gap-2 text-sm" aria-live="polite">
              <StepIcon status={lastStep.status} />
              <span className="font-medium">{lastStep.label}</span>
              {lastStep.detail ? <span className="truncate text-muted-foreground">{lastStep.detail}</span> : null}
            </p>
          ) : null}

          {build.status === "passed" ? (
            <div className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200">
              <p className="font-medium">
                {build.files.length} files · typecheck, build, and smoke test pass
                {build.rounds ? ` after ${build.rounds} repair round${build.rounds === 1 ? "" : "s"}` : " on the first try"}.
              </p>
              {build.meta.tasksCompleted?.length ? (
                <p className="mt-1 text-xs">Checked off: {build.meta.tasksCompleted.join(" · ")}</p>
              ) : null}
              {build.notes ? <p className="mt-1 text-xs opacity-80">{build.notes}</p> : null}
            </div>
          ) : null}
          {showPreview && build.previewUrl ? (
            <div className="overflow-hidden rounded-lg border border-border bg-background">
              <div className="flex items-center gap-2 border-b border-border bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground">
                <span className="flex gap-1" aria-hidden>
                  <span className="size-2.5 rounded-full bg-rose-400/70" />
                  <span className="size-2.5 rounded-full bg-amber-400/70" />
                  <span className="size-2.5 rounded-full bg-emerald-400/70" />
                </span>
                <span className="truncate font-medium text-foreground">{build.ideaTitle}</span>
                <span className="truncate">· the generated app, running from its production build</span>
                <a
                  href={build.previewUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="ml-auto inline-flex shrink-0 items-center gap-1 hover:text-foreground"
                >
                  Open in new tab <IconExternalLink className="size-3.5" />
                </a>
              </div>
              <iframe
                key={`${build.id}-${previewNonce}`}
                src={build.previewUrl}
                title={`Preview of ${build.ideaTitle}`}
                sandbox={designBuild ? "allow-scripts" : "allow-scripts allow-forms allow-same-origin allow-popups"}
                className="block h-[34rem] w-full bg-white"
              />
            </div>
          ) : null}
          {build.status === "failed" ? (
            <div className="flex items-start gap-2 rounded-lg bg-rose-50 p-3 text-sm text-rose-900 dark:bg-rose-950/40 dark:text-rose-200">
              <IconAlertTriangle className="mt-0.5 size-4 shrink-0" />
              <div>
                <p>{build.error ?? "The build failed."}</p>
                {designBuild && !fusion && hasDesignPrototype && build.ideaId === selected?.id ? (
                  <p className="mt-1 text-xs">Retry with Build again, or clear Use Design prototype to start a regular build.</p>
                ) : null}
              </div>
            </div>
          ) : null}

          <div className="flex flex-wrap gap-4 text-xs">
            <button type="button" className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground" onClick={() => setShowLog((v) => !v)} aria-expanded={showLog}>
              <IconChevronDown className={`size-3.5 transition-transform ${showLog ? "" : "-rotate-90"}`} /> Build log ({build.steps.length} steps)
            </button>
            {build.files.length ? (
              <button type="button" className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground" onClick={() => setShowFiles((v) => !v)} aria-expanded={showFiles}>
                <IconChevronDown className={`size-3.5 transition-transform ${showFiles ? "" : "-rotate-90"}`} /> Files ({build.files.length})
              </button>
            ) : null}
          </div>

          {showLog ? (
            <ol className="space-y-1.5 rounded-lg border border-border bg-background p-3">
              {build.steps.map((s, i) => (
                <li key={`${s.at}-${i}`} className="flex items-start gap-2 text-sm">
                  <span className="mt-0.5"><StepIcon status={s.status} /></span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2">
                      <span className={s.status === "fail" ? "text-rose-700 dark:text-rose-300" : ""}>{s.label}</span>
                      {s.ms != null ? <span className="hp-tabular text-xs text-muted-foreground">{secs(s.ms)}</span> : null}
                    </span>
                    {s.detail ? (
                      <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/60 p-2 font-mono text-[11px] leading-snug text-muted-foreground">{s.detail}</pre>
                    ) : null}
                  </span>
                </li>
              ))}
            </ol>
          ) : null}

          {showFiles ? (
            <ul className="grid gap-1 rounded-lg border border-border bg-background p-3 sm:grid-cols-2">
              {build.files.map((f) => (
                <li key={f.path} className="flex items-center gap-2 font-mono text-xs">
                  <IconFile className="size-3.5 text-muted-foreground" />
                  <span className="truncate">{f.path}</span>
                  <span className="ml-auto hp-tabular text-muted-foreground">{f.bytes < 1024 ? `${f.bytes} B` : `${(f.bytes / 1024).toFixed(1)} KB`}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
