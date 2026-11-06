import { z } from "zod";

/** One judging criterion. `weight` is a percentage-like number (40 = 40%). */
export const criterionSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(64)
    .describe('Stable criterion key, e.g. "usefulness"; idea scores use it'),
  name: z.string().min(1).max(120).describe("Criterion name as published"),
  weight: z
    .number()
    .min(0)
    .max(100)
    .describe("Relative weight, usually a percent (40 = 40%)"),
  description: z
    .string()
    .max(600)
    .optional()
    .describe("What judges look for, one or two sentences"),
});
export type Criterion = z.infer<typeof criterionSchema>;

export const prizeSchema = z.object({
  label: z.string().min(1).max(160).describe('Prize name, e.g. "Grand Prize"'),
  amount: z
    .number()
    .min(0)
    .nullable()
    .optional()
    .describe("Cash value as a number in `currency`; null when non-cash"),
  currency: z
    .string()
    .max(8)
    .optional()
    .describe('ISO currency code, defaults to "USD"'),
  description: z.string().max(400).optional().describe("Extra prize details"),
});
export type Prize = z.infer<typeof prizeSchema>;

export const SUBMISSION_KINDS = [
  "demo_video",
  "repo",
  "writeup",
  "deployment",
  "form",
  "slides",
  "other",
] as const;
export type SubmissionKind = (typeof SUBMISSION_KINDS)[number];

export const SUBMISSION_STATUSES = ["todo", "in_progress", "done"] as const;
export type SubmissionStatus = (typeof SUBMISSION_STATUSES)[number];

export const requirementSchema = z.object({
  label: z
    .string()
    .min(1)
    .max(200)
    .describe("Short requirement, e.g. 'Public demo video'"),
  kind: z
    .enum(SUBMISSION_KINDS)
    .default("other")
    .describe(
      'Kind: "demo_video", "repo", "writeup", "deployment", "form", "slides", or "other"',
    ),
  detail: z
    .string()
    .max(600)
    .optional()
    .describe("Constraints such as max length, platform, or required links"),
});
export type Requirement = z.infer<typeof requirementSchema>;

export const ideaScoresSchema = z
  .record(z.string(), z.number().min(0).max(10))
  .describe("Scores keyed by criterion id, each 0-10");
export type IdeaScores = z.infer<typeof ideaScoresSchema>;

/** Weighted average on a 0-10 scale; null until every criterion is scored. */
export function weightedScore(
  scores: IdeaScores | null | undefined,
  rubric: Criterion[],
): number | null {
  if (!scores || rubric.length === 0) return null;
  let total = 0;
  let weights = 0;
  let scored = 0;
  for (const c of rubric) {
    const s = scores[c.id];
    const w = c.weight > 0 ? c.weight : 0;
    if (typeof s === "number") {
      scored += 1;
      total += s * w;
      weights += w;
    }
  }
  if (scored === 0) return null;
  if (weights === 0) {
    // All weights zero: plain average of what is scored.
    const vals = rubric
      .map((c) => scores[c.id])
      .filter((v): v is number => typeof v === "number");
    return round1(vals.reduce((a, b) => a + b, 0) / vals.length);
  }
  return round1(total / weights);
}

export function scoreCoverage(
  scores: IdeaScores | null | undefined,
  rubric: Criterion[],
): number {
  if (!scores || rubric.length === 0) return 0;
  return (
    rubric.filter((c) => typeof scores[c.id] === "number").length /
    rubric.length
  );
}

export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function slugKey(value: string): string {
  const key = value
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  return key || "criterion";
}

/** Make criterion ids unique and present. */
export function normalizeRubric(rubric: Criterion[]): Criterion[] {
  const seen = new Set<string>();
  return rubric.map((c) => {
    let id = slugKey(c.id || c.name);
    let n = 2;
    while (seen.has(id)) id = `${slugKey(c.id || c.name)}_${n++}`;
    seen.add(id);
    return { ...c, id };
  });
}

export function totalPrizePool(
  prizes: Prize[],
): { amount: number; currency: string } | null {
  const cash = prizes.filter(
    (p) => typeof p.amount === "number" && p.amount > 0,
  );
  if (cash.length === 0) return null;
  const currency = cash[0]?.currency || "USD";
  return {
    amount: cash
      .filter((p) => (p.currency || "USD") === currency)
      .reduce((sum, p) => sum + (p.amount ?? 0), 0),
    currency,
  };
}

export function formatMoney(amount: number, currency = "USD"): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    return `${currency} ${amount}`;
  }
}

export const SUBMISSION_KIND_LABELS: Record<SubmissionKind, string> = {
  demo_video: "Demo video",
  repo: "Repository",
  writeup: "Write-up",
  deployment: "Live deployment",
  form: "Submission form",
  slides: "Slides",
  other: "Other",
};

export const TASK_PHASES = [
  "ideate",
  "build",
  "polish",
  "record",
  "submit",
  "other",
] as const;
export type TaskPhase = (typeof TASK_PHASES)[number];

/**
 * Keep existing criterion ids when a re-import or edit renames the same
 * criterion slightly, so idea scores stay attached.
 */
export function preserveRubricIds(previous: Criterion[], next: Criterion[]): Criterion[] {
  const used = new Set<string>();
  const words = (s: string) => new Set(slugKey(s).split("_").filter((w) => w.length > 2));
  const mapped = next.map((c) => {
    const exact = previous.find((p) => !used.has(p.id) && (p.id === c.id || slugKey(p.name) === slugKey(c.name)));
    let match = exact;
    if (!match) {
      const w = words(c.name);
      match = previous.find((p) => {
        if (used.has(p.id)) return false;
        const pw = words(p.name);
        return [...w].some((x) => pw.has(x));
      });
    }
    if (match) {
      used.add(match.id);
      return { ...c, id: match.id };
    }
    return c;
  });
  return normalizeRubric(mapped);
}
