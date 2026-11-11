import {
  defineAction,
  defineActionErrors,
  fail,
} from "@agent-native/core/action";
import { accessFilter } from "@agent-native/core/sharing";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import { extractFromPage } from "../server/lib/import.js";
import { failOtari } from "../server/lib/llm.js";
import {
  otariGuardCheck,
  OtariError,
  otariWebFetch,
  otariWebSearch,
} from "../server/lib/otari.js";
import {
  type FetchedPage,
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
import { preserveRubricIds } from "../shared/hackpilot.js";
import { normalizeTimezone } from "../shared/time.js";

const errors = defineActionErrors("already_imported", "unauthenticated");

export default defineAction({
  description:
    "Import a hackathon from its public URL: fetch the page server-side, extract name, deadline (+ timezone), prizes, weighted judging rubric, and submission requirements. Fetches through Otari's otari_web_fetch tool when the workspace enables it (local fetch otherwise, otari_web_search as a last resort), screens the untrusted page text with an open-weight guard model, then extracts with a small open-weight model on Otari (deterministic parser as fallback), then create the workspace and its submission checklist. Pass id to re-import into an existing workspace (keeps ideas and tasks). Fails with already_imported (409, details.id) if the URL is already a workspace.",
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
        '"auto" (default) uses the LLM when a model key (OTARI_API_KEY first) is set; "heuristic" forces the deterministic parser',
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
    fetchedVia: z.enum(["otari_web_fetch", "otari_web_search", "direct", "pasted"]),
    guard: z
      .object({
        flagged: z.boolean(),
        verdict: z.string(),
        categories: z.array(z.string()),
        model: z.string(),
        otariRequestId: z.string().optional(),
      })
      .optional(),
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

    const textPage = (raw: string): FetchedPage => ({
      url,
      html: raw.includes("<") ? raw : "",
      ...htmlToText(raw.includes("<") ? raw : raw.replace(/\n/g, "<br>")),
    });
    let fetchedVia: "otari_web_fetch" | "otari_web_search" | "direct" | "pasted" = "pasted";
    let page: FetchedPage;
    let guard: Awaited<ReturnType<typeof otariGuardCheck>> = null;
    const extraWarnings: string[] = [];
    let extracted: Awaited<ReturnType<typeof extractFromPage>>;
    try {
      if (args.pageText?.trim()) {
        page = textPage(args.pageText);
      } else {
        // 1. Otari's gateway-run fetch (when the workspace enables it).
        const viaOtari = await otariWebFetch(url);
        if (viaOtari) {
          page = textPage(viaOtari.text.slice(0, 200_000));
          fetchedVia = "otari_web_fetch";
        } else {
          // 2. Local SSRF-guarded fetch; 3. Otari web search when the site blocks us.
          try {
            page = await fetchPage(url);
            fetchedVia = "direct";
          } catch (error) {
            const found = await otariWebSearch(`${url} hackathon rules prizes judging criteria deadline`);
            if (!found) throw error;
            page = textPage(found.text.slice(0, 200_000));
            fetchedVia = "otari_web_search";
            extraWarnings.push("The site blocked a direct fetch; details came from Otari web search results. Double-check them.");
          }
        }
      }
      // Untrusted page text: screen it for prompt injection before any model reads it.
      let mode = args.mode ?? "auto";
      if (mode === "auto") {
        guard = await otariGuardCheck(page.text);
        if (guard?.flagged) {
          mode = "heuristic";
          extraWarnings.push(
            `Otari guard model (${guard.model}) flagged the page text as ${guard.verdict}${guard.categories.length ? ` (${guard.categories.join(", ")})` : ""}, so it was parsed without an LLM. Review the extracted fields.`,
          );
        }
      }
      extracted = await extractFromPage(page, mode);
    } catch (error) {
      if (error instanceof OtariError && error.fatal) failOtari(error);
      throw error;
    }
    extracted = { ...extracted, warnings: [...extracted.warnings, ...extraWarnings] };
    const timezone = args.timezone
      ? normalizeTimezone(args.timezone)
      : extracted.timezone;
    const now = nowIso();
    const sourceText = page.text.slice(0, MAX_SOURCE_TEXT);

    const id = existing?.id ?? crypto.randomUUID();
    const requirementsAdded = await db.transaction(async (tx) => {
      if (existing) {
        const [updated] = await tx
          .update(hackathons)
          .set({
            url,
            name: extracted.name || existing.name,
            tagline: extracted.tagline ?? existing.tagline,
            deadlineAt: extracted.deadlineAt ?? existing.deadlineAt,
            timezone,
            prizes: extracted.prizes.length
              ? extracted.prizes
              : existing.prizes,
            rubric: extracted.rubric.length
              ? preserveRubricIds(existing.rubric, extracted.rubric)
              : existing.rubric,
            sourceText,
            extraction: extracted.method,
            importedAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(hackathons.id, id),
              accessFilter(hackathons, hackathonShares, undefined, "editor"),
            ),
          )
          .returning({ id: hackathons.id });
        if (!updated) {
          fail("Hackathon not found or you can't edit it.", {
            errorCode: "not_found",
            statusCode: 404,
            details: { hackathonId: id },
          });
        }
      } else {
        await tx.insert(hackathons).values({
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
        ? await tx
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
        await tx.insert(submissionItems).values(
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
      return toAdd.length;
    });

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
      requirementsAdded,
      warnings: extracted.warnings,
      fetchedVia,
      ...(guard
        ? {
            guard: {
              flagged: guard.flagged,
              verdict: guard.verdict,
              categories: guard.categories,
              model: guard.model,
              ...(guard.requestId ? { otariRequestId: guard.requestId } : {}),
            },
          }
        : {}),
      message: `${existing ? "Re-imported" : "Imported"} ${name} (${extracted.method}): ${extracted.rubric.length} criteria, ${extracted.prizes.length} prizes, ${requirementsAdded} checklist items.`,
      nextRequiredAction: extracted.warnings.length
        ? "update-hackathon"
        : "add-ideas",
    };
  },
});
