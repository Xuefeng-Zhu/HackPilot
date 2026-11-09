import { defineAction, fail } from "@agent-native/core/action";
import { accessFilter } from "@agent-native/core/sharing";
import { and, eq, exists, isNull } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import { verifyClipsShare } from "../server/lib/clips-proof.js";
import {
  hackathonLink,
  nowIso,
  requireHackathon,
  serializeItem,
} from "../server/lib/workspace.js";
import { submissionItemOut } from "../shared/outputs.js";

export default defineAction({
  description:
    "Verify that Agent-Native Clips reports the share link as a ready public video, then save it on the workspace's demo video checklist item. Leaves the item's status unchanged.",
  schema: z.object({
    hackathonId: z.string().min(1).describe("Hackathon workspace id"),
    itemId: z.string().min(1).describe("Demo video checklist item id"),
    url: z
      .string()
      .trim()
      .min(1)
      .max(2000)
      .describe("Public https://clips.agent-native.com/share/... link"),
  }),
  outputSchema: z.object({
    hackathonId: z.string(),
    item: submissionItemOut,
    message: z.string(),
  }),
  link: ({ result }) => hackathonLink(result.hackathonId, "checklist"),
  run: async ({ hackathonId, itemId, url }, ctx) => {
    const { hackathons, hackathonShares, submissionItems } = schema;
    const db = getDb();
    await requireHackathon(hackathonId, "editor");
    const target = and(
      eq(submissionItems.id, itemId),
      eq(submissionItems.hackathonId, hackathonId),
      eq(submissionItems.kind, "demo_video"),
    );
    const [item] = await db
      .select({ link: submissionItems.link })
      .from(submissionItems)
      .where(target)
      .limit(1);
    if (!item) {
      fail("Demo video checklist item not found in this hackathon.", {
        errorCode: "not_found",
        statusCode: 404,
      });
    }

    const verifiedLink = await verifyClipsShare(url, ctx?.signal);
    const canEdit = db
      .select({ id: hackathons.id })
      .from(hackathons)
      .where(
        and(
          eq(hackathons.id, hackathonId),
          accessFilter(hackathons, hackathonShares, undefined, "editor"),
        ),
      );
    const [updated] = await db
      .update(submissionItems)
      .set({ link: verifiedLink, updatedAt: nowIso() })
      .where(
        and(
          target,
          exists(canEdit),
          item.link === null
            ? isNull(submissionItems.link)
            : eq(submissionItems.link, item.link),
        ),
      )
      .returning();
    if (!updated) {
      fail(
        "The checklist item or your access changed during verification. Refresh and try again.",
        {
          errorCode: "clips_proof_conflict",
          statusCode: 409,
        },
      );
    }
    return {
      hackathonId,
      item: serializeItem(updated),
      message: "Public Clips recording verified and attached.",
    };
  },
});
