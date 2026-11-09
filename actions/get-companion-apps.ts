import { defineAction, fail } from "@agent-native/core/action";
import { resolveAccess, roleSatisfies } from "@agent-native/core/sharing";
import { z } from "zod";

import {
  currentCompanionUser,
  listCompanionConnections,
} from "../server/lib/companion-apps.js";
import "../server/db/index.js";

export default defineAction({
  description:
    "Read this user's saved companion app connection status for a HackPilot workspace.",
  schema: z.object({
    hackathonId: z.string().min(1).max(200).describe("Hackathon workspace ID"),
  }),
  outputSchema: z.object({
    canEdit: z.boolean(),
    connected: z.object({
      content: z.boolean(),
      slides: z.boolean(),
      plan: z.boolean(),
      design: z.boolean(),
    }),
  }),
  agentTool: false,
  http: { method: "GET" },
  readOnly: true,
  persistInBrowser: false,
  run: async ({ hackathonId }) => {
    const userEmail = currentCompanionUser();
    const access = await resolveAccess("hackathon", hackathonId, undefined, {
      skipResourceBody: true,
    });
    if (!access) {
      fail("Hackathon not found.", { errorCode: "not_found", statusCode: 404 });
    }
    const canEdit = roleSatisfies(access.role, "editor");
    const connections = canEdit
      ? await listCompanionConnections(userEmail)
      : {};
    return {
      canEdit,
      connected: {
        content: Boolean(connections.content),
        slides: Boolean(connections.slides),
        plan: Boolean(connections.plan),
        design: Boolean(connections.design),
      },
    };
  },
});
