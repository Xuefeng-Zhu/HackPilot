import { defineAction } from "@agent-native/core/action";
import { ACTION_CHAT_UI_DATA_TABLE_RENDERER } from "@agent-native/core/action-ui";
import {
  createDataTableWidgetResult,
  dataTableWidgetResultSchema,
} from "@agent-native/core/data-widgets";
import { z } from "zod";

import {
  hackathonLink,
  loadChildren,
  requireHackathon,
} from "../server/lib/workspace.js";

export default defineAction({
  description:
    "Show the idea leaderboard for a hackathon as a table in chat: ideas ranked by weighted rubric score with per-criterion scores. Use when the user asks which idea is best or to compare ideas.",
  schema: z.object({ hackathonId: z.string().describe("Hackathon id") }),
  outputSchema: dataTableWidgetResultSchema,
  chatUI: {
    renderer: ACTION_CHAT_UI_DATA_TABLE_RENDERER,
    title: "Idea leaderboard",
  },
  http: { method: "GET" },
  readOnly: true,
  link: ({ args }) => hackathonLink(args.hackathonId, "ideas"),
  run: async ({ hackathonId }) => {
    const row = await requireHackathon(hackathonId);
    const { ideas } = await loadChildren(row.id, row.rubric);
    const ranked = [...ideas].sort(
      (a, b) => (b.weightedScore ?? -1) - (a.weightedScore ?? -1),
    );
    const link = hackathonLink(row.id, "ideas");
    return createDataTableWidgetResult({
      title: `${row.name} — idea leaderboard`,
      summary: {
        ideas: ideas.length,
        leader: ranked[0]?.title ?? null,
        leaderScore: ranked[0]?.weightedScore ?? null,
      },
      display: { primaryAction: { label: "Open idea board", href: link.url } },
      table: {
        title: "Ranked by weighted rubric score (0-10)",
        columns: [
          { key: "rank", label: "#", align: "right" },
          { key: "idea", label: "Idea" },
          { key: "total", label: "Weighted", align: "right" },
          ...row.rubric.map((c) => ({
            key: c.id,
            label: `${c.name} (${c.weight}%)`,
            align: "right" as const,
          })),
        ],
        rows: ranked.slice(0, 50).map((idea, i) => ({
          rank: i + 1,
          idea: `${idea.selected ? "★ " : ""}${idea.title}`,
          total: idea.weightedScore ?? "—",
          ...Object.fromEntries(
            row.rubric.map((c) => [c.id, idea.scores[c.id] ?? "—"]),
          ),
        })),
        totalRows: ideas.length,
        truncated: ideas.length > 50,
      },
    });
  },
});
