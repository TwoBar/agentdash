import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
  type Server,
} from "node:http";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, extname, resolve, sep } from "node:path";
import { z, ZodError } from "zod";
import {
  freshEntity,
  validatePersonaMetadata,
  validateSkillVersion,
  type SkillVersion,
  type Artifact,
  type Observation,
  type Persona,
  type Session,
  type Task,
} from "../../../packages/domain/src/index.js";
import { Runtime } from "./runtime.js";
import { AppError, OperatorSessions, requireCondition } from "./security.js";
import { handleMcp } from "./mcp.js";
import { proposalInput, repositoryName } from "./github-contracts.js";

export interface AppOptions {
  runtime: Runtime;
  port?: number;
  development?: boolean;
  staticDirectory?: string;
}
const idSchema = z.string().trim().min(1).max(200);
const short = z.string().trim().min(1).max(500);
const text = z.string().trim().min(1).max(20_000);
const projectSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    workspace: z.string().min(1).max(4096),
    objective: text,
    createWorkspace: z.boolean().optional(),
    initializeGit: z.boolean().optional(),
    githubRepo: z
      .string()
      .regex(/^[\w.-]+\/[\w.-]+$/)
      .optional(),
  })
  .strict();
const taskSchema = z
  .object({
    parentTaskId: idSchema,
    name: z.string().trim().min(1).max(100),
    objective: text,
    personaId: idSchema,
  })
  .strict();
const messageSchema = z.object({ text }).strict();
const startSchema = z
  .object({
    model: z
      .string()
      .regex(/^[a-zA-Z0-9._:-]{1,100}$/)
      .optional(),
  })
  .strict();
const groupSchema = z
  .object({
    decision: z.enum(["approve", "deny"]),
    members: z
      .array(
        z
          .object({
            approvalId: idSchema,
            actionDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
            expectedRevision: z.number().int().positive(),
          })
          .strict(),
      )
      .min(1)
      .max(50),
  })
  .strict();
const artifactSchema = z
  .object({
    taskId: idSchema,
    logicalKey: z.string().regex(/^[a-z][a-z0-9_]{0,79}$/),
    summary: short,
    content: z.string().max(30_000).optional(),
    externalRef: z
      .string()
      .url()
      .max(2000)
      .refine(
        (v) => /^https:\/\/github\.com\//.test(v),
        "Only GitHub HTTPS references are supported.",
      )
      .optional(),
    sourceCommit: z
      .string()
      .regex(/^[a-f0-9]{40,64}$/)
      .optional(),
  })
  .strict();
function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(value));
}
async function readBody(req: IncomingMessage): Promise<unknown> {
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    requireCondition(
      bytes <= 1_000_000,
      "request_too_large",
      "The request exceeds the local size limit.",
      413,
    );
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new AppError("invalid_json", "The request body must be valid JSON.");
  }
}
export async function createApplication(
  options: AppOptions,
): Promise<{ server: Server; origin: string; close: () => Promise<void> }> {
  const { runtime } = options;
  const operators = new OperatorSessions();
  let origin = "";
  let expectedHost = "";
  let vite: import("vite").ViteDevServer | undefined;
  const staticDirectory =
    options.staticDirectory ??
    resolve(dirname(fileURLToPath(import.meta.url)), "../../../web");
  const server = createServer((req, res) => {
    void handle(req, res).catch((error) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (error instanceof ZodError)
        json(res, 400, {
          error: {
            code: "invalid_input",
            message: error.issues
              .map((i) => `${i.path.join(".") || "request"}: ${i.message}`)
              .join("; "),
            fieldErrors: Object.fromEntries(
              error.issues.map((i) => [
                i.path.join(".") || "request",
                i.message,
              ]),
            ),
            retryable: false,
          },
        });
      else if (error instanceof AppError)
        json(res, error.status, {
          error: { code: error.code, message: error.message, ...error.details },
        });
      else
        json(res, 409, {
          error: {
            code: "operation_failed",
            message:
              "This operation could not complete safely. Check the task state, required context and local workspace.",
          },
        });
    });
  });
  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    requireCondition(
      req.headers.host === expectedHost,
      "host_rejected",
      "The local Host is not trusted.",
      403,
    );
    const url = new URL(req.url ?? "/", origin);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader("X-Frame-Options", "DENY");
    if (url.pathname === "/mcp") {
      requireCondition(
        req.method === "POST",
        "method_not_allowed",
        "This scoped MCP endpoint accepts POST requests only.",
        405,
      );
      if (req.headers.origin !== undefined)
        requireCondition(
          req.headers.origin === origin,
          "origin_rejected",
          "Untrusted MCP browser origin.",
          403,
        );
      const principal = runtime.capabilities.authenticate(
        req.headers.authorization,
      );
      await handleMcp(runtime, req, res, await readBody(req), principal);
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      const mutating = req.method !== "GET" && req.method !== "HEAD";
      const operator = operators.authenticate(req, origin, mutating, res);
      if (req.method === "GET" && url.pathname === "/api/session") {
        json(res, 200, { csrfToken: operator.csrfToken });
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/state") {
        json(
          res,
          200,
          runtime.state(url.searchParams.get("projectId") ?? undefined),
        );
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/profile/github") {
        json(res, 200, runtime.github.profile());
        return;
      }
      const readParts = url.pathname.split("/").filter(Boolean);
      if (
        req.method === "GET" &&
        readParts[1] === "projects" &&
        readParts[3] === "github" &&
        readParts[4] === "proposals" &&
        readParts.length === 5
      ) {
        json(res, 200, { proposals: runtime.github.list(readParts[2]) });
        return;
      }
      requireCondition(
        req.method === "POST",
        "method_not_allowed",
        "This API operation requires POST.",
        405,
      );
      const body = await readBody(req);
      if (url.pathname === "/api/profile/github/connect") {
        z.object({ provider: z.literal("gh-cli") })
          .strict()
          .parse(body);
        json(res, 200, await runtime.github.connect());
        return;
      }
      if (url.pathname === "/api/profile/github/disconnect") {
        z.object({}).strict().parse(body);
        json(res, 200, runtime.github.disconnect());
        return;
      }
      if (url.pathname === "/api/skills") {
        const input = z
          .object({
            sourceId: idSchema.optional(),
            name: short,
            procedure: text,
            requiredCapabilities: z.array(idSchema).max(8),
            inputSchema: z.record(z.string(), z.unknown()).optional(),
            outputSchema: z.record(z.string(), z.unknown()).optional(),
          })
          .strict()
          .parse(body);
        const source = input.sourceId
          ? runtime.must<SkillVersion>("skills", input.sourceId)
          : undefined;
        const skillId =
          source?.skillId ?? source?.name ?? freshEntity("skill").id;
        const skill: SkillVersion = {
          ...freshEntity("skl"),
          skillId,
          name: input.name,
          procedure: input.procedure,
          version:
            Math.max(
              0,
              ...runtime.store
                .list<SkillVersion>("skills")
                .filter((s) => (s.skillId ?? s.name) === skillId)
                .map((s) => s.version),
            ) + 1,
          requiredCapabilities: input.requiredCapabilities,
          inputSchema: input.inputSchema ??
            source?.inputSchema ?? { type: "object" },
          outputSchema: input.outputSchema ??
            source?.outputSchema ?? { type: "object" },
        };
        validateSkillVersion(skill);
        json(res, 201, runtime.store.create("skills", skill, "human"));
        return;
      }
      if (url.pathname === "/api/projects") {
        json(res, 201, await runtime.createProject(projectSchema.parse(body)));
        return;
      }
      if (url.pathname === "/api/personas") {
        const input = z
          .object({
            sourceId: idSchema,
            name: z.string().trim().min(1).max(100),
            instructions: text,
            mandate: short.optional(),
            requiredArtifacts: z
              .array(z.string().regex(/^[a-z][a-z0-9_]{0,79}$/))
              .max(20)
              .optional(),
            toolScope: z.array(idSchema).max(8).optional(),
            dataScope: z.array(short).max(20).optional(),
            escalationRules: z.array(short).max(20).optional(),
            expectedOutputs: z.array(short).max(20).optional(),
            completionContract: text.optional(),
            skillVersionIds: z.array(idSchema).max(20).optional(),
          })
          .strict()
          .parse(body);
        const source = runtime.must<Persona>("personas", input.sourceId);
        const versions = runtime.store
          .list<Persona>("personas")
          .filter((p) => p.role === source.role);
        const persona: Persona = {
          ...source,
          ...freshEntity("per"),
          name: input.name,
          instructions: input.instructions,
          mandate: input.mandate ?? source.mandate,
          requiredArtifacts:
            input.requiredArtifacts ?? source.requiredArtifacts,
          toolScope: input.toolScope ??
            source.toolScope ?? [...runtime.coordinationTools()],
          authorityTemplate: {
            mode: "human-only",
            capabilities: input.toolScope ??
              source.toolScope ?? [...runtime.coordinationTools()],
          },
          dataScope: input.dataScope ??
            source.dataScope ?? ["Assigned project only"],
          escalationRules: input.escalationRules ??
            source.escalationRules ?? [
              "Escalate missing authority or required context to the parent or human",
            ],
          expectedOutputs: input.expectedOutputs ??
            source.expectedOutputs ?? ["Verified outputs with provenance"],
          completionContract:
            input.completionContract ??
            source.completionContract ??
            "Completion is a claim requiring human acceptance.",
          skillVersionIds:
            input.skillVersionIds ?? source.skillVersionIds ?? [],
          version: Math.max(...versions.map((v) => v.version)) + 1,
        };
        try { validatePersonaMetadata(persona); } catch (error) { throw new AppError("persona_metadata_invalid", (error as Error).message, 400, { operation: "Save persona" }); }
        json(
          res,
          201,
          runtime.store.create<Persona>("personas", persona, "human"),
        );
        return;
      }
      if (url.pathname === "/api/settings/retention") {
        const input = z
          .object({ retention: z.enum(["minimal", "local-content"]) })
          .strict()
          .parse(body);
        runtime.retention = input.retention;
        json(res, 200, { retention: runtime.retention });
        return;
      }
      const parts = url.pathname.split("/").filter(Boolean);
      requireCondition(
        parts[1] === "projects" && parts[2],
        "not_found",
        "This API route does not exist.",
        404,
      );
      const projectId = parts[2];
      runtime.must("projects", projectId);
      if (parts[3] === "github") {
        if (parts[4] === "link" && parts.length === 5) {
          const input = z
            .object({ repository: repositoryName })
            .strict()
            .parse(body);
          json(
            res,
            200,
            await runtime.github.link(projectId, input.repository),
          );
          return;
        }
        if (parts[4] === "proposals" && parts.length === 5) {
          json(
            res,
            201,
            await runtime.github.propose(projectId, proposalInput.parse(body)),
          );
          return;
        }
        if (parts[4] === "proposals" && parts[5] === "from-artifact" && parts.length === 6) {
          const input = z.object({ artifactId: z.string().min(1), index: z.number().int().nonnegative() }).strict().parse(body);
          json(res, 201, await runtime.github.proposeFromArtifact(projectId, input.artifactId, input.index));
          return;
        }
        if (
          parts[4] === "proposals" &&
          parts.length === 7 &&
          parts[6] === "resolve"
        ) {
          const input = z
            .object({
              decision: z.enum(["approve", "deny"]),
              expectedRevision: z.number().int().positive(),
              actionDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
            })
            .strict()
            .parse(body);
          json(
            res,
            200,
            await runtime.github.resolve(projectId, parts[5], input),
          );
          return;
        }
        if (
          parts[4] === "proposals" &&
          parts.length === 7 &&
          parts[6] === "reconcile"
        ) {
          z.object({}).strict().parse(body);
          json(res, 200, await runtime.github.reconcile(projectId, parts[5]));
          return;
        }
        if (
          parts[4] === "references" &&
          parts[5] === "resolve" &&
          parts.length === 6
        ) {
          const input = z
            .object({ reference: z.string().url().max(2000) })
            .strict()
            .parse(body);
          json(
            res,
            200,
            await runtime.github.reference(projectId, input.reference),
          );
          return;
        }
      }
      if (parts[3] === "tasks" && parts.length === 4) {
        json(res, 201, runtime.createTask(projectId, taskSchema.parse(body)));
        return;
      }
      if (parts[3] === "tasks" && parts.length === 6) {
        const task = runtime.must<Task>("tasks", parts[4], projectId);
        const operation = parts[5];
        if (operation === "start") {
          json(
            res,
            201,
            await runtime.startTask(
              projectId,
              task.id,
              startSchema.parse(body).model,
            ),
          );
          return;
        }
        if (operation === "resume") {
          json(
            res,
            201,
            await runtime.startTask(
              projectId,
              task.id,
              startSchema.parse(body).model,
              "resume",
            ),
          );
          return;
        }
        if (operation === "history") {
          const input = z
            .object({ includeText: z.boolean().default(false) })
            .strict()
            .parse(body);
          json(
            res,
            200,
            await runtime.hydrateHistory(projectId, task.id, input.includeText),
          );
          return;
        }
        if (operation === "message") {
          json(
            res,
            202,
            await runtime.sendTaskMessage(
              projectId,
              task.id,
              messageSchema.parse(body).text,
            ),
          );
          return;
        }
        z.object({}).strict().parse(body);
        if (operation === "accept") {
          requireCondition(
            task.state === "review",
            "not_reviewable",
            "Only a reviewed completion claim can be accepted.",
            409,
          );
          if (task.sessionId) {
            runtime.capabilities.revokeSession(task.sessionId);
            runtime.governance.invalidateSession(task.sessionId);
            await runtime.connector.terminate(task.sessionId);
            const completedSession = runtime.must<Session>(
              "sessions",
              task.sessionId,
              projectId,
            );
            if (completedSession.state !== "terminated")
              runtime.store.update<Session>(
                "sessions",
                completedSession.id,
                completedSession.revision,
                { state: "terminated" },
              );
          }
          json(
            res,
            200,
            runtime.patchTask(runtime.must<Task>("tasks", task.id, projectId), {
              state: "completed",
            }),
          );
          return;
        }
        requireCondition(
          task.sessionId,
          "no_session",
          "This task has no registered session.",
          409,
        );
        if (operation === "interrupt") {
          await runtime.connector.interrupt(task.sessionId);
          json(res, 200, { interrupted: true });
          return;
        }
        if (operation === "terminate") {
          runtime.governance.invalidateSession(task.sessionId);
          runtime.capabilities.revokeSession(task.sessionId);
          await runtime.connector.terminate(task.sessionId);
          const session = runtime.must<Session>(
            "sessions",
            task.sessionId,
            projectId,
          );
          if (session.state !== "terminated")
            runtime.store.update<Session>(
              "sessions",
              session.id,
              session.revision,
              { state: "terminated" },
            );
          const current = runtime.must<Task>("tasks", task.id, projectId);
          if (!["completed", "cancelled", "failed"].includes(current.state))
            runtime.patchTask(current, { state: "blocked" });
          json(res, 200, { terminated: true });
          return;
        }
      }
      if (
        parts[3] === "approvals" &&
        parts[4] === "resolve" &&
        parts.length === 5
      ) {
        const input = groupSchema.parse(body);
        json(res, 200, {
          outcomes: await runtime.governance.resolve(
            projectId,
            input.members,
            input.decision,
          ),
        });
        return;
      }
      if (parts[3] === "artifacts" && parts.length === 4) {
        const input = artifactSchema.parse(body);
        json(
          res,
          201,
          await runtime.registerArtifact(projectId, input.taskId, input),
        );
        return;
      }
      if (
        parts[3] === "artifacts" &&
        parts.length === 6 &&
        ["approve", "stale"].includes(parts[5])
      ) {
        z.object({}).strict().parse(body);
        const artifact = runtime.must<Artifact>(
          "artifacts",
          parts[4],
          projectId,
        );
        json(
          res,
          200,
          runtime.store.update<Artifact>(
            "artifacts",
            artifact.id,
            artifact.revision,
            { status: parts[5] === "approve" ? "approved" : "stale" },
            "human",
          ),
        );
        return;
      }
      if (parts[3] === "observations" && parts.length === 6) {
        const observation = runtime.must<Observation>(
          "observations",
          parts[4],
          projectId,
        );
        if (parts[5] === "reply") {
          await runtime.replyObservation(
            projectId,
            observation.id,
            messageSchema.parse(body).text,
          );
          json(res, 200, { replied: true });
          return;
        }
        if (parts[5] === "read") {
          z.object({}).strict().parse(body);
          json(
            res,
            200,
            runtime.store.update<Observation>(
              "observations",
              observation.id,
              observation.revision,
              { state: "read" },
              "human",
            ),
          );
          return;
        }
      }
      throw new AppError("not_found", "This API route does not exist.", 404);
    }
    requireCondition(
      req.method === "GET" || req.method === "HEAD",
      "method_not_allowed",
      "This local page is read-only.",
      405,
    );
    if (url.pathname === "/" || url.pathname === "/index.html") {
      requireCondition(
        !req.headers.origin || req.headers.origin === origin,
        "origin_rejected",
        "Navigate directly to the local Agentdash address.",
        403,
      );
      requireCondition(
        !["cross-site", "same-site"].includes(
          req.headers["sec-fetch-site"] as string,
        ),
        "navigation_rejected",
        "Navigate directly to the local Agentdash address.",
        403,
      );
      operators.establish(res);
      res.setHeader("Cache-Control", "no-store");
      res.setHeader(
        "Content-Security-Policy",
        options.development
          ? "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://127.0.0.1:*; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'"
          : "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
      );
      if (vite) {
        const html = await readFile(resolve("apps/web/index.html"), "utf8");
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(await vite.transformIndexHtml(url.pathname, html));
        return;
      }
    }
    if (vite) {
      vite.middlewares(req, res, () =>
        json(res, 404, {
          error: { code: "not_found", message: "Page unavailable." },
        }),
      );
      return;
    }
    const relative =
      url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
    const path = resolve(staticDirectory, "." + relative);
    requireCondition(
      path.startsWith(resolve(staticDirectory) + sep),
      "path_rejected",
      "This file is outside the application assets.",
      403,
    );
    try {
      requireCondition(
        (await stat(path)).isFile(),
        "not_found",
        "Page unavailable.",
        404,
      );
      const types: Record<string, string> = {
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".svg": "image/svg+xml",
        ".json": "application/json",
        ".ico": "image/x-icon",
      };
      res.writeHead(200, {
        "Content-Type": types[extname(path)] ?? "application/octet-stream",
      });
      res.end(await readFile(path));
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(
        "not_found",
        "Build the UI before starting production mode.",
        404,
      );
    }
  }
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 4317, "127.0.0.1", done);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("The local service did not bind a TCP port.");
  expectedHost = `127.0.0.1:${address.port}`;
  origin = "http://" + expectedHost;
  runtime.origin = origin;
  if (options.development) {
    const { createServer: createViteServer } = await import("vite");
    vite = await createViteServer({
      configFile: resolve("apps/web/vite.config.ts"),
      server: {
        middlewareMode: true,
        hmr: { server },
        host: "127.0.0.1",
        allowedHosts: ["127.0.0.1"],
        cors: false,
        fs: {
          strict: true,
          allow: [resolve("apps/web"), resolve("packages/domain")],
        },
      },
      appType: "custom",
    });
  }
  const expiry = setInterval(() => {
    runtime.refreshActiveCapabilities();
    void runtime.governance.expire();
  }, 1000);
  expiry.unref();
  return {
    server,
    origin,
    close: async () => {
      clearInterval(expiry);
      await vite?.close();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
      await runtime.close();
    },
  };
}
