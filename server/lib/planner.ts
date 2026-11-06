/**
 * Deterministic sprint planner. Produces a day-by-day plan from today to the
 * deadline day, shaped by the rubric, the chosen idea, and the submission
 * checklist. The agent can then edit any task with `update-task`; this keeps
 * the baseline instant, free, and reproducible.
 */
import type {
  Criterion,
  SubmissionKind,
  TaskPhase,
} from "../../shared/hackpilot.js";
import { addDaysToKey, daysBetweenKeys } from "../../shared/time.js";

export interface PlannedTask {
  title: string;
  phase: TaskPhase;
  day: string;
  notes?: string | undefined;
  estimateHours?: number | undefined;
}

interface PlanInput {
  todayKey: string;
  deadlineKey: string;
  deadlineLabel: string | null;
  ideaTitle: string | null;
  rubric: Criterion[];
  submission: {
    label: string;
    kind: SubmissionKind | string;
    status: string;
  }[];
  focus?: string | null | undefined;
}

interface Template {
  title: string;
  phase: TaskPhase;
  /** Position in the timeline, 0 (today) .. 1 (deadline day). */
  at: number;
  hours?: number | undefined;
  notes?: string | undefined;
}

export function buildSprintPlan(input: PlanInput): PlannedTask[] {
  const span = daysBetweenKeys(input.todayKey, input.deadlineKey);
  const days = Math.max(1, span + 1);
  const idea = input.ideaTitle ? `“${input.ideaTitle}”` : "the chosen idea";
  const topCriteria = [...input.rubric]
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 2)
    .map((c) => `${c.name}${c.weight ? ` (${c.weight}%)` : ""}`);

  const templates: Template[] = [];
  if (!input.ideaTitle) {
    templates.push({
      title: "Pick the idea: compare the top cards on the idea board",
      phase: "ideate",
      at: 0,
      hours: 1,
      notes: "Score each idea against the rubric, then mark one as selected.",
    });
  }
  templates.push(
    {
      title: `Write the pitch & demo story for ${idea}`,
      phase: "ideate",
      at: 0,
      hours: 1,
      notes: topCriteria.length
        ? `Lead with what judges weigh most: ${topCriteria.join(", ")}.`
        : undefined,
    },
    {
      title: "Scaffold the app, data model, and core actions",
      phase: "build",
      at: 0.12,
      hours: 3,
    },
    {
      title: `Build the core workflow end-to-end for ${idea}`,
      phase: "build",
      at: 0.25,
      hours: 4,
    },
    {
      title: "Give the agent the same actions + clear instructions",
      phase: "build",
      at: 0.38,
      hours: 2,
    },
    {
      title: "Second feature pass: the moment that makes the demo memorable",
      phase: "build",
      at: 0.5,
      hours: 3,
    },
    { title: "Seed realistic demo data", phase: "build", at: 0.6, hours: 1 },
    {
      title: "Polish pass: empty, loading, and error states",
      phase: "polish",
      at: 0.68,
      hours: 2,
    },
    {
      title: "Run the happy path end-to-end and fix the top bugs",
      phase: "polish",
      at: 0.76,
      hours: 2,
    },
  );
  if (input.focus?.trim()) {
    templates.push({
      title: `Focus: ${input.focus.trim().slice(0, 140)}`,
      phase: "build",
      at: 0.45,
      hours: 2,
    });
  }
  const rubricByWeight = [...input.rubric].sort((a, b) => b.weight - a.weight);
  if (rubricByWeight.length) {
    templates.push({
      title: "Rubric walkthrough: demo the app as a judge would",
      phase: "polish",
      at: 0.8,
      hours: 1,
      notes: rubricByWeight
        .map((c) => `${c.name}${c.weight ? ` (${c.weight}%)` : ""}${c.description ? ` — ${c.description}` : ""}`)
        .join("\n"),
    });
  }

  const open = input.submission.filter((s) => s.status !== "done");
  const hasVideo = open.some((s) => s.kind === "demo_video");
  if (hasVideo) {
    templates.push(
      {
        title: "Script the demo video (problem → workflow → agent moment)",
        phase: "record",
        at: 0.86,
        hours: 1,
      },
      {
        title: "Record and upload the demo video",
        phase: "record",
        at: 0.9,
        hours: 2,
      },
    );
  }
  for (const item of open) {
    if (item.kind === "demo_video") continue;
    templates.push({
      title: item.label,
      phase: "submit",
      at: 0.94,
      hours: 1,
    });
  }
  templates.push({
    title: input.deadlineLabel
      ? `Submit before ${input.deadlineLabel}`
      : "Submit the entry",
    phase: "submit",
    at: 1,
    hours: 1,
    notes: "Leave buffer: aim to submit a few hours early.",
  });

  return templates.map((t) => {
    // Submission tasks land on the last day; everything else spreads out.
    const index =
      t.at >= 1 ? days - 1 : Math.min(days - 1, Math.round(t.at * (days - 1)));
    return {
      title: t.title,
      phase: t.phase,
      day: addDaysToKey(input.todayKey, index),
      notes: t.notes,
      estimateHours: t.hours,
    };
  });
}

/**
 * Move undone tasks that are overdue (before today) or past the deadline into
 * the remaining days, filling the lightest days first. Returns id → new day
 * for tasks that moved.
 */
export function rebalanceTasks(
  tasks: { id: string; day: string; done: boolean }[],
  todayKey: string,
  deadlineKey: string,
): Map<string, string> {
  const days = Math.max(1, daysBetweenKeys(todayKey, deadlineKey) + 1);
  const load = new Map<string, number>();
  for (let i = 0; i < days; i++) load.set(addDaysToKey(todayKey, i), 0);
  for (const t of tasks) {
    if (!t.done && load.has(t.day)) load.set(t.day, (load.get(t.day) ?? 0) + 1);
  }
  const moves = new Map<string, string>();
  const stranded = tasks
    .filter((t) => !t.done && (t.day < todayKey || t.day > deadlineKey))
    .sort((a, b) => a.day.localeCompare(b.day));
  for (const t of stranded) {
    let best = todayKey;
    let bestLoad = Number.POSITIVE_INFINITY;
    // Overdue work goes as early as possible; tie-break on earliest day.
    const window =
      t.day > deadlineKey ? [...load.keys()].reverse() : [...load.keys()];
    for (const day of window) {
      const l = load.get(day) ?? 0;
      if (l < bestLoad) {
        best = day;
        bestLoad = l;
      }
      if (t.day < todayKey && l === 0) break;
    }
    moves.set(t.id, best);
    load.set(best, (load.get(best) ?? 0) + 1);
  }
  return moves;
}
