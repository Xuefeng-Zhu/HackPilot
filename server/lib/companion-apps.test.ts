import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  currentContext: vi.fn(),
  listRemoteServers: vi.fn(),
  toHttpServerConfigAsync: vi.fn(),
  makeManager: vi.fn(),
  getToolsForServer: vi.fn(),
  callTool: vi.fn(),
  requireHackathon: vi.fn(),
  select: vi.fn(),
  limit: vi.fn(),
  getUserSetting: vi.fn(),
  putUserSetting: vi.fn(),
}));

vi.mock("@agent-native/core/mcp-client", () => ({
  listRemoteServers: mocks.listRemoteServers,
  toHttpServerConfigAsync: mocks.toHttpServerConfigAsync,
  McpClientManager: class {
    constructor(config: unknown) {
      mocks.makeManager(config);
    }
    start = async () => undefined;
    stop = async () => undefined;
    hasServer = () => true;
    getToolsForServer = mocks.getToolsForServer;
    callTool = mocks.callTool;
  },
}));
vi.mock("@agent-native/core/server", () => ({
  getRequestContext: mocks.currentContext,
}));
vi.mock("@agent-native/core/settings", () => ({
  getUserSetting: mocks.getUserSetting,
  putUserSetting: mocks.putUserSetting,
}));
vi.mock("./workspace.js", () => ({
  requireHackathon: mocks.requireHackathon,
}));
vi.mock("../db/index.js", async () => ({
  getDb: () => ({ select: mocks.select }),
  schema: await import("../db/schema.js"),
}));

import action from "../../actions/companion-app-tool.js";
import {
  discoverCompanionTools,
  invokeCompanionTool,
  listCompanionConnections,
} from "./companion-apps.js";
import { readDesignBuildReference } from "./design-build-reference.js";

const userEmail = "editor@example.test";
const context = { caller: "tool", userEmail } as const;
const origin = "https://slides.agent-native.com";
const connection = {
  id: "slides",
  name: "slides",
  url: `${origin}/mcp`,
  oauthSecretKey: "ref",
};
const slides = Array.from({ length: 5 }, (_, index) => ({
  id: `slide-${index + 1}`,
  content: "<div class='fmd-slide'>A real slide</div>",
}));

function mcpTool(
  name: string,
  properties: Record<string, object>,
  required: string[],
  app = "slides",
) {
  return {
    name: `mcp__${app}__${name}`,
    originalName: name,
    inputSchema: { properties, required },
  };
}

const createDeck = mcpTool(
  "create-deck",
  {
    title: { type: "string" },
    slides: { type: "array" },
    visibility: { type: "string" },
    deckId: { type: "string" },
  },
  ["title", "slides"],
);
const getDeck = mcpTool("get-deck", { id: { type: "string" } }, ["id"]);

beforeEach(() => {
  vi.resetAllMocks();
  mocks.currentContext.mockReturnValue(context);
  mocks.listRemoteServers.mockResolvedValue([connection]);
  mocks.toHttpServerConfigAsync.mockResolvedValue({
    type: "http",
    url: connection.url,
    headers: { Authorization: "Bearer fake", Host: "untrusted.example" },
  });
  mocks.getToolsForServer.mockReturnValue([createDeck, getDeck]);
  mocks.requireHackathon.mockResolvedValue({ id: "hackathon-id" });
  mocks.select.mockReturnValue({
    from: () => ({ where: () => ({ limit: mocks.limit }) }),
  });
  mocks.limit.mockResolvedValue([{ id: "idea" }]);
});

afterEach(() => vi.unstubAllGlobals());

describe("Design input for builds", () => {
  const url = "https://design.agent-native.com/mcp";
  const index = {
    filename: "index.html",
    fileType: "html",
    content: "<!doctype html><body><main><button>Save mission</button></main></body>",
  };

  beforeEach(() => {
    mocks.listRemoteServers.mockResolvedValue([{ ...connection, url }]);
    mocks.toHttpServerConfigAsync.mockResolvedValue({
      type: "http",
      url,
      headers: { Authorization: "Bearer fake" },
    });
    mocks.getToolsForServer.mockReturnValue([
      mcpTool("get-design", { id: { type: "string" }, includeFileContent: { type: "boolean" } }, ["id"], "design"),
    ]);
  });

  it("reads the exact owned private draft with its saved file", async () => {
    mocks.callTool.mockResolvedValue({
      structuredContent: { design: { id: "saved", visibility: "private", accessRole: "owner", files: [index] } },
    });

    const reference = await readDesignBuildReference(userEmail, "saved");
    expect(reference).toContain("Save mission");
    expect(reference).not.toContain("<button>");
    expect(mocks.listRemoteServers).toHaveBeenCalledWith("user", userEmail);
    expect(mocks.callTool).toHaveBeenCalledWith("mcp__design__get-design", {
      id: "saved",
      includeFileContent: true,
    });
  });

  it.each([
    { id: "another" },
    { accessRole: "editor" },
    { visibility: "public" },
    { files: [{ ...index, filename: "preview.html" }] },
  ])("does not use an unverified draft (%j)", async (override) => {
    mocks.callTool.mockResolvedValue({
      structuredContent: { id: "saved", visibility: "private", accessRole: "owner", files: [index], ...override },
    });

    await expect(readDesignBuildReference(userEmail, "saved")).rejects.toMatchObject({
      errorCode: "companion_readback_unverified",
    });
  });

  it("reports a revoked connection without including its provider response", async () => {
    mocks.toHttpServerConfigAsync.mockRejectedValue(new Error("private provider response"));
    await expect(readDesignBuildReference(userEmail, "saved")).rejects.toMatchObject({
      errorCode: "companion_auth_unavailable",
      message: expect.not.stringContaining("private provider response"),
    });
    expect(mocks.callTool).not.toHaveBeenCalled();
  });
});

describe("companion MCP boundary", () => {
  it("recognizes only the exact personal endpoint and keeps status local", async () => {
    mocks.listRemoteServers.mockResolvedValue([
      { ...connection, url: "https://slides.agent-native.com.example/mcp" },
      { ...connection, url: `${origin}/mcp?token=bad` },
      { ...connection, firstParty: true },
    ]);
    await expect(listCompanionConnections(userEmail)).resolves.toEqual({});
    await expect(
      discoverCompanionTools("slides", userEmail),
    ).rejects.toMatchObject({
      errorCode: "companion_not_connected",
    });
    expect(mocks.listRemoteServers).toHaveBeenCalledWith("user", userEmail);
    expect(mocks.makeManager).not.toHaveBeenCalled();
  });

  it("asks the user to reconnect when the saved grant has been revoked", async () => {
    mocks.toHttpServerConfigAsync.mockRejectedValue(
      new Error("OAuth refresh denied for bearer fake"),
    );
    const discovery = discoverCompanionTools("slides", userEmail);
    await expect(discovery).rejects.toMatchObject({
      errorCode: "companion_auth_unavailable",
    });
    await expect(discovery).rejects.not.toThrow("bearer fake");
    expect(mocks.makeManager).not.toHaveBeenCalled();
  });

  it("only passes the scoped bearer to the approved host and hides existing deck inputs", async () => {
    const result = await discoverCompanionTools("slides", userEmail);
    expect(mocks.makeManager).toHaveBeenCalledWith({
      servers: {
        slides: {
          type: "http",
          url: connection.url,
          headers: { Authorization: "Bearer fake" },
        },
      },
    });
    expect(result.tools.map(({ name }) => name)).toEqual([
      "create-deck",
      "get-deck",
    ]);
    expect(result.tools[0]?.inputSchema.properties).not.toHaveProperty(
      "deckId",
    );
  });

  it("requires five populated slides and forces explicit private visibility", async () => {
    const input = { title: "Pitch", slides };
    for (const args of [
      { ...input, slides: slides.slice(0, 4) },
      { ...input, deckId: "existing" },
      { ...input, visibility: "public" },
    ]) {
      await expect(
        invokeCompanionTool("slides", userEmail, "create-deck", args, context),
      ).rejects.toMatchObject({ errorCode: "invalid_companion_arguments" });
    }
    expect(mocks.callTool).not.toHaveBeenCalled();

    mocks.callTool.mockResolvedValue({ structuredContent: { id: "draft" } });
    await expect(
      invokeCompanionTool("slides", userEmail, "create-deck", input, context),
    ).resolves.toEqual({ status: "written", result: { id: "draft" } });
    expect(mocks.callTool.mock.calls[0]?.[1]).toEqual({
      ...input,
      visibility: "private",
    });
  });

  it.each([
    `${origin}/_agent-native/open?app=slides&view=editor&deckId=draft&agentSidebar=closed`,
    `${origin}/deck/draft`,
  ])(
    "recovers only a candidate ID from the structured Slides link %s",
    async (webUrl) => {
      mocks.callTool.mockResolvedValueOnce({
        content: [
          {
            type: "text",
            text: "create-deck completed for untrusted-prose-id.",
          },
        ],
        _meta: { "agent-native/openLink": { webUrl } },
      });
      await expect(
        invokeCompanionTool(
          "slides",
          userEmail,
          "create-deck",
          { title: "Pitch", slides },
          context,
        ),
      ).resolves.toEqual({ status: "written", result: { id: "draft" } });

      mocks.callTool.mockResolvedValueOnce({
        structuredContent: { id: "draft", visibility: "private", slides },
      });
      await expect(
        invokeCompanionTool(
          "slides",
          userEmail,
          "get-deck",
          { id: "draft" },
          context,
        ),
      ).resolves.toMatchObject({
        status: "verified",
        artifact: { id: "draft", url: `${origin}/deck/draft` },
      });
    },
  );

  it.each([
    "https://slides.agent-native.com.example/deck/draft",
    "http://slides.agent-native.com/deck/draft",
    `${origin}/_agent-native/open?app=slides&view=editor&deckId=draft&deckId=other`,
    `${origin}/_agent-native/open?app=slides&view=editor&deckId=draft&to=https://example.test/`,
    `${origin}/_agent-native/open?app=design&view=editor&deckId=draft`,
    `${origin}/_agent-native/open?app=slides&view=home&deckId=draft`,
    `${origin}/deck/draft?token=anything`,
  ])("rejects a noncanonical Slides link %s", async (webUrl) => {
    mocks.callTool.mockResolvedValueOnce({
      content: [{ type: "text", text: "Deck created." }],
      _meta: { "agent-native/openLink": { webUrl } },
    });
    await expect(
      invokeCompanionTool(
        "slides",
        userEmail,
        "create-deck",
        { title: "Pitch", slides },
        context,
      ),
    ).rejects.toMatchObject({ errorCode: "companion_write_outcome_unknown" });
    expect(mocks.callTool).toHaveBeenCalledTimes(1);
  });

  it("does not accept a Slides error response or a URL present only in prose", async () => {
    for (const response of [
      { content: [{ type: "text", text: `Open deck: ${origin}/deck/draft` }] },
      {
        isError: true,
        content: [],
        _meta: { "agent-native/openLink": { webUrl: `${origin}/deck/draft` } },
      },
    ]) {
      mocks.callTool.mockResolvedValueOnce(response);
      await expect(
        invokeCompanionTool(
          "slides",
          userEmail,
          "create-deck",
          { title: "Pitch", slides },
          context,
        ),
      ).rejects.toMatchObject({ errorCode: "companion_write_outcome_unknown" });
    }
  });

  it("returns an artifact link only for matching, private, populated readback", async () => {
    const read = () =>
      invokeCompanionTool(
        "slides",
        userEmail,
        "get-deck",
        { id: "draft" },
        context,
      );
    for (const deck of [
      { id: "other", visibility: "private", slides },
      { id: "draft", visibility: "public", slides },
      { id: "draft", visibility: "private", slides: [] },
    ]) {
      mocks.callTool.mockResolvedValue({ structuredContent: { deck } });
      await expect(read()).rejects.toMatchObject({
        errorCode: "companion_readback_unverified",
      });
    }
    mocks.callTool.mockResolvedValue({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            deck: {
              id: "draft",
              title: "Pitch",
              visibility: "private",
              slides,
            },
          }),
        },
        {
          type: "text",
          text: "[Untrusted link](https://example.test/deck/draft)",
        },
      ],
    });
    await expect(read()).resolves.toEqual({
      status: "verified",
      artifact: { id: "draft", url: `${origin}/deck/draft` },
      result: { id: "draft", title: "Pitch", slideCount: 5 },
    });
  });

  it("reports an unknown write after a timeout without leaking or retrying it", async () => {
    mocks.callTool.mockRejectedValue(
      new Error("request timed out with bearer fake"),
    );
    const write = invokeCompanionTool(
      "slides",
      userEmail,
      "create-deck",
      { title: "Pitch", slides },
      context,
    );
    await expect(write).rejects.toMatchObject({
      errorCode: "companion_write_outcome_unknown",
    });
    await expect(write).rejects.not.toThrow("bearer fake");
    expect(mocks.callTool).toHaveBeenCalledTimes(1);
  });

  it("refuses creation when a compatible read-back action is unavailable", async () => {
    mocks.getToolsForServer.mockReturnValue([createDeck]);
    await expect(
      invokeCompanionTool(
        "slides",
        userEmail,
        "create-deck",
        { title: "Pitch", slides },
        context,
      ),
    ).rejects.toMatchObject({ errorCode: "companion_readback_unavailable" });
    expect(mocks.callTool).not.toHaveBeenCalled();
  });
});

describe("companion action access and prerequisites", () => {
  const args = {
    hackathonId: "hackathon-id",
    app: "plan",
    operation: "discover",
  } as const;

  it("projects an editor button only after verified readback", () => {
    const renderer = action.chatUI;
    const candidate = { status: "written", result: { id: "draft" } };
    const verified = {
      status: "verified",
      artifact: {
        id: "draft",
        url: "https://plan.agent-native.com/plans/draft",
      },
      result: { id: "draft", title: "Sprint" },
    };
    expect(renderer?.renderer).toBe("hackpilot.companion-editor-link");
    expect(renderer?.when?.(args, candidate)).toBe(false);
    expect(renderer?.when?.(args, verified)).toBe(true);
    expect(renderer?.projectResult?.(args, verified)).toEqual({
      app: "plan",
      id: "draft",
      title: "Sprint",
    });
  });

  it("keeps discovery out of HTTP, remote, and automated contexts", async () => {
    expect(action.http).toBe(false);
    for (const request of [
      { ...context, caller: "http" as const },
      { ...context, networkProtocol: "mcp" as const },
      { ...context, networkProtocol: "a2a" as const },
    ]) {
      await expect(action.run(args, request)).rejects.toThrow();
    }
    expect(mocks.requireHackathon).not.toHaveBeenCalled();
  });

  it("checks edit access before reading settings or opening a connection", async () => {
    mocks.requireHackathon.mockRejectedValue(new Error("no editor access"));
    await expect(action.run(args, context)).rejects.toThrow("no editor access");
    expect(mocks.requireHackathon).toHaveBeenCalledWith(
      args.hackathonId,
      "editor",
    );
    expect(mocks.listRemoteServers).not.toHaveBeenCalled();
  });

  it("requires a selected idea and a Plan sprint before contacting the app", async () => {
    mocks.limit.mockResolvedValueOnce([]);
    await expect(action.run(args, context)).rejects.toMatchObject({
      errorCode: "companion_missing_idea",
    });
    mocks.limit
      .mockResolvedValueOnce([{ id: "idea" }])
      .mockResolvedValueOnce([]);
    await expect(action.run(args, context)).rejects.toMatchObject({
      errorCode: "companion_missing_sprint",
    });
    expect(mocks.listRemoteServers).not.toHaveBeenCalled();
  });
});

describe("selected idea's private Design shortcut", () => {
  const origin = "https://design.agent-native.com";
  const args = {
    operation: "invoke",
    app: "design",
    tool: "get-design",
    hackathonId: "hackathon-id",
    linkToIdeaId: "idea",
    input: { id: "prototype" },
  } as const;

  beforeEach(() => {
    mocks.listRemoteServers.mockResolvedValue([
      { ...connection, url: `${origin}/mcp` },
    ]);
    mocks.getToolsForServer.mockReturnValue([
      mcpTool("get-design", { id: {} }, ["id"], "design"),
    ]);
  });

  const draft = (accessRole: "owner" | "viewer") => ({
    structuredContent: {
      id: "prototype",
      accessRole,
      visibility: "private",
      files: [
        {
          filename: "index.html",
          fileType: "html",
          content: "<body>Prototype</body>",
        },
      ],
    },
  });

  it("saves the confirmed artifact for the requesting user and selected idea", async () => {
    mocks.callTool.mockResolvedValue(draft("owner"));
    mocks.getUserSetting.mockResolvedValue({ id: "prototype" });

    await expect(action.run(args, context)).resolves.toMatchObject({
      status: "verified",
      artifact: { url: `${origin}/design/prototype` },
      prototypeLink: { ideaId: "idea", status: "saved" },
    });
    expect(mocks.putUserSetting).toHaveBeenCalledWith(
      userEmail,
      expect.stringContaining('["hackathon-id","idea"]'),
      { id: "prototype" },
    );
  });

  it("does not replace a shortcut using a draft the current user does not own", async () => {
    mocks.callTool.mockResolvedValue(draft("viewer"));
    await expect(action.run(args, context)).rejects.toMatchObject({
      errorCode: "companion_readback_unverified",
    });
    expect(mocks.putUserSetting).not.toHaveBeenCalled();
  });

  it("rejects a stale idea selection before contacting Design", async () => {
    mocks.limit.mockResolvedValue([{ id: "different-idea" }]);
    await expect(action.run(args, context)).rejects.toMatchObject({
      errorCode: "companion_idea_changed",
    });
    expect(mocks.callTool).not.toHaveBeenCalled();
    expect(mocks.putUserSetting).not.toHaveBeenCalled();
  });
});

describe("Plan's structured create acknowledgment", () => {
  const origin = "https://plan.agent-native.com";
  const planText =
    "## UI wireframe\n" + "- Review the prototype and checklist.\n".repeat(20);
  const open = `${origin}/_agent-native/open?app=plan&view=plan&to=%2Fplans%2Fdraft&planId=draft&agentSidebar=closed`;
  const create = () =>
    invokeCompanionTool(
      "plan",
      userEmail,
      "create-visual-plan",
      {
        title: "Sprint",
        planText,
      },
      context,
    );

  beforeEach(() => {
    mocks.listRemoteServers.mockResolvedValue([
      { ...connection, url: `${origin}/mcp` },
    ]);
    mocks.toHttpServerConfigAsync.mockResolvedValue({
      type: "http",
      url: `${origin}/mcp`,
      headers: { Authorization: "Bearer fake" },
    });
    mocks.getToolsForServer.mockReturnValue([
      mcpTool(
        "create-visual-plan",
        { title: {}, planText: {}, sections: { type: "array" } },
        ["planText"],
        "plan",
      ),
      mcpTool("get-visual-plan", { id: {} }, ["id"], "plan"),
    ]);
  });

  it("uses matching Plan ID and destination, then verifies the private plan", async () => {
    mocks.callTool.mockResolvedValueOnce({
      content: [{ type: "text", text: "Visual plan created." }],
      _meta: { "agent-native/openLink": { webUrl: open } },
    });
    await expect(create()).resolves.toEqual({
      status: "written",
      result: { id: "draft" },
    });
    expect(mocks.callTool.mock.calls[0]?.[1]).toEqual({
      title: "Sprint",
      planText,
      sections: [{ type: "custom", title: "Sprint snapshot", body: planText }],
    });
    mocks.callTool.mockResolvedValueOnce({
      structuredContent: {
        plan: {
          id: "draft",
          title: "Sprint",
          content: { blocks: [{ type: "rich-text" }] },
        },
        access: { visibility: "private" },
      },
    });
    await expect(
      invokeCompanionTool(
        "plan",
        userEmail,
        "get-visual-plan",
        { id: "draft" },
        context,
      ),
    ).resolves.toMatchObject({
      status: "verified",
      artifact: { id: "draft", url: `${origin}/plans/draft` },
    });
  });

  it("rejects mismatched paths and preserves write uncertainty on remote errors", async () => {
    mocks.callTool
      .mockResolvedValueOnce({
        _meta: {
          "agent-native/openLink": {
            webUrl: open.replace("planId=draft", "planId=other"),
          },
        },
      })
      .mockResolvedValueOnce({
        isError: true,
        _meta: { "agent-native/openLink": { webUrl: open } },
      });
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(create()).rejects.toMatchObject({
        errorCode: "companion_write_outcome_unknown",
      });
    }
    expect(mocks.callTool).toHaveBeenCalledTimes(2);
  });

  it("does not send a sprint to a Plan server without explicit sections", async () => {
    mocks.getToolsForServer.mockReturnValue([
      mcpTool(
        "create-visual-plan",
        { title: {}, planText: {} },
        ["planText"],
        "plan",
      ),
      mcpTool("get-visual-plan", { id: {} }, ["id"], "plan"),
    ]);
    await expect(create()).rejects.toMatchObject({
      errorCode: "companion_plan_section_unavailable",
    });
    expect(mocks.callTool).not.toHaveBeenCalled();
  });
});

describe("private Design handoff for an organization-scoped token", () => {
  const origin = "https://design.agent-native.com";
  const authorization = "Bearer fake-org-bearer";
  const title = "User's private project idea";
  const description = "Private description";
  const getDesign = mcpTool(
    "get-design",
    { id: { type: "string" } },
    ["id"],
    "design",
  );
  const create = () =>
    invokeCompanionTool(
      "design",
      userEmail,
      "create-design",
      { title, description },
      context,
    );
  const shell = (visibility: string, values: Record<string, unknown> = {}) => ({
    structuredContent: {
      id: "shell",
      accessRole: "owner",
      visibility,
      files: [],
      ...values,
    },
  });

  beforeEach(() => {
    mocks.listRemoteServers.mockResolvedValue([
      { ...connection, url: `${origin}/mcp` },
    ]);
    mocks.toHttpServerConfigAsync.mockResolvedValue({
      type: "http",
      url: `${origin}/mcp`,
      headers: { Authorization: authorization },
    });
    mocks.getToolsForServer.mockReturnValue([
      mcpTool(
        "create-design",
        {
          title: { type: "string" },
          description: { type: "string" },
          designSystemId: {},
        },
        ["title"],
        "design",
      ),
      getDesign,
      mcpTool(
        "create-file",
        { designId: {}, filename: {}, content: {}, fileType: {} },
        ["designId", "filename", "content"],
        "design",
      ),
      mcpTool(
        "update-design",
        { id: {}, title: {}, description: {} },
        ["id"],
        "design",
      ),
    ]);
    mocks.callTool.mockResolvedValueOnce({
      structuredContent: { id: "shell" },
    });
    mocks.callTool.mockResolvedValueOnce(shell("org"));
  });

  it("sends metadata only after reading back private visibility", async () => {
    const request = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", request);
    mocks.callTool.mockResolvedValueOnce(shell("private"));
    mocks.callTool.mockResolvedValueOnce({
      content: [{ type: "text", text: "update-design completed for shell." }],
    });
    mocks.callTool.mockResolvedValueOnce(
      shell("private", { title, description }),
    );
    await expect(create()).resolves.toEqual({
      status: "written",
      result: { id: "shell" },
    });
    expect(
      mocks.callTool.mock.calls.map(([tool, input]) => [tool, input]),
    ).toEqual([
      [
        "mcp__design__create-design",
        { title: "HackPilot prototype", designSystemId: null },
      ],
      ["mcp__design__get-design", { id: "shell" }],
      ["mcp__design__get-design", { id: "shell" }],
      ["mcp__design__update-design", { id: "shell", title, description }],
      ["mcp__design__get-design", { id: "shell" }],
    ]);
    expect(request).toHaveBeenCalledWith(
      `${origin}/_agent-native/actions/set-resource-visibility`,
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: authorization,
          "Content-Type": "application/json",
        },
        redirect: "error",
        body: JSON.stringify({
          resourceType: "design",
          resourceId: "shell",
          expectedVisibility: "org",
          visibility: "private",
        }),
      }),
    );
  });

  it("keeps project metadata local if privacy could not be confirmed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 403 })),
    );
    await expect(create()).rejects.toMatchObject({
      errorCode: "companion_design_privacy_unverified",
    });
    expect(mocks.callTool).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(mocks.callTool.mock.calls)).not.toContain(title);
  });

  it("does not replay a rename when readback still has the generic title", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 200 })),
    );
    mocks.callTool.mockResolvedValueOnce(shell("private"));
    mocks.callTool.mockResolvedValueOnce({
      content: [{ type: "text", text: "update-design completed for shell." }],
    });
    mocks.callTool.mockResolvedValueOnce(
      shell("private", { title: "HackPilot prototype" }),
    );

    await expect(create()).rejects.toMatchObject({
      errorCode: "companion_write_outcome_unknown",
    });
    expect(
      mocks.callTool.mock.calls.filter(
        ([name]) => name === "mcp__design__update-design",
      ),
    ).toHaveLength(1);
  });

  it("fills an empty Design with a system board and verifies the persisted screen", async () => {
    const content =
      "<!doctype html><html><body><main>Prototype</main></body></html>";
    const board = { id: "board", filename: "__board__.html", fileType: "html" };
    mocks.callTool.mockReset();
    mocks.callTool
      .mockResolvedValueOnce(shell("private", { files: [board] }))
      .mockResolvedValueOnce({
        content: [
          { type: "text", text: "create-file completed for ignored-id." },
        ],
      })
      .mockResolvedValueOnce(
        shell("private", {
          files: [
            board,
            {
              id: "persisted-file",
              filename: "index.html",
              fileType: "html",
              content,
            },
          ],
        }),
      );
    await expect(
      invokeCompanionTool(
        "design",
        userEmail,
        "create-file",
        {
          designId: "shell",
          filename: "index.html",
          fileType: "html",
          content,
        },
        context,
      ),
    ).resolves.toEqual({
      status: "written",
      result: { id: "shell", fileId: "persisted-file" },
    });
    expect(mocks.callTool.mock.calls.map(([name]) => name)).toEqual([
      "mcp__design__get-design",
      "mcp__design__create-file",
      "mcp__design__get-design",
    ]);
  });

  it("does not insert a screen when the Design has another file", async () => {
    mocks.callTool.mockReset();
    mocks.callTool.mockResolvedValueOnce(
      shell("private", {
        files: [{ filename: "__board__.html" }, { filename: "existing.html" }],
      }),
    );
    await expect(
      invokeCompanionTool(
        "design",
        userEmail,
        "create-file",
        {
          designId: "shell",
          filename: "index.html",
          fileType: "html",
          content: "<main>Prototype</main>",
        },
        context,
      ),
    ).rejects.toMatchObject({ errorCode: "companion_invalid_design" });
    expect(mocks.callTool.mock.calls.map(([name]) => name)).toEqual([
      "mcp__design__get-design",
    ]);
  });

  it("does not certify a file if privacy widened during its save", async () => {
    const content =
      "<!doctype html><html><body><main>Prototype</main></body></html>";
    mocks.callTool.mockReset();
    mocks.callTool
      .mockResolvedValueOnce(shell("private"))
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Saved." }] })
      .mockResolvedValueOnce(
        shell("org", {
          files: [
            {
              id: "persisted-file",
              filename: "index.html",
              fileType: "html",
              content,
            },
          ],
        }),
      );
    await expect(
      invokeCompanionTool(
        "design",
        userEmail,
        "create-file",
        {
          designId: "shell",
          filename: "index.html",
          fileType: "html",
          content,
        },
        context,
      ),
    ).rejects.toMatchObject({ errorCode: "companion_write_outcome_unknown" });
    expect(
      mocks.callTool.mock.calls.filter(
        ([name]) => name === "mcp__design__create-file",
      ),
    ).toHaveLength(1);
  });
});
