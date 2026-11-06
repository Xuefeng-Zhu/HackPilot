import { defineAction } from "@agent-native/core/action";
import { buildDeepLink } from "@agent-native/core/server";
import { accessFilter } from "@agent-native/core/sharing";
import { desc, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import {
  formatMoney,
  totalPrizePool,
  weightedScore,
} from "../shared/hackpilot.js";
import { hackathonSummaryOut } from "../shared/outputs.js";
import { countdownLabel } from "../shared/time.js";

export default defineAction({
  description:
    "List the hackathon workspaces the user can see, newest first, with deadline countdown, prize pool, top idea, and plan/checklist progress.",
  schema: z.object({}),
  outputSchema: z.object({ hackathons: z.array(hackathonSummaryOut) }),
  http: { method: "GET" },
  readOnly: true,
  link: () => ({
    url: buildDeepLink({ view: "hackathons", to: "/hackathons" }),
    label: "Open HackPilot",
  }),
  run: async () => {
    const db = getDb();
    const { hackathons, hackathonShares, ideas, tasks, submissionItems } =
      schema;
    const rows = await db
      .select({
        id: hackathons.id,
        name: hackathons.name,
        url: hackathons.url,
        tagline: hackathons.tagline,
        deadlineAt: hackathons.deadlineAt,
        timezone: hackathons.timezone,
        prizes: hackathons.prizes,
        rubric: hackathons.rubric,
        updatedAt: hackathons.updatedAt,
      })
      .from(hackathons)
      .where(accessFilter(hackathons, hackathonShares))
      .orderBy(desc(hackathons.updatedAt))
      .limit(100);
    if (rows.length === 0) return { hackathons: [] };
    const ids = rows.map((r) => r.id);
    const [ideaRows, taskCounts, itemCounts] = await Promise.all([
      db
        .select({
          hackathonId: ideas.hackathonId,
          title: ideas.title,
          scores: ideas.scores,
          selected: ideas.selected,
        })
        .from(ideas)
        .where(inArray(ideas.hackathonId, ids))
        .limit(2000),
      db
        .select({
          hackathonId: tasks.hackathonId,
          total: sql<number>`count(*)::int`,
          done: sql<number>`count(*) filter (where ${tasks.done})::int`,
        })
        .from(tasks)
        .where(inArray(tasks.hackathonId, ids))
        .groupBy(tasks.hackathonId),
      db
        .select({
          hackathonId: submissionItems.hackathonId,
          total: sql<number>`count(*)::int`,
          done: sql<number>`count(*) filter (where ${submissionItems.status} = 'done')::int`,
        })
        .from(submissionItems)
        .where(inArray(submissionItems.hackathonId, ids))
        .groupBy(submissionItems.hackathonId),
    ]);
    return {
      hackathons: rows.map((r) => {
        const mine = ideaRows.filter((i) => i.hackathonId === r.id);
        const selected = mine.find((i) => i.selected);
        const best = [...mine].sort(
          (a, b) =>
            (weightedScore(b.scores, r.rubric) ?? -1) -
            (weightedScore(a.scores, r.rubric) ?? -1),
        )[0];
        const pool = totalPrizePool(r.prizes ?? []);
        const t = taskCounts.find((c) => c.hackathonId === r.id);
        const s = itemCounts.find((c) => c.hackathonId === r.id);
        return {
          id: r.id,
          name: r.name,
          url: r.url,
          tagline: r.tagline,
          deadlineAt: r.deadlineAt,
          timezone: r.timezone,
          countdown: r.deadlineAt ? countdownLabel(r.deadlineAt) : null,
          prizePool: pool ? formatMoney(pool.amount, pool.currency) : null,
          ideaCount: mine.length,
          topIdea: (selected ?? best)?.title ?? null,
          tasksDone: Number(t?.done ?? 0),
          tasksTotal: Number(t?.total ?? 0),
          submissionDone: Number(s?.done ?? 0),
          submissionTotal: Number(s?.total ?? 0),
          updatedAt: r.updatedAt,
        };
      }),
    };
  },
});
