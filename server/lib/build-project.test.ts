import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  getRequestContext: vi.fn(),
  reapInterrupted: vi.fn(),
  select: vi.fn(),
  startBuild: vi.fn(),
  readDesignPrototypeForIdea: vi.fn(),
  insert: vi.fn(),
}));

vi.mock("@agent-native/core/server", () => ({
  getRequestContext: mocks.getRequestContext,
}));
vi.mock("./workspace.js", () => ({
  hackathonLink: vi.fn(),
  nowIso: () => "2026-11-08T12:00:00.000Z",
  requireHackathon: mocks.access,
}));
vi.mock("./builder.js", () => ({
  reapInterrupted: mocks.reapInterrupted,
  startBuild: mocks.startBuild,
  waitForBuild: vi.fn(),
}));
vi.mock("./build-serialize.js", () => ({
  serializeBuild: (row: Record<string, unknown>) => ({
    rounds: 0,
    files: [],
    notes: null,
    error: null,
    downloadUrl: null,
    previewUrl: null,
    createdAt: "2026-11-08T12:00:00.000Z",
    updatedAt: "2026-11-08T12:00:00.000Z",
    finishedAt: null,
    ...row,
  }),
}));
vi.mock("./design-prototype.js", () => ({
  readDesignPrototypeForIdea: mocks.readDesignPrototypeForIdea,
}));
vi.mock("../db/index.js", async () => ({
  getDb: () => ({
    select: mocks.select,
    insert: () => ({ values: mocks.insert }),
  }),
  schema: await import("../db/schema.js"),
}));

import action from "../../actions/build-project.js";
import { schema } from "../db/index.js";

const input = { hackathonId: "hackathon", ideaId: "requested-idea" };
const email = "build-editor@example.test";
const ctx = { caller: "http" as const, userEmail: email };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.access.mockResolvedValue({
    id: input.hackathonId,
    ownerEmail: "workspace-owner@example.test",
    orgId: "workspace-org",
  });
  mocks.getRequestContext.mockReturnValue({ userEmail: email, authUserId: "authenticated-editor" });
  mocks.readDesignPrototypeForIdea.mockResolvedValue({ id: "prototype" });
  mocks.select.mockReturnValue({
    from: (table: unknown) => ({
      where: () => ({
        orderBy: () => ({ limit: async () => [{ id: input.ideaId, title: "Requested idea" }] }),
        limit: async () => table === schema.builds ? [mocks.insert.mock.lastCall?.[0]].filter(Boolean) : [],
      }),
    }),
  });
});

describe("Design build selection", () => {
  it("defaults to the caller's prototype for the exact idea and registers the build as private", async () => {
    await action.run(input, ctx);
    expect(mocks.readDesignPrototypeForIdea).toHaveBeenCalledWith(input.hackathonId, input.ideaId, email);
    expect(mocks.insert).toHaveBeenCalledWith(expect.objectContaining({
      ideaId: input.ideaId,
      designPrototypeId: "prototype",
      designOwnerAuthId: "authenticated-editor",
      ownerEmail: email,
      orgId: null,
    }));
  });

  it.each([{ design: "off" as const }, { mode: "template" as const }])(
    "skips the linked Design for %j",
    async (options) => {
      await action.run({ ...input, ...options }, ctx);
      expect(mocks.readDesignPrototypeForIdea).not.toHaveBeenCalled();
      expect(mocks.insert).toHaveBeenCalledWith(expect.objectContaining({
        designPrototypeId: null,
        designOwnerAuthId: null,
        orgId: "workspace-org",
      }));
    },
  );

  it("builds an idea with no linked prototype normally", async () => {
    mocks.readDesignPrototypeForIdea.mockResolvedValue(null);
    await action.run(input, ctx);
    expect(mocks.insert).toHaveBeenCalledWith(expect.objectContaining({
      mode: "llm",
      designPrototypeId: null,
      orgId: "workspace-org",
    }));
  });

  it("does not start a second worker or reveal an unreadable active run", async () => {
    mocks.reapInterrupted.mockResolvedValue("private-running-build");
    await expect(action.run(input, ctx)).rejects.toMatchObject({ errorCode: "build_busy", statusCode: 409 });
    expect(mocks.readDesignPrototypeForIdea).not.toHaveBeenCalled();
    expect(mocks.startBuild).not.toHaveBeenCalled();
  });
});
