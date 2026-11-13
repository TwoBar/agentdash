import { execFile } from "node:child_process";
import { mkdir, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { requireCondition } from "./security.js";
const run = promisify(execFile);
export async function requirePrivateDataDirectory(
  directory: string,
): Promise<void> {
  let insideRepository = false;
  try {
    await run("git", ["-C", directory, "rev-parse", "--absolute-git-dir"], {
      timeout: 10_000,
    });
    insideRepository = true;
  } catch (error) {
    const failure = error as { code?: number; stderr?: string };
    requireCondition(
      failure.code === 128 &&
        /not a git repository/i.test(failure.stderr ?? ""),
      "data_location_unverified",
      "The private data location could not be verified outside Git repositories.",
    );
  }
  requireCondition(
    !insideRepository,
    "data_inside_repository",
    "Choose a private data directory outside all Git repositories.",
  );
}
export async function validatedWorkspace(input: string): Promise<string> {
  requireCondition(
    input.length > 0 && input.length < 4096 && !input.includes("\0"),
    "invalid_workspace",
    "Select an existing local project directory.",
  );
  let path: string;
  try {
    path = await realpath(resolve(input));
    requireCondition(
      (await stat(path)).isDirectory(),
      "invalid_workspace",
      "The workspace must be a directory.",
    );
  } catch {
    throw new Error("The selected workspace directory is unavailable.");
  }
  return path;
}
export async function sourceCommit(workspace: string): Promise<string | null> {
  try {
    return (
      await run("git", ["-C", workspace, "rev-parse", "HEAD"], {
        timeout: 10_000,
      })
    ).stdout.trim();
  } catch {
    return null;
  }
}
export async function isolatedWorktree(
  workspace: string,
  dataDirectory: string,
  taskId: string,
): Promise<string> {
  requireCondition(
    /^[a-z0-9_-]+$/i.test(taskId),
    "invalid_task",
    "Invalid registered task identity.",
  );
  requireCondition(
    await sourceCommit(workspace),
    "isolation_unavailable",
    "Child sessions need a Git repository with a commit so an isolated worktree can be created.",
    409,
  );
  const destination = join(dataDirectory, "worktrees", taskId);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  try {
    // A unique detached worktree isolates concurrent edits without branch changes in the user's checkout.
    await run(
      "git",
      ["-C", workspace, "worktree", "add", "--detach", destination, "HEAD"],
      { timeout: 20_000 },
    );
  } catch {
    throw new Error(
      "The isolated child worktree could not be created. Existing worktrees were left unchanged.",
    );
  }
  return await realpath(destination);
}
