import fs from "node:fs/promises";
import path from "node:path";

import { defineAction, fail, noteExternalWrite } from "@agent-native/core/action";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import { buildAccessFilter, getBuildAuthUserId } from "../server/lib/build-access.js";
import { serializeBuild } from "../server/lib/build-serialize.js";
import { withBuildSlot } from "../server/lib/build-slot.js";
import { reapInterrupted, startBuild } from "../server/lib/builder.js";
import { decodeFusionArchive } from "../server/lib/fusion-archive.js";
import { hackathonLink, nowIso, requireHackathon } from "../server/lib/workspace.js";
import { buildOut, MAX_FUSION_ARCHIVE_BYTES } from "../shared/build.js";

const protectedFiles = ["package.json", "package-lock.json", "tsconfig.json", "vite.config.ts", "smoke.test.ts"];
const requiredSource = ["index.html", "src/App.tsx", "src/main.tsx"];

export default defineAction({
  description:
    "Verify a Builder.io Fusion source ZIP returned from a passed HackPilot starter. Pass the original buildId and the ZIP encoded as base64 (up to 2 MiB before encoding). Keep the original dependencies, build config, and smoke test. Verification of private Design builds stays private to the initiating account. Poll get-build with the returned id for results and the verified source download.",
  schema: z.object({
    buildId: z.string().uuid().describe("Passed starter build ID used in Fusion"),
    archive: z.string().min(1).max(4 * Math.ceil(MAX_FUSION_ARCHIVE_BYTES / 3)).describe("Fusion Download Code ZIP as base64"),
  }),
  outputSchema: buildOut,
  persistInChatHistory: false,
  link: ({ result }) => hackathonLink(result.hackathonId, "plan"),
  run: async ({ buildId, archive }, ctx) => {
    const db = getDb();
    const [source] = await db
      .select()
      .from(schema.builds)
      .where(and(eq(schema.builds.id, buildId), buildAccessFilter(getBuildAuthUserId())))
      .limit(1);
    if (!source) fail("Build not found.", { errorCode: "not_found", statusCode: 404 });
    const hackathon = await requireHackathon(source.hackathonId, "editor");
    const fromDesign = source.designPrototypeId !== null;
    const starterSource = fromDesign ? "design" : "idea";
    const sourceDir = source.dir;
    if (source.status !== "passed" || !sourceDir) {
      fail("Start with a passed starter build.", { errorCode: "source_build_required", statusCode: 409 });
    }

    return withBuildSlot(hackathon.id, async () => {
      if (ctx?.signal?.aborted) {
        fail("Fusion import was canceled.", { errorCode: "build_canceled", statusCode: 409 });
      }
      if (await reapInterrupted(hackathon.id)) {
        fail("A build is already running. Try again when it finishes.", { errorCode: "build_running", statusCode: 409 });
      }
      const files = new Map((await decodeFusionArchive(archive)).map(({ path, content }) => [path, content]));
      for (const name of requiredSource) {
        if (!files.has(name)) {
          fail(`The ZIP is missing ${name}. Export the full starter from Fusion.`, { errorCode: "invalid_fusion_archive" });
        }
      }
      for (const name of protectedFiles) {
        const sourcePath = path.join(sourceDir, "app", name);
        const stat = await fs.lstat(sourcePath).catch(() => null);
        const original = stat?.isFile() && stat.size <= MAX_FUSION_ARCHIVE_BYTES
          ? await fs.readFile(sourcePath).catch(() => null)
          : null;
        if (!original) {
          fail(`The starter's ${name} is unavailable. Run Build it again and use its ZIP.`, { errorCode: "source_build_unavailable", statusCode: 409 });
        }
        const incoming = files.get(name);
        // Older ZIPs omit the lockfile, and Fusion can regenerate it. Always use ours.
        if (name !== "package-lock.json" && !incoming?.equals(original)) {
          fail(`Keep ${name} from the original starter. Fusion verification reuses the original toolchain and smoke test.`, { errorCode: "fusion_toolchain_changed" });
        }
        files.set(name, original);
      }
      if (ctx?.signal?.aborted) {
        fail("Fusion import was canceled.", { errorCode: "build_canceled", statusCode: 409 });
      }

      const id = crypto.randomUUID();
      noteExternalWrite("local-disk");
      const [build] = await db.insert(schema.builds).values({
        id,
        hackathonId: hackathon.id,
        ideaId: source.ideaId,
        ideaTitle: source.ideaTitle,
        designPrototypeId: source.designPrototypeId,
        designOwnerAuthId: source.designOwnerAuthId,
        mode: "fusion",
        meta: { source: starterSource, sourceBuildId: source.id },
        steps: [{ at: nowIso(), stage: "queued", label: "Verify Fusion edits", status: "info" }],
        ownerEmail: fromDesign ? source.ownerEmail : ctx?.userEmail ?? hackathon.ownerEmail,
        orgId: fromDesign ? null : hackathon.orgId,
      }).returning();
      startBuild(id, { sourceBuildId: source.id, starterSource, files });
      return serializeBuild(build!);
    });
  },
});
