import {
  actionErrorMessage,
  useActionMutation,
  useActionQuery,
} from "@agent-native/core/client/hooks";
import {
  IconArrowRight,
  IconBolt,
  IconClipboardText,
  IconClockHour4,
  IconLink,
  IconRocket,
  IconSparkles,
  IconTrophy,
} from "@tabler/icons-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import type { HackathonSummaryOut } from "@shared/outputs";
import { formatInZone } from "@shared/time";

import { askPilot } from "./ask-pilot";

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "errorCode" in error
    ? String((error as { errorCode?: unknown }).errorCode)
    : undefined;
}

function errorDetails(error: unknown): Record<string, unknown> | undefined {
  return error && typeof error === "object" && "details" in error
    ? ((error as { details?: Record<string, unknown> }).details ?? undefined)
    : undefined;
}

export function ImportForm({ compact = false }: { compact?: boolean }) {
  const navigate = useNavigate();
  const [url, setUrl] = useState("");
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pageText, setPageText] = useState("");
  const importHackathon = useActionMutation("import-hackathon", {
    onSuccess: (result) => {
      toast.success(result.message);
      for (const w of result.warnings) toast.warning(w);
      navigate(`/hackathons/${result.id}`);
    },
    onError: (error) => {
      const code = errorCode(error);
      if (code === "already_imported") {
        const id = errorDetails(error)?.id;
        toast.message(actionErrorMessage(error) ?? "Already imported.", {
          action: id
            ? { label: "Open", onClick: () => navigate(`/hackathons/${String(id)}`) }
            : undefined,
        });
        return;
      }
      if (code === "fetch_failed") setPasteOpen(true);
      toast.error(actionErrorMessage(error) ?? "Import failed.");
    },
  });

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!url.trim()) return;
    toast.loading("Reading the hackathon page…", { id: "import", duration: 2500 });
    importHackathon.mutate({
      url: url.trim(),
      ...(pasteOpen && pageText.trim() ? { pageText } : {}),
    });
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row">
        <div className="relative flex-1">
          <IconLink className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Label htmlFor="hackathon-url" className="sr-only">
            Hackathon URL
          </Label>
          <Input
            id="hackathon-url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="Paste a hackathon URL — devpost, lu.ma, a sponsor page…"
            className={compact ? "h-10 pl-9" : "h-12 pl-9 text-base"}
            autoComplete="off"
            inputMode="url"
          />
        </div>
        <Button
          type="submit"
          size={compact ? "default" : "lg"}
          disabled={!url.trim() || importHackathon.isPending}
          className={compact ? "h-10" : "h-12 px-5"}
        >
          <IconRocket className="size-4" />
          {importHackathon.isPending ? "Importing…" : "Build my workspace"}
        </Button>
      </div>
      {pasteOpen ? (
        <div className="space-y-1.5">
          <Label htmlFor="page-text" className="text-xs text-muted-foreground">
            The site blocked our fetch. Paste the page text (rules, prizes, judging, deadline):
          </Label>
          <Textarea
            id="page-text"
            value={pageText}
            onChange={(e) => setPageText(e.target.value)}
            rows={5}
            placeholder="Copy everything from the hackathon page and paste it here"
          />
        </div>
      ) : (
        <button
          type="button"
          className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          onClick={() => setPasteOpen(true)}
        >
          Page needs a login? Paste its text instead
        </button>
      )}
    </form>
  );
}

function HackathonRow({ h }: { h: HackathonSummaryOut }) {
  const passed = h.countdown === "passed";
  const progress = h.tasksTotal ? Math.round((h.tasksDone / h.tasksTotal) * 100) : 0;
  return (
    <Link
      to={`/hackathons/${h.id}`}
      className="group grid gap-3 rounded-xl border border-border bg-card p-4 transition-colors hover:border-foreground/20 hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:grid-cols-[1fr_auto] sm:items-center"
    >
      <div className="min-w-0 space-y-1.5">
        <div className="flex items-center gap-2">
          <h3 className="truncate text-base font-semibold tracking-tight">{h.name}</h3>
          {h.prizePool ? (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-signal-soft px-2 py-0.5 text-xs font-medium text-signal">
              <IconTrophy className="size-3" />
              {h.prizePool}
            </span>
          ) : null}
        </div>
        {h.tagline ? (
          <p className="line-clamp-1 text-sm text-muted-foreground">{h.tagline}</p>
        ) : null}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <IconSparkles className="size-3.5" />
            {h.ideaCount} idea{h.ideaCount === 1 ? "" : "s"}
            {h.topIdea ? <span className="text-foreground"> · {h.topIdea}</span> : null}
          </span>
          <span className="inline-flex items-center gap-1 hp-tabular">
            <IconBolt className="size-3.5" />
            {h.tasksDone}/{h.tasksTotal} tasks
          </span>
          <span className="inline-flex items-center gap-1 hp-tabular">
            <IconClipboardText className="size-3.5" />
            {h.submissionDone}/{h.submissionTotal} checklist
          </span>
        </div>
        {h.tasksTotal ? (
          <div className="h-1 w-full max-w-xs overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-signal transition-all" style={{ width: `${progress}%` }} />
          </div>
        ) : null}
      </div>
      <div className="flex items-center gap-3 sm:flex-col sm:items-end sm:gap-1">
        {h.deadlineAt ? (
          <>
            <span
              className={`inline-flex items-center gap-1 text-lg font-semibold tracking-tight hp-tabular ${passed ? "text-muted-foreground" : "text-signal"}`}
            >
              <IconClockHour4 className="size-4" />
              {passed ? "Closed" : h.countdown}
            </span>
            <span className="text-xs text-muted-foreground">
              {formatInZone(h.deadlineAt, h.timezone, {
                month: "short",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
                timeZoneName: "short",
              })}
            </span>
          </>
        ) : (
          <span className="text-xs text-muted-foreground">Deadline unknown</span>
        )}
        <IconArrowRight className="hidden size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 sm:block" />
      </div>
    </Link>
  );
}

export function HackathonList() {
  const navigate = useNavigate();
  const { data, isPending } = useActionQuery("list-hackathons", {});
  const seed = useActionMutation("seed-demo", {
    onSuccess: (result) => {
      toast.success(result.message);
      navigate(`/hackathons/${result.id}`);
    },
    onError: (error) => toast.error(actionErrorMessage(error) ?? "Could not create the demo."),
  });
  const hackathons = data?.hackathons ?? [];

  return (
    <div className="mx-auto w-full max-w-4xl space-y-8 px-4 py-8 sm:px-6 sm:py-12">
      <section className="space-y-5">
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            Paste a hackathon. Get a plan to win it.
          </h1>
          <p className="max-w-2xl text-sm text-muted-foreground sm:text-base">
            HackPilot reads the page, pulls out the deadline, prizes, and judging rubric, then gives you
            a rubric-scored idea board, a day-by-day sprint, and a submission checklist — editable by
            you and by the agent beside you.
          </p>
        </div>
        <ImportForm />
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>Or try:</span>
          <Button
            variant="outline"
            size="sm"
            disabled={seed.isPending}
            onClick={() => seed.mutate({ timezone: Intl.DateTimeFormat().resolvedOptions().timeZone })}
          >
            <IconSparkles className="size-3.5" />
            {seed.isPending ? "Loading demo…" : "Builder.io Agent-Native Hackathon demo"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              askPilot(
                "Find the hackathon I should enter: ask me what I like to build and how much time I have, then import the best match.",
              )
            }
          >
            Ask Pilot to find one
          </Button>
        </div>
      </section>

      <section className="space-y-3" aria-label="Your hackathons">
        {isPending ? (
          Array.from({ length: 2 }, (_, i) => <Skeleton key={i} className="h-28 rounded-xl" />)
        ) : hackathons.length ? (
          hackathons.map((h) => <HackathonRow key={h.id} h={h} />)
        ) : (
          <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
            No hackathons yet. Paste a URL above, or load the demo.
          </div>
        )}
      </section>
    </div>
  );
}
