/** Explicit synthetic browser harness. Never imported by the application. */
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Runtime } from "../../server/src/runtime.js";
import { createApplication } from "../../server/src/app.js";
import { AppError } from "../../server/src/security.js";
import type {
  GitHubProvider,
  Repository,
  Issue,
} from "../../server/src/github-provider.js";
import type { CodexConnector } from "../../../packages/codex/src/index.js";
import {
  actionDigest,
  freshEntity,
  type Artifact,
} from "../../../packages/domain/src/index.js";

if (process.env.AGENTDASH_UI_QA !== "1")
  throw new Error(
    "Set AGENTDASH_UI_QA=1 explicitly. This is a synthetic test harness, not the application.",
  );

class SyntheticGitHub implements GitHubProvider {
  repos = new Map<string, Repository>();
  issues: Issue[] = [];
  async identity() {
    return {
      login: "synthetic-ui",
      id: 98701,
      owners: [{ login: "synthetic-ui", id: 98701 }],
      capabilities: {
        read: true,
        repositoryCreate: true,
        issueCreate: true,
        administration: false,
        release: false,
      },
      privateRepositoryCreate: true,
    };
  }
  async repository(name: string) {
    return this.repos.get(name.toLowerCase()) || null;
  }
  async createRepository(
    owner: string,
    name: string,
    visibility: "private" | "public",
    description: string,
  ) {
    const value = {
      id: 98702 + this.repos.size,
      full_name: `${owner}/${name}`,
      html_url: `https://github.com/${owner}/${name}`,
      private: visibility === "private",
      description,
      permissions: { push: true, pull: true },
    };
    this.repos.set(value.full_name.toLowerCase(), value);
    return value;
  }
  async createIssue(
    repository: string,
    input: { title: string; body: string; labels: string[] },
  ) {
    const value = {
      id: 98800 + this.issues.length,
      number: this.issues.length + 1,
      html_url: `https://github.com/${repository}/issues/${this.issues.length + 1}`,
      title: input.title,
      body: input.body,
    };
    this.issues.push(value);
    return value;
  }
  async findIssue(_repository: string, marker: string) {
    return this.issues.find((issue) => issue.body?.includes(marker)) || null;
  }
  async reference() {
    return {
      title: "Synthetic fixture reference",
      name: "synthetic.txt",
      sha: "a".repeat(40),
    };
  }
}

const root = mkdtempSync(join(tmpdir(), "agentdash-ui-qa-"));
const workspace = join(root, "workspace");
mkdirSync(workspace);
const dataDirectory = join(root, "data");
mkdirSync(dataDirectory);
execFileSync("git", ["init", "--quiet", workspace]);
execFileSync("git", [
  "-C",
  workspace,
  "-c",
  "user.name=Synthetic UI QA",
  "-c",
  "user.email=synthetic@example.invalid",
  "commit",
  "--allow-empty",
  "--quiet",
  "-m",
  "Synthetic baseline",
]);
const provider = new SyntheticGitHub();
let runtime: Runtime;
let turn = 0;
const connector = {
  async probe() {
    return {
      available: true,
      version: "synthetic-protocol-double",
      reason: "Synthetic UI harness only; no real Codex process.",
    };
  },
  async startSession(input: { sessionId: string }) {
    return { bindingRef: "synthetic:" + input.sessionId };
  },
  async sendMessage(sessionId: string) {
    const turnId = `synthetic-turn-${++turn}`;
    runtime.onConnectorEvent({
      sessionId,
      type: "turn.started",
      turnId,
      sourceId: turnId,
      summary: "Synthetic fixture turn started; no model invoked.",
    });
    return { turnId };
  },
  async resolveApproval(sessionId: string, key: string, _digest: string) {
    runtime.onConnectorEvent({
      sessionId,
      type: "approval.resolved",
      sourceId: `synthetic-resolved-${key}`,
      summary: "Synthetic callback resolved; no command was executed.",
    });
  },
  async interrupt(sessionId: string) {
    runtime.onConnectorEvent({
      sessionId,
      type: "turn.completed",
      turnId: `synthetic-turn-${turn}`,
      sourceId: `synthetic-stop-${turn}`,
      terminalStatus: "interrupted",
      summary: "Synthetic interrupted terminal.",
    });
  },
  async terminate() {},
  async close() {},
} as unknown as CodexConnector;
runtime = new Runtime({
  dataDirectory,
  connector,
  githubProvider: provider,
  bootId: "synthetic-ui-qa-boot",
});
await runtime.probe();
const project = await runtime.createProject({
  name: "Synthetic UI fixture · no real services",
  workspace,
  objective:
    "Synthetic browser verification only. No model or real GitHub is connected.",
});
const commit = execFileSync("git", ["-C", workspace, "rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
for (const logicalKey of ["current_roadmap", "codebase_map"])
  runtime.store.create<Artifact>("artifacts", {
    ...freshEntity("art"),
    projectId: project.id,
    taskId: project.rootTaskId,
    logicalKey,
    version: 1,
    status: "approved",
    summary: "Synthetic fixture context",
    content: null,
    externalRef: null,
    sourceCommit: commit,
    expiresAt: null,
  });
const first = await runtime.startTask(project.id, project.rootTaskId);
// Explicit browser fixture only: these references are not evidence of agent reads.
const planningFixture = runtime.store.create<Artifact>("artifacts", {
  ...freshEntity("art"),
  projectId: project.id,
  taskId: project.rootTaskId,
  logicalKey: "issue_proposals",
  version: 1,
  status: "approved",
  summary: "Synthetic approved issue plan · browser fixture, not native proof",
  content: JSON.stringify([
    {
      title: "Synthetic planned issue",
      body: "Synthetic browser publication fixture only. No real GitHub write occurs.",
      labels: ["planning"],
    },
  ]),
  externalRef: null,
  sourceCommit: commit,
  expiresAt: null,
  sourceSessionId: first.id,
  inputArtifacts: ["current_roadmap", "codebase_map"].map((logicalKey) => {
    const input = runtime.store
      .list<Artifact>("artifacts", project.id)
      .find((a) => a.logicalKey === logicalKey)!;
    return {
      id: input.id,
      logicalKey: input.logicalKey,
      version: input.version,
      sourceCommit: input.sourceCommit,
    };
  }),
});
const child = runtime.createTask(project.id, {
  parentTaskId: project.rootTaskId,
  name: "Synthetic child task",
  objective: "Synthetic keyboard/tree fixture",
  personaId: "persona_research_v1",
});
await runtime.startTask(project.id, child.id);
for (let index = 0; index < 2; index++) {
  const action = {
    kind: "command" as const,
    command: `printf SYNTHETIC_ACTION_${index}`,
    cwd: workspace,
  };
  runtime.onConnectorEvent({
    sessionId: first.id,
    type: "approval.requested",
    sourceId: `synthetic-approval-${index}`,
    summary: "Synthetic pending action; no execution",
    approval: {
      key: `synthetic-key-${index}`,
      kind: "command",
      command: action.command,
      cwd: workspace,
      digest: actionDigest(action),
      summary: "Synthetic pending command",
    },
  });
}
let failReads = false;
const state = runtime.state.bind(runtime);
runtime.state = (projectId?: string) => {
  if (failReads)
    throw new AppError(
      "synthetic_state_unavailable",
      "Synthetic read outage. Restore the QA service and retry; your form draft should remain intact.",
      503,
      { retryable: true, operation: "Refresh workspace" },
    );
  const value = state(projectId);
  const status = value.status as { limitations: string[] };
  status.limitations.unshift(
    "SYNTHETIC UI FIXTURE: GitHub and Codex use test doubles. No model usage, commands or real remote writes occur.",
  );
  return value;
};
const realNow = Date.now;
let clockSkew = 0;
Date.now = () => realNow() + clockSkew;
process.on("SIGUSR1", () => {
  failReads = !failReads;
  console.info(`Synthetic read outage ${failReads ? "enabled" : "disabled"}`);
});
process.on("SIGUSR2", () => {
  clockSkew += 31 * 60_000;
  console.info(
    "Synthetic server clock advanced to exercise cookie expiry. No native process exists.",
  );
});
const app = await createApplication({
  runtime,
  port: Number(process.env.AGENTDASH_UI_QA_PORT || 4327),
  development: true,
});
console.info(
  JSON.stringify({
    purpose: "SYNTHETIC browser QA only; no real GitHub or model calls",
    origin: app.origin,
    workspace,
    pid: process.pid,
    syntheticPlanningArtifactId: planningFixture.id,
    readOutageSignal: "SIGUSR1",
    expireCookieSignal: "SIGUSR2",
  }),
);
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => void app.close().then(() => process.exit(0)));
