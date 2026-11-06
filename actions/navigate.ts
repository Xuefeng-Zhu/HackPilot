import { defineAction } from "@agent-native/core/action";
import { writeAppStateForCurrentTab } from "@agent-native/core/application-state";
import { z } from "zod";

export default defineAction({
  description:
    'Navigate the UI. Use view "hackathons" for the list, or view "hackathon" with hackathonId and optional tab (overview, ideas, plan, checklist) to open a workspace; path also works, e.g. /hackathons/<id>?tab=plan.',
  schema: z.object({
    view: z.string().optional().describe("View name to navigate to"),
    path: z.string().optional().describe("URL path to navigate to"),
    threadId: z.string().optional().describe("Chat thread ID to open"),
    hackathonId: z
      .string()
      .optional()
      .describe('Hackathon id when view is "hackathon"'),
    tab: z
      .enum(["overview", "ideas", "plan", "checklist"])
      .optional()
      .describe('Workspace tab when view is "hackathon"'),
  }),
  http: false,
  run: async (args) => {
    if (!args.view && !args.path) {
      throw new Error("At least --view or --path is required.");
    }
    const nav: Record<string, string> = {};
    if (args.view) nav.view = args.view;
    if (args.path) nav.path = args.path;
    if (args.threadId) nav.threadId = args.threadId;
    if (args.hackathonId) nav.hackathonId = args.hackathonId;
    if (args.tab) nav.tab = args.tab;
    if (args.view === "hackathon" && args.hackathonId && !args.path) {
      nav.path = `/hackathons/${encodeURIComponent(args.hackathonId)}${args.tab ? `?tab=${args.tab}` : ""}`;
    }
    nav._writeId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await writeAppStateForCurrentTab("navigate", nav);
    return `Navigating to ${args.view || args.path}`;
  },
});
