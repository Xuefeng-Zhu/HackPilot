/**
 * Serves a passed "Build it" run's vite dist/ so the Build panel can preview
 * the generated app in an iframe. Access mirrors the zip route: the caller must
 * be able to view the hackathon. The app is built with base "./", so its
 * assets resolve relative to /api/builds/<id>/preview/.
 */
import fs from "node:fs/promises";
import path from "node:path";

import { getOrgContext } from "@agent-native/core/org";
import { getSession, runWithRequestContext } from "@agent-native/core/server";
import { eq } from "drizzle-orm";
import { defineEventHandler, getRouterParam, HTTPError } from "h3";

import { getDb, schema } from "../../../../../db/index.js";
import { previewPathFor } from "../../../../../lib/builder.js";
import { requireHackathon } from "../../../../../lib/workspace.js";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, "id") ?? "";
  const rel = decodeURIComponent(getRouterParam(event, "path") ?? "") || "index.html";
  const session = await getSession(event);
  if (!session?.email) throw new HTTPError({ status: 401, message: "Sign in to preview builds." });
  const { orgId } = await getOrgContext(event);
  const [row] = await getDb().select().from(schema.builds).where(eq(schema.builds.id, id)).limit(1);
  if (!row || row.status !== "passed" || row.mode === "fusion") throw new HTTPError({ status: 404, message: "Build not found." });
  try {
    await runWithRequestContext({ userEmail: session.email, ...(orgId ? { orgId } : {}) }, () =>
      requireHackathon(row.hackathonId),
    );
  } catch {
    throw new HTTPError({ status: 404, message: "Build not found." });
  }
  const abs = previewPathFor(row.dir, rel);
  const data = abs ? await fs.readFile(abs).catch(() => null) : null;
  if (!data) throw new HTTPError({ status: 404, message: "Not in this build's preview." });
  const ext = path.extname(abs!).toLowerCase();
  // Builds made before the "./" base used absolute /assets/ paths; make them relative.
  const body =
    ext === ".html"
      ? data.toString("utf8").replace(/(src|href)="\/(assets\/[^"]+)"/g, '$1="./$2"')
      : new Uint8Array(data);
  return new Response(body, {
    headers: {
      "Content-Type": TYPES[ext] ?? "application/octet-stream",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
