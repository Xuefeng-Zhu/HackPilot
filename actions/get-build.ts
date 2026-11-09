import { defineAction, fail } from "@agent-native/core/action";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import {
  buildAccessFilter,
  getBuildAuthUserId,
} from "../server/lib/build-access.js";
import { serializeBuild } from "../server/lib/build-serialize.js";
import { readBuildFile } from "../server/lib/builder.js";
import { hackathonLink, requireHackathon } from "../server/lib/workspace.js";
import { buildOut } from "../shared/build.js";

export default defineAction({
  description:
    "Read a Build it run: status, steps, source, repair rounds, model/provider and cost, generated files, and download and preview URLs. Pass hackathonId for its latest accessible build, or buildId for one run. Pass file (a path from files) to also read its content. Design builds are only accessible to the person who started the build.",
  schema: z.object({
    hackathonId: z.string().optional().describe("Hackathon id: returns its latest build"),
    buildId: z.string().optional().describe("A specific build id"),
    file: z.string().optional().describe("Relative path of a generated file to include its content"),
  }),
  outputSchema: z.object({
    build: buildOut.nullable(),
    file: z.object({ path: z.string(), content: z.string() }).nullable(),
  }),
  http: { method: "GET" },
  readOnly: true,
  persistInBrowser: false,
  persistInChatHistory: false,
  link: ({ result }) => (result.build ? hackathonLink(result.build.hackathonId, "plan") : undefined),
  run: async ({ hackathonId, buildId, file }) => {
    if (!hackathonId && !buildId) fail("Pass hackathonId or buildId.", { errorCode: "bad_request", statusCode: 400 });
    const db = getDb();
    const access = buildAccessFilter(getBuildAuthUserId());
    let row: typeof schema.builds.$inferSelect | undefined;
    if (buildId) {
      [row] = await db
        .select()
        .from(schema.builds)
        .where(and(eq(schema.builds.id, buildId), access))
        .limit(1);
      if (!row) fail("Build not found.", { errorCode: "not_found", statusCode: 404 });
      await requireHackathon(row.hackathonId);
      if (hackathonId && row.hackathonId !== hackathonId) fail("Build not found.", { errorCode: "not_found", statusCode: 404 });
    } else if (hackathonId) {
      await requireHackathon(hackathonId);
      [row] = await db
        .select()
        .from(schema.builds)
        .where(and(eq(schema.builds.hackathonId, hackathonId), access))
        .orderBy(desc(schema.builds.createdAt))
        .limit(1);
    }
    if (!row) return { build: null, file: null };
    const content = file ? await readBuildFile(row.dir, file) : null;
    return {
      build: serializeBuild(row),
      file: file && content !== null ? { path: file, content } : null,
    };
  },
});
