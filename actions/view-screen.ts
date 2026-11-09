import { defineAction } from "@agent-native/core/action";
import { readAppState } from "@agent-native/core/application-state";
import { getRequestContext } from "@agent-native/core/server";
import { accessFilter } from "@agent-native/core/sharing";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import { buildAccessFilter, getBuildAuthUserId } from "../server/lib/build-access.js";
import { readDesignPrototype } from "../server/lib/design-prototype.js";

export default defineAction({
  description:
    "Read the current navigation state, a compact hackathon summary, the current user's saved prototype on Ideas and Plan, and the latest accessible build on Plan. Use get-hackathon for full workspace details.",
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
        if (nav.tab === "plan") {
          const { builds } = schema;
          const [build] = await getDb()
            .select({
              id: builds.id,
              status: builds.status,
              stage: builds.stage,
              mode: builds.mode,
              meta: builds.meta,
            })
            .from(builds)
            .where(and(eq(builds.hackathonId, row.id), buildAccessFilter(getBuildAuthUserId())))
            .orderBy(desc(builds.createdAt))
            .limit(1);
          if (build) {
            screen.build = {
              id: build.id,
              status: build.status,
              stage: build.stage,
              mode: build.mode,
              sourceBuildId: build.meta?.sourceBuildId,
              next: "Call get-build for check logs and the ZIP download.",
            };
          }
        }
      }
    }

    if (Object.keys(screen).length === 0) {
      return "No application state found. Is the app running?";
    }
    return screen;
  },
});
