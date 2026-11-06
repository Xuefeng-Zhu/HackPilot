import { defineAction, fail } from "@agent-native/core/action";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import {
  hackathonLink,
  nextPosition,
  nowIso,
  one,
  requireHackathon,
  serializeItem,
} from "../server/lib/workspace.js";
import { SUBMISSION_KINDS, SUBMISSION_STATUSES } from "../shared/hackpilot.js";
import { submissionItemOut } from "../shared/outputs.js";

export default defineAction({
  description:
    'Create, update, or delete a submission checklist item. Omit id and pass hackathonId + label to add one. With id: set status ("todo", "in_progress", "done"), link (e.g. the demo video or repo URL), label, kind, detail, or delete=true.',
  schema: z.object({
    id: z.string().optional().describe("Checklist item id; omit to create"),
    hackathonId: z
      .string()
      .optional()
      .describe("Hackathon id; required when creating"),
    label: z.string().min(1).max(200).optional().describe("Requirement label"),
    kind: z
      .enum(SUBMISSION_KINDS)
      .optional()
      .describe(
        '"demo_video", "repo", "writeup", "deployment", "form", "slides", or "other"',
      ),
    detail: z
      .string()
      .max(600)
      .nullable()
      .optional()
      .describe("Constraints/notes; null clears"),
    status: z
      .enum(SUBMISSION_STATUSES)
      .optional()
      .describe('"todo", "in_progress", or "done"'),
    link: z
      .string()
      .max(2000)
      .nullable()
      .optional()
      .describe("URL proving the item (video, repo, form); null clears"),
    delete: z.boolean().optional().describe("true to delete the item"),
  }),
  outputSchema: z.object({
    id: z.string(),
    hackathonId: z.string(),
    deleted: z.boolean(),
    item: submissionItemOut.nullable(),
    message: z.string(),
  }),
  link: ({ result }) => hackathonLink(result.hackathonId, "checklist"),
  run: async (args, ctx) => {
    if (args.link && !/^https?:\/\//i.test(args.link)) {
      fail("link must be an http(s) URL.", { errorCode: "invalid_link" });
    }
    const db = getDb();
    const { submissionItems } = schema;
    if (!args.id) {
      if (!args.hackathonId || !args.label) {
        fail("To add an item pass hackathonId and label.", {
          errorCode: "missing_fields",
        });
      }
      const row = await requireHackathon(args.hackathonId, "editor");
      const posRows = await db
        .select({
          max: sql<number>`coalesce(max(${submissionItems.position}), -1)::int`,
        })
        .from(submissionItems)
        .where(eq(submissionItems.hackathonId, row.id));
      const created = one(
        await db
          .insert(submissionItems)
          .values({
            id: crypto.randomUUID(),
            hackathonId: row.id,
            label: args.label.trim(),
            kind: args.kind ?? "other",
            detail: args.detail ?? null,
            status: args.status ?? "todo",
            link: args.link ?? null,
            position: nextPosition(posRows),
            ownerEmail: ctx?.userEmail ?? row.ownerEmail,
            orgId: row.orgId,
          })
          .returning(),
      );
      return {
        id: created.id,
        hackathonId: row.id,
        deleted: false,
        item: serializeItem(created),
        message: `Added “${created.label}” to the checklist.`,
      };
    }
    const [item] = await db
      .select({
        id: submissionItems.id,
        hackathonId: submissionItems.hackathonId,
      })
      .from(submissionItems)
      .where(eq(submissionItems.id, args.id))
      .limit(1);
    if (!item)
      fail("Checklist item not found.", {
        errorCode: "not_found",
        statusCode: 404,
      });
    const row = await requireHackathon(item.hackathonId, "editor");
    if (args.delete) {
      await db
        .delete(submissionItems)
        .where(
          and(
            eq(submissionItems.id, item.id),
            eq(submissionItems.hackathonId, row.id),
          ),
        );
      return {
        id: item.id,
        hackathonId: row.id,
        deleted: true,
        item: null,
        message: "Item removed.",
      };
    }
    const patch: Partial<typeof submissionItems.$inferInsert> = {
      updatedAt: nowIso(),
    };
    if (args.label !== undefined) patch.label = args.label.trim();
    if (args.kind !== undefined) patch.kind = args.kind;
    if (args.detail !== undefined) patch.detail = args.detail;
    if (args.status !== undefined) patch.status = args.status;
    if (args.link !== undefined) patch.link = args.link;
    if (Object.keys(patch).length === 1) {
      fail("Nothing to update: pass at least one field.", {
        errorCode: "empty_patch",
      });
    }
    const updated = one(
      await db
        .update(submissionItems)
        .set(patch)
        .where(
          and(
            eq(submissionItems.id, item.id),
            eq(submissionItems.hackathonId, row.id),
          ),
        )
        .returning(),
    );
    return {
      id: updated.id,
      hackathonId: row.id,
      deleted: false,
      item: serializeItem(updated),
      message: `“${updated.label}” is ${updated.status.replace("_", " ")}.`,
    };
  },
});
