import assert from "node:assert/strict";
import test from "node:test";
import {
  chmodSync,
  readFileSync,
  mkdtempSync,
  mkdirSync,
  existsSync,
  rmSync,
  writeFileSync,
  symlinkSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareWorkspace } from "./workspace-setup.js";

test("missing project folder has an actionable error and is created only after explicit selection", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agentdash-setup-"));
  const data = join(directory, "private");
  mkdirSync(data);
  try {
    const workspace = join(directory, "project");
    await assert.rejects(
      prepareWorkspace(workspace, data),
      (error) => (error as any).code === "workspace_not_found",
    );
    assert.equal(existsSync(workspace), false);
    await prepareWorkspace(workspace, data, { createWorkspace: true });
    assert.equal(existsSync(workspace), true);
    assert.equal(existsSync(join(workspace, ".git")), false);
    await assert.rejects(
      prepareWorkspace("relative/project", data, { createWorkspace: true }),
      /absolute/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("explicit Git setup creates an empty baseline without staging pre-existing private files", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agentdash-setup-git-"));
  const data = join(directory, "private");
  mkdirSync(data);
  const workspace = join(directory, "project");
  mkdirSync(workspace);
  writeFileSync(
    join(workspace, "private-untracked.txt"),
    "Synthetic private fixture",
  );
  try {
    await prepareWorkspace(workspace, data, { initializeGit: true });
    assert.equal(
      execFileSync("git", [
        "-C",
        workspace,
        "ls-tree",
        "-r",
        "--name-only",
        "HEAD",
      ]).toString(),
      "",
    );
    assert.match(
      execFileSync("git", [
        "-C",
        workspace,
        "status",
        "--porcelain",
      ]).toString(),
      /\?\? private-untracked.txt/,
    );
    const before = execFileSync("git", [
      "-C",
      workspace,
      "rev-parse",
      "HEAD",
    ]).toString();
    await prepareWorkspace(workspace, data, { initializeGit: true });
    assert.equal(
      execFileSync("git", ["-C", workspace, "rev-parse", "HEAD"]).toString(),
      before,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("private data overlap and symlinked private parents reject before any folder is created", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agentdash-setup-private-"));
  const data = join(directory, "private");
  mkdirSync(data);
  symlinkSync(data, join(directory, "alias"));
  try {
    await assert.rejects(
      prepareWorkspace(join(data, "project"), data, { createWorkspace: true }),
      /separate/,
    );
    await assert.rejects(
      prepareWorkspace(join(directory, "alias", "project"), data, {
        createWorkspace: true,
      }),
      /separate/,
    );
    await assert.rejects(
      prepareWorkspace(directory, data, { createWorkspace: true }),
      /separate/,
    );
    assert.equal(existsSync(join(data, "project")), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("initialization refuses an existing staged index instead of committing it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agentdash-setup-index-"));
  const data = join(directory, "private");
  mkdirSync(data);
  const workspace = join(directory, "project");
  mkdirSync(workspace);
  try {
    execFileSync("git", ["init", "--quiet", workspace]);
    writeFileSync(join(workspace, "staged.txt"), "Synthetic staged data");
    execFileSync("git", ["-C", workspace, "add", "staged.txt"]);
    await assert.rejects(
      prepareWorkspace(workspace, data, { initializeGit: true }),
      /already has staged files/,
    );
    assert.throws(() =>
      execFileSync("git", ["-C", workspace, "rev-parse", "--verify", "HEAD"], {
        stdio: "pipe",
      }),
    );
    assert.match(
      execFileSync("git", [
        "-C",
        workspace,
        "status",
        "--porcelain",
      ]).toString(),
      /A  staged.txt/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});


test('initial managed commit never executes hooks or configured signing programs', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agentdash-setup-hooks-')); const data = join(directory, 'state'); const workspace = join(directory, 'workspace'); mkdirSync(data); mkdirSync(workspace);
  try {
    execFileSync('git', ['init', '--quiet', workspace]); const sentinel = join(directory, 'hook-effect');
    for (const name of ['pre-commit','prepare-commit-msg','commit-msg','post-commit']) { const hook = join(workspace, '.git', 'hooks', name); writeFileSync(hook, '#!/bin/sh\ntouch "' + sentinel + '"\n'); chmodSync(hook, 0o700); }
    const signer = join(directory, 'synthetic-signer'); writeFileSync(signer, '#!/bin/sh\ntouch "' + sentinel + '"\nexit 1\n'); chmodSync(signer, 0o700);
    execFileSync('git', ['-C', workspace, 'config', 'commit.gpgSign', 'true']); execFileSync('git', ['-C', workspace, 'config', 'gpg.program', signer]);
    const before = readFileSync(join(workspace, '.git', 'config'), 'utf8');
    await prepareWorkspace(workspace, data, { initializeGit: true }); assert.equal(existsSync(sentinel), false);
    assert.equal(execFileSync('git', ['-C', workspace, 'ls-tree', '-r', '--name-only', 'HEAD'], { encoding: 'utf8' }), '');
    assert.equal(readFileSync(join(workspace, '.git', 'config'), 'utf8'), before);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('initialization refuses executable conversion filters without invoking them', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agentdash-setup-filters-')); const data = join(directory, 'state'); const workspace = join(directory, 'workspace'); mkdirSync(data); mkdirSync(workspace);
  try {
    execFileSync('git', ['init', '--quiet', workspace]); const sentinel = join(directory, 'filter-effect'); execFileSync('git', ['-C', workspace, 'config', 'filter.synthetic.clean', 'touch "' + sentinel + '"']);
    await assert.rejects(prepareWorkspace(workspace, data, { initializeGit: true }), /conversion filters/); assert.equal(existsSync(sentinel), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
