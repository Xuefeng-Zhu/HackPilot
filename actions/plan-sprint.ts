import { defineAction, fail } from "@agent-native/core/action";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import { buildSprintPlan, rebalanceTasks } from "../server/lib/planner.js";
import {
  hackathonLink,
  nowIso,
  requireHackathon,
  serializeTask,
  touchHackathon,
} from "../server/lib/workspace.js";
import { taskOut } from "../shared/outputs.js";
import {
  dateKeyInZone,
  formatInZone,
  isDateKey,
  isValidTimezone,
} from "../shared/time.js";

export default defineAction({
  description:
    'Plan or re-plan the day-by-day sprint from today to the deadline day. mode "fresh" (default) regenerates the generated plan around the selected idea, rubric, and open checklist items, keeping done tasks and tasks the user or agent added; mode "rebalance" keeps every task and only moves overdue or past-deadline undone tasks onto the lightest remaining days. Fine-tune afterwards with update-task.',
  schema: z.object({
    hackathonId: z.string().describe("Hackathon id"),
    mode: z
      .enum(["fresh", "rebalance"])
      .default("fresh")
      .describe('"fresh" (default) or "rebalance"'),
    timezone: z
      .string()
      .optional()
      .describe(
        "IANA timezone the builder works in; plan days are calendar dates there. Defaults to the hackathon's timezone",
      ),
    today: z
      .string()
      .optional()
      .describe(
        "Override today's date (YYYY-MM-DD) in that timezone; default is the real current date",
      ),
    focus: z
      .string()
      .max(200)
      .optional()
      .describe("Extra emphasis to schedule, e.g. 'voice input'"),
  }),
  outputSchema: z.object({
    hackathonId: z.string(),
    mode: z.string(),
    timezone: z.string(),
    days: z.number(),
    created: z.number(),
    moved: z.number(),
    removed: z.number(),
    tasks: z.array(taskOut),
    message: z.string(),
  }),
  link: ({ args }) => hackathonLink(args.hackathonId, "plan"),
  run: async (args, ctx) => {
    const row = await requireHackathon(args.hackathonId, "editor");
    if (!row.deadlineAt) {
      fail(
        "Set the deadline first (update-hackathon deadlineLocal + timezone).",
        { errorCode: "no_deadline" },
      );
    }
    const tz =
      args.timezone && isValidTimezone(args.timezone)
        ? args.timezone
        : row.timezone;
    const todayKey =
      args.today && isDateKey(args.today)
        ? args.today
        : dateKeyInZone(new Date(), tz);
    const deadlineKey = dateKeyInZone(new Date(row.deadlineAt), tz);
    if (deadlineKey < todayKey) {
      fail("The deadline has passed, so there is nothing left to plan.", {
        errorCode: "deadline_passed",
      });
    }
    const db = getDb();
    const { tasks, ideas, submissionItems } = schema;
    const existing = await db
      .select()
      .from(tasks)
      .where(eq(tasks.hackathonId, row.id))
      .limit(500);

    let created = 0;
    let moved = 0;
    let removed = 0;
    if (args.mode === "rebalance") {
      const moves = rebalanceTasks(existing, todayKey, deadlineKey);
      await db.transaction(async (tx) => {
        for (const [id, day] of moves) {
          await tx
            .update(tasks)
            .set({ day, updatedAt: nowIso() })
            .where(and(eq(tasks.id, id), eq(tasks.hackathonId, row.id)));
        }
      });
      moved = moves.size;
    } else {
      const [selected] = await db
        .select({ title: ideas.title })
        .from(ideas)
        .where(and(eq(ideas.hackathonId, row.id), eq(ideas.selected, true)))
        .limit(1);
      const items = await db
        .select({
          label: submissionItems.label,
          kind: submissionItems.kind,
          status: submissionItems.status,
        })
        .from(submissionItems)
        .where(eq(submissionItems.hackathonId, row.id))
        .limit(100);
      const plan = buildSprintPlan({
        todayKey,
        deadlineKey,
        deadlineLabel: formatInZone(row.deadlineAt, tz, {
          weekday: "short",
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
          timeZoneName: "short",
        }),
        ideaTitle: selected?.title ?? null,
        rubric: row.rubric,
        submission: items,
        focus: args.focus,
      });
      const stale = existing
        .filter((t) => t.source === "plan" && !t.done)
        .map((t) => t.id);
      const doneTitles = new Set(
        existing.filter((t) => t.done).map((t) => t.title),
      );
      const fresh = plan.filter((p) => !doneTitles.has(p.title));
      const ownerEmail = ctx?.userEmail ?? row.ownerEmail;
      await db.transaction(async (tx) => {
        if (stale.length) {
          await tx
            .delete(tasks)
            .where(
              and(eq(tasks.hackathonId, row.id), inArray(tasks.id, stale)),
            );
        }
        if (fresh.length) {
          await tx.insert(tasks).values(
            fresh.map((p, i) => ({
              id: crypto.randomUUID(),
              hackathonId: row.id,
              title: p.title,
              notes: p.notes ?? null,
              day: p.day,
              phase: p.phase,
              position: 100 + i,
              source: "plan",
              estimateHours: p.estimateHours ?? null,
              ownerEmail,
              orgId: row.orgId,
            })),
          );
        }
      });
      removed = stale.length;
      created = fresh.length;
      // Also pull stranded user tasks into the window.
      const after = await db
        .select()
        .from(tasks)
        .where(eq(tasks.hackathonId, row.id))
        .limit(500);
      const moves = rebalanceTasks(after, todayKey, deadlineKey);
      for (const [id, day] of moves) {
        await db
          .update(tasks)
          .set({ day })
          .where(and(eq(tasks.id, id), eq(tasks.hackathonId, row.id)));
      }
      moved = moves.size;
    }
    await touchHackathon(row.id);
    const final = await db
      .select()
      .from(tasks)
      .where(eq(tasks.hackathonId, row.id))
      .orderBy(tasks.day, tasks.position)
      .limit(500);
    const days = new Set(final.map((t) => t.day)).size;
    return {
      hackathonId: row.id,
      mode: args.mode,
      timezone: tz,
      days,
      created,
      moved,
      removed,
      tasks: final.map(serializeTask),
      message:
        args.mode === "rebalance"
          ? `Rebalanced: moved ${moved} task${moved === 1 ? "" : "s"} into ${todayKey}…${deadlineKey}.`
          : `Planned ${created} tasks across ${todayKey}…${deadlineKey} (${tz}); replaced ${removed}, moved ${moved}.`,
    };
  },
});
