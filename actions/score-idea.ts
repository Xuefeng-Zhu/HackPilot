import { defineAction, fail } from "@agent-native/core/action";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import { aiScoreIdea, otariScoreMath } from "../server/lib/ai-ideas.js";
import {
  hackathonLink,
  nowIso,
  one,
  requireHackathon,
  serializeIdea,
  validateScores,
} from "../server/lib/workspace.js";
import { ideaScoresSchema } from "../shared/hackpilot.js";
import { ideaOut } from "../shared/outputs.js";

export default defineAction({
  description:
    "Score an idea 0-10 per rubric criterion id (partial updates merge with existing scores) and record a rationale; returns the new weighted total. Pass auto=true to have the server-side judge model (open-weight, via the Otari gateway) score it instead; otherwise judge it yourself and pass scores. With auto=true or verify=true the weighted total, per-criterion contributions, weakest criterion and hours left are computed in Otari's code-execution sandbox.",
  schema: z.object({
    id: z.string().describe("Idea id"),
    scores: ideaScoresSchema.optional(),
    rationale: z
      .string()
      .max(1500)
      .optional()
      .describe("Why, one short line per criterion"),
    auto: z
      .boolean()
      .optional()
      .describe("true to let the LLM score every criterion"),
    verify: z
      .boolean()
      .optional()
      .describe("true to compute the weighted total and time left in Otari's code-execution sandbox"),
  }),
  outputSchema: z.object({
    id: z.string(),
    hackathonId: z.string(),
    idea: ideaOut,
    math: z
      .object({
        computedBy: z.literal("otari_code_execution"),
        weightedScore: z.number(),
        contributions: z.record(z.string(), z.number()),
        weakest: z.string().nullable(),
        hoursLeft: z.number().nullable(),
        model: z.string(),
        otariRequestId: z.string().optional(),
      })
      .optional(),
    judge: z.object({ model: z.string(), otariRequestId: z.string().optional() }).optional(),
    message: z.string(),
  }),
  link: ({ result }) => hackathonLink(result.hackathonId, "ideas"),
  run: async (args) => {
    const db = getDb();
    const { ideas } = schema;
    const [idea] = await db
      .select()
      .from(ideas)
      .where(eq(ideas.id, args.id))
      .limit(1);
    if (!idea)
      fail("Idea not found.", { errorCode: "not_found", statusCode: 404 });
    const row = await requireHackathon(idea.hackathonId, "editor");
    if (!row.rubric.length) {
      fail(
        "This hackathon has no rubric yet. Add criteria with update-hackathon first.",
        {
          errorCode: "no_rubric",
        },
      );
    }
    let scores: Record<string, number>;
    let rationale = args.rationale ?? idea.rationale;
    let judge: { model: string; otariRequestId?: string } | undefined;
    if (args.auto) {
      const { object, model, otariRequestId } = await aiScoreIdea(row, idea);
      judge = { model, ...(otariRequestId ? { otariRequestId } : {}) };
      scores = validateScores(
        object.scores as Record<string, number>,
        row.rubric,
      );
      rationale = object.rationale;
    } else {
      if (!args.scores || Object.keys(args.scores).length === 0) {
        fail("Pass scores (criterion id → 0-10) or auto=true.", {
          errorCode: "empty_patch",
        });
      }
      scores = { ...idea.scores, ...validateScores(args.scores, row.rubric) };
    }
    const updated = one(
      await db
        .update(ideas)
        .set({ scores, rationale: rationale ?? null, updatedAt: nowIso() })
        .where(and(eq(ideas.id, idea.id), eq(ideas.hackathonId, row.id)))
        .returning(),
    );
    const out = serializeIdea(updated, row.rubric);
    const math = args.auto || args.verify ? await otariScoreMath(row.rubric, scores, row.deadlineAt) : null;
    const weakestName = math?.weakest ? (row.rubric.find((c) => c.id === math.weakest)?.name ?? math.weakest) : null;
    return {
      id: updated.id,
      hackathonId: row.id,
      idea: out,
      ...(math ? { math: { computedBy: "otari_code_execution" as const, ...math } } : {}),
      ...(judge ? { judge } : {}),
      message: `“${updated.title}” scores ${math?.weightedScore ?? out.weightedScore ?? "—"}/10 weighted${
        math
          ? ` (computed in Otari's sandbox${weakestName ? `; most headroom: ${weakestName}` : ""}${math.hoursLeft != null ? `; ${math.hoursLeft} h left` : ""})`
          : ""
      }.`,
    };
  },
});
