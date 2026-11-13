import { z } from "zod";

const id = z.string().min(1).max(200);
const base = {
  id,
  revision: z.number().int().positive(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  schemaVersion: z.literal(1).optional(),
};
const task = z
  .object({
    ...base,
    projectId: id,
    parentTaskId: id.nullable(),
    name: z.string(),
    objective: z.string(),
    personaId: id,
    authorityGrantId: id.nullable().optional(),
    state: z.enum([
      "requested",
      "ready",
      "running",
      "waiting_approval",
      "blocked",
      "review",
      "completed",
      "failed",
      "cancelled",
    ]),
    sessionId: id.nullable(),
    workspace: z.string().nullable(),
  })
  .strict();
const observation = z
  .object({
    ...base,
    projectId: id,
    taskId: id,
    parentTaskId: id.nullable(),
    sessionId: id,
    sourceTurnId: id,
    terminalStatus: z.string().nullable().optional(),
    classification: z.enum([
      "awaiting_input",
      "decision_proposal",
      "blocker",
      "completion_claim",
      "progress_update",
      "ambiguous",
    ]),
    summary: z.string(),
    state: z.enum(["unread", "read", "replied"]),
    deadlineAt: z.string().datetime().nullable(),
  })
  .strict();
const artifact = z
  .object({
    ...base,
    projectId: id,
    taskId: id,
    logicalKey: z.string(),
    version: z.number().int().positive(),
    status: z.enum(["draft", "approved", "stale"]),
    summary: z.string(),
    content: z.string().nullable(),
    externalRef: z.string().nullable(),
    sourceCommit: z.string().nullable(),
    expiresAt: z.string().datetime().nullable(),
    readableByTaskIds: z.array(id).optional(),
    inputArtifacts: z.array(z.object({ id, logicalKey: z.string(), version: z.number().int().positive(), sourceCommit: z.string().nullable() }).strict()).optional(),
    sourceSessionId: id.optional(),
  })
  .strict();

/** Public coordination output contracts. Invalid internal results never cross the MCP boundary. */
export const mcpOutputSchemas = {
  get_task_context: z
    .object({
      identity: z
        .object({ projectId: id, taskId: id, sessionId: id, bootId: id })
        .strict(),
      objective: z.string(),
      parentTaskId: id.nullable(),
      persona: z
        .object({
          id,
          version: z.number().int().positive(),
          mandate: z.string(),
        })
        .strict(),
      requiredArtifacts: z.array(z.string()),
      availablePersonas: z.array(
        z
          .object({
            id,
            role: z.string(),
            requiredArtifacts: z.array(z.string()),
          })
          .strict(),
      ),
      children: z.array(task),
      inbox: z.array(observation),
      authority: z.string(),
    })
    .strict(),
  resolve_artifact: artifact,
  register_artifact: artifact,
  request_subagent: z
    .object({
      taskId: id,
      sessionId: id.optional(),
      state: z.enum([
        "starting",
        "idle",
        "running",
        "waiting_approval",
        "disconnected",
        "failed",
        "terminated",
        "blocked",
      ]),
      reason: z.string().optional(),
    })
    .strict(),
  get_child_status: z
    .object({ children: z.array(task), observations: z.array(observation) })
    .strict(),
  reply_to_child: z.object({ turnId: id }).strict(),
  report_status: z
    .object({
      received: z.literal(true),
      advisoryOnly: z.literal(true),
      acceptedCompletion: z.literal(false),
    })
    .strict(),
  request_decision: z
    .object({
      recorded: z.literal(true),
      authorizationGranted: z.literal(false),
      message: z.string(),
    })
    .strict(),
};
export type CoordinationTool = keyof typeof mcpOutputSchemas;
