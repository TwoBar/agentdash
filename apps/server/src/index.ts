import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";
import { mkdir, realpath, open } from "node:fs/promises";
import { readFileSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createApplication } from "./app.js";
import { Runtime } from "./runtime.js";
import { requirePrivateDataDirectory } from "./workspaces.js";

const defaultDirectory =
  platform() === "darwin"
    ? join(homedir(), "Library", "Application Support", "Agentdash")
    : join(
        process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
        "agentdash",
      );
const dataDirectory = resolve(
  process.env.AGENTDASH_DATA_DIR || defaultDirectory,
);
await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
const source = await realpath(process.cwd());
const actualData = await realpath(dataDirectory);
if (actualData === source || actualData.startsWith(source + "/"))
  throw new Error(
    "Choose an Agentdash data directory outside the source checkout.",
  );
await requirePrivateDataDirectory(actualData);
const port = Number(process.env.AGENTDASH_PORT || "4317");
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("AGENTDASH_PORT must be a valid local port.");
const lockPath = join(dataDirectory, "server.lock");
const lockOwner = randomUUID();
let lock: Awaited<ReturnType<typeof open>>;
try {
  lock = await open(lockPath, "wx", 0o600);
} catch {
  throw new Error(
    "This data directory already has a server.lock. Stop the owning instance first. After a crash, verify that its recorded process has stopped before removing the stale lock and restarting.",
  );
}
await lock.writeFile(JSON.stringify({ pid: process.pid, owner: lockOwner }));
process.on("exit", () => {
  try {
    if (JSON.parse(readFileSync(lockPath, "utf8")).owner === lockOwner)
      unlinkSync(lockPath);
  } catch {
    /* A different owner must never be removed. */
  }
});
const runtime = new Runtime({ dataDirectory });
const app = await createApplication({
  runtime,
  port,
  development: !import.meta.url.includes("/dist/"),
});
await runtime.probe();
console.info(`Agentdash is available at ${app.origin}`);
console.info(
  "Local development build. Native command approval support is limited to the tested Codex version.",
);
let closing = false;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    void app.close().then(
      async () => {
        await lock.close();
        process.exit(0);
      },
      () => process.exit(1),
    );
  });
