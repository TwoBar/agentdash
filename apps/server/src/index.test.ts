import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  existsSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import test from "node:test";
import { requirePrivateDataDirectory } from "./workspaces.js";

async function unusedPort(): Promise<number> {
  const socket = createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  return port;
}
function launch(directory: string, port: number) {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "apps/server/src/index.ts"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        AGENTDASH_DATA_DIR: directory,
        AGENTDASH_PORT: String(port),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.on("data", (data) => {
    output += data.toString();
  });
  child.stderr.on("data", (data) => {
    output += data.toString();
  });
  const done = once(child, "exit").then(([code]) => code as number | null);
  return { child, done, output: () => output };
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  timer.unref();
  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
}

test("private data location rejects committed, uncommitted and linked Git workspaces", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agentdash-private-location-"));
  try {
    await requirePrivateDataDirectory(directory);
    const repository = join(directory, "repository");
    mkdirSync(repository);
    execFileSync("git", ["init", "-q", repository]);
    const state = join(repository, "state");
    mkdirSync(state);
    await assert.rejects(
      requirePrivateDataDirectory(state),
      /outside all Git repositories/,
    );
    execFileSync("git", [
      "-C",
      repository,
      "-c",
      "user.name=Synthetic",
      "-c",
      "user.email=synthetic@example.invalid",
      "commit",
      "--allow-empty",
      "-qm",
      "Synthetic",
    ]);
    const worktree = join(directory, "worktree");
    execFileSync("git", [
      "-C",
      repository,
      "worktree",
      "add",
      "--quiet",
      "--detach",
      worktree,
    ]);
    await assert.rejects(
      requirePrivateDataDirectory(worktree),
      /outside all Git repositories/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test(
  "service entry point rejects a second boot before touching live state and releases only its own lock",
  { timeout: 25000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "agentdash-entry-"));
    const port = await unusedPort();
    const first = launch(directory, port);
    try {
      const deadline = Date.now() + 15000;
      while (!first.output().includes("Agentdash is available at")) {
        assert.equal(first.child.exitCode, null, first.output());
        assert.ok(Date.now() < deadline, first.output());
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const lock = readFileSync(join(directory, "server.lock"), "utf8");
      const second = launch(directory, await unusedPort());
      assert.notEqual(await second.done, 0);
      assert.match(second.output(), /already has a server.lock/);
      assert.equal(readFileSync(join(directory, "server.lock"), "utf8"), lock);
      const response = await fetch(`http://127.0.0.1:${port}/`);
      assert.equal(response.status, 200);
      await response.text();
      await stop(first.child);
      assert.equal(existsSync(join(directory, "server.lock")), false);
    } finally {
      await stop(first.child);
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
