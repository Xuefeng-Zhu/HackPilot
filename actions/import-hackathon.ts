import { defineAction, defineActionErrors } from "@agent-native/core/action";
import { accessFilter } from "@agent-native/core/sharing";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import { extractFromPage } from "../server/lib/import.js";
import {
  fetchPage,
  htmlToText,
  MAX_SOURCE_TEXT,
  normalizeUrl,
} from "../server/lib/page.js";
import {
  hackathonLink,
  nowIso,
  requireHackathon,
} from "../server/lib/workspace.js";
import { normalizeTimezone } from "../shared/time.js";
import { preserveRubricIds } from "../shared/hackpilot.js";

const errors = defineActionErrors("already_imported", "unauthenticated");

export default defineAction({
  description:
    "Import a hackathon from its public URL: fetch the page server-side, extract name, deadline (+ timezone), prizes, weighted judging rubric, and submission requirements (LLM via OpenRouter when configured, deterministic parser otherwise), then create the workspace and its submission checklist. Pass id to re-import into an existing workspace (keeps ideas and tasks). Fails with already_imported (409, details.id) if the URL is already a workspace.",
  schema: z.object({
    url: z
      .string()
      .min(4)
      .max(2000)
      .describe("Hackathon page URL, e.g. https://www.builder.io/hackathon"),
    id: z
      .string()
      .optional()
      .describe(
        "Existing hackathon id to refresh from the page instead of creating a new one",
      ),
    mode: z
      .enum(["auto", "heuristic"])
      .optional()
      .describe(
        '"auto" (default) uses the LLM when OPENROUTER_API_KEY is set; "heuristic" forces the deterministic parser',
      ),
    pageText: z
      .string()
      .max(60000)
      .optional()
      .describe(
        "Page text pasted by the user when the site blocks server fetches (e.g. 403); skips fetching",
      ),
    timezone: z
      .string()
      .optional()
      .describe(
        "Override the deadline timezone (IANA, e.g. America/New_York) when the page omits it",
      ),
  }),
  outputSchema: z.object({
    id: z.string(),
    name: z.string(),
    created: z.boolean(),
    method: z.enum(["llm", "heuristic"]),
    model: z.string().optional(),
    deadlineAt: z.string().nullable(),
    timezone: z.string(),
    prizes: z.number(),
    criteria: z.number(),
    requirementsAdded: z.number(),
    warnings: z.array(z.string()),
    message: z.string(),
    nextRequiredAction: z.string().optional(),
  }),
  errors,
  link: ({ result }) => hackathonLink(result.id),
  run: async (args, ctx) => {
    const ownerEmail =
      ctx?.userEmail ??
      errors.fail("Sign in to import a hackathon.", "unauthenticated", {
        statusCode: 401,
      });
    const orgId = ctx?.orgId ?? null;
    const url = normalizeUrl(args.url);
    const db = getDb();
    const { hackathons, hackathonShares, submissionItems } = schema;

    let existing: Awaited<ReturnType<typeof requireHackathon>> | null = null;
    if (args.id) {
      existing = await requireHackathon(args.id, "editor");
    } else {
      const [dupe] = await db
        .select({ id: hackathons.id, name: hackathons.name })
        .from(hackathons)
        .where(
          and(
            eq(hackathons.url, url),
            accessFilter(hackathons, hackathonShares),
          ),
        )
        .limit(1);
      if (dupe) {
        errors.fail(
          `"${dupe.name}" is already imported from this URL. Open it, or re-import with id=${dupe.id}.`,
          "already_imported",
          { statusCode: 409, details: { id: dupe.id } },
        );
      }
    }

    const page = args.pageText?.trim()
      ? { url, html: "", ...htmlToText(args.pageText.includes("<") ? args.pageText : args.pageText.replace(/\n/g, "<br>")) }
      : await fetchPage(url);
    const extracted = await extractFromPage(page, args.mode ?? "auto");
    const timezone = args.timezone
      ? normalizeTimezone(args.timezone)
      : extracted.timezone;
    const now = nowIso();
    const sourceText = page.text.slice(0, MAX_SOURCE_TEXT);

    const id = existing?.id ?? crypto.randomUUID();
    if (existing) {
      await db
        .update(hackathons)
        .set({
          url,
          name: extracted.name || existing.name,
          tagline: extracted.tagline ?? existing.tagline,
          deadlineAt: extracted.deadlineAt ?? existing.deadlineAt,
          timezone,
          prizes: extracted.prizes.length ? extracted.prizes : existing.prizes,
          rubric: extracted.rubric.length
            ? preserveRubricIds(existing.rubric, extracted.rubric)
            : existing.rubric,
          sourceText,
          extraction: extracted.method,
          importedAt: now,
          updatedAt: now,
        })
        .where(eq(hackathons.id, id));
    } else {
      await db.insert(hackathons).values({
        id,
        name: extracted.name,
        url,
        tagline: extracted.tagline,
        deadlineAt: extracted.deadlineAt,
        timezone,
        prizes: extracted.prizes,
        rubric: extracted.rubric,
        sourceText,
        extraction: extracted.method,
        importedAt: now,
        createdAt: now,
        updatedAt: now,
        ownerEmail,
        orgId,
        visibility: orgId ? "org" : "private",
      });
    }

    // Checklist: add requirement kinds not already present.
    const currentItems = existing
      ? await db
          .select({
            kind: submissionItems.kind,
            position: submissionItems.position,
          })
          .from(submissionItems)
          .where(eq(submissionItems.hackathonId, id))
          .limit(100)
      : [];
    const haveKinds = new Set(currentItems.map((i) => i.kind));
    let position = currentItems.reduce(
      (m, i) => Math.max(m, i.position + 1),
      0,
    );
    const toAdd = extracted.requirements.filter(
      (r) => r.kind === "other" || !haveKinds.has(r.kind),
    );
    if (toAdd.length) {
      await db.insert(submissionItems).values(
        toAdd.map((r) => ({
          id: crypto.randomUUID(),
          hackathonId: id,
          label: r.label,
          kind: r.kind,
          detail: r.detail ?? null,
          status: "todo",
          position: position++,
          ownerEmail,
          orgId: existing?.orgId ?? orgId,
        })),
      );
    }

    const name = extracted.name || existing?.name || "Hackathon";
    return {
      id,
      name,
      created: !existing,
      method: extracted.method,
      ...(extracted.model ? { model: extracted.model } : {}),
      deadlineAt: extracted.deadlineAt ?? existing?.deadlineAt ?? null,
      timezone,
      prizes: extracted.prizes.length,
      criteria: extracted.rubric.length,
      requirementsAdded: toAdd.length,
      warnings: extracted.warnings,
      message: `${existing ? "Re-imported" : "Imported"} ${name} (${extracted.method}): ${extracted.rubric.length} criteria, ${extracted.prizes.length} prizes, ${toAdd.length} checklist items.`,
      nextRequiredAction: extracted.warnings.length
        ? "update-hackathon"
        : "add-ideas",
    };
  },
});
