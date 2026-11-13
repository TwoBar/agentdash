import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { isolatedWorktree, sourceCommit, validatedWorkspace } from './workspaces.js';
function fixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'agentdash-worktree-')));
  const source = join(directory, 'source'); const state = join(directory, 'state');
  mkdirSync(source); mkdirSync(state);
  execFileSync('git', ['init', '--quiet', source]);
  writeFileSync(join(source, 'tracked.txt'), 'original\n');
  execFileSync('git', ['-C', source, 'add', 'tracked.txt']);
  execFileSync('git', ['-C', source, '-c', 'user.name=Synthetic Test', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'Synthetic initial']);
  return { directory, source, state, close: () => rmSync(directory, { recursive: true, force: true }) };
}
test('recognized worktree retries preserve tracked/untracked edits and current commit', async () => {
  const f = fixture();
  try {
    const path = await isolatedWorktree(f.source, f.state, 'task_one');
    writeFileSync(join(path, 'tracked.txt'), 'dirty tracked edits\n'); writeFileSync(join(path, 'untracked.txt'), 'keep me');
    const head = execFileSync('git', ['-C', path, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
    assert.equal(await isolatedWorktree(f.source, f.state, 'task_one', path), path);
    assert.equal(await isolatedWorktree(f.source, f.state, 'task_one'), path);
    assert.equal(readFileSync(join(path, 'tracked.txt'), 'utf8'), 'dirty tracked edits\n');
    assert.equal(readFileSync(join(path, 'untracked.txt'), 'utf8'), 'keep me');
    assert.equal(execFileSync('git', ['-C', path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }), head);
  } finally { f.close(); }
});
test('legacy task-bound Git worktree can be adopted, while unbound folders cannot', async () => {
  const f = fixture();
  try {
    mkdirSync(join(f.state, 'worktrees')); const path = join(f.state, 'worktrees', 'legacy');
    execFileSync('git', ['-C', f.source, 'worktree', 'add', '--quiet', '--detach', path, 'HEAD']);
    writeFileSync(join(path, 'untracked.txt'), 'legacy edits');
    await assert.rejects(isolatedWorktree(f.source, f.state, 'legacy'), /unrecognized worktree/);
    assert.equal(await isolatedWorktree(f.source, f.state, 'legacy', path), path);
    assert.equal(readFileSync(join(path, 'untracked.txt'), 'utf8'), 'legacy edits');
  } finally { f.close(); }
});
test('foreign repository, owner record and saved path mismatches fail without modifying edits', async () => {
  const f = fixture(); const other = fixture();
  try {
    const path = await isolatedWorktree(f.source, f.state, 'task_one');
    writeFileSync(join(path, 'dirty.txt'), 'preserve');
    await assert.rejects(isolatedWorktree(other.source, f.state, 'task_one', path), /another repository/);
    await assert.rejects(isolatedWorktree(f.source, f.state, 'task_one', other.source), /saved workspace/);
    const owner = join(f.state, 'worktree-ownership', 'task_one.json'); const value = JSON.parse(readFileSync(owner, 'utf8')); value.taskId = 'foreign_task'; writeFileSync(owner, JSON.stringify(value));
    await assert.rejects(isolatedWorktree(f.source, f.state, 'task_one', path), /original task/);
    assert.equal(readFileSync(join(path, 'dirty.txt'), 'utf8'), 'preserve');
  } finally { f.close(); other.close(); }
});
test('destination, parent, owner and .git symlinks are rejected without following foreign paths', async () => {
  for (const position of ['parent', 'destination', 'owner', 'git'] as const) {
    const f = fixture(); const foreign = join(f.directory, 'foreign'); mkdirSync(foreign);
    try {
      if (position === 'parent') symlinkSync(foreign, join(f.state, 'worktrees'));
      else if (position === 'destination') { mkdirSync(join(f.state, 'worktrees')); symlinkSync(foreign, join(f.state, 'worktrees', 'task_one')); }
      else {
        const path = await isolatedWorktree(f.source, f.state, 'task_one');
        const replaced = position === 'owner' ? join(f.state, 'worktree-ownership', 'task_one.json') : join(path, '.git');
        const original = readFileSync(replaced); const copy = join(foreign, 'foreign-file'); writeFileSync(copy, original); rmSync(replaced); symlinkSync(copy, replaced);
      }
      await assert.rejects(isolatedWorktree(f.source, f.state, 'task_one'), /trusted|unexpected|verified/);
      assert.equal(readFileSync(join(f.source, 'tracked.txt'), 'utf8'), 'original\n');
    } finally { f.close(); }
  }
});
test('missing previously owned workspace is never recreated, and concurrent ownership cannot cross repositories', async () => {
  const f = fixture(); const other = fixture();
  try {
    const path = await isolatedWorktree(f.source, f.state, 'task_one'); rmSync(path, { recursive: true });
    await assert.rejects(isolatedWorktree(f.source, f.state, 'task_one', path), /saved task workspace is missing/);
    const attempts = await Promise.allSettled([isolatedWorktree(f.source, f.state, 'task_two'), isolatedWorktree(other.source, f.state, 'task_two')]);
    assert.equal(attempts[0].status, 'fulfilled'); assert.equal(attempts[1].status, 'rejected');
  } finally { f.close(); other.close(); }
});
test('workspace errors are actionable and home shorthand resolves to the actual folder', async () => {
  const f = fixture();
  try {
    assert.equal(await validatedWorkspace('~'), realpathSync(homedir()));
    await assert.rejects(validatedWorkspace(join(f.directory, 'missing')), { code: 'workspace_not_found' });
    await assert.rejects(validatedWorkspace(join(f.source, 'tracked.txt')), { code: 'workspace_not_directory' });
    await assert.rejects(validatedWorkspace('\0'), { code: 'invalid_workspace' });
  } finally { f.close(); }
});


test('legacy adoption rejects a .git pointer swapped to another task in the same repository', async () => {
  const f = fixture();
  try {
    const first = await isolatedWorktree(f.source, f.state, 'task_a');
    const second = await isolatedWorktree(f.source, f.state, 'task_b');
    rmSync(join(f.state, 'worktree-ownership', 'task_a.json'));
    writeFileSync(join(first, '.git'), readFileSync(join(second, '.git')));
    await assert.rejects(isolatedWorktree(f.source, f.state, 'task_a', first), /another worktree|registered task worktree/);
  } finally { f.close(); }
});


test('managed worktree checkout suppresses actual repository hooks and preserves source config', async () => {
  const f = fixture();
  try {
    const sentinel = join(f.directory, 'hook-effect'); const hook = join(f.source, '.git', 'hooks', 'post-checkout');
    writeFileSync(hook, '#!/bin/sh\ntouch "' + sentinel + '"\n'); chmodSync(hook, 0o700);
    const before = readFileSync(join(f.source, '.git', 'config'), 'utf8');
    const path = await isolatedWorktree(f.source, f.state, 'safe_hook');
    assert.equal(existsSync(sentinel), false); assert.equal(readFileSync(join(path, 'tracked.txt'), 'utf8'), 'original\n');
    assert.equal(readFileSync(join(f.source, '.git', 'config'), 'utf8'), before);
  } finally { f.close(); }
});

test('managed checkout refuses local conversion commands and conditional includes without effects', async () => {
  for (const command of ['clean', 'smudge', 'process', 'include']) {
    const f = fixture();
    try {
      const sentinel = join(f.directory, 'filter-effect');
      writeFileSync(join(f.source, '.gitattributes'), '*.txt filter=synthetic\n');
      execFileSync('git', ['-C', f.source, 'add', '.gitattributes']); execFileSync('git', ['-C', f.source, '-c', 'user.name=Synthetic', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'Synthetic attributes']);
      if (command === 'include') { const included = join(f.directory, 'conditional-config'); writeFileSync(included, '[filter "synthetic"]\n smudge = touch "' + sentinel + '"\n'); execFileSync('git', ['-C', f.source, 'config', 'includeIf.gitdir:' + join(f.source, '.git', 'worktrees') + '/.path', included]); }
      else execFileSync('git', ['-C', f.source, 'config', 'filter.synthetic.' + command, 'touch "' + sentinel + '"']);
      await assert.rejects(isolatedWorktree(f.source, f.state, 'unsafe_filter'), /conversion filters or conditional/);
      assert.equal(existsSync(sentinel), false); assert.equal(existsSync(join(f.state, 'worktrees', 'unsafe_filter')), false);
    } finally { f.close(); }
  }
});

test('service Git ignores inherited repository overrides and global executable configuration', async () => {
  const f = fixture(); const other = fixture();
  const keys = ['GIT_DIR','GIT_WORK_TREE','GIT_INDEX_FILE','GIT_CONFIG_COUNT','GIT_CONFIG_KEY_0','GIT_CONFIG_VALUE_0','GIT_CONFIG_GLOBAL','GIT_CONFIG_SYSTEM','GIT_CONFIG_PARAMETERS','AWS_SECRET_ACCESS_KEY'];
  const previous = keys.map(key => process.env[key]);
  try {
    const sentinel = join(f.directory, 'global-effect'); const hooks = join(f.directory, 'hooks'); mkdirSync(hooks);
    const hook = join(hooks, 'post-checkout'); writeFileSync(hook, '#!/bin/sh\ntouch "' + sentinel + '"\n'); chmodSync(hook, 0o700);
    const global = join(f.directory, 'global-config'); writeFileSync(global, '[core]\n hooksPath = "' + hooks + '"\n[filter "global"]\n smudge = touch "' + sentinel + '"\n');
    process.env.GIT_DIR = join(other.source, '.git'); process.env.GIT_WORK_TREE = other.source; process.env.GIT_INDEX_FILE = join(other.source, '.git', 'index'); process.env.GIT_CONFIG_COUNT = '1'; process.env.GIT_CONFIG_KEY_0 = 'core.hooksPath'; process.env.GIT_CONFIG_VALUE_0 = hooks; process.env.GIT_CONFIG_GLOBAL = global; process.env.GIT_CONFIG_SYSTEM = global; process.env.GIT_CONFIG_PARAMETERS = "'core.hooksPath=" + hooks + "'"; process.env.AWS_SECRET_ACCESS_KEY = 'synthetic-unrelated-secret';
    const expected = execFileSync('git', ['--git-dir=' + join(f.source, '.git'), 'rev-parse', 'HEAD'], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME } }).trim();
    assert.equal(await sourceCommit(f.source), expected);
    const path = await isolatedWorktree(f.source, f.state, 'safe_environment');
    assert.equal(readFileSync(join(path, 'tracked.txt'), 'utf8'), 'original\n'); assert.equal(existsSync(sentinel), false);
  } finally { keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; }); f.close(); other.close(); }
});
