import { defineAction } from "@agent-native/core/action";
import { ACTION_CHAT_UI_DATA_INSIGHTS_RENDERER } from "@agent-native/core/action-ui";
import {
  createDataInsightsWidgetResult,
  dataInsightsWidgetResultSchema,
} from "@agent-native/core/data-widgets";
import { z } from "zod";

import {
  hackathonLink,
  loadChildren,
  requireHackathon,
} from "../server/lib/workspace.js";
import {
  SUBMISSION_KIND_LABELS,
  type SubmissionKind,
} from "../shared/hackpilot.js";
import { countdownLabel, dateKeyInZone, formatInZone } from "../shared/time.js";

export default defineAction({
  description:
    "Audit submission readiness for a hackathon and show it in chat: time left, checklist status (what's missing, what lacks a proof link), overdue sprint tasks, and whether an idea is selected. Use before the deadline or when the user asks 'am I ready to submit?'.",
  schema: z.object({
    hackathonId: z.string().describe("Hackathon id"),
    timezone: z
      .string()
      .optional()
      .describe(
        "IANA timezone for 'today' when counting overdue tasks; defaults to the hackathon's",
      ),
  }),
  outputSchema: dataInsightsWidgetResultSchema,
  chatUI: {
    renderer: ACTION_CHAT_UI_DATA_INSIGHTS_RENDERER,
    title: "Submission readiness",
  },
  http: { method: "GET" },
  readOnly: true,
  link: ({ args }) => hackathonLink(args.hackathonId, "checklist"),
  run: async ({ hackathonId, timezone }) => {
    const row = await requireHackathon(hackathonId);
    const { ideas, tasks, submissionItems } = await loadChildren(
      row.id,
      row.rubric,
    );
    const tz = timezone || row.timezone;
    const today = dateKeyInZone(new Date(), tz);
    const done = submissionItems.filter((s) => s.status === "done");
    const missingLink = submissionItems.filter(
      (s) =>
        s.status === "done" &&
        !s.link &&
        ["demo_video", "repo", "deployment"].includes(s.kind),
    );
    const overdue = tasks.filter((t) => !t.done && t.day < today);
    const selected = ideas.find((i) => i.selected);
    const readiness = submissionItems.length
      ? Math.round((done.length / submissionItems.length) * 100)
      : 0;
    const blockers = [
      ...(!row.deadlineAt
        ? ["Deadline unknown — set it on the Overview tab."]
        : []),
      ...(!selected ? ["No idea selected yet."] : []),
      ...submissionItems
        .filter((s) => s.status !== "done")
        .map((s) => `Checklist: ${s.label} (${s.status.replace("_", " ")})`),
      ...missingLink.map((s) => `Add a proof link for “${s.label}”.`),
      ...(overdue.length
        ? [
            `${overdue.length} sprint task(s) overdue — run plan-sprint mode=rebalance.`,
          ]
        : []),
    ];
    const link = hackathonLink(row.id, "checklist");
    return createDataInsightsWidgetResult({
      title: `${row.name} — submission readiness`,
      summary: {
        readiness: `${readiness}%`,
        timeLeft: row.deadlineAt ? countdownLabel(row.deadlineAt) : "unknown",
        deadline: row.deadlineAt
          ? formatInZone(row.deadlineAt, row.timezone)
          : "unknown",
        selectedIdea: selected?.title ?? "none",
        overdueTasks: overdue.length,
        ready: blockers.length === 0,
        blockers,
      },
      display: {
        description: blockers.length
          ? `${blockers.length} thing(s) left before you can submit.`
          : "Everything on the checklist is done.",
        primaryAction: { label: "Open checklist", href: link.url },
      },
      table: {
        title: "Submission checklist",
        columns: [
          { key: "item", label: "Item" },
          { key: "kind", label: "Kind" },
          { key: "status", label: "Status" },
          { key: "link", label: "Proof link" },
        ],
        rows: submissionItems.map((s) => ({
          item: s.label,
          kind: SUBMISSION_KIND_LABELS[s.kind as SubmissionKind] ?? s.kind,
          status: s.status.replace("_", " "),
          link: s.link ?? "—",
        })),
      },
    });
  },
});
