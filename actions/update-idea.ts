import { defineAction, fail } from "@agent-native/core/action";
import { and, eq, ne } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import {
  hackathonLink,
  nowIso,
  one,
  requireHackathon,
  serializeIdea,
} from "../server/lib/workspace.js";
import { ideaOut } from "../shared/outputs.js";

export default defineAction({
  description:
    "Patch an idea card: title, pitch, tags, or selected (true marks it as THE idea for this hackathon and unselects the others). Use score-idea for scores, reorder-ideas for order, delete=true to remove the card.",
  schema: z.object({
    id: z.string().describe("Idea id"),
    title: z.string().min(1).max(140).optional().describe("New title"),
    pitch: z.string().max(1200).optional().describe("New pitch"),
    tags: z
      .array(z.string().min(1).max(32))
      .max(8)
      .optional()
      .describe("Replacement tag list"),
    selected: z
      .boolean()
      .optional()
      .describe(
        "true to choose this idea (only one per hackathon), false to unselect",
      ),
    delete: z.boolean().optional().describe("true to delete the card"),
  }),
  outputSchema: z.object({
    id: z.string(),
    hackathonId: z.string(),
    deleted: z.boolean(),
    idea: ideaOut.nullable(),
    message: z.string(),
  }),
  link: ({ result }) => hackathonLink(result.hackathonId, "ideas"),
  run: async (args) => {
    const db = getDb();
    const { ideas } = schema;
    const [idea] = await db
      .select({ id: ideas.id, hackathonId: ideas.hackathonId })
      .from(ideas)
      .where(eq(ideas.id, args.id))
      .limit(1);
    if (!idea)
      fail("Idea not found.", { errorCode: "not_found", statusCode: 404 });
    const row = await requireHackathon(idea.hackathonId, "editor");
    if (args.delete) {
      await db
        .delete(ideas)
        .where(and(eq(ideas.id, idea.id), eq(ideas.hackathonId, row.id)));
      return {
        id: idea.id,
        hackathonId: row.id,
        deleted: true,
        idea: null,
        message: "Idea deleted.",
      };
    }
    const patch: Partial<typeof ideas.$inferInsert> = { updatedAt: nowIso() };
    if (args.title !== undefined) patch.title = args.title.trim();
    if (args.pitch !== undefined) patch.pitch = args.pitch.trim();
    if (args.tags !== undefined)
      patch.tags = args.tags.map((t) => t.trim().toLowerCase());
    if (args.selected !== undefined) patch.selected = args.selected;
    if (Object.keys(patch).length === 1) {
      fail("Nothing to update: pass at least one field.", {
        errorCode: "empty_patch",
      });
    }
    const updated = await db.transaction(async (tx) => {
      if (args.selected) {
        await tx
          .update(ideas)
          .set({ selected: false })
          .where(and(eq(ideas.hackathonId, row.id), ne(ideas.id, idea.id)));
      }
      const u = one(
        await tx
          .update(ideas)
          .set(patch)
          .where(and(eq(ideas.id, idea.id), eq(ideas.hackathonId, row.id)))
          .returning(),
      );
      return u;
    });
    return {
      id: updated.id,
      hackathonId: row.id,
      deleted: false,
      idea: serializeIdea(updated, row.rubric),
      message: args.selected
        ? `Selected “${updated.title}”.`
        : `Updated “${updated.title}”.`,
    };
  },
});
