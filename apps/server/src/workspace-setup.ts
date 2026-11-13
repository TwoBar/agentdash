import { access, mkdir, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { AppError, requireCondition } from "./security.js";
import { requireSafeGitCheckout, runGit, sourceCommit, validatedWorkspace } from "./workspaces.js";
function overlaps(left: string, right: string): boolean {
  return (
    left === right ||
    left.startsWith(right.endsWith(sep) ? right : right + sep) ||
    right.startsWith(left.endsWith(sep) ? left : left + sep)
  );
}
export async function prepareWorkspace(
  input: string,
  dataDirectory: string,
  options: { createWorkspace?: boolean; initializeGit?: boolean } = {},
): Promise<string> {
  const expanded =
    input === "~"
      ? homedir()
      : input.startsWith("~/")
        ? join(homedir(), input.slice(2))
        : input;
  requireCondition(
    isAbsolute(expanded) && !expanded.includes("\0"),
    "workspace_absolute_required",
    "Enter an absolute folder path, or use ~/ for your home directory.",
    400,
  );
  const privatePath = await realpath(dataDirectory);
  const desired = resolve(expanded);
  let parent = desired;
  while (true) {
    try {
      await stat(parent);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new AppError(
          "workspace_access_denied",
          "This folder cannot be accessed. Choose a writable local folder.",
          400,
          { fieldErrors: { workspace: "The local folder is inaccessible." } },
        );
      const next = dirname(parent);
      requireCondition(
        next !== parent,
        "workspace_not_found",
        "The folder parent is unavailable.",
      );
      parent = next;
    }
  }
  const canonicalDesired = resolve(
    await realpath(parent),
    relative(parent, desired),
  );
  requireCondition(
    !overlaps(canonicalDesired, privatePath),
    "private_workspace_overlap",
    "Select a project workspace separate from the private Agentdash data directory.",
    400,
  );
  if (options.createWorkspace) {
    try {
      await mkdir(canonicalDesired, { recursive: true, mode: 0o700 });
    } catch {
      throw new AppError(
        "workspace_create_failed",
        "The project folder could not be created. Check parent folder permissions or choose another location.",
        400,
        { fieldErrors: { workspace: "Cannot create this folder." } },
      );
    }
  }
  const workspace = await validatedWorkspace(canonicalDesired);
  requireCondition(
    !overlaps(workspace, privatePath),
    "private_workspace_overlap",
    "Select a workspace separate from private Agentdash data.",
    400,
  );
  try {
    await access(workspace, constants.R_OK | constants.W_OK | constants.X_OK);
  } catch {
    throw new AppError(
      "workspace_access_denied",
      "The project needs a readable, writable local folder.",
      400,
    );
  }
  if (options.initializeGit) {
    let root: string | null = null;
    try {
      root = (
        await runGit(["-C", workspace, "rev-parse", "--show-toplevel"])
      ).stdout.trim();
    } catch {
      /* Initialize only when requested and not inside another repository. */
    }
    requireCondition(
      root === null || (await realpath(root)) === workspace,
      "workspace_nested_repository",
      "This folder is inside another Git repository. Select its repository root rather than initializing a nested project.",
      409,
    );
    try {
      if (root === null)
        await runGit(["-C", workspace, "init", "--quiet", "--initial-branch=main"],
          { timeout: 10_000 },
        );
      if (!(await sourceCommit(workspace))) {
        await requireSafeGitCheckout(workspace);
        const staged = (
          await runGit(["-C", workspace, "diff", "--cached", "--no-ext-diff", "--no-textconv", "--name-only"],
            { timeout: 10_000 },
          )
        ).stdout;
        requireCondition(
          !staged.trim(),
          "workspace_staged_files",
          "This repository already has staged files. Review and commit them yourself before enabling isolated child sessions.",
          409,
        );
        await runGit([
            "-C",
            workspace,
            "-c",
            "user.name=Agentdash",
            "-c",
            "user.email=agentdash@localhost.invalid",
            "commit",
            "--quiet",
            "--allow-empty",
            "--only",
            "-m",
            "Initialize local Agentdash project",
          ],
          { timeout: 10_000 },
        );
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(
        "workspace_git_initialization_failed",
        "The folder exists, but Git initialization did not finish. Inspect its local Git state and retry with the same path.",
        409,
        { retryable: true },
      );
    }
  }
  return workspace;
}
