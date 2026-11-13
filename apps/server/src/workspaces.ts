import { execFile } from "node:child_process";
import { lstat, mkdir, open, readFile, realpath, rename, stat } from "node:fs/promises";
import { devNull, homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { AppError, requireCondition } from "./security.js";
const run = promisify(execFile);
/** Local metadata/checkout operations must not execute inherited hooks, helpers or environment config. */
export function runGit(args: string[], options: { timeout?: number; maxBuffer?: number } = {}) {
  const permitted = new Set(["HOME", "PATH", "USER", "LOGNAME", "SHELL", "TMPDIR", "TEMP", "TMP", "LANG", "SYSTEMROOT", "COMSPEC"]);
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && (permitted.has(key) || /^LC_[A-Za-z0-9_]+$/.test(key))));
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: devNull, GIT_CONFIG_GLOBAL: devNull, GIT_ATTR_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" });
  return run("git", ["-c", `core.hooksPath=${devNull}`, "-c", "core.fsmonitor=false", "-c", `core.attributesFile=${devNull}`, "-c", "commit.gpgSign=false", "-c", "submodule.recurse=false", ...args], { timeout: 10_000, ...options, env });
}
/** Conversion filters are executable repository configuration, so managed checkout refuses them. */
export async function requireSafeGitCheckout(workspace: string): Promise<void> {
  let output: string;
  try { output = (await runGit(["-C", workspace, "config", "--includes", "--null", "--get-regexp", "^(filter\\..*\\.(clean|smudge|process)|includeif\\..*\\.path)$"])).stdout; }
  catch (error) {
    if ((error as { code?: number }).code === 1) return;
    throw new AppError("git_configuration_unverified", "The repository's local Git configuration could not be verified for safe checkout. Review it before starting isolated sessions.", 409);
  }
  requireCondition(!output.split("\0").filter(Boolean).some(entry => entry.slice(entry.indexOf("\n") + 1).trim()), "workspace_execution_filter", "This repository configures executable Git conversion filters or conditional local includes. Agentdash cannot execute that configuration during managed initialization or isolated checkout. Use a repository without these local settings.", 409);
}
export async function requirePrivateDataDirectory(
  directory: string,
): Promise<void> {
  let insideRepository = false;
  try {
    await runGit(["-C", directory, "rev-parse", "--absolute-git-dir"], {
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
  requireCondition(input.length > 0 && input.length < 4096 && !input.includes("\0"), "invalid_workspace", "Choose an existing local project folder.");
  const expanded = input === "~" ? homedir() : input.startsWith("~/") ? join(homedir(), input.slice(2)) : input;
  let path: string;
  try { path = await realpath(resolve(expanded)); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") throw new AppError("workspace_not_found", "The project folder does not exist. Choose an existing folder or create it first.", 400);
    if (code === "EACCES" || code === "EPERM") throw new AppError("workspace_access_denied", "Agentdash cannot access this project folder. Grant folder access or choose another folder.", 403);
    throw new AppError("workspace_unavailable", "The project folder could not be opened. Check that it is available and readable.", 400);
  }
  try { requireCondition((await stat(path)).isDirectory(), "workspace_not_directory", "The project location is a file. Choose a folder instead.", 400); }
  catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("workspace_access_denied", "Agentdash cannot read this project folder. Grant folder access or choose another folder.", 403);
  }
  return path;
}
export async function sourceCommit(workspace: string): Promise<string | null> {
  try {
    return (
      await runGit(["-C", workspace, "rev-parse", "HEAD"], {
        timeout: 10_000,
      })
    ).stdout.trim();
  } catch {
    return null;
  }
}
interface WorktreeOwner {
  version: 1;
  taskId: string;
  workspace: string;
  path: string;
  commonDir: string;
  gitDir: string;
}
const worktreeOperations = new Map<string, Promise<string>>();
async function present(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
async function managedDirectory(path: string): Promise<void> {
  await mkdir(path, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
  const info = await lstat(path);
  requireCondition(info.isDirectory() && !info.isSymbolicLink() && await realpath(path) === path,
    "unsafe_worktree_path", "The managed worktree location is not a trusted directory. Existing files were left unchanged.", 409);
}
async function gitPath(workspace: string, flag: string): Promise<string> {
  return realpath((await runGit(["-C", workspace, "rev-parse", "--path-format=absolute", flag], { timeout: 10_000 })).stdout.trim());
}
async function inspectWorktree(workspace: string, destination: string, taskId: string): Promise<WorktreeOwner> {
  const root = await lstat(destination);
  const gitFile = await lstat(join(destination, ".git"));
  requireCondition(root.isDirectory() && !root.isSymbolicLink() && await realpath(destination) === destination && gitFile.isFile() && !gitFile.isSymbolicLink(),
    "unsafe_worktree_path", "The retained task workspace contains an unexpected path or Git link. Existing files were left unchanged.", 409);
  const commonDir = await gitPath(workspace, "--git-common-dir");
  requireCondition(await gitPath(destination, "--git-common-dir") === commonDir,
    "foreign_worktree", "The retained workspace belongs to another repository. It will not be adopted or modified.", 409);
  const rawGitDir = (await runGit(["-C", destination, "rev-parse", "--absolute-git-dir"], { timeout: 10_000 })).stdout.trim();
  const gitDir = await realpath(rawGitDir);
  const reciprocal = join(gitDir, "gitdir");
  requireCondition(gitDir === rawGitDir && (await lstat(rawGitDir)).isDirectory() && !(await lstat(rawGitDir)).isSymbolicLink() && (await lstat(reciprocal)).isFile() && !(await lstat(reciprocal)).isSymbolicLink() && (await readFile(reciprocal, "utf8")).trim() === join(destination, ".git"), "unsafe_worktree_metadata", "The retained Git worktree metadata cannot be trusted or belongs to another worktree.", 409);
  const top = await gitPath(destination, "--show-toplevel");
  const listed = (await runGit(["-C", workspace, "worktree", "list", "--porcelain", "-z"], { timeout: 10_000 })).stdout.split("\0").filter(field => field.startsWith("worktree ")).map(field => field.slice(9));
  requireCondition(top === destination && listed.includes(destination), "unregistered_worktree", "The retained directory is not this repository's registered task worktree.", 409);
  return { version: 1, taskId, workspace, path: destination, commonDir, gitDir };
}
async function writeOwner(path: string, value: WorktreeOwner): Promise<void> {
  const temporary = path + "." + randomUUID() + ".tmp";
  const file = await open(temporary, "wx", 0o600);
  try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
  // Parent is a verified private directory; the final name is not followed as a symlink.
  await rename(temporary, path);
}
/** Reuses only a recognized, original task worktree; never resets, cleans or removes its edits. */
export async function isolatedWorktree(workspace: string, dataDirectory: string, taskId: string, existingWorkspace?: string | null): Promise<string> {
  requireCondition(/^[a-z0-9_-]+$/i.test(taskId), "invalid_task", "Invalid registered task identity.");
  const canonicalSource = await validatedWorkspace(workspace);
  const canonicalData = await realpath(dataDirectory);
  const operationKey = canonicalData + "/" + taskId;
  const previous = worktreeOperations.get(operationKey);
  if (previous) { await previous.catch(() => {}); return isolatedWorktree(workspace, dataDirectory, taskId, existingWorkspace); }
  const operation = (async () => {
    requireCondition(await sourceCommit(canonicalSource), "isolation_unavailable", "Child sessions need a Git repository with a commit so an isolated worktree can be created.", 409);
    const parent = join(canonicalData, "worktrees"); const ownership = join(canonicalData, "worktree-ownership");
    await managedDirectory(parent); await managedDirectory(ownership);
    const destination = join(parent, taskId); const ownerPath = join(ownership, taskId + ".json");
    if (existingWorkspace) requireCondition(resolve(existingWorkspace) === destination, "worktree_binding_mismatch", "The task's saved workspace does not match its managed worktree. Existing files were left unchanged.", 409);
    if (await present(destination)) {
      let actual: WorktreeOwner;
      try { actual = await inspectWorktree(canonicalSource, destination, taskId); }
      catch (error) { if (error instanceof AppError) throw error; throw new AppError("worktree_unverified", "The retained workspace could not be verified. Existing files were left unchanged.", 409); }
      if (await present(ownerPath)) {
        const info = await lstat(ownerPath);
        requireCondition(info.isFile() && !info.isSymbolicLink(), "unsafe_worktree_owner", "The task workspace ownership record is not trusted.", 409);
        let expected: WorktreeOwner;
        try { expected = JSON.parse(await readFile(ownerPath, "utf8")); }
        catch { throw new AppError("invalid_worktree_owner", "The task workspace ownership record is unreadable. Existing files were left unchanged.", 409); }
        requireCondition(JSON.stringify(expected) === JSON.stringify(actual), "foreign_worktree_owner", "This retained worktree does not match its original task/repository ownership. It will not be reused.", 409);
      } else {
        requireCondition(!!existingWorkspace, "unknown_worktree_owner", "An unrecognized worktree already occupies this task location. It will not be adopted automatically.", 409);
        // Migration from the first build requires a persisted task binding plus complete Git ownership checks.
        await writeOwner(ownerPath, actual);
      }
      return destination;
    }
    requireCondition(!(await present(ownerPath)) && !existingWorkspace, "missing_worktree", "The saved task workspace is missing. Restore it or create a new task; no replacement was created automatically.", 409);
    await requireSafeGitCheckout(canonicalSource);
    try { await runGit(["-C", canonicalSource, "worktree", "add", "--detach", destination, "HEAD"], { timeout: 20_000 }); }
    catch { throw new AppError("worktree_create_failed", "The isolated task worktree could not be created. Check repository access and Git worktree registrations; existing files were left unchanged.", 409); }
    const created = await inspectWorktree(canonicalSource, destination, taskId);
    await writeOwner(ownerPath, created);
    return destination;
  })();
  worktreeOperations.set(operationKey, operation);
  try { return await operation; } finally { if (worktreeOperations.get(operationKey) === operation) worktreeOperations.delete(operationKey); }
}
