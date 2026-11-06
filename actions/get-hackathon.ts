import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import {
  hackathonLink,
  loadChildren,
  requireHackathon,
  serializeHackathon,
} from "../server/lib/workspace.js";
import { workspaceOut } from "../shared/outputs.js";

const boolParam = z.union([z.boolean(), z.enum(["true", "false"])]);

export default defineAction({
  description:
    "Get one hackathon workspace: the record (deadline, timezone, prizes, weighted rubric), idea cards with per-criterion scores and weighted totals (0-10), the day-by-day sprint tasks, and the submission checklist. Pass includeSource=true to also read the imported page text.",
  schema: z.object({
    id: z.string().min(1).describe("Hackathon id from list-hackathons"),
    includeSource: boolParam
      .optional()
      .describe(
        "true to include the imported page text (up to 40k chars); default false",
      ),
  }),
  outputSchema: workspaceOut,
  http: { method: "GET" },
  readOnly: true,
  link: ({ args }) => hackathonLink(args.id),
  run: async ({ id, includeSource }) => {
    const row = await requireHackathon(id);
    const hackathon = serializeHackathon(
      row,
      includeSource === true || includeSource === "true",
    );
    const children = await loadChildren(row.id, hackathon.rubric);
    return {
      hackathon,
      ...children,
      progress: {
        tasksDone: children.tasks.filter((t) => t.done).length,
        tasksTotal: children.tasks.length,
        submissionDone: children.submissionItems.filter(
          (s) => s.status === "done",
        ).length,
        submissionTotal: children.submissionItems.length,
        selectedIdeaId: children.ideas.find((i) => i.selected)?.id ?? null,
      },
    };
  },
});
