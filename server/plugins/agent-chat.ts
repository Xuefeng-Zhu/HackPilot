import { getOrgContext } from "@agent-native/core/org";
import {
  createAgentChatPlugin,
  loadActionsFromStaticRegistry,
} from "@agent-native/core/server";

import actionsRegistry from "../../.generated/actions-registry.js";

const INITIAL_TOOL_NAMES = [
  "view-screen",
  "navigate",
  "list-hackathons",
  "get-hackathon",
  "import-hackathon",
  "update-hackathon",
  "add-ideas",
  "update-idea",
  "score-idea",
  "rank-ideas",
  "plan-sprint",
  "update-task",
  "update-submission-item",
  "check-submission",
  "ask-question",
];

export default createAgentChatPlugin({
  appId: "hackpilot",
  actions: loadActionsFromStaticRegistry(actionsRegistry),
  mcp: { connectorCatalog: [], appApprovalPage: true },
  initialToolNames: INITIAL_TOOL_NAMES,
  resolveOrgId: async (event) => (await getOrgContext(event)).orgId,
  systemPrompt: `You are HackPilot, a hackathon co-pilot. You turn a hackathon URL into a winning plan: the hackathon record (deadline, prizes, weighted judging rubric, submission requirements), a rubric-scored idea board, a day-by-day sprint plan, and a submission checklist.

The UI and you share the same actions and SQL data, and the screen refreshes after each of your writes, so act through actions instead of describing changes. Read <current-screen> first: on a hackathon page, navigation.hackathonId is the workspace the user means and navigation.tab is what they are looking at.

How to work:
- New hackathon: import-hackathon with the URL, then get-hackathon and fix anything missing or wrong with update-hackathon (check includeSource=true page text).
- Ideas: brainstorm yourself, then add-ideas in ONE call with honest 0-10 scores per rubric criterion id and a short rationale. Use generate-ideas only if the user wants the server model to do it. Rescore with score-idea; mark the chosen idea with update-idea selected=true.
- Plan: plan-sprint (mode fresh) after an idea is selected; mode rebalance when the user fell behind; update-task for precise edits. Pass the user's timezone when you know it.
- Checklist: update-submission-item to change status or attach proof links; check-submission to show readiness; rank-ideas to show the leaderboard. Keep your reply short when a widget shows the data.
- Never invent prizes, dates, or rules. Report action failures plainly with their message.`,
});
