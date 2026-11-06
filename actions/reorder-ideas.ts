import { defineAction, fail } from "@agent-native/core/action";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import { hackathonLink, requireHackathon } from "../server/lib/workspace.js";

export default defineAction({
  description:
    "Set the manual order of idea cards on the board (drag-to-reorder). Pass every idea id in the new order; ids not listed keep their relative order after the listed ones.",
  schema: z.object({
    hackathonId: z.string().describe("Hackathon id"),
    ids: z
      .array(z.string())
      .min(1)
      .max(200)
      .describe("Idea ids in the desired top-to-bottom order"),
  }),
  outputSchema: z.object({
    hackathonId: z.string(),
    order: z.array(z.string()),
    message: z.string(),
  }),
  link: ({ args }) => hackathonLink(args.hackathonId, "ideas"),
  run: async ({ hackathonId, ids }) => {
    const row = await requireHackathon(hackathonId, "editor");
    const db = getDb();
    const { ideas } = schema;
    const all = await db
      .select({ id: ideas.id, position: ideas.position })
      .from(ideas)
      .where(eq(ideas.hackathonId, row.id))
      .orderBy(ideas.position)
      .limit(200);
    const known = new Set(all.map((i) => i.id));
    const missing = ids.filter((id) => !known.has(id));
    if (missing.length) {
      fail(`Idea id(s) not on this board: ${missing.join(", ")}`, {
        errorCode: "not_found",
        statusCode: 404,
      });
    }
    const listed = new Set(ids);
    const order = [
      ...new Set(ids),
      ...all.filter((i) => !listed.has(i.id)).map((i) => i.id),
    ];
    await db.transaction(async (tx) => {
      for (const [position, id] of order.entries()) {
        await tx
          .update(ideas)
          .set({ position })
          .where(
            and(
              eq(ideas.id, id),
              eq(ideas.hackathonId, row.id),
              inArray(ideas.id, order),
            ),
          );
      }
    });
    return {
      hackathonId: row.id,
      order,
      message: `Reordered ${order.length} ideas.`,
    };
  },
});
