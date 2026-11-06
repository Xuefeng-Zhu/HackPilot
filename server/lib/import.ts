import { z } from "zod";

import {
  criterionSchema,
  normalizeRubric,
  prizeSchema,
  requirementSchema,
} from "../../shared/hackpilot.js";
import {
  isValidTimezone,
  normalizeTimezone,
  zonedWallTimeToUtcIso,
} from "../../shared/time.js";
import { type ExtractedHackathon, extractHackathon } from "./extract.js";
import { generateStructured, isLlmConfigured } from "./llm.js";
import { type FetchedPage, MAX_SOURCE_TEXT } from "./page.js";

const llmExtractionSchema = z.object({
  name: z.string().describe("Hackathon name"),
  tagline: z.string().nullable().describe("One-sentence theme or challenge"),
  deadlineLocal: z
    .string()
    .nullable()
    .describe(
      "Final submission deadline as local wall time YYYY-MM-DDTHH:mm in `timezone`; null if absent",
    ),
  timezone: z
    .string()
    .nullable()
    .describe("IANA timezone of the deadline, e.g. America/Los_Angeles"),
  prizes: z.array(prizeSchema),
  rubric: z
    .array(criterionSchema)
    .describe(
      "Judging criteria; weights as percents summing to ~100 (split evenly if unweighted)",
    ),
  requirements: z
    .array(requirementSchema)
    .describe("What a submission must include"),
});

export type ExtractionMode = "auto" | "heuristic";

export async function extractFromPage(
  page: FetchedPage,
  mode: ExtractionMode,
  now = new Date(),
): Promise<
  ExtractedHackathon & { method: "llm" | "heuristic"; model?: string }
> {
  const base = extractHackathon({ ...page, now });
  if (mode === "heuristic" || !(await isLlmConfigured())) {
    return { ...base, method: "heuristic" };
  }
  const { object, model } = await generateStructured({
    schema: llmExtractionSchema,
    system:
      "You extract structured facts about a hackathon from its web page text. Only use facts stated on the page. Never invent prizes or deadlines; use null or empty arrays when absent. Criterion ids are short snake_case keys.",
    prompt: `Today is ${now.toISOString().slice(0, 10)}. URL: ${page.url}\nTitle: ${page.title ?? ""}\nDescription: ${page.description ?? ""}\n\nHeuristic draft (may be wrong or incomplete):\n${JSON.stringify(
      {
        deadlineAt: base.deadlineAt,
        timezone: base.timezone,
        prizes: base.prizes,
        rubric: base.rubric,
      },
    )}\n\nPage text:\n${page.text.slice(0, MAX_SOURCE_TEXT)}`,
  });
  const tz =
    object.timezone && isValidTimezone(object.timezone)
      ? object.timezone
      : base.timezone;
  let deadlineAt = base.deadlineAt;
  const m = object.deadlineLocal?.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/,
  );
  if (m) {
    deadlineAt = zonedWallTimeToUtcIso(
      {
        year: Number(m[1]),
        month: Number(m[2]),
        day: Number(m[3]),
        hour: m[4] ? Number(m[4]) : 23,
        minute: m[5] ? Number(m[5]) : 59,
      },
      normalizeTimezone(tz),
    );
  }
  return {
    name: object.name?.trim() || base.name,
    tagline: object.tagline ?? base.tagline,
    deadlineAt,
    timezone: normalizeTimezone(tz),
    prizes: object.prizes.length ? object.prizes : base.prizes,
    rubric: object.rubric.length ? normalizeRubric(object.rubric) : base.rubric,
    requirements: object.requirements.length
      ? object.requirements
      : base.requirements,
    warnings: deadlineAt ? [] : ["No deadline found; set it manually."],
    method: "llm",
    model,
  };
}
