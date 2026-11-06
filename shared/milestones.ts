/**
 * Milestone backbone for a hackathon plan. Four checkpoints whose target times
 * scale with the event window (48 hours or a month+):
 *
 *   Idea locked ~10% · Core works ~55% · Demo-ready ~85% · Submitted = deadline
 *
 * Pure and isomorphic: the planner, actions, and UI all use it.
 */
import { z } from "zod";

import type { TaskPhase } from "./hackpilot.js";
import { dateKeyInZone, toUtcIso, zonedWallTimeToUtcIso } from "./time.js";

export const MILESTONE_IDS = ["idea", "core", "demo", "submit"] as const;
export type MilestoneId = (typeof MILESTONE_IDS)[number];

export const MILESTONE_META: Record<MilestoneId, { title: string; fraction: number; blurb: string }> = {
  idea: { title: "Idea locked", fraction: 0.1, blurb: "One idea picked, pitch and demo story written." },
  core: { title: "Core works", fraction: 0.55, blurb: "The main workflow runs end-to-end, UI and agent." },
  demo: { title: "Demo-ready", fraction: 0.85, blurb: "Polished happy path, seed data, demo recorded." },
  submit: { title: "Submitted", fraction: 1, blurb: "Every requirement in and the entry sent." },
};

export const milestoneSchema = z.object({
  id: z.enum(MILESTONE_IDS),
  title: z.string(),
  /** UTC ISO target time. */
  dueAt: z.string(),
  /** Calendar day of dueAt in the plan timezone. */
  day: z.string(),
  /** True when the date was pushed because the original target had passed. */
  reslotted: z.boolean().optional(),
});
export type Milestone = z.infer<typeof milestoneSchema>;

export function isMilestoneId(v: unknown): v is MilestoneId {
  return typeof v === "string" && (MILESTONE_IDS as readonly string[]).includes(v);
}

/** Default milestone for a task that predates milestones, from its phase. */
export function milestoneForPhase(phase: TaskPhase | string): MilestoneId {
  switch (phase) {
    case "ideate":
      return "idea";
    case "build":
      return "core";
    case "polish":
    case "record":
      return "demo";
    case "submit":
      return "submit";
    default:
      return "core";
  }
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function localDayAt(key: string, hour: number, tz: string): number {
  const [y = 1970, m = 1, d = 1] = key.split("-").map(Number);
  return Date.parse(zonedWallTimeToUtcIso({ year: y, month: m, day: d, hour, minute: hour === 23 ? 59 : 0 }, tz));
}

/**
 * Round a target to a time a human would pick: month-long events land at the
 * end of a local day, multi-day (3+) events at a working-hours anchor (9 AM, 1 PM,
 * 6 PM, 10 PM local), shorter sprints on the hour.
 */
function roundTarget(ms: number, windowMs: number, tz: string): number {
  if (windowMs >= 10 * DAY) return localDayAt(dateKeyInZone(new Date(ms), tz), 23, tz);
  if (windowMs >= 3 * DAY) {
    let best = ms;
    let bestDiff = Number.POSITIVE_INFINITY;
    for (const offset of [-DAY, 0, DAY]) {
      const key = dateKeyInZone(new Date(ms + offset), tz);
      for (const hour of [9, 13, 18, 22]) {
        const c = localDayAt(key, hour, tz);
        if (Math.abs(c - ms) < bestDiff) {
          best = c;
          bestDiff = Math.abs(c - ms);
        }
      }
    }
    return best;
  }
  return Math.round(ms / HOUR) * HOUR;
}

export interface MilestoneInput {
  /** Window start (import/creation time), UTC ISO. */
  startAt: string;
  deadlineAt: string;
  timezone: string;
  now?: Date;
  /** Milestones already reached: never re-slotted. */
  complete?: Partial<Record<MilestoneId, boolean>>;
  /** Existing targets to keep when they are still in the future. */
  previous?: Milestone[];
}

/**
 * Target times for the four milestones. Targets that already passed (for
 * milestones not yet reached) are re-slotted into the remaining time with the
 * same relative spacing, so the plan is never behind the moment it is made.
 */
export function computeMilestones(input: MilestoneInput): Milestone[] {
  const now = (input.now ?? new Date()).getTime();
  const deadline = Date.parse(input.deadlineAt);
  let start = Date.parse(input.startAt);
  if (!Number.isFinite(start) || start >= deadline) start = Math.min(now, deadline - DAY);
  const window = Math.max(HOUR, deadline - start);
  const prev = new Map((input.previous ?? []).map((m) => [m.id, m]));

  // Base targets: keep a previous future target, otherwise the proportional one.
  const base = MILESTONE_IDS.map((id) => {
    if (id === "submit") return deadline;
    const kept = prev.get(id);
    const keptMs = kept ? Date.parse(kept.dueAt) : NaN;
    if (Number.isFinite(keptMs) && keptMs > now && keptMs < deadline) return keptMs;
    return roundTarget(start + window * MILESTONE_META[id].fraction, window, input.timezone);
  });

  // Behind on a milestone: re-slot it and every unreached milestone after it
  // into the time that is left, keeping their relative spacing.
  const minLead = Math.min(2 * HOUR, Math.max(0, (deadline - now) / 8));
  const firstBehind = MILESTONE_IDS.findIndex(
    (id, i) => id !== "submit" && !input.complete?.[id] && (base[i] ?? 0) < now + minLead,
  );
  const remaining = Math.max(0, deadline - now);
  const lo = firstBehind > 0 ? MILESTONE_META[MILESTONE_IDS[firstBehind - 1]!].fraction : 0;
  const result = MILESTONE_IDS.map((id, i) => {
    let ms = base[i] ?? deadline;
    let reslotted = false;
    if (firstBehind >= 0 && i >= firstBehind && id !== "submit" && !input.complete?.[id]) {
      const share = (MILESTONE_META[id].fraction - lo) / Math.max(0.0001, 1 - lo);
      const target = roundTarget(now + remaining * share, remaining, input.timezone);
      ms = Math.max(target, now + minLead);
      reslotted = ms !== base[i];
    }
    return { id, ms: Math.min(ms, deadline), reslotted };
  });
  // Keep order strictly increasing and the last one at the deadline.
  for (let i = result.length - 2; i >= 0; i--) {
    const next = result[i + 1]!.ms;
    if (result[i]!.ms >= next) result[i]!.ms = next - Math.max(HOUR / 2, Math.min(window / 20, DAY / 2));
  }
  return result.map(({ id, ms, reslotted }) => ({
    id,
    title: MILESTONE_META[id].title,
    dueAt: toUtcIso(ms),
    day: dateKeyInZone(new Date(ms), input.timezone),
    ...(reslotted ? { reslotted: true } : {}),
  }));
}

export interface MilestoneProgress {
  milestone: Milestone;
  total: number;
  done: number;
  complete: boolean;
  overdue: boolean;
}

export function milestoneProgress(
  milestones: Milestone[],
  tasks: { milestone: string | null; phase: string; done: boolean }[],
  now = new Date(),
): MilestoneProgress[] {
  return milestones.map((m) => {
    const mine = tasks.filter((t) => (isMilestoneId(t.milestone) ? t.milestone : milestoneForPhase(t.phase)) === m.id);
    const done = mine.filter((t) => t.done).length;
    const complete = mine.length > 0 && done === mine.length;
    return {
      milestone: m,
      total: mine.length,
      done,
      complete,
      overdue: !complete && Date.parse(m.dueAt) < now.getTime(),
    };
  });
}
