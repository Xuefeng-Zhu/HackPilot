import { defineAction, fail } from "@agent-native/core/action";
import { resolveAccess, roleSatisfies } from "@agent-native/core/sharing";
import { z } from "zod";

import {
  currentCompanionUser,
  listCompanionConnections,
} from "../server/lib/companion-apps.js";
import { readDesignPrototype } from "../server/lib/design-prototype.js";
import { COMPANION_ARTIFACT_ID_PATTERN } from "../shared/companion-apps.js";

export default defineAction({
  description:
    "Read this user's companion app connections and selected idea's saved Design prototype.",
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
    designPrototype: z
      .object({
        ideaId: z.string(),
        id: z.string().regex(COMPANION_ARTIFACT_ID_PATTERN),
        url: z.url(),
      })
      .nullable(),
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
    const [connections, designPrototype] = await Promise.all([
      canEdit ? listCompanionConnections(userEmail) : undefined,
      readDesignPrototype(hackathonId, userEmail),
    ]);
    return {
      canEdit,
      designPrototype,
      connected: {
        content: Boolean(connections?.content),
        slides: Boolean(connections?.slides),
        plan: Boolean(connections?.plan),
        design: Boolean(connections?.design),
      },
    };
  },
});
