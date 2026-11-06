import { z } from "zod";

import type { Criterion } from "../../shared/hackpilot.js";
import { generateStructured } from "./llm.js";
import type { HackathonRow } from "./workspace.js";

function rubricText(rubric: Criterion[]): string {
  return rubric
    .map(
      (c) =>
        `- ${c.id} (${c.weight}%): ${c.name}${c.description ? ` — ${c.description}` : ""}`,
    )
    .join("\n");
}

function contextText(h: HackathonRow): string {
  return [
    `Hackathon: ${h.name}`,
    h.tagline ? `Theme: ${h.tagline}` : "",
    h.deadlineAt ? `Deadline: ${h.deadlineAt} (${h.timezone})` : "",
    `Judging rubric (score each 0-10):\n${rubricText(h.rubric)}`,
    h.notes ? `Builder notes: ${h.notes}` : "",
    h.sourceText ? `Page excerpt:\n${h.sourceText.slice(0, 6000)}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function scoresSchema(rubric: Criterion[]) {
  return z.object(
    Object.fromEntries(rubric.map((c) => [c.id, z.number().min(0).max(10)])),
  );
}

export async function aiGenerateIdeas(
  h: HackathonRow,
  opts: { count: number; brief?: string | undefined; existingTitles: string[] },
) {
  const schema = z.object({
    ideas: z.array(
      z.object({
        title: z.string(),
        pitch: z.string(),
        tags: z.array(z.string()),
        scores: scoresSchema(h.rubric),
        rationale: z.string(),
      }),
    ),
  });
  return generateStructured({
    schema,
    system:
      "You are a hackathon strategist. Propose distinct, buildable project ideas a solo developer can ship before the deadline, and score them honestly and critically against the rubric (most ideas should land between 4 and 8).",
    prompt: `${contextText(h)}\n\n${opts.brief ? `Builder's direction: ${opts.brief}\n\n` : ""}Avoid repeating these existing ideas: ${opts.existingTitles.join("; ") || "(none)"}.\n\nReturn exactly ${opts.count} ideas. Pitch: 2-3 sentences (user, problem, what the agent does, the demo wow moment). Tags: 2-4 lowercase words. Rationale: one short line per criterion.`,
  });
}

export async function aiScoreIdea(
  h: HackathonRow,
  idea: { title: string; pitch: string },
) {
  const schema = z.object({
    scores: scoresSchema(h.rubric),
    rationale: z.string(),
  });
  return generateStructured({
    schema,
    system:
      "You are a strict hackathon judge. Score the idea 0-10 on each rubric criterion. Be calibrated: 5 is average, 8+ is rare.",
    prompt: `${contextText(h)}\n\nIdea: ${idea.title}\n${idea.pitch}\n\nReturn scores keyed by criterion id and a short rationale (one line per criterion).`,
  });
}
