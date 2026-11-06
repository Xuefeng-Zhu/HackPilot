import { defineAction } from "@agent-native/core/action";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import {
  hackathonLink,
  ideaSource,
  nextPosition,
  requireHackathon,
  serializeIdea,
  touchHackathon,
  validateScores,
} from "../server/lib/workspace.js";
import { ideaScoresSchema } from "../shared/hackpilot.js";
import { ideaOut } from "../shared/outputs.js";

export default defineAction({
  description:
    "Add 1-12 idea cards to a hackathon's idea board in one call, optionally pre-scored. Scores are 0-10 per rubric criterion id (see get-hackathon rubric); the weighted total is computed from rubric weights. Use this after brainstorming ideas yourself.",
  schema: z.object({
    hackathonId: z.string().describe("Hackathon id"),
    ideas: z
      .array(
        z.object({
          title: z
            .string()
            .min(1)
            .max(140)
            .describe("Short, memorable idea name"),
          pitch: z
            .string()
            .max(1200)
            .default("")
            .describe(
              "2-3 sentence pitch: user, problem, agent's job, wow moment",
            ),
          tags: z
            .array(z.string().min(1).max(32))
            .max(8)
            .optional()
            .describe('Short tags, e.g. ["productivity","data viz"]'),
          scores: ideaScoresSchema.optional(),
          rationale: z
            .string()
            .max(1500)
            .optional()
            .describe("Why these scores, one line per criterion"),
        }),
      )
      .min(1)
      .max(12)
      .describe("Ideas to add, in display order"),
  }),
  outputSchema: z.object({
    hackathonId: z.string(),
    ideas: z.array(ideaOut),
    message: z.string(),
  }),
  link: ({ args }) => hackathonLink(args.hackathonId, "ideas"),
  run: async (args, ctx) => {
    const row = await requireHackathon(args.hackathonId, "editor");
    const ownerEmail = ctx?.userEmail ?? row.ownerEmail;
    const db = getDb();
    const { ideas } = schema;
    const posRows = await db
      .select({ max: sql<number>`coalesce(max(${ideas.position}), -1)::int` })
      .from(ideas)
      .where(eq(ideas.hackathonId, row.id));
    const source = ideaSource(ctx?.caller);
    const values = args.ideas.map((idea, i) => ({
      id: crypto.randomUUID(),
      hackathonId: row.id,
      title: idea.title.trim(),
      pitch: idea.pitch.trim(),
      tags: (idea.tags ?? []).map((t) => t.trim().toLowerCase()),
      scores: validateScores(idea.scores, row.rubric),
      rationale: idea.rationale ?? null,
      position: nextPosition(posRows) + i,
      source,
      ownerEmail,
      orgId: row.orgId,
    }));
    const inserted = await db.insert(ideas).values(values).returning();
    await touchHackathon(row.id);
    return {
      hackathonId: row.id,
      ideas: inserted.map((i) => serializeIdea(i, row.rubric)),
      message: `Added ${inserted.length} idea${inserted.length === 1 ? "" : "s"} to ${row.name}.`,
    };
  },
});
