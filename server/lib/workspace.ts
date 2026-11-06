import { fail } from "@agent-native/core/action";
import { buildDeepLink } from "@agent-native/core/server";
import { accessFilter } from "@agent-native/core/sharing";
import { and, asc, eq } from "drizzle-orm";

import {
  type Criterion,
  scoreCoverage,
  weightedScore,
} from "../../shared/hackpilot.js";
import {
  computeMilestones,
  isMilestoneId,
  type Milestone,
  milestoneForPhase,
} from "../../shared/milestones.js";
import { countdownLabel, toUtcIso } from "../../shared/time.js";
import { getDb, schema } from "../db/index.js";

export type ShareRole = "viewer" | "editor" | "admin";

export const nowIso = () => toUtcIso(new Date());

/** Window start for milestone scaling: when the hackathon entered HackPilot. */
export function planStartAt(row: { importedAt: string | null; createdAt: string }) {
  return row.importedAt ?? row.createdAt;
}

/**
 * Stored milestones, or ones computed on the fly for hackathons planned before
 * milestones existed (persisted on the next plan-sprint).
 */
export function planMilestones(row: {
  milestones?: Milestone[] | null;
  deadlineAt: string | null;
  timezone: string;
  importedAt: string | null;
  createdAt: string;
}): Milestone[] {
  if (row.milestones?.length) return row.milestones;
  if (!row.deadlineAt) return [];
  return computeMilestones({ startAt: planStartAt(row), deadlineAt: row.deadlineAt, timezone: row.timezone });
}

export function hackathonLink(id: string, tab?: string) {
  return {
    url: buildDeepLink({
      view: "hackathon",
      to: `/hackathons/${encodeURIComponent(id)}${tab ? `?tab=${tab}` : ""}`,
      params: { hackathonId: id, ...(tab ? { tab } : {}) },
    }),
    label: "Open in HackPilot",
  };
}

/** Load a hackathon the caller can access at `minRole`, or fail 404. */
export async function requireHackathon(
  id: string,
  minRole: ShareRole = "viewer",
) {
  const { hackathons, hackathonShares } = schema;
  const [row] = await getDb()
    .select()
    .from(hackathons)
    .where(
      and(
        eq(hackathons.id, id),
        accessFilter(hackathons, hackathonShares, undefined, minRole),
      ),
    )
    .limit(1);
  if (!row) {
    fail(
      minRole === "viewer"
        ? "Hackathon not found. Call list-hackathons for valid ids."
        : "Hackathon not found or you can't edit it.",
      { errorCode: "not_found", statusCode: 404, details: { hackathonId: id } },
    );
  }
  return row;
}

export type HackathonRow = Awaited<ReturnType<typeof requireHackathon>>;

export function serializeHackathon(row: HackathonRow, includeSource = false) {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    tagline: row.tagline,
    deadlineAt: row.deadlineAt,
    timezone: row.timezone,
    countdown: row.deadlineAt ? countdownLabel(row.deadlineAt) : null,
    prizes: row.prizes ?? [],
    rubric: row.rubric ?? [],
    notes: row.notes,
    milestones: planMilestones(row),
    extraction: row.extraction,
    importedAt: row.importedAt,
    updatedAt: row.updatedAt,
    visibility: row.visibility,
    ...(includeSource ? { sourceText: row.sourceText ?? null } : {}),
  };
}

export async function loadChildren(hackathonId: string, rubric: Criterion[]) {
  const db = getDb();
  const { ideas, tasks, submissionItems } = schema;
  const [ideaRows, taskRows, itemRows] = await Promise.all([
    db
      .select()
      .from(ideas)
      .where(eq(ideas.hackathonId, hackathonId))
      .orderBy(asc(ideas.position), asc(ideas.createdAt))
      .limit(200),
    db
      .select()
      .from(tasks)
      .where(eq(tasks.hackathonId, hackathonId))
      .orderBy(asc(tasks.day), asc(tasks.position), asc(tasks.createdAt))
      .limit(500),
    db
      .select()
      .from(submissionItems)
      .where(eq(submissionItems.hackathonId, hackathonId))
      .orderBy(asc(submissionItems.position), asc(submissionItems.createdAt))
      .limit(100),
  ]);
  return {
    ideas: ideaRows.map((i) => serializeIdea(i, rubric)),
    tasks: taskRows.map(serializeTask),
    submissionItems: itemRows.map(serializeItem),
  };
}

export function serializeIdea(
  i: typeof schema.ideas.$inferSelect,
  rubric: Criterion[],
) {
  return {
    id: i.id,
    title: i.title,
    pitch: i.pitch,
    tags: i.tags ?? [],
    scores: i.scores ?? {},
    weightedScore: weightedScore(i.scores, rubric),
    coverage: scoreCoverage(i.scores, rubric),
    rationale: i.rationale,
    position: i.position,
    selected: i.selected,
    source: i.source,
  };
}

export function serializeTask(t: typeof schema.tasks.$inferSelect) {
  return {
    id: t.id,
    title: t.title,
    notes: t.notes,
    day: t.day,
    phase: t.phase,
    milestone: isMilestoneId(t.milestone) ? t.milestone : milestoneForPhase(t.phase),
    position: t.position,
    done: t.done,
    source: t.source,
    estimateHours: t.estimateHours,
  };
}

export function serializeItem(s: typeof schema.submissionItems.$inferSelect) {
  return {
    id: s.id,
    label: s.label,
    kind: s.kind,
    detail: s.detail,
    status: s.status,
    link: s.link,
    position: s.position,
  };
}

export async function touchHackathon(id: string) {
  await getDb()
    .update(schema.hackathons)
    .set({ updatedAt: nowIso() })
    .where(eq(schema.hackathons.id, id));
}

/** Reject score keys that are not rubric criterion ids; round to 0.5. */
export function validateScores(
  scores: Record<string, number> | undefined,
  rubric: Criterion[],
): Record<string, number> {
  if (!scores) return {};
  const ids = new Set(rubric.map((c) => c.id));
  const unknown = Object.keys(scores).filter((k) => !ids.has(k));
  if (unknown.length) {
    fail(
      `Unknown criterion id(s): ${unknown.join(", ")}. Valid ids: ${[...ids].join(", ") || "(rubric is empty — add criteria with update-hackathon first)"}.`,
      { errorCode: "unknown_criterion", details: { validIds: [...ids] } },
    );
  }
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(scores)) {
    out[k] = Math.max(0, Math.min(10, Math.round(v * 2) / 2));
  }
  return out;
}

export function ideaSource(caller: string | undefined): "user" | "agent" {
  return caller === "frontend" ? "user" : "agent";
}

/** First row of a write that must return one (`.returning()`), else 500. */
export function one<T>(rows: T[]): T {
  const row = rows[0];
  if (row === undefined)
    throw new Error("Expected a row from the database write.");
  return row;
}

/** `coalesce(max(position), -1)` result → next position. */
export function nextPosition(rows: { max: number }[]): number {
  return Number(rows[0]?.max ?? -1) + 1;
}
