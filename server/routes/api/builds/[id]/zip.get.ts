/**
 * Binary download of a passed "Build it" run's source zip. A route rather than
 * an action because the payload is a file, not JSON. Access mirrors the
 * hackathon's sharing: the caller must be able to view the hackathon.
 */
import fs from "node:fs/promises";

import { getOrgContext } from "@agent-native/core/org";
import { getSession, runWithRequestContext } from "@agent-native/core/server";
import { eq } from "drizzle-orm";
import { defineEventHandler, getRouterParam, HTTPError } from "h3";

import { getDb, schema } from "../../../../db/index.js";
import { zipPathFor } from "../../../../lib/builder.js";
import { requireHackathon } from "../../../../lib/workspace.js";

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, "id") ?? "";
  const session = await getSession(event);
  if (!session?.email) throw new HTTPError({ status: 401, message: "Sign in to download builds." });
  const { orgId } = await getOrgContext(event);
  const [row] = await getDb().select().from(schema.builds).where(eq(schema.builds.id, id)).limit(1);
  if (!row) throw new HTTPError({ status: 404, message: "Build not found." });
  try {
    await runWithRequestContext({ userEmail: session.email, ...(orgId ? { orgId } : {}) }, () =>
      requireHackathon(row.hackathonId),
    );
  } catch {
    throw new HTTPError({ status: 404, message: "Build not found." });
  }
  const zipPath = zipPathFor(row.dir);
  const data = zipPath ? await fs.readFile(zipPath).catch(() => null) : null;
  if (!data) throw new HTTPError({ status: 404, message: "This build has no zip yet." });
  const name = (row.ideaTitle.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "starter").slice(0, 40);
  return new Response(new Uint8Array(data), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${name}-starter.zip"`,
      "Cache-Control": "private, no-store",
    },
  });
});
