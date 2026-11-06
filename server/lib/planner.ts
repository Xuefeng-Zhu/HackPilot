/**
 * Deterministic sprint planner. Hangs tasks off four milestones (Idea locked,
 * Core works, Demo-ready, Submitted) whose targets scale with the event
 * window, and gives every task a due day inside its milestone's segment. The
 * plan is shaped by the rubric, the chosen idea, and the submission
 * checklist. The agent can then edit any task with `update-task`; this keeps
 * the baseline instant, free, and reproducible.
 */
import type {
  Criterion,
  SubmissionKind,
  TaskPhase,
} from "../../shared/hackpilot.js";
import { type Milestone, type MilestoneId } from "../../shared/milestones.js";
import { addDaysToKey, dateKeyInZone, daysBetweenKeys } from "../../shared/time.js";

export interface PlannedTask {
  title: string;
  phase: TaskPhase;
  milestone: MilestoneId;
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
  milestones: Milestone[];
  timezone: string;
  now?: Date;
}

interface Template {
  title: string;
  phase: TaskPhase;
  milestone: MilestoneId;
  /** Position inside the milestone's segment, 0 (segment start) .. 1 (milestone target). */
  at: number;
  hours?: number | undefined;
  notes?: string | undefined;
}

export function buildSprintPlan(input: PlanInput): PlannedTask[] {
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
      milestone: "idea",
      at: 0.2,
      hours: 1,
      notes: "Score each idea against the rubric, then mark one as selected.",
    });
  }
  templates.push(
    {
      title: `Write the pitch & demo story for ${idea}`,
      phase: "ideate",
      milestone: "idea",
      at: 0.9,
      hours: 1,
      notes: topCriteria.length
        ? `Lead with what judges weigh most: ${topCriteria.join(", ")}.`
        : undefined,
    },
    {
      title: "Scaffold the app, data model, and core actions",
      phase: "build",
      milestone: "core",
      at: 0.15,
      hours: 3,
    },
    {
      title: `Build the core workflow end-to-end for ${idea}`,
      phase: "build",
      milestone: "core",
      at: 0.55,
      hours: 4,
    },
    {
      title: "Give the agent the same actions + clear instructions",
      phase: "build",
      milestone: "core",
      at: 0.9,
      hours: 2,
    },
    {
      title: "Second feature pass: the moment that makes the demo memorable",
      phase: "build",
      milestone: "demo",
      at: 0.15,
      hours: 3,
    },
    { title: "Seed realistic demo data", phase: "build", milestone: "demo", at: 0.3, hours: 1 },
    {
      title: "Polish pass: empty, loading, and error states",
      phase: "polish",
      milestone: "demo",
      at: 0.45,
      hours: 2,
    },
    {
      title: "Run the happy path end-to-end and fix the top bugs",
      phase: "polish",
      milestone: "demo",
      at: 0.6,
      hours: 2,
    },
  );
  if (input.focus?.trim()) {
    templates.push({
      title: `Focus: ${input.focus.trim().slice(0, 140)}`,
      phase: "build",
      milestone: "core",
      at: 0.7,
      hours: 2,
    });
  }
  const rubricByWeight = [...input.rubric].sort((a, b) => b.weight - a.weight);
  if (rubricByWeight.length) {
    templates.push({
      title: "Rubric walkthrough: demo the app as a judge would",
      phase: "polish",
      milestone: "demo",
      at: 0.7,
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
        milestone: "demo",
        at: 0.8,
        hours: 1,
      },
      {
        title: "Record and upload the demo video",
        phase: "record",
        milestone: "demo",
        at: 1,
        hours: 2,
      },
    );
  }
  for (const item of open) {
    if (item.kind === "demo_video") continue;
    templates.push({
      title: item.label,
      phase: "submit",
      milestone: "submit",
      at: 0.5,
      hours: 1,
    });
  }
  templates.push({
    title: input.deadlineLabel
      ? `Submit before ${input.deadlineLabel}`
      : "Submit the entry",
    phase: "submit",
    milestone: "submit",
    at: 1,
    hours: 1,
    notes: "Leave buffer: aim to submit a few hours early.",
  });

  return templates.map((t) => ({
    title: t.title,
    phase: t.phase,
    milestone: t.milestone,
    day: dayInMilestone(input.milestones, t.milestone, t.at, input.timezone, input.now),
    notes: t.notes,
    estimateHours: t.hours,
  }));
}

/**
 * Calendar day for a task at position `at` (0..1) inside its milestone's
 * segment: from the previous milestone's target (or now) to this one's.
 * Never before today.
 */
export function dayInMilestone(
  milestones: Milestone[],
  id: MilestoneId,
  at: number,
  timezone: string,
  now = new Date(),
): string {
  const idx = milestones.findIndex((m) => m.id === id);
  const m = milestones[idx];
  const todayKey = dateKeyInZone(now, timezone);
  if (!m) return todayKey;
  const end = Date.parse(m.dueAt);
  const prev = idx > 0 ? Date.parse(milestones[idx - 1]!.dueAt) : now.getTime();
  const start = Math.max(now.getTime(), Math.min(prev, end));
  const ms = start + (end - start) * Math.min(1, Math.max(0, at));
  const key = dateKeyInZone(new Date(Math.min(ms, end)), timezone);
  return key < todayKey ? todayKey : key;
}

/**
 * Re-slot undone tasks after milestones moved or the builder fell behind:
 * overdue tasks (before today) and tasks due after their milestone's target
 * move into their milestone's remaining segment, lightest days first.
 * Returns id → new day for tasks that moved.
 */
export function rebalanceToMilestones(
  tasks: { id: string; day: string; done: boolean; milestone: MilestoneId }[],
  milestones: Milestone[],
  timezone: string,
  now = new Date(),
): Map<string, string> {
  const todayKey = dateKeyInZone(now, timezone);
  const moves = new Map<string, string>();
  const load = new Map<string, number>();
  for (const t of tasks) if (!t.done) load.set(t.day, (load.get(t.day) ?? 0) + 1);
  for (const m of milestones) {
    const first = dayInMilestone(milestones, m.id, 0, timezone, now);
    const last = m.day < todayKey ? todayKey : m.day;
    const span = Math.max(0, daysBetweenKeys(first, last));
    const window = Array.from({ length: span + 1 }, (_, i) => addDaysToKey(first, i));
    const stranded = tasks
      .filter((t) => !t.done && t.milestone === m.id && (t.day < todayKey || t.day > last))
      .sort((a, b) => a.day.localeCompare(b.day));
    for (const t of stranded) {
      let best = window[0] ?? todayKey;
      let bestLoad = Number.POSITIVE_INFINITY;
      for (const day of window) {
        const l = load.get(day) ?? 0;
        if (l < bestLoad) {
          best = day;
          bestLoad = l;
        }
      }
      if (best !== t.day) {
        moves.set(t.id, best);
        load.set(t.day, Math.max(0, (load.get(t.day) ?? 1) - 1));
        load.set(best, (load.get(best) ?? 0) + 1);
      }
    }
  }
  return moves;
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
