import { defineAction } from "@agent-native/core/action";
import { readAppState } from "@agent-native/core/application-state";
import { getRequestContext } from "@agent-native/core/server";
import { accessFilter } from "@agent-native/core/sharing";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import { readDesignPrototype } from "../server/lib/design-prototype.js";

export default defineAction({
  description:
    "Read the current navigation state, a compact hackathon summary, and the current user's saved prototype on Ideas and Plan. Use get-hackathon for full workspace details.",
  schema: z.object({}),
  http: false,
  readOnly: true,
  run: async () => {
    const navigation = await readAppState("navigation");

    const screen: Record<string, unknown> = {};
    if (navigation) screen.navigation = navigation;
    const nav = navigation && typeof navigation === "object"
      ? (navigation as { hackathonId?: unknown; tab?: unknown })
      : null;
    if (typeof nav?.hackathonId === "string" && nav.hackathonId) {
      const { hackathons, hackathonShares } = schema;
      const [row] = await getDb()
        .select({
          id: hackathons.id,
          name: hackathons.name,
          deadlineAt: hackathons.deadlineAt,
          timezone: hackathons.timezone,
        })
        .from(hackathons)
        .where(
          and(
            eq(hackathons.id, nav.hackathonId),
            accessFilter(hackathons, hackathonShares),
          ),
        )
        .limit(1);
      if (row) {
        screen.hackathon = {
          ...row,
          next: "Call get-hackathon for ideas, tasks, and checklist.",
        };
        const request = getRequestContext();
        if (
          (nav.tab === "ideas" || nav.tab === "plan") &&
          request?.userEmail &&
          !request.agentRunAnonymous
        ) {
          screen.designPrototype = await readDesignPrototype(row.id, request.userEmail);
        }
      }
    }

    if (Object.keys(screen).length === 0) {
      return "No application state found. Is the app running?";
    }
    return screen;
  },
});
