import { defineAction } from "@agent-native/core/action";
import { buildDeepLink } from "@agent-native/core/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import { requireHackathon } from "../server/lib/workspace.js";

export default defineAction({
  description:
    "Permanently delete a hackathon workspace with its ideas, tasks, and checklist. Only call when the user explicitly asks.",
  schema: z.object({ id: z.string().describe("Hackathon id") }),
  outputSchema: z.object({
    id: z.string(),
    deleted: z.literal(true),
    message: z.string(),
  }),
  needsApproval: (_args, ctx) => ctx?.caller !== "frontend",
  link: () => ({
    url: buildDeepLink({ view: "hackathons", to: "/hackathons" }),
    label: "Open HackPilot",
  }),
  run: async ({ id }) => {
    const row = await requireHackathon(id, "admin");
    const db = getDb();
    await db.transaction(async (tx) => {
      await tx.delete(schema.ideas).where(eq(schema.ideas.hackathonId, row.id));
      await tx.delete(schema.tasks).where(eq(schema.tasks.hackathonId, row.id));
      await tx
        .delete(schema.submissionItems)
        .where(eq(schema.submissionItems.hackathonId, row.id));
      await tx
        .delete(schema.hackathonShares)
        .where(eq(schema.hackathonShares.resourceId, row.id));
      await tx
        .delete(schema.hackathons)
        .where(eq(schema.hackathons.id, row.id));
    });
    return {
      id: row.id,
      deleted: true as const,
      message: `Deleted ${row.name}.`,
    };
  },
});
