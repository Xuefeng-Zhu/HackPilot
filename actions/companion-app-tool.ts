import { defineAction, fail } from "@agent-native/core/action";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import {
  companionOperation,
  companionWrites,
  currentCompanionUser,
  discoverCompanionTools,
  invokeCompanionTool,
} from "../server/lib/companion-apps.js";
import { requireHackathon } from "../server/lib/workspace.js";
import {
  COMPANION_APP_IDS,
  COMPANION_ARTIFACT_ID_PATTERN,
  COMPANION_EDITOR_LINK_RENDERER,
} from "../shared/companion-apps.js";

const companionAppSchema = z.enum(COMPANION_APP_IDS);
const verifiedResult = z.object({
  status: z.literal("verified"),
  artifact: z.object({ id: z.string().regex(COMPANION_ARTIFACT_ID_PATTERN) }),
  result: z.object({ title: z.string().optional() }),
});

export default defineAction({
  description:
    "Discover or call approved Content, Slides, Plan, and Design draft tools using the current editor's personal connection. Discover first and use the returned input schema. After a write, verify the returned ID with the app's read tool before giving the user its link.",
  schema: z.discriminatedUnion("operation", [
    z.object({
      operation: z.literal("discover"),
      app: companionAppSchema.describe("Companion app selected by the user"),
      hackathonId: z
        .string()
        .min(1)
        .max(200)
        .describe("Hackathon workspace ID"),
    }),
    z.object({
      operation: z.literal("invoke"),
      app: companionAppSchema.describe("Companion app selected by the user"),
      hackathonId: z
        .string()
        .min(1)
        .max(200)
        .describe("Hackathon workspace ID"),
      tool: z
        .string()
        .min(1)
        .max(100)
        .describe("Exact tool name from discovery"),
      input: z
        .record(z.string(), z.json())
        .default({})
        .describe("Tool arguments from the discovered contract"),
    }),
  ]),
  http: false,
  chatUI: {
    renderer: COMPANION_EDITOR_LINK_RENDERER,
    when: (_args, result) => verifiedResult.safeParse(result).success,
    projectResult: (args, result) => {
      const verified = verifiedResult.parse(result);
      return {
        app: companionAppSchema.parse(args.app),
        id: verified.artifact.id,
        ...(verified.result.title ? { title: verified.result.title } : {}),
      };
    },
  },
  toolCallable: false,
  timeoutMs: 30_000,
  retrySafe: (args) =>
    args.operation === "discover" || !companionWrites(args.app, args.tool),
  authorize: (_args, context) =>
    context?.caller === "tool" &&
    !context.networkProtocol &&
    !context.automation,
  run: async (args, context) => {
    const userEmail = currentCompanionUser();
    await requireHackathon(args.hackathonId, "editor");
    const effect =
      args.operation === "invoke" &&
      companionOperation(args.app, args.tool)?.effect;
    if (
      args.operation === "discover" ||
      effect === "create" ||
      effect === "fill"
    ) {
      const db = getDb();
      const [idea] = await db
        .select({ id: schema.ideas.id })
        .from(schema.ideas)
        .where(
          and(
            eq(schema.ideas.hackathonId, args.hackathonId),
            eq(schema.ideas.selected, true),
          ),
        )
        .limit(1);
      if (!idea) {
        fail(
          "Select an idea in HackPilot before starting a companion artifact.",
          { errorCode: "companion_missing_idea" },
        );
      }
      if (args.app === "plan") {
        const [task] = await db
          .select({ id: schema.tasks.id })
          .from(schema.tasks)
          .where(eq(schema.tasks.hackathonId, args.hackathonId))
          .limit(1);
        if (!task) {
          fail(
            "Create a sprint plan in HackPilot before opening this handoff in Plan.",
            { errorCode: "companion_missing_sprint" },
          );
        }
      }
    }
    return args.operation === "discover"
      ? discoverCompanionTools(args.app, userEmail)
      : invokeCompanionTool(
          args.app,
          userEmail,
          args.tool,
          args.input,
          context,
        );
  },
});
