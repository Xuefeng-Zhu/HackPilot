import { defineAction, fail } from "@agent-native/core/action";
import { accessFilter } from "@agent-native/core/sharing";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import { hackathonLink, nowIso } from "../server/lib/workspace.js";
import type { Criterion, Prize } from "../shared/hackpilot.js";
import { zonedWallTimeToUtcIso } from "../shared/time.js";
import planSprint from "./plan-sprint.js";

const DEMO_URL = "https://www.builder.io/hackathon";

// Curated from https://www.builder.io/hackathon (read Nov 2026).
const RUBRIC: Criterion[] = [
  {
    id: "usefulness",
    name: "Usefulness and Execution",
    weight: 40,
    description: "Solve a clear problem with a complete, working experience.",
  },
  {
    id: "creativity",
    name: "Creativity and Design",
    weight: 20,
    description: "Make the idea or interaction distinctive and thoughtful.",
  },
  {
    id: "innovation",
    name: "Innovation",
    weight: 20,
    description: "Use the agent to meaningfully improve the experience.",
  },
  {
    id: "agent_native",
    name: "Cleverness and Use of Agent-Native",
    weight: 20,
    description:
      "Use Agent-Native resourcefully to connect the whole experience.",
  },
];
const PRIZES: Prize[] = [
  {
    label: "Grand Prize",
    amount: 5000,
    currency: "USD",
    description: "Top overall project",
  },
  { label: "2nd Place", amount: 2500, currency: "USD" },
  { label: "3rd Place", amount: 1500, currency: "USD" },
  { label: "4th Place", amount: 750, currency: "USD" },
  { label: "5th Place", amount: 250, currency: "USD" },
];
const CHECKLIST = [
  {
    label: "Working app built with Agent-Native",
    kind: "deployment",
    detail: "UI and agent share the same actions and data.",
  },
  {
    label: "Public Clips demo video",
    kind: "demo_video",
    detail:
      "Record a public Clips demo of your working app (clips.agent-native.com).",
  },
  {
    label: "Project details + public demo link",
    kind: "form",
    detail:
      "Submit at builder.io/hackathon/submit before Nov 9, 11:59 PM PT. Identify every team member.",
  },
  {
    label: "Review the Official Rules",
    kind: "other",
    detail:
      "Eligibility and submission requirements: builder.io/hackathon/rules",
  },
];
const IDEAS = [
  {
    title: "HackPilot",
    pitch:
      "Paste a hackathon URL and an agent builds your war room: rubric-weighted idea board, a sprint plan that re-plans itself, and a submission checklist. The UI and the agent share every action, so you can drag a card or just ask.",
    tags: ["productivity", "planning", "meta"],
    scores: { usefulness: 8, creativity: 7, innovation: 7.5, agent_native: 9 },
    rationale:
      "Solves a real pain for every entrant (usefulness 8); rubric-aware scoring is distinctive (7); agent re-plans and audits readiness (7.5); every capability is one defineAction shared by UI, chat, CLI, and MCP (9).",
    selected: true,
  },
  {
    title: "Inbox to Invoice",
    pitch:
      "Freelancers forward client threads; the agent drafts invoices from agreed scope and the UI lets them approve line items before sending.",
    tags: ["finance", "email"],
    scores: { usefulness: 7, creativity: 5, innovation: 6, agent_native: 6.5 },
    rationale:
      "Clear value but crowded space; email integration eats build time.",
  },
  {
    title: "Meeting Debt Collector",
    pitch:
      "Turns meeting transcripts into owned action items with nudges, and a board where people close, reassign, or snooze them alongside the agent.",
    tags: ["teams", "productivity"],
    scores: { usefulness: 7, creativity: 6, innovation: 6.5, agent_native: 7 },
    rationale: "Useful and demoable; transcript ingestion is the risk.",
  },
  {
    title: "Grant Radar",
    pitch:
      "An agent that finds open grants matching a nonprofit's mission, scores fit, and drafts the first application section for human editing.",
    tags: ["nonprofit", "research"],
    scores: { usefulness: 6.5, creativity: 6, innovation: 7, agent_native: 6 },
    rationale:
      "Strong story; data sources are scattered and hard to demo reliably.",
  },
  {
    title: "Lease Lens",
    pitch:
      "Upload two apartment leases; the agent extracts terms into a side-by-side table you can annotate, and flags clauses worth negotiating.",
    tags: ["documents", "consumer"],
    scores: {
      usefulness: 6,
      creativity: 6.5,
      innovation: 6,
      agent_native: 5.5,
    },
    rationale: "Nice UI moment, but PDF parsing dominates the build.",
  },
];

export default defineAction({
  description:
    "Create (or return) the demo workspace for the Builder.io Agent-Native Hackathon (https://www.builder.io/hackathon) with its real rubric, prizes, deadline, checklist, five scored ideas, and a sprint plan. Idempotent per user.",
  schema: z.object({
    timezone: z
      .string()
      .optional()
      .describe(
        "IANA timezone for the sprint plan; default America/Los_Angeles",
      ),
  }),
  outputSchema: z.object({
    id: z.string(),
    created: z.boolean(),
    message: z.string(),
  }),
  link: ({ result }) => hackathonLink(result.id),
  run: async (args, ctx) => {
    const ownerEmail =
      ctx?.userEmail ??
      fail("Sign in to create the demo.", {
        errorCode: "unauthenticated",
        statusCode: 401,
      });
    const orgId = ctx?.orgId ?? null;
    const db = getDb();
    const { hackathons, hackathonShares, ideas, submissionItems } = schema;
    const [existing] = await db
      .select({ id: hackathons.id })
      .from(hackathons)
      .where(
        and(
          eq(hackathons.url, DEMO_URL),
          accessFilter(hackathons, hackathonShares),
        ),
      )
      .limit(1);
    if (existing) {
      return {
        id: existing.id,
        created: false,
        message: "The Builder.io hackathon demo already exists.",
      };
    }
    const id = crypto.randomUUID();
    const now = nowIso();
    await db.transaction(async (tx) => {
      await tx.insert(hackathons).values({
        id,
        name: "Agent-Native Hackathon",
        url: DEMO_URL,
        tagline:
          "Build AI agents with interfaces people love to use — an app where people and agents work together.",
        deadlineAt: zonedWallTimeToUtcIso(
          { year: 2026, month: 11, day: 9, hour: 23, minute: 59 },
          "America/Los_Angeles",
        ),
        timezone: "America/Los_Angeles",
        prizes: PRIZES,
        rubric: RUBRIC,
        notes:
          "Open worldwide, solo or team, no registration. Final weekend Nov 6–8; winners announced Nov 13. Recognition categories: Best Overall, Best Productivity, Most Creative, Best Use of Agent-Native.",
        extraction: "seed",
        importedAt: now,
        createdAt: now,
        updatedAt: now,
        ownerEmail,
        orgId,
        visibility: orgId ? "org" : "private",
      });
      await tx.insert(submissionItems).values(
        CHECKLIST.map((c, position) => ({
          id: crypto.randomUUID(),
          hackathonId: id,
          ...c,
          status: "todo",
          position,
          ownerEmail,
          orgId,
        })),
      );
      await tx.insert(ideas).values(
        IDEAS.map((idea, position) => ({
          id: crypto.randomUUID(),
          hackathonId: id,
          title: idea.title,
          pitch: idea.pitch,
          tags: idea.tags,
          scores: idea.scores,
          rationale: idea.rationale,
          selected: idea.selected ?? false,
          position,
          source: "agent",
          ownerEmail,
          orgId,
        })),
      );
    });
    // Same planner the UI and agent use. A passed deadline just skips the plan.
    try {
      await planSprint.run(
        {
          hackathonId: id,
          mode: "fresh",
          timezone: args.timezone ?? "America/Los_Angeles",
        },
        ctx,
      );
    } catch {
      // deadline_passed: the demo still has ideas and a checklist.
    }
    return {
      id,
      created: true,
      message: "Created the Builder.io Agent-Native Hackathon demo workspace.",
    };
  },
});
