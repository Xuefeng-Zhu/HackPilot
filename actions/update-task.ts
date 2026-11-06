import { defineAction, fail } from "@agent-native/core/action";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import {
  hackathonLink,
  ideaSource,
  planMilestones,
  nextPosition,
  nowIso,
  one,
  requireHackathon,
  serializeTask,
} from "../server/lib/workspace.js";
import { TASK_PHASES } from "../shared/hackpilot.js";
import { taskOut } from "../shared/outputs.js";
import { MILESTONE_IDS, milestoneForPhase, type MilestoneId } from "../shared/milestones.js";
import { dateKeyInZone, isDateKey } from "../shared/time.js";

/**
 * Due day for a task in a milestone: keep `current` when it already falls
 * inside the milestone's segment, else the milestone's first open day.
 */
function dueDayFor(
  row: Parameters<typeof planMilestones>[0],
  id: MilestoneId,
  current: string | null,
): string {
  const ms = planMilestones(row);
  const today = dateKeyInZone(new Date(), row.timezone);
  const idx = ms.findIndex((m) => m.id === id);
  const target = ms[idx]?.day ?? today;
  const prev = idx > 0 ? (ms[idx - 1]?.day ?? today) : today;
  const lo = prev > today ? prev : today;
  const hi = target < lo ? lo : target;
  if (current && current >= lo && current <= hi) return current;
  return current && current > hi ? hi : lo;
}

export default defineAction({
  description:
    'Create, edit, move, check off, or delete one sprint task. Tasks hang off a milestone ("idea" = Idea locked, "core" = Core works, "demo" = Demo-ready, "submit" = Submitted) and have a due day. Omit id and pass hackathonId + title + milestone (and/or day) to create; without day it lands on the first open day of that milestone. With id: patch title, notes, milestone (move between milestones; the due day is pulled inside the new milestone unless you pass day), day, position, done, phase, estimateHours, or delete=true.',
  schema: z.object({
    id: z.string().optional().describe("Task id; omit to create a new task"),
    hackathonId: z
      .string()
      .optional()
      .describe("Hackathon id; required when creating"),
    title: z.string().min(1).max(200).optional().describe("Task title"),
    notes: z
      .string()
      .max(2000)
      .nullable()
      .optional()
      .describe("Details; null clears"),
    day: z
      .string()
      .optional()
      .describe("Calendar day YYYY-MM-DD to schedule/move the task to"),
    position: z.coerce
      .number()
      .int()
      .min(0)
      .max(10000)
      .optional()
      .describe("Order within the day, lower first"),
    done: z.boolean().optional().describe("true to check off, false to reopen"),
    phase: z
      .enum(TASK_PHASES)
      .optional()
      .describe(
        'Phase: "ideate", "build", "polish", "record", "submit", or "other"',
      ),
    estimateHours: z.coerce
      .number()
      .int()
      .min(0)
      .max(24)
      .nullable()
      .optional()
      .describe("Rough hours"),
    milestone: z
      .enum(MILESTONE_IDS)
      .optional()
      .describe('Milestone: "idea", "core", "demo", or "submit"'),
    delete: z.boolean().optional().describe("true to delete the task"),
  }),
  outputSchema: z.object({
    id: z.string(),
    hackathonId: z.string(),
    deleted: z.boolean(),
    task: taskOut.nullable(),
    message: z.string(),
  }),
  link: ({ result }) => hackathonLink(result.hackathonId, "plan"),
  run: async (args, ctx) => {
    if (args.day !== undefined && !isDateKey(args.day)) {
      fail("day must be a calendar date YYYY-MM-DD.", {
        errorCode: "invalid_day",
      });
    }
    const db = getDb();
    const { tasks } = schema;
    if (!args.id) {
      if (!args.hackathonId || !args.title || (!args.day && !args.milestone)) {
        fail("To create a task pass hackathonId, title, and a milestone or day.", {
          errorCode: "missing_fields",
        });
      }
      const row = await requireHackathon(args.hackathonId, "editor");
      const milestone: MilestoneId = args.milestone ?? milestoneForPhase(args.phase ?? "build");
      const day = args.day ?? dueDayFor(row, milestone, null);
      const posRows = await db
        .select({ max: sql<number>`coalesce(max(${tasks.position}), -1)::int` })
        .from(tasks)
        .where(and(eq(tasks.hackathonId, row.id), eq(tasks.day, day)));
      const created = one(
        await db
          .insert(tasks)
          .values({
            id: crypto.randomUUID(),
            hackathonId: row.id,
            title: args.title.trim(),
            notes: args.notes ?? null,
            day,
            phase: args.phase ?? "build",
            milestone,
            position: args.position ?? nextPosition(posRows),
            done: args.done ?? false,
            source: ideaSource(ctx?.caller),
            estimateHours: args.estimateHours ?? null,
            ownerEmail: ctx?.userEmail ?? row.ownerEmail,
            orgId: row.orgId,
          })
          .returning(),
      );
      return {
        id: created.id,
        hackathonId: row.id,
        deleted: false,
        task: serializeTask(created),
        message: `Added “${created.title}” on ${created.day}.`,
      };
    }
    const [task] = await db
      .select({ id: tasks.id, hackathonId: tasks.hackathonId, day: tasks.day })
      .from(tasks)
      .where(eq(tasks.id, args.id))
      .limit(1);
    if (!task)
      fail("Task not found.", { errorCode: "not_found", statusCode: 404 });
    const row = await requireHackathon(task.hackathonId, "editor");
    if (args.delete) {
      await db
        .delete(tasks)
        .where(and(eq(tasks.id, task.id), eq(tasks.hackathonId, row.id)));
      return {
        id: task.id,
        hackathonId: row.id,
        deleted: true,
        task: null,
        message: "Task deleted.",
      };
    }
    const patch: Partial<typeof tasks.$inferInsert> = { updatedAt: nowIso() };
    if (args.title !== undefined) patch.title = args.title.trim();
    if (args.notes !== undefined) patch.notes = args.notes;
    if (args.day !== undefined) patch.day = args.day;
    if (args.position !== undefined) patch.position = args.position;
    if (args.done !== undefined) patch.done = args.done;
    if (args.phase !== undefined) patch.phase = args.phase;
    if (args.milestone !== undefined) {
      patch.milestone = args.milestone;
      if (args.day === undefined) patch.day = dueDayFor(row, args.milestone, task.day);
    }
    if (args.estimateHours !== undefined)
      patch.estimateHours = args.estimateHours;
    if (Object.keys(patch).length === 1) {
      fail("Nothing to update: pass at least one field.", {
        errorCode: "empty_patch",
      });
    }
    const updated = one(
      await db
        .update(tasks)
        .set(patch)
        .where(and(eq(tasks.id, task.id), eq(tasks.hackathonId, row.id)))
        .returning(),
    );
    return {
      id: updated.id,
      hackathonId: row.id,
      deleted: false,
      task: serializeTask(updated),
      message: `Updated “${updated.title}”.`,
    };
  },
});
