import { fail, type ActionRunContext } from "@agent-native/core/action";
import {
  listRemoteServers,
  McpClientManager,
  toHttpServerConfigAsync,
  type McpTool,
  type StoredRemoteMcpServer,
} from "@agent-native/core/mcp-client";
import { getRequestContext } from "@agent-native/core/server";

import {
  COMPANION_APPS,
  COMPANION_APP_IDS,
  COMPANION_ARTIFACT_ID_PATTERN,
  companionEditorUrl,
  type CompanionApp,
} from "../../shared/companion-apps.js";

type JsonRecord = Record<string, unknown>;
const hasOwn = (value: object, key: PropertyKey) =>
  Object.prototype.hasOwnProperty.call(value, key);
type Operation = {
  effect: "create" | "fill" | "verify" | "read";
  fields: string[];
};

const idFields = ["id", "documentId", "deckId", "planId", "designId"];
const operations: Record<CompanionApp, Record<string, Operation>> = {
  content: {
    "create-document": {
      effect: "create",
      fields: [
        "title",
        "content",
        "description",
        "preserveLeadingTitleHeading",
        "contextModeOverride",
      ],
    },
    "get-document": { effect: "verify", fields: ["id"] },
  },
  slides: {
    "create-deck": {
      effect: "create",
      fields: ["title", "slides", "aspectRatio", "contextModeOverride"],
    },
    "get-deck": {
      effect: "verify",
      fields: ["id", "deckId", "compact", "agentContext"],
    },
  },
  plan: {
    "get-plan-blocks": { effect: "read", fields: [] },
    "create-visual-plan": {
      effect: "create",
      fields: ["title", "brief", "planText"],
    },
    "get-visual-plan": {
      effect: "verify",
      fields: ["id", "includeMdx", "includeHtml"],
    },
  },
  design: {
    "create-design": {
      effect: "create",
      fields: ["title", "description", "projectType"],
    },
    "create-file": {
      effect: "fill",
      fields: ["designId", "filename", "content", "fileType"],
    },
    "get-design": { effect: "verify", fields: ["id", "includeFileContent"] },
  },
};

const recordKeys: Record<CompanionApp, string> = {
  content: "document",
  slides: "deck",
  plan: "plan",
  design: "design",
};
const readbackTools: Record<CompanionApp, string> = {
  content: "get-document",
  slides: "get-deck",
  plan: "get-visual-plan",
  design: "get-design",
};
const MAX_INPUT_CHARS = 96_000;
const MAX_SCHEMA_CHARS = 28_000;
const MAX_CATALOG_CHARS = 16_000;

export function currentCompanionUser() {
  const context = getRequestContext();
  const email = context?.userEmail?.trim().toLowerCase();
  if (!email || context?.agentRunAnonymous) {
    fail("Sign in to use companion apps.", {
      statusCode: 401,
      errorCode: "unauthorized",
    });
  }
  return email;
}

/** A local settings lookup. Do not resolve tokens or contact a destination here. */
export async function listCompanionConnections(userEmail: string) {
  const saved = await listRemoteServers("user", userEmail);
  const connections: Partial<Record<CompanionApp, StoredRemoteMcpServer>> = {};
  for (const app of COMPANION_APP_IDS) {
    const origin = COMPANION_APPS[app].origin;
    const connection = saved.find(
      (server) =>
        !server.firstParty &&
        (server.url === `${origin}/mcp` || server.url === `${origin}/mcp/`) &&
        Boolean(
          server.oauthSecretKey ||
          server.headerSecretKey ||
          bearerHeader(server.headers),
        ),
    );
    if (connection) connections[app] = connection;
  }
  return connections;
}

function bearerHeader(headers: Record<string, string> | undefined) {
  return Object.entries(headers ?? {}).find(
    ([key, value]) =>
      key.toLowerCase() === "authorization" && /^Bearer +[^\s]+$/i.test(value),
  )?.[1];
}

export function companionOperation(
  app: CompanionApp,
  tool: string | undefined,
): Operation | undefined {
  const allowed = operations[app];
  return tool && hasOwn(allowed, tool) ? allowed[tool] : undefined;
}

export function companionWrites(app: CompanionApp, tool: string | undefined) {
  const effect = companionOperation(app, tool)?.effect;
  return effect === "create" || effect === "fill";
}

async function withCompanion<T>(
  app: CompanionApp,
  userEmail: string,
  useTools: (
    manager: McpClientManager,
    tools: McpTool[],
    authorization: string,
  ) => Promise<T>,
) {
  const { label } = COMPANION_APPS[app];
  const stored = (await listCompanionConnections(userEmail))[app];
  if (!stored) {
    fail(
      `Connect ${label} as a personal MCP connection from this workspace first.`,
      {
        errorCode: "companion_not_connected",
      },
    );
  }
  const config = await toHttpServerConfigAsync("user", userEmail, stored).catch(
    () => null,
  );
  const auth = bearerHeader(config?.headers);
  if (!config || !auth) {
    fail(
      `The ${label} connection could not authenticate. Check it in Settings and reconnect if needed.`,
      {
        errorCode: "companion_auth_unavailable",
      },
    );
  }
  // Give the client only this approved origin and its personal bearer. The shared
  // manager may hold unrelated personal, organization, and workspace connectors.
  const manager = new McpClientManager(
    {
      servers: { [app]: { ...config, headers: { Authorization: auth } } },
    },
    { connectTimeoutMs: 8_000 },
  );
  try {
    await manager.start().catch(() => undefined);
    if (!manager.hasServer(app)) {
      fail(
        `Could not reach ${label}. Check the connection in Settings before trying again.`,
        {
          errorCode: "companion_unavailable",
        },
      );
    }
    const tools = manager.getToolsForServer(app);
    return await useTools(manager, tools, auth);
  } finally {
    await manager.stop().catch(() => undefined);
  }
}

function asRecord(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function contract(tool: McpTool, operation: Operation) {
  const fields = new Set(operation.fields);
  const properties = asRecord(tool.inputSchema.properties) ?? {};
  if (operation.effect === "create" && hasOwn(properties, "visibility"))
    fields.add("visibility");
  const required = Array.isArray(tool.inputSchema.required)
    ? tool.inputSchema.required
    : [];
  if (required.some((key) => typeof key !== "string" || !fields.has(key)))
    return null;
  const permitted = Object.fromEntries(
    Object.entries(properties).filter(([key]) => fields.has(key)),
  );
  if (
    operation.effect === "verify" &&
    !idFields.some((key) => hasOwn(permitted, key))
  )
    return null;
  if (
    operation.effect === "fill" &&
    ["designId", "filename", "content", "fileType"].some(
      (key) => !hasOwn(permitted, key),
    )
  )
    return null;
  const inputSchema = {
    type: "object",
    properties: permitted,
    required,
    additionalProperties: false,
    ...(tool.inputSchema.$defs ? { $defs: tool.inputSchema.$defs } : {}),
    ...(tool.inputSchema.definitions
      ? { definitions: tool.inputSchema.definitions }
      : {}),
  };
  return JSON.stringify(inputSchema).length <= MAX_SCHEMA_CHARS
    ? inputSchema
    : null;
}

export async function discoverCompanionTools(
  app: CompanionApp,
  userEmail: string,
) {
  return withCompanion(app, userEmail, async (_manager, tools) => ({
    status: "ready" as const,
    tools: tools.flatMap((tool) => {
      const operation = companionOperation(app, tool.originalName);
      const inputSchema = operation && contract(tool, operation);
      return inputSchema ? [{ name: tool.originalName, inputSchema }] : [];
    }),
  }));
}

function artifactId(value: unknown) {
  return typeof value === "string" && COMPANION_ARTIFACT_ID_PATTERN.test(value)
    ? value
    : undefined;
}

function requestedId(input: JsonRecord) {
  const supplied = idFields.filter((key) => hasOwn(input, key));
  return supplied.length === 1
    ? artifactId(input[supplied[0] ?? ""])
    : undefined;
}

function resultRecord(response: unknown): JsonRecord | undefined {
  const envelope = asRecord(response);
  if (!envelope || envelope.isError === true) return undefined;
  const structured = asRecord(envelope.structuredContent);
  if (structured) return structured;
  if (!Array.isArray(envelope.content)) return undefined;
  for (const item of envelope.content) {
    const part = asRecord(item);
    if (
      part?.type !== "text" ||
      typeof part.text !== "string" ||
      part.text.length > 1_000_000
    )
      continue;
    try {
      const parsed = asRecord(JSON.parse(part.text));
      if (parsed) return parsed;
    } catch {
      // Ordinary text and separate link blocks are not trusted receipts.
    }
  }
}

function companionOpenLinkId(
  app: "slides" | "plan",
  envelope: JsonRecord | undefined,
) {
  if (!envelope || envelope.isError === true) return undefined;
  const meta = asRecord(envelope._meta);
  const webUrl = asRecord(meta?.["agent-native/openLink"])?.webUrl;
  if (typeof webUrl !== "string" || webUrl.length > 2048) return undefined;
  try {
    const url = new URL(webUrl);
    if (
      url.origin !== COMPANION_APPS[app].origin ||
      url.username ||
      url.password ||
      url.hash
    )
      return undefined;
    if (app === "slides" && url.pathname.startsWith("/deck/") && !url.search) {
      return artifactId(url.pathname.slice("/deck/".length));
    }
    if (url.pathname !== "/_agent-native/open") return undefined;

    const params = url.searchParams;
    const idKey = app === "plan" ? "planId" : "deckId";
    const view = app === "plan" ? "plan" : "editor";
    const allowed = [
      "app",
      "view",
      idKey,
      "agentSidebar",
      ...(app === "plan" ? ["to"] : []),
    ];
    const sidebar = params.getAll("agentSidebar");
    if (
      [...params.keys()].some((key) => !allowed.includes(key)) ||
      params.getAll("app").length !== 1 ||
      params.get("app") !== app ||
      params.getAll("view").length !== 1 ||
      params.get("view") !== view ||
      params.getAll(idKey).length !== 1 ||
      (sidebar.length > 0 && (sidebar.length !== 1 || sidebar[0] !== "closed"))
    )
      return undefined;
    const id = artifactId(params.get(idKey));
    if (
      !id ||
      (app === "plan" &&
        (params.getAll("to").length !== 1 ||
          params.get("to") !== `/plans/${id}`))
    ) {
      return undefined;
    }
    return id;
  } catch {
    return undefined;
  }
}

function remoteError(app: CompanionApp, write: boolean): never {
  const { label } = COMPANION_APPS[app];
  fail(
    write
      ? `Could not verify whether ${label} saved the artifact. Check that app before making another write.`
      : `Could not read the artifact in ${label}. Check access and the connection.`,
    {
      errorCode: write
        ? "companion_write_outcome_unknown"
        : "companion_read_failed",
    },
  );
}

function operationInput(
  tool: McpTool,
  operation: Operation,
  input: JsonRecord,
) {
  const schema = contract(tool, operation);
  const privateInput = { ...input };
  if (schema) {
    for (const [key, value] of Object.entries({
      visibility: "private",
      contextModeOverride: "off",
      compact: "false",
      agentContext: "false",
      includeMdx: false,
      includeHtml: false,
      includeFileContent: true,
      projectType: "prototype",
    })) {
      if (hasOwn(schema.properties, key)) privateInput[key] = value;
    }
  }
  if (
    !schema ||
    Object.keys(input).some((key) => !hasOwn(schema.properties, key)) ||
    schema.required.some((key) => !hasOwn(privateInput, String(key))) ||
    JSON.stringify(input).length > MAX_INPUT_CHARS ||
    (hasOwn(input, "visibility") && input.visibility !== "private")
  ) {
    fail(
      "Use the supported arguments from discovery. Companion artifacts must stay private.",
      {
        errorCode: "invalid_companion_arguments",
      },
    );
  }
  return privateInput;
}

function resourceId(record: JsonRecord) {
  return artifactId(
    record.id ??
      record.documentId ??
      record.deckId ??
      record.planId ??
      record.designId,
  );
}

function hasPrivateVisibility(resource: JsonRecord, result: JsonRecord) {
  return [
    resource.visibility,
    result.visibility,
    asRecord(result.access)?.visibility,
  ].every((visibility) => visibility === undefined || visibility === "private");
}

function confirmsPrivate(resource: JsonRecord, result: JsonRecord) {
  return (
    hasPrivateVisibility(resource, result) &&
    (resource.visibility ??
      result.visibility ??
      asRecord(result.access)?.visibility) === "private"
  );
}

function personalDesignBearer(authorization: string) {
  const payload = authorization.split(".")[1];
  if (!payload || payload.length > 12_000) return false;
  try {
    const claims = asRecord(
      JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
    );
    // Design still verifies the bearer. These claims only decide whether to
    // use the generic shell workflow before transmitting any user content.
    return (
      claims?.typ === "agent-native-mcp-oauth" &&
      claims.org_id === null &&
      !claims.org_domain &&
      claims.resource === `${COMPANION_APPS.design.origin}/mcp`
    );
  } catch {
    return false;
  }
}

async function narrowDesignShell(
  id: string,
  authorization: string,
  signal?: AbortSignal,
) {
  const timeout = AbortSignal.timeout(8_000);
  try {
    const response = await fetch(
      `${COMPANION_APPS.design.origin}/_agent-native/actions/set-resource-visibility`,
      {
        method: "POST",
        headers: {
          Authorization: authorization,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          resourceType: "design",
          resourceId: id,
          expectedVisibility: "org",
          visibility: "private",
        }),
        redirect: "error",
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      },
    );
    await response.body?.cancel().catch(() => undefined);
    return response.ok;
  } catch {
    return false;
  }
}

function nonempty(value: unknown) {
  return (
    (typeof value === "string" && value.trim().length > 0) ||
    (Array.isArray(value) && value.length > 0)
  );
}

function hasFiveSlides(slides: unknown) {
  return (
    Array.isArray(slides) &&
    slides.length === 5 &&
    slides.every((slide) => nonempty(asRecord(slide)?.content))
  );
}

function hasDesignFiles(files: unknown) {
  return (
    Array.isArray(files) &&
    files.some((entry) => {
      const file = asRecord(entry);
      return (
        file?.filename === "index.html" &&
        file.fileType === "html" &&
        typeof file.content === "string" &&
        nonempty(file.content)
      );
    })
  );
}

function hasArtifactContent(
  app: CompanionApp,
  resource: JsonRecord,
  result: JsonRecord,
) {
  switch (app) {
    case "content":
      return [
        resource.content,
        resource.markdown,
        resource.body,
        result.content,
        result.markdown,
      ].some(nonempty);
    case "slides":
      return hasFiveSlides(resource.slides ?? result.slides);
    case "plan": {
      const content = asRecord(resource.content ?? result.content);
      return (
        nonempty(resource.markdown) ||
        nonempty(resource.html) ||
        nonempty(resource.planText) ||
        nonempty(resource.content) ||
        nonempty(result.markdown) ||
        nonempty(content?.blocks) ||
        nonempty(resource.sections) ||
        nonempty(result.sections)
      );
    }
    case "design":
      return hasDesignFiles(resource.files ?? result.files);
  }
}

export async function invokeCompanionTool(
  app: CompanionApp,
  userEmail: string,
  name: string,
  input: JsonRecord,
  context: ActionRunContext | undefined,
) {
  const operation = companionOperation(app, name);
  if (!operation)
    fail("This companion tool is outside the handoff workflow.", {
      errorCode: "unsupported_companion_tool",
    });
  const write = companionWrites(app, name);
  return withCompanion(
    app,
    userEmail,
    async (manager, tools, authorization) => {
      const tool = tools.find((candidate) => candidate.originalName === name);
      if (!tool)
        fail("The connected app does not advertise this handoff tool.", {
          errorCode: "unsupported_companion_tool",
        });
      const args = operationInput(tool, operation, input);
      const id = requestedId(args);
      if (write) {
        const required = [
          readbackTools[app],
          ...(name === "create-design" ? ["create-file"] : []),
        ];
        if (
          required.some((requiredName) => {
            const advertised = tools.find(
              (candidate) => candidate.originalName === requiredName,
            );
            const spec = companionOperation(app, requiredName);
            return !advertised || !spec || !contract(advertised, spec);
          })
        ) {
          fail(
            "The connected app does not provide the tools needed to finish and verify this draft.",
            {
              errorCode: "companion_readback_unavailable",
            },
          );
        }
      }
      if (name === "create-document" && !nonempty(args.content)) {
        fail("Pass the complete draft body from the workspace.", {
          errorCode: "invalid_companion_arguments",
        });
      }
      if (name === "create-visual-plan") {
        if (typeof args.planText !== "string" || !args.planText.trim()) {
          fail("Pass the complete draft body from the workspace.", {
            errorCode: "invalid_companion_arguments",
          });
        }
        if (!hasOwn(asRecord(tool.inputSchema.properties) ?? {}, "sections")) {
          fail(
            "The connected Plan app cannot accept an explicit sprint section.",
            {
              errorCode: "companion_plan_section_unavailable",
            },
          );
        }
        // Keep sprint prose in a rich text block. Plan otherwise infers
        // wireframes and diagrams from headings and can reject long captions.
        args.sections = [
          { type: "custom", title: "Sprint snapshot", body: args.planText },
        ];
      }
      if (
        name === "create-deck" &&
        (!Array.isArray(args.slides) ||
          !hasFiveSlides(args.slides) ||
          new Set(
            args.slides
              .map((slide) => artifactId(asRecord(slide)?.id))
              .filter(Boolean),
          ).size !== 5)
      ) {
        fail("Pass exactly five slides with unique IDs and rendered content.", {
          errorCode: "invalid_companion_arguments",
        });
      }
      if (
        name === "create-file" &&
        (args.filename !== "index.html" ||
          args.fileType !== "html" ||
          typeof args.content !== "string" ||
          !nonempty(args.content))
      ) {
        fail("Pass a single renderable index.html file with fileType html.", {
          errorCode: "invalid_companion_arguments",
        });
      }
      if (
        (operation.effect === "verify" || operation.effect === "fill") &&
        !id
      ) {
        fail("Pass one artifact ID returned by this companion app.", {
          errorCode: "invalid_companion_arguments",
        });
      }

      const call = async (
        target: McpTool,
        payload: JsonRecord,
        writeMayHaveRun: boolean,
        allowOpaqueSuccess = false,
      ) => {
        if (context?.signal?.aborted) {
          fail("The handoff was interrupted before the request was sent.", {
            errorCode: "companion_interrupted",
          });
        }
        let raw: unknown;
        try {
          raw = await manager.callTool(
            target.name,
            payload,
            context ? { context } : {},
          );
        } catch {
          return remoteError(app, writeMayHaveRun);
        }
        const result = resultRecord(raw);
        const envelope = asRecord(raw);
        if (
          ((app === "slides" && target.originalName === "create-deck") ||
            (app === "plan" && target.originalName === "create-visual-plan")) &&
          !result?.error &&
          result?.ok !== false &&
          !resourceId(result ?? {})
        ) {
          const id = companionOpenLinkId(app, envelope);
          if (id) return { ...result, id };
        }
        // These known-ID Design writes may return only an MCP acknowledgment.
        // The caller must confirm the persisted state without using its text.
        if (
          !result &&
          allowOpaqueSuccess &&
          envelope?.isError !== true &&
          Array.isArray(envelope?.content)
        ) {
          return {};
        }
        if (!result || result.error || result.ok === false)
          return remoteError(app, writeMayHaveRun);
        return result;
      };

      const readOwnedDesign = async (designId: string, afterWrite = false) => {
        const getDesign = tools.find(
          (candidate) => candidate.originalName === "get-design",
        );
        const read = getDesign && companionOperation("design", "get-design");
        const readSchema = read && getDesign && contract(getDesign, read);
        if (!readSchema || !hasOwn(readSchema.properties, "id") || !getDesign) {
          fail("The connected Design app cannot verify the empty project.", {
            errorCode: "companion_readback_unavailable",
          });
        }
        const result = await call(getDesign, { id: designId }, afterWrite);
        const design = asRecord(result.design) ?? result;
        const files = design.files ?? result.files;
        if (
          (resourceId(design) ?? resourceId(result)) !== designId ||
          design.accessRole !== "owner" ||
          !Array.isArray(files)
        ) {
          if (afterWrite) return remoteError("design", true);
          fail("Design generation requires a project you own.", {
            errorCode: "companion_invalid_design",
          });
        }
        return { design, files };
      };

      const readDesignShell = async (designId: string) => {
        const { design, files } = await readOwnedDesign(designId);
        // Design's canvas can lazily initialize this reserved board even
        // before the user has created a screen.
        const hasOnlyBoard =
          files.length === 1 &&
          asRecord(files[0])?.filename === "__board__.html";
        if (files.length > 0 && !hasOnlyBoard) {
          fail("Design generation requires an empty project you own.", {
            errorCode: "companion_invalid_design",
          });
        }
        return design;
      };

      if (name === "create-design" && !personalDesignBearer(authorization)) {
        const rename = tools.find(
          (candidate) => candidate.originalName === "update-design",
        );
        const getDesign = tools.find(
          (candidate) => candidate.originalName === "get-design",
        );
        if (
          !rename ||
          !getDesign ||
          !hasOwn(asRecord(tool.inputSchema.properties) ?? {}, "designSystemId")
        ) {
          fail(
            "The Design connection cannot create a private draft. Connect with Personal access and try again.",
            {
              errorCode: "companion_design_personal_required",
            },
          );
        }
        // Organization tokens create an org-visible row. Send a generic shell
        // with no project data, then make it private before sending the title.
        const created = await call(
          tool,
          {
            title: "HackPilot prototype",
            designSystemId: null,
          },
          true,
        );
        const shellId = resourceId(created);
        if (!shellId) return remoteError("design", true);
        const shell = await readDesignShell(shellId);
        if (shell.visibility === "org") {
          const narrowed = await narrowDesignShell(
            shellId,
            authorization,
            context?.signal,
          );
          if (!narrowed) {
            fail(
              "Design could not make its empty shell private. No project content was sent. Check the empty shell in Design before trying again.",
              {
                errorCode: "companion_design_privacy_unverified",
                details: { id: shellId },
              },
            );
          }
        }
        const privateShell =
          shell.visibility === "private"
            ? shell
            : await readDesignShell(shellId);
        if (privateShell.visibility !== "private") {
          fail(
            "Design did not confirm private visibility. No project content was sent.",
            {
              errorCode: "companion_design_privacy_unverified",
              details: { id: shellId },
            },
          );
        }
        await call(
          rename,
          {
            id: shellId,
            title: args.title,
            ...(args.description === undefined
              ? {}
              : { description: args.description }),
          },
          true,
          true,
        );
        const { design: renamed } = await readOwnedDesign(shellId, true);
        if (
          renamed.visibility !== "private" ||
          renamed.title !== args.title ||
          (args.description !== undefined &&
            renamed.description !== args.description)
        ) {
          return remoteError("design", true);
        }
        return { status: "written" as const, result: { id: shellId } };
      }

      if (operation.effect === "fill" && id) {
        const shell = await readDesignShell(id);
        if (shell.visibility !== "private") {
          fail("Design generation requires a private project.", {
            errorCode: "companion_design_privacy_unverified",
          });
        }
        const receipt = await call(tool, args, true, true);
        const { design, files } = await readOwnedDesign(id, true);
        const index = files
          .map(asRecord)
          .find(
            (file) =>
              file?.filename === "index.html" && file.fileType === "html",
          );
        const fileId = artifactId(index?.id);
        if (
          design.visibility !== "private" ||
          !fileId ||
          typeof index?.content !== "string" ||
          !nonempty(index.content) ||
          (receipt.designId !== undefined && receipt.designId !== id) ||
          (receipt.id !== undefined && receipt.id !== fileId)
        ) {
          return remoteError("design", true);
        }
        return { status: "written" as const, result: { id, fileId } };
      }

      const result = await call(tool, args, write);
      if (operation.effect === "read") {
        const data = JSON.stringify(result);
        if (data.length > MAX_CATALOG_CHARS) {
          return {
            status: "data" as const,
            result: {
              ...(typeof result.count === "number"
                ? { count: result.count }
                : {}),
              reference:
                typeof result.reference === "string"
                  ? result.reference.slice(0, MAX_CATALOG_CHARS)
                  : "",
              truncated: true,
            },
          };
        }
        return { status: "data" as const, result };
      }
      const resource = asRecord(result[recordKeys[app]]) ?? result;
      const returnedId = resourceId(resource) ?? resourceId(result);
      if (write) {
        if (!returnedId || !hasPrivateVisibility(resource, result)) {
          return remoteError(app, true);
        }
        return { status: "written" as const, result: { id: returnedId } };
      }
      if (
        !id ||
        returnedId !== id ||
        !confirmsPrivate(resource, result) ||
        !hasArtifactContent(app, resource, result)
      ) {
        fail(
          "The app did not confirm the requested private artifact and its content. Check the destination before retrying any write.",
          {
            errorCode: "companion_readback_unverified",
          },
        );
      }
      return {
        status: "verified" as const,
        artifact: {
          id,
          url: companionEditorUrl(app, id),
        },
        result: {
          id,
          ...(typeof resource.title === "string"
            ? { title: resource.title.slice(0, 300) }
            : {}),
          ...(app === "slides" ? { slideCount: 5 } : {}),
        },
      };
    },
  );
}
