import { z } from "zod";

import { criterionSchema, prizeSchema } from "./hackpilot.js";
import { MILESTONE_IDS, milestoneSchema } from "./milestones.js";

/** Output contracts shared by actions (validation) and the UI (types). */

export const hackathonOut = z.object({
  id: z.string(),
  name: z.string(),
  url: z.string().nullable(),
  tagline: z.string().nullable(),
  deadlineAt: z.string().nullable(),
  timezone: z.string(),
  countdown: z.string().nullable(),
  prizes: z.array(prizeSchema),
  rubric: z.array(criterionSchema),
  notes: z.string().nullable(),
  milestones: z.array(milestoneSchema),
  extraction: z.string(),
  importedAt: z.string().nullable(),
  updatedAt: z.string(),
  visibility: z.string().nullable().optional(),
  sourceText: z.string().nullable().optional(),
});
export type HackathonOut = z.infer<typeof hackathonOut>;

export const ideaOut = z.object({
  id: z.string(),
  title: z.string(),
  pitch: z.string(),
  tags: z.array(z.string()),
  scores: z.record(z.string(), z.number()),
  weightedScore: z.number().nullable(),
  coverage: z.number(),
  rationale: z.string().nullable(),
  position: z.number(),
  selected: z.boolean(),
  source: z.string(),
});
export type IdeaOut = z.infer<typeof ideaOut>;

export const taskOut = z.object({
  id: z.string(),
  title: z.string(),
  notes: z.string().nullable(),
  day: z.string(),
  phase: z.string(),
  milestone: z.enum(MILESTONE_IDS),
  position: z.number(),
  done: z.boolean(),
  source: z.string(),
  estimateHours: z.number().nullable(),
});
export type TaskOut = z.infer<typeof taskOut>;

export const submissionItemOut = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.string(),
  detail: z.string().nullable(),
  status: z.string(),
  link: z.string().nullable(),
  position: z.number(),
});
export type SubmissionItemOut = z.infer<typeof submissionItemOut>;

export const workspaceOut = z.object({
  hackathon: hackathonOut,
  ideas: z.array(ideaOut),
  tasks: z.array(taskOut),
  submissionItems: z.array(submissionItemOut),
  progress: z.object({
    tasksDone: z.number(),
    tasksTotal: z.number(),
    submissionDone: z.number(),
    submissionTotal: z.number(),
    selectedIdeaId: z.string().nullable(),
  }),
});
export type WorkspaceOut = z.infer<typeof workspaceOut>;

export const hackathonSummaryOut = z.object({
  id: z.string(),
  name: z.string(),
  url: z.string().nullable(),
  tagline: z.string().nullable(),
  deadlineAt: z.string().nullable(),
  timezone: z.string(),
  countdown: z.string().nullable(),
  prizePool: z.string().nullable(),
  ideaCount: z.number(),
  topIdea: z.string().nullable(),
  tasksDone: z.number(),
  tasksTotal: z.number(),
  submissionDone: z.number(),
  submissionTotal: z.number(),
  updatedAt: z.string(),
});
export type HackathonSummaryOut = z.infer<typeof hackathonSummaryOut>;

export const receiptOut = z
  .object({
    changed: z.boolean(),
    verified: z.union([z.boolean(), z.literal("unverified")]),
    summary: z.string(),
  })
  .passthrough()
  .optional();
