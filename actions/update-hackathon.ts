import { defineAction, fail } from "@agent-native/core/action";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import {
  hackathonLink,
  nowIso,
  one,
  requireHackathon,
  serializeHackathon,
} from "../server/lib/workspace.js";
import {
  criterionSchema,
  preserveRubricIds,
  prizeSchema,
} from "../shared/hackpilot.js";
import { hackathonOut } from "../shared/outputs.js";
import {
  isValidTimezone,
  toUtcIso,
  zonedWallTimeToUtcIso,
} from "../shared/time.js";

export default defineAction({
  description:
    "Patch a hackathon record: name, url, tagline, notes, deadline (deadlineAt ISO with offset, or deadlineLocal wall time in timezone), timezone, and full replacements of prizes or the judging rubric. Rubric criterion ids are kept stable so idea scores survive; changing weights re-ranks ideas instantly.",
  schema: z.object({
    id: z.string().describe("Hackathon id"),
    name: z.string().min(1).max(200).optional().describe("New name"),
    url: z
      .string()
      .max(2000)
      .nullable()
      .optional()
      .describe("Source URL; null clears"),
    tagline: z
      .string()
      .max(500)
      .nullable()
      .optional()
      .describe("One-line theme; null clears"),
    notes: z
      .string()
      .max(5000)
      .nullable()
      .optional()
      .describe("Free-form notes (markdown); null clears"),
    deadlineAt: z
      .string()
      .datetime({ offset: true })
      .nullable()
      .optional()
      .describe(
        "Deadline instant, ISO 8601 with offset, e.g. 2026-11-09T23:59:00-08:00; null clears",
      ),
    deadlineLocal: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
      .optional()
      .describe(
        "Deadline as wall time YYYY-MM-DDTHH:mm interpreted in `timezone` (or the current one)",
      ),
    timezone: z
      .string()
      .optional()
      .describe("IANA timezone of the deadline, e.g. America/Los_Angeles"),
    prizes: z
      .array(prizeSchema)
      .max(30)
      .optional()
      .describe("Full replacement list of prizes"),
    rubric: z
      .array(criterionSchema)
      .max(12)
      .optional()
      .describe(
        "Full replacement list of judging criteria; keep existing ids to preserve scores",
      ),
  }),
  outputSchema: z.object({
    id: z.string(),
    hackathon: hackathonOut,
    message: z.string(),
  }),
  link: ({ result }) => hackathonLink(result.id, "overview"),
  run: async (args) => {
    const row = await requireHackathon(args.id, "editor");
    if (args.timezone !== undefined && !isValidTimezone(args.timezone)) {
      fail(
        `Unknown timezone "${args.timezone}". Use an IANA name like America/Los_Angeles.`,
        {
          errorCode: "invalid_timezone",
        },
      );
    }
    const timezone = args.timezone ?? row.timezone;
    const patch: Partial<typeof schema.hackathons.$inferInsert> = {
      updatedAt: nowIso(),
    };
    if (args.name !== undefined) patch.name = args.name.trim();
    if (args.url !== undefined) patch.url = args.url;
    if (args.tagline !== undefined) patch.tagline = args.tagline;
    if (args.notes !== undefined) patch.notes = args.notes;
    if (args.timezone !== undefined) patch.timezone = timezone;
    if (args.deadlineLocal) {
      const [year = 0, month = 1, day = 1, hour = 0, minute = 0] =
        args.deadlineLocal.split(/[-T:]/).map(Number);
      patch.deadlineAt = zonedWallTimeToUtcIso(
        { year, month, day, hour, minute },
        timezone,
      );
    } else if (args.deadlineAt !== undefined) {
      patch.deadlineAt =
        args.deadlineAt === null ? null : toUtcIso(new Date(args.deadlineAt));
    }
    if (args.prizes) patch.prizes = args.prizes;
    if (args.rubric) patch.rubric = preserveRubricIds(row.rubric, args.rubric);
    if (Object.keys(patch).length === 1) {
      fail("Nothing to update: pass at least one field.", {
        errorCode: "empty_patch",
      });
    }
    if (
      args.prizes ||
      args.rubric ||
      args.deadlineAt !== undefined ||
      args.deadlineLocal
    ) {
      patch.extraction =
        row.extraction === "manual"
          ? "manual"
          : `${row.extraction.replace(/\+edited$/, "")}+edited`;
    }
    const updated = one(
      await getDb()
        .update(schema.hackathons)
        .set(patch)
        .where(eq(schema.hackathons.id, row.id))
        .returning(),
    );
    return {
      id: row.id,
      hackathon: serializeHackathon(updated),
      message: `Updated ${updated.name}.`,
    };
  },
});
