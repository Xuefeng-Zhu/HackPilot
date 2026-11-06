import { defineAction, fail } from "@agent-native/core/action";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import {
  hackathonLink,
  ideaSource,
  nextPosition,
  nowIso,
  one,
  requireHackathon,
  serializeTask,
} from "../server/lib/workspace.js";
import { TASK_PHASES } from "../shared/hackpilot.js";
import { taskOut } from "../shared/outputs.js";
import { isDateKey } from "../shared/time.js";

export default defineAction({
  description:
    "Create, edit, move, check off, or delete one sprint task. Omit id and pass hackathonId + title + day to create. With id: patch title, notes, day (move), position, done, phase, estimateHours, or delete=true.",
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
      if (!args.hackathonId || !args.title || !args.day) {
        fail("To create a task pass hackathonId, title, and day.", {
          errorCode: "missing_fields",
        });
      }
      const row = await requireHackathon(args.hackathonId, "editor");
      const posRows = await db
        .select({ max: sql<number>`coalesce(max(${tasks.position}), -1)::int` })
        .from(tasks)
        .where(and(eq(tasks.hackathonId, row.id), eq(tasks.day, args.day)));
      const created = one(
        await db
          .insert(tasks)
          .values({
            id: crypto.randomUUID(),
            hackathonId: row.id,
            title: args.title.trim(),
            notes: args.notes ?? null,
            day: args.day,
            phase: args.phase ?? "build",
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
      .select({ id: tasks.id, hackathonId: tasks.hackathonId })
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
