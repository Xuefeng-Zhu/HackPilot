import { defineAction, fail } from "@agent-native/core/action";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import { aiGenerateIdeas, researchHackathonTech } from "../server/lib/ai-ideas.js";
import {
  hackathonLink,
  nextPosition,
  requireHackathon,
  serializeIdea,
  touchHackathon,
  validateScores,
} from "../server/lib/workspace.js";
import { ideaOut } from "../shared/outputs.js";

export default defineAction({
  description:
    "One-shot server-side brainstorm: an open-weight model on the Otari gateway (after optional Otari-managed MCP research on the sponsor tech) proposes N new rubric-scored ideas for a hackathon and adds them to the board. Fails with llm_not_configured when no model key is set — then brainstorm yourself and call add-ideas with scores.",
  schema: z.object({
    hackathonId: z.string().describe("Hackathon id"),
    count: z.coerce
      .number()
      .int()
      .min(1)
      .max(8)
      .default(4)
      .describe("How many ideas, 1-8; default 4"),
    brief: z
      .string()
      .max(1000)
      .optional()
      .describe("Direction from the user, e.g. 'dev tools, solo, 3 days'"),
    research: z
      .boolean()
      .optional()
      .describe("Research the sponsor tech through Otari-managed MCP first (default true when configured)"),
  }),
  outputSchema: z.object({
    hackathonId: z.string(),
    ideas: z.array(ideaOut),
    model: z.string(),
    research: z
      .object({
        server: z.string(),
        model: z.string(),
        toolsUsed: z.array(z.string()),
        otariRequestId: z.string().optional(),
      })
      .optional(),
    otariRequestId: z.string().optional(),
    message: z.string(),
  }),
  link: ({ args }) => hackathonLink(args.hackathonId, "ideas"),
  run: async (args, ctx) => {
    const row = await requireHackathon(args.hackathonId, "editor");
    if (!row.rubric.length) {
      fail(
        "Add a judging rubric first (update-hackathon) so ideas can be scored.",
        { errorCode: "no_rubric" },
      );
    }
    const db = getDb();
    const { ideas } = schema;
    const existing = await db
      .select({ title: ideas.title })
      .from(ideas)
      .where(eq(ideas.hackathonId, row.id))
      .limit(200);
    const research = args.research === false ? null : await researchHackathonTech(row, args.brief);
    const { object, model, otariRequestId } = await aiGenerateIdeas(row, {
      count: args.count,
      ...(args.brief ? { brief: args.brief } : {}),
      existingTitles: existing.map((e) => e.title),
      ...(research ? { research: research.text } : {}),
    });
    const posRows = await db
      .select({ max: sql<number>`coalesce(max(${ideas.position}), -1)::int` })
      .from(ideas)
      .where(eq(ideas.hackathonId, row.id));
    const values = object.ideas.slice(0, args.count).map((idea, i) => ({
      id: crypto.randomUUID(),
      hackathonId: row.id,
      title: idea.title.slice(0, 140),
      pitch: idea.pitch.slice(0, 1200),
      tags: idea.tags.slice(0, 8).map((t) => t.toLowerCase().slice(0, 32)),
      scores: validateScores(idea.scores as Record<string, number>, row.rubric),
      rationale: idea.rationale.slice(0, 1500),
      position: nextPosition(posRows) + i,
      source: "llm",
      ownerEmail: ctx?.userEmail ?? row.ownerEmail,
      orgId: row.orgId,
    }));
    if (!values.length)
      fail("The model returned no ideas.", {
        errorCode: "llm_failed",
        statusCode: 502,
      });
    const inserted = await db.insert(ideas).values(values).returning();
    await touchHackathon(row.id);
    return {
      hackathonId: row.id,
      ideas: inserted.map((i) => serializeIdea(i, row.rubric)),
      model,
      ...(research
        ? {
            research: {
              server: research.server,
              model: research.model,
              toolsUsed: research.toolsUsed,
              ...(research.requestId ? { otariRequestId: research.requestId } : {}),
            },
          }
        : {}),
      ...(otariRequestId ? { otariRequestId } : {}),
      message: `Generated ${inserted.length} scored ideas with ${model}${research ? ` after researching the sponsor tech via ${research.server} MCP on Otari` : ""}.`,
    };
  },
});
