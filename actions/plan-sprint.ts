import { defineAction, fail } from "@agent-native/core/action";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import { buildSprintPlan, rebalanceToMilestones } from "../server/lib/planner.js";
import {
  hackathonLink,
  nowIso,
  planStartAt,
  requireHackathon,
  serializeTask,
  touchHackathon,
} from "../server/lib/workspace.js";
import {
  computeMilestones,
  isMilestoneId,
  MILESTONE_IDS,
  milestoneForPhase,
  type MilestoneId,
  milestoneSchema,
} from "../shared/milestones.js";
import { taskOut } from "../shared/outputs.js";
import {
  dateKeyInZone,
  formatInZone,
  isDateKey,
  isValidTimezone,
  zonedWallTimeToUtcIso,
} from "../shared/time.js";

export default defineAction({
  description:
    'Plan or re-plan the sprint around four milestones: Idea locked (~10% of the window from import to deadline), Core works (~55%), Demo-ready (~85%), Submitted (the deadline). Targets scale with the event length and are never in the past; every task hangs off a milestone and gets a due day inside it. mode "fresh" (default) regenerates the generated plan around the selected idea, rubric, and open checklist items, keeping done tasks and tasks the user or agent added; mode "rebalance" keeps every task, re-slots milestones the builder fell behind on into the remaining time, and moves overdue undone tasks into their milestone\'s remaining days. Fine-tune with update-task (milestone, day, done).',
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
        "IANA timezone the builder works in; due days are calendar dates there. Defaults to the hackathon's timezone",
      ),
    today: z
      .string()
      .optional()
      .describe(
        "Override today's date (YYYY-MM-DD) in that timezone; default is the real current time",
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
    milestones: z.array(milestoneSchema),
    nextMilestone: milestoneSchema.nullable(),
    days: z.number(),
    created: z.number(),
    moved: z.number(),
    removed: z.number(),
    reslotted: z.number(),
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
    let now = new Date();
    if (args.today && isDateKey(args.today) && args.today !== dateKeyInZone(now, tz)) {
      const [y = 1970, m = 1, d = 1] = args.today.split("-").map(Number);
      now = new Date(zonedWallTimeToUtcIso({ year: y, month: m, day: d, hour: 9, minute: 0 }, tz));
    }
    if (Date.parse(row.deadlineAt) <= now.getTime()) {
      fail("The deadline has passed, so there is nothing left to plan.", {
        errorCode: "deadline_passed",
      });
    }
    const db = getDb();
    const { tasks, ideas, submissionItems, hackathons } = schema;
    const existing = await db
      .select()
      .from(tasks)
      .where(eq(tasks.hackathonId, row.id))
      .limit(500);
    const msOf = (t: { milestone: string | null; phase: string }): MilestoneId =>
      isMilestoneId(t.milestone) ? t.milestone : milestoneForPhase(t.phase);
    const complete = Object.fromEntries(
      MILESTONE_IDS.map((id) => {
        const mine = existing.filter((t) => msOf(t) === id);
        return [id, mine.length > 0 && mine.every((t) => t.done)];
      }),
    ) as Record<MilestoneId, boolean>;

    const milestones = computeMilestones({
      startAt: planStartAt(row),
      deadlineAt: row.deadlineAt,
      timezone: tz,
      now,
      complete,
      ...(args.mode === "rebalance" ? { previous: row.milestones ?? [] } : {}),
    });
    const reslotted = milestones.filter((m) => m.reslotted).length;

    let created = 0;
    let removed = 0;
    if (args.mode === "fresh") {
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
        todayKey: dateKeyInZone(now, tz),
        deadlineKey: dateKeyInZone(new Date(row.deadlineAt), tz),
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
        milestones,
        timezone: tz,
        now,
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
              milestone: p.milestone,
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
    }

    // Persist the backbone, then pull stranded tasks into their milestone.
    await db
      .update(hackathons)
      .set({ milestones, updatedAt: nowIso() })
      .where(eq(hackathons.id, row.id));
    const after = await db
      .select()
      .from(tasks)
      .where(eq(tasks.hackathonId, row.id))
      .limit(500);
    const moves = rebalanceToMilestones(
      after.map((t) => ({ id: t.id, day: t.day, done: t.done, milestone: msOf(t) })),
      milestones,
      tz,
      now,
    );
    const backfill = after.filter((t) => !isMilestoneId(t.milestone));
    await db.transaction(async (tx) => {
      for (const [id, day] of moves) {
        await tx
          .update(tasks)
          .set({ day, updatedAt: nowIso() })
          .where(and(eq(tasks.id, id), eq(tasks.hackathonId, row.id)));
      }
      for (const t of backfill) {
        await tx
          .update(tasks)
          .set({ milestone: msOf(t) })
          .where(and(eq(tasks.id, t.id), eq(tasks.hackathonId, row.id)));
      }
    });
    const moved = moves.size;
    await touchHackathon(row.id);
    const final = await db
      .select()
      .from(tasks)
      .where(eq(tasks.hackathonId, row.id))
      .orderBy(tasks.day, tasks.position)
      .limit(500);
    const days = new Set(final.map((t) => t.day)).size;
    const finalComplete = (id: MilestoneId) => {
      const mine = final.filter((t) => msOf(t) === id);
      return mine.length > 0 && mine.every((t) => t.done);
    };
    const next = milestones.find((m) => !finalComplete(m.id)) ?? null;
    const nextLabel = next
      ? `${next.title} by ${formatInZone(next.dueAt, tz, { weekday: "short", month: "short", day: "numeric", hour: "numeric", timeZoneName: "short" })}`
      : null;
    const message =
      args.mode === "rebalance"
        ? moved || reslotted
          ? `Caught up: ${reslotted ? `re-slotted ${reslotted} milestone${reslotted === 1 ? "" : "s"}, ` : ""}moved ${moved} task${moved === 1 ? "" : "s"}.${nextLabel ? ` Next: ${nextLabel}.` : ""}`
          : `You're on track; nothing needed moving.${nextLabel ? ` Next: ${nextLabel}.` : ""}`
        : `Plan ready: ${final.length} tasks across 4 milestones.${nextLabel ? ` Next: ${nextLabel}.` : ""}`;
    return {
      hackathonId: row.id,
      mode: args.mode,
      timezone: tz,
      milestones,
      nextMilestone: next,
      days,
      created,
      moved,
      removed,
      reslotted,
      tasks: final.map(serializeTask),
      message,
    };
  },
});
