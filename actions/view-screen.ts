import { defineAction } from "@agent-native/core/action";
import { readAppState } from "@agent-native/core/application-state";
import { accessFilter } from "@agent-native/core/sharing";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";

export default defineAction({
  description:
    "Read the current navigation state plus, on a hackathon page, a compact summary of the visible workspace (name, deadline, timezone). Basic navigation is already in <current-screen>; use get-hackathon for full details.",
  schema: z.object({}),
  http: false,
  readOnly: true,
  run: async () => {
    const navigation = await readAppState("navigation");

    const screen: Record<string, unknown> = {};
    if (navigation) screen.navigation = navigation;
    const hackathonId =
      navigation &&
      typeof navigation === "object" &&
      "hackathonId" in navigation
        ? String((navigation as { hackathonId?: unknown }).hackathonId ?? "")
        : "";
    if (hackathonId) {
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
            eq(hackathons.id, hackathonId),
            accessFilter(hackathons, hackathonShares),
          ),
        )
        .limit(1);
      if (row) {
        screen.hackathon = {
          ...row,
          next: "Call get-hackathon for ideas, tasks, and checklist.",
        };
      }
    }

    if (Object.keys(screen).length === 0) {
      return "No application state found. Is the app running?";
    }
    return screen;
  },
});
