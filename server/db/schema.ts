import {
  createSharesTable,
  ownableColumns,
} from "@agent-native/core/db/schema";
import { sql } from "drizzle-orm";
import { boolean, integer, jsonb, pgTable, text } from "drizzle-orm/pg-core";

import type { BuildFile, BuildMeta, BuildStep } from "../../shared/build.js";

import type { Criterion, IdeaScores, Prize } from "../../shared/hackpilot.js";

/**
 * A hackathon workspace. Shareable: private to its creator by default,
 * org-visible when an organization is active. Ideas, tasks, and submission
 * items are children that inherit the hackathon's access.
 */
export const hackathons = pgTable("hackathons", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  url: text("url"),
  tagline: text("tagline"),
  /** UTC ISO 8601; null when unknown. */
  deadlineAt: text("deadline_at"),
  /** IANA zone the organizer published the deadline in. */
  timezone: text("timezone").notNull().default("UTC"),
  prizes: jsonb("prizes").$type<Prize[]>().notNull().default([]),
  rubric: jsonb("rubric").$type<Criterion[]>().notNull().default([]),
  notes: text("notes"),
  /** Plain text snapshot of the source page (truncated) for the agent. */
  sourceText: text("source_text"),
  /** How the record was filled: "llm", "heuristic", "seed", or "manual". */
  extraction: text("extraction").notNull().default("manual"),
  importedAt: text("imported_at"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`now()`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`now()`),
  ...ownableColumns(),
});
export const hackathonShares = createSharesTable("hackathon_shares");

export const ideas = pgTable("hackathon_ideas", {
  id: text("id").primaryKey(),
  hackathonId: text("hackathon_id").notNull(),
  title: text("title").notNull(),
  pitch: text("pitch").notNull().default(""),
  tags: jsonb("tags").$type<string[]>().notNull().default([]),
  scores: jsonb("scores").$type<IdeaScores>().notNull().default({}),
  rationale: text("rationale"),
  position: integer("position").notNull().default(0),
  selected: boolean("selected").notNull().default(false),
  /** "user", "agent", or "llm" */
  source: text("source").notNull().default("user"),
  ownerEmail: text("owner_email").notNull(),
  orgId: text("org_id"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`now()`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`now()`),
});

export const tasks = pgTable("hackathon_tasks", {
  id: text("id").primaryKey(),
  hackathonId: text("hackathon_id").notNull(),
  title: text("title").notNull(),
  notes: text("notes"),
  /** Calendar day `YYYY-MM-DD` in the plan's timezone. */
  day: text("day").notNull(),
  phase: text("phase").notNull().default("build"),
  position: integer("position").notNull().default(0),
  done: boolean("done").notNull().default(false),
  /** "plan" (generated), "user", or "agent" */
  source: text("source").notNull().default("user"),
  estimateHours: integer("estimate_hours"),
  ownerEmail: text("owner_email").notNull(),
  orgId: text("org_id"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`now()`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`now()`),
});

export const submissionItems = pgTable("hackathon_submission_items", {
  id: text("id").primaryKey(),
  hackathonId: text("hackathon_id").notNull(),
  label: text("label").notNull(),
  kind: text("kind").notNull().default("other"),
  detail: text("detail"),
  status: text("status").notNull().default("todo"),
  link: text("link"),
  position: integer("position").notNull().default(0),
  ownerEmail: text("owner_email").notNull(),
  orgId: text("org_id"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`now()`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`now()`),
});

/**
 * A "Build it" run: the picked idea + plan turned into a starter app through a
 * generate -> install -> typecheck -> build -> smoke test -> repair loop.
 * Files live on disk under `dir`; this row is the progress record the UI polls.
 */
export const builds = pgTable("hackathon_builds", {
  id: text("id").primaryKey(),
  hackathonId: text("hackathon_id").notNull(),
  ideaId: text("idea_id"),
  ideaTitle: text("idea_title").notNull(),
  /** "running" | "passed" | "failed" */
  status: text("status").notNull().default("running"),
  /** Current stage key, e.g. "generating", "installing", "repairing". */
  stage: text("stage").notNull().default("queued"),
  /** "llm" or "template" */
  mode: text("mode").notNull().default("llm"),
  steps: jsonb("steps").$type<BuildStep[]>().notNull().default([]),
  files: jsonb("files").$type<BuildFile[]>().notNull().default([]),
  meta: jsonb("meta").$type<BuildMeta>().notNull().default({}),
  rounds: integer("rounds").notNull().default(0),
  notes: text("notes"),
  error: text("error"),
  dir: text("dir"),
  ownerEmail: text("owner_email").notNull(),
  orgId: text("org_id"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`now()`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`now()`),
  finishedAt: text("finished_at"),
});
