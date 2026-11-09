import { z } from "zod";

/** "Build it" run contracts shared by the server, actions, and UI. */

export const BUILD_STAGES = [
  "queued",
  "generating",
  "installing",
  "typechecking",
  "building",
  "testing",
  "repairing",
  "packaging",
  "done",
  "failed",
] as const;
export type BuildStage = (typeof BUILD_STAGES)[number];

export const buildStepSchema = z.object({
  at: z.string(),
  stage: z.string(),
  label: z.string(),
  status: z.enum(["running", "ok", "fail", "info"]),
  detail: z.string().optional(),
  ms: z.number().optional(),
});
export type BuildStep = z.infer<typeof buildStepSchema>;

export const buildFileSchema = z.object({
  path: z.string(),
  bytes: z.number(),
});
export type BuildFile = z.infer<typeof buildFileSchema>;

export const buildMetaSchema = z.object({
  source: z.enum(["design", "idea"]).optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  /** Every model call, in order: "nvidia/<model>: ok in 31s". */
  calls: z.array(z.string()).optional(),
  /** USD reported by providers that report cost (OpenRouter). */
  cost: z.number().optional(),
  completionTokens: z.number().optional(),
  tasksCompleted: z.array(z.string()).optional(),
  checklistUpdated: z.array(z.string()).optional(),
  zipBytes: z.number().optional(),
  durationMs: z.number().optional(),
});
export type BuildMeta = z.infer<typeof buildMetaSchema>;

export const buildOut = z.object({
  id: z.string(),
  hackathonId: z.string(),
  ideaId: z.string().nullable(),
  ideaTitle: z.string(),
  status: z.enum(["running", "passed", "failed"]),
  stage: z.string(),
  mode: z.string(),
  rounds: z.number(),
  steps: z.array(buildStepSchema),
  files: z.array(buildFileSchema),
  meta: buildMetaSchema,
  notes: z.string().nullable(),
  error: z.string().nullable(),
  downloadUrl: z.string().nullable(),
  /** Same-origin URL of the built app (vite dist/), for the inline Preview. */
  previewUrl: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  finishedAt: z.string().nullable(),
});
export type BuildOut = z.infer<typeof buildOut>;

export const MAX_REPAIR_ROUNDS = 3;

export function buildDownloadUrl(id: string) {
  return `/api/builds/${encodeURIComponent(id)}/zip`;
}

export function buildPreviewUrl(id: string) {
  return `/api/builds/${encodeURIComponent(id)}/preview/index.html`;
}
