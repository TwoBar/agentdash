import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type {
  Artifact,
  Observation,
  Persona,
  Task,
} from "../../../packages/domain/src/index.js";
import type { Runtime } from "./runtime.js";
import {
  AppError,
  requireCondition,
  redact,
  type CapabilityPrincipal,
} from "./security.js";
import { sourceCommit } from "./workspaces.js";
import { mcpOutputSchemas, type CoordinationTool } from "./mcp-contracts.js";

const short = z.string().trim().min(1).max(500);
const message = z.string().trim().min(1).max(20_000);
const result = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
});
export async function handleMcp(
  runtime: Runtime,
  req: IncomingMessage,
  res: ServerResponse,
  body: unknown,
  principal: CapabilityPrincipal,
): Promise<void> {
  runtime.validateCapability(principal);
  const server = new McpServer({ name: "agentdash", version: "0.1.0" });
  const task = () => runtime.validateCapability(principal);
  async function guarded(
    name: CoordinationTool,
    fn: () => unknown | Promise<unknown>,
  ) {
    try {
      task();
      const output = mcpOutputSchemas[name].parse(await fn());
      return { ...result(output), structuredContent: output };
    } catch (error) {
      return {
        ...result({
          error:
            error instanceof AppError
              ? error.message
              : "The scoped operation could not be completed.",
        }),
        isError: true,
      };
    }
  }
  server.registerTool(
    "get_task_context",
    {
      outputSchema: mcpOutputSchemas.get_task_context,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
      description:
        "Read only your registered objective, parent identity and scoped context references.",
      inputSchema: {},
    },
    () =>
      guarded("get_task_context", async () => {
        const own = task();
        const persona = runtime.must<Persona>("personas", own.personaId);
        const children = runtime.store
          .list<Task>("tasks", principal.projectId)
          .filter((t) => t.parentTaskId === own.id);
        const inbox = runtime.store
          .list<Observation>("observations", principal.projectId)
          .filter((o) => o.parentTaskId === own.id && o.state === "unread");
        return {
          identity: principal,
          objective: own.objective,
          parentTaskId: own.parentTaskId,
          persona: {
            id: persona.id,
            version: persona.version,
            mandate: persona.mandate,
          },
          requiredArtifacts: persona.requiredArtifacts,
          availablePersonas: runtime.store
            .list<Persona>("personas")
            .map((p) => ({
              id: p.id,
              role: p.role,
              requiredArtifacts: p.requiredArtifacts,
            })),
          children,
          inbox,
          authority:
            "No operator approvals or self-accepted completion. Ask for a scoped child through request_subagent.",
        };
      }),
  );
  server.registerTool(
    "resolve_artifact",
    {
      outputSchema: mcpOutputSchemas.resolve_artifact,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
      description:
        "Resolve an approved current project artifact by logical key; stale or missing inputs fail closed.",
      inputSchema: { logicalKey: z.string().regex(/^[a-z][a-z0-9_]{0,79}$/) },
    },
    (input) =>
      guarded("resolve_artifact", async () => {
        const project = runtime.store.get<
          import("../../../packages/domain/src/index.js").Project
        >("projects", principal.projectId)!;
        const head = await sourceCommit(task().workspace || project.workspace);
        const artifact = runtime.store
          .list<Artifact>("artifacts", principal.projectId)
          .filter(
            (a) =>
              a.logicalKey === input.logicalKey &&
              a.status === "approved" &&
              (!a.expiresAt || Date.parse(a.expiresAt) > Date.now()) &&
              (a.logicalKey !== "codebase_map" ||
                (head && a.sourceCommit === head)),
          )
          .sort((a, b) => b.version - a.version)[0];
        requireCondition(
          artifact,
          "artifact_unavailable",
          "No approved, current, readable artifact is available.",
          409,
        );
        return artifact;
      }),
  );
  server.registerTool(
    "register_artifact",
    {
      outputSchema: mcpOutputSchemas.register_artifact,
      description:
        "Register a draft project artifact with provenance. It requires human approval before use as an approved input.",
      inputSchema: {
        logicalKey: z.string().regex(/^[a-z][a-z0-9_]{0,79}$/),
        summary: short,
        content: z.string().max(30_000).optional(),
      },
    },
    (input) =>
      guarded("register_artifact", () =>
        runtime.registerArtifact(principal.projectId, principal.taskId, input),
      ),
  );
  server.registerTool(
    "request_subagent",
    {
      outputSchema: mcpOutputSchemas.request_subagent,
      description:
        "Request a registered, policy-checked child. The service chooses parent/scope and creates an isolated worktree; never use native unregistered agents.",
      inputSchema: {
        name: short,
        objective: message,
        personaId: z.string().min(1).max(200),
      },
    },
    (input) =>
      guarded("request_subagent", async () => {
        const child = runtime.createTask(
          principal.projectId,
          { ...input, parentTaskId: principal.taskId },
          `agent:${principal.taskId}`,
        );
        try {
          const session = await runtime.startTask(
            principal.projectId,
            child.id,
          );
          return {
            taskId: child.id,
            sessionId: session.id,
            state: session.state,
          };
        } catch (error) {
          return {
            taskId: child.id,
            state: "blocked",
            reason:
              error instanceof AppError
                ? error.message
                : "Child provisioning did not complete. Inspect the registered task.",
          };
        }
      }),
  );
  server.registerTool(
    "get_child_status",
    {
      outputSchema: mcpOutputSchemas.get_child_status,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
      description:
        "Read status and advisory turn observations only for your direct registered children.",
      inputSchema: {},
    },
    () =>
      guarded("get_child_status", () => {
        const children = runtime.store
          .list<Task>("tasks", principal.projectId)
          .filter((t) => t.parentTaskId === principal.taskId);
        return {
          children,
          observations: runtime.store
            .list<Observation>("observations", principal.projectId)
            .filter((o) => o.parentTaskId === principal.taskId),
        };
      }),
  );
  server.registerTool(
    "reply_to_child",
    {
      outputSchema: mcpOutputSchemas.reply_to_child,
      description:
        "Send a bounded reply into one of your direct child sessions. This never grants action approval.",
      inputSchema: { childTaskId: z.string().min(1).max(200), text: message },
    },
    (input) =>
      guarded("reply_to_child", async () => {
        const child = runtime.must<Task>(
          "tasks",
          input.childTaskId,
          principal.projectId,
        );
        requireCondition(
          child.parentTaskId === principal.taskId,
          "not_your_child",
          "The target is not your direct registered child.",
          403,
        );
        const response = await runtime.sendTaskMessage(
          principal.projectId,
          child.id,
          input.text,
          "parent",
        );
        for (const observation of runtime.store
          .list<Observation>("observations", principal.projectId)
          .filter(
            (o) =>
              o.taskId === child.id &&
              o.parentTaskId === principal.taskId &&
              o.state === "unread",
          ))
          runtime.store.update<Observation>(
            "observations",
            observation.id,
            observation.revision,
            { state: "replied" },
            `agent:${principal.taskId}`,
          );
        return response;
      }),
  );
  server.registerTool(
    "report_status",
    {
      outputSchema: mcpOutputSchemas.report_status,
      description:
        "Report advisory progress, blockers, or a completion claim. Completion is accepted separately; no agent can self-approve.",
      inputSchema: {
        status: z.enum(["progress", "blocked", "completion_claim"]),
        summary: short,
      },
    },
    (input) =>
      guarded("report_status", () => {
        const own = task();
        runtime.event(own, "status." + input.status, redact(input.summary));
        return {
          received: true,
          advisoryOnly: true,
          acceptedCompletion: false,
        };
      }),
  );
  server.registerTool(
    "request_decision",
    {
      outputSchema: mcpOutputSchemas.request_decision,
      description:
        "Record a conversational decision request, without authorizing any tool action.",
      inputSchema: { summary: short },
    },
    (input) =>
      guarded("request_decision", () => {
        runtime.event(task(), "decision.proposed", redact(input.summary));
        return {
          recorded: true,
          authorizationGranted: false,
          message:
            "End the turn with your question so automatic observation can route it to the parent inbox.",
        };
      }),
  );
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await transport.handleRequest(req, res, body);
}
