import { useActionQuery, useDbSync } from "@agent-native/core/client/hooks";
import { useSetPageTitle } from "@agent-native/toolkit/app-shell/header-actions";
import {
  IconArrowLeft,
  IconClipboardCheck,
  IconClockHour4,
  IconExternalLink,
  IconLayoutKanban,
  IconListCheck,
  IconSparkles,
  IconTrophy,
} from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";

import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TAB_ID } from "@/lib/tab-id";
import { formatMoney, totalPrizePool } from "@shared/hackpilot";
import type { WorkspaceOut } from "@shared/outputs";
import { countdownLabel, formatInZone } from "@shared/time";

import { ChecklistTab } from "./ChecklistTab";
import { IdeasTab } from "./IdeasTab";
import { OverviewTab } from "./OverviewTab";
import { PlanTab } from "./PlanTab";

const TABS = ["overview", "ideas", "plan", "checklist"] as const;
type Tab = (typeof TABS)[number];

function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), intervalMs);
    return () => window.clearInterval(t);
  }, [intervalMs]);
  return now;
}

function DeadlineBadge({ ws }: { ws: WorkspaceOut }) {
  const now = useNow();
  const h = ws.hackathon;
  if (!h.deadlineAt) {
    return <span className="text-sm text-muted-foreground">Deadline not set</span>;
  }
  const label = countdownLabel(h.deadlineAt, now);
  const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const hoursLeft = (Date.parse(h.deadlineAt) - now.getTime()) / 3_600_000;
  const urgent = hoursLeft > 0 && hoursLeft < 48;
  return (
    <div className="flex flex-col items-start gap-0.5 sm:items-end">
      <span
        className={`inline-flex items-center gap-1.5 text-2xl font-semibold tracking-tight hp-tabular ${label === "passed" ? "text-muted-foreground" : "text-signal"} ${urgent ? "motion-safe:animate-pulse" : ""}`}
        aria-label={`Time left: ${label}`}
      >
        <IconClockHour4 className="size-5" />
        {label === "passed" ? "Closed" : `${label} left`}
      </span>
      <span className="text-xs text-muted-foreground">
        Due {formatInZone(h.deadlineAt, h.timezone)}
        {localTz !== h.timezone ? (
          <> · {formatInZone(h.deadlineAt, localTz, { weekday: "short", hour: "numeric", minute: "2-digit", timeZoneName: "short" })} your time</>
        ) : null}
      </span>
    </div>
  );
}

export function Workspace({ id }: { id: string }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const rawTab = searchParams.get("tab") ?? "overview";
  const tab: Tab = (TABS as readonly string[]).includes(rawTab) ? (rawTab as Tab) : "overview";
  const queryClient = useQueryClient();
  // The agent, the CLI, or a teammate can change this workspace while it is open.
  useDbSync({
    queryClient,
    ignoreSource: TAB_ID,
    realtime: { reason: "agent, CLI, and teammate edits to the open hackathon workspace" },
  });
  const { data, isPending, error } = useActionQuery("get-hackathon", { id });
  useSetPageTitle(data?.hackathon.name ?? "Hackathon");

  if (isPending) {
    return (
      <div className="mx-auto w-full max-w-6xl space-y-4 px-4 py-6 sm:px-6">
        <Skeleton className="h-16 rounded-xl" />
        <Skeleton className="h-10 w-80 rounded-lg" />
        <div className="grid gap-3 md:grid-cols-3">
          <Skeleton className="h-48 rounded-xl" />
          <Skeleton className="h-48 rounded-xl" />
          <Skeleton className="h-48 rounded-xl" />
        </div>
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="mx-auto max-w-xl px-6 py-16 text-center">
        <p className="text-sm text-muted-foreground">This hackathon doesn't exist or you can't open it.</p>
        <Link to="/hackathons" className="mt-3 inline-block text-sm underline underline-offset-4">
          Back to hackathons
        </Link>
      </div>
    );
  }
  const ws = data as WorkspaceOut;
  const h = ws.hackathon;
  const pool = totalPrizePool(h.prizes);
  const selected = ws.ideas.find((i) => i.selected);

  return (
    <div className="mx-auto w-full max-w-6xl px-4 pb-16 pt-5 sm:px-6">
      <header className="flex flex-col gap-4 pb-5 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1.5">
          <Link
            to="/hackathons"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <IconArrowLeft className="size-3.5" />
            Hackathons
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight">{h.name}</h1>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
            {pool ? (
              <span className="inline-flex items-center gap-1 font-medium text-foreground">
                <IconTrophy className="size-4 text-signal" />
                {formatMoney(pool.amount, pool.currency)} in prizes
              </span>
            ) : null}
            {selected ? (
              <span className="inline-flex items-center gap-1">
                <IconSparkles className="size-4" />
                Building <span className="font-medium text-foreground">{selected.title}</span>
              </span>
            ) : null}
            {h.url ? (
              <a
                href={h.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 hover:text-foreground"
              >
                <IconExternalLink className="size-3.5" />
                {new URL(h.url).hostname.replace(/^www\./, "")}
              </a>
            ) : null}
          </div>
        </div>
        <DeadlineBadge ws={ws} />
      </header>

      <Tabs
        value={tab}
        onValueChange={(value) => {
          const next = new URLSearchParams(searchParams);
          next.set("tab", value);
          setSearchParams(next, { replace: true });
        }}
      >
        <TabsList className="mb-5">
          <TabsTrigger value="overview" className="gap-1.5">
            <IconClipboardCheck className="size-4" />
            Overview
          </TabsTrigger>
          <TabsTrigger value="ideas" className="gap-1.5">
            <IconSparkles className="size-4" />
            Ideas <span className="ml-1 text-xs text-muted-foreground hp-tabular">{ws.ideas.length}</span>
          </TabsTrigger>
          <TabsTrigger value="plan" className="gap-1.5">
            <IconLayoutKanban className="size-4" />
            Plan
            <span className="ml-1 text-xs text-muted-foreground hp-tabular">
              {ws.progress.tasksDone}/{ws.progress.tasksTotal}
            </span>
          </TabsTrigger>
          <TabsTrigger value="checklist" className="gap-1.5">
            <IconListCheck className="size-4" />
            Checklist
            <span className="ml-1 text-xs text-muted-foreground hp-tabular">
              {ws.progress.submissionDone}/{ws.progress.submissionTotal}
            </span>
          </TabsTrigger>
        </TabsList>
        <TabsContent value="overview">
          <OverviewTab ws={ws} />
        </TabsContent>
        <TabsContent value="ideas">
          <IdeasTab ws={ws} />
        </TabsContent>
        <TabsContent value="plan">
          <PlanTab ws={ws} />
        </TabsContent>
        <TabsContent value="checklist">
          <ChecklistTab ws={ws} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
