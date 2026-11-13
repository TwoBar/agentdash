/** Two-member native group smoke, with no root model turn or unrelated scenario reruns.
 * npx tsx scripts/spikes/native-approval-group.ts --live [--output /tmp/group-evidence.json]
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Runtime } from '../../apps/server/src/runtime.js';
import { createApplication } from '../../apps/server/src/app.js';
import type { Approval, Decision, Project, Task } from '../../packages/domain/src/index.js';
if (!process.argv.includes('--live')) { console.log('Pass --live to test two real native approvals in one frozen HTTP group.'); process.exit(0); }
const outputIndex = process.argv.indexOf('--output');
const output = outputIndex < 0 ? null : resolve(process.argv[outputIndex + 1]);
const temporary = mkdtempSync(join(tmpdir(), 'agentdash-native-group-'));
const dataDirectory = join(temporary, 'private-data'); const workspace = join(temporary, 'workspace'); const assets = join(temporary, 'assets');
for (const directory of [dataDirectory, workspace, assets]) mkdirSync(directory, { mode: 0o700 });
writeFileSync(join(assets, 'index.html'), '<!doctype html><title>Synthetic group smoke</title>');
execFileSync('git', ['init', '--quiet', workspace]);
writeFileSync(join(workspace, 'README.md'), '# Synthetic grouped approval test\n');
execFileSync('git', ['-C', workspace, 'add', 'README.md']);
execFileSync('git', ['-C', workspace, '-c', 'user.name=Synthetic Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'Synthetic group workspace']);
const runtime = new Runtime({ dataDirectory });
const app = await createApplication({ runtime, port: 0, development: false, staticDirectory: assets });
const evidence: Record<string, unknown> = { kind: 'sanitized-live-native-group-observations', date: new Date().toISOString().slice(0, 10) };
let cookie = ''; let csrf = '';
async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(app.origin + path, { method: 'POST', headers: { Cookie: cookie, Origin: app.origin, 'Content-Type': 'application/json', 'X-AGCP-CSRF': csrf }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`Group smoke HTTP operation failed: ${response.status}`);
  return await response.json() as T;
}
async function until<T>(read: () => T | false | undefined, label: string): Promise<T> {
  for (let i = 0; i < 6000; i++) { const result = read(); if (result) return result; await delay(20); }
  throw new Error(`Group smoke timed out: ${label}`);
}
try {
  await runtime.probe(); assert(runtime.probeStatus.available); evidence.cliVersion = runtime.probeStatus.version;
  const navigation = await fetch(app.origin + '/'); assert.equal(navigation.status, 200);
  cookie = navigation.headers.get('set-cookie')!.split(';')[0]; await navigation.text();
  const session = await fetch(app.origin + '/api/session', { headers: { Cookie: cookie, Origin: app.origin } });
  assert.equal(session.status, 200); csrf = (await session.json() as { csrfToken: string }).csrfToken;
  const project = await post<Project>('/api/projects', { name: 'Synthetic two-member group', workspace, objective: 'Hold the project tree; two operator-registered research children perform isolated synthetic approval tests.' });
  const children: Task[] = [];
  for (const branch of ['a', 'b']) children.push(await post<Task>(`/api/projects/${project.id}/tasks`, {
    parentTaskId: project.rootTaskId, personaId: 'persona_research_v1', name: `Synthetic group ${branch}`,
    objective: `Synthetic native approval test. Execute exactly this shell command once: touch group-${branch}. Request sandbox_permissions=require_escalated because the sandbox is read-only. Do not execute other commands, use apply_patch/request_permissions, create children, or retry after denial. If scoped context is needed, get_task_context is the only other permitted tool. Stop after the command result.`,
  }));
  await Promise.all(children.map(task => post(`/api/projects/${project.id}/tasks/${task.id}/start`, {})));
  const actual = children.map(task => runtime.store.get<Task>('tasks', task.id)!);
  assert.equal(runtime.store.get<Task>('tasks', project.rootTaskId)!.sessionId, null);
  assert(actual.every(task => task.workspace && task.workspace !== project.workspace && task.workspace.startsWith(realpathSync(dataDirectory) + '/worktrees/')));
  assert.notEqual(actual[0].workspace, actual[1].workspace); assert.notEqual(actual[0].sessionId, actual[1].sessionId);
  const approvals = await Promise.all(actual.map(task => until(() => runtime.store.list<Approval>('approvals', project.id).find(row => row.taskId === task.id && row.state === 'pending'), 'two simultaneous native approvals')));
  const sentinels = actual.map((task, i) => join(task.workspace!, `group-${i === 0 ? 'a' : 'b'}`));
  for (let i = 0; i < actual.length; i++) {
    const binding = runtime.governance.pending.get(approvals[i].id)!;
    assert.equal(binding.command, `/bin/zsh -lc 'touch group-${i === 0 ? 'a' : 'b'}'`);
    assert.equal(binding.cwd, actual[i].workspace);
  }
  assert(sentinels.every(path => !existsSync(path)));
  const began = Date.now(); await delay(2000); assert(sentinels.every(path => !existsSync(path)));
  const holdMs = Date.now() - began;
  const frozenMembers = approvals.map(approval => ({ approvalId: approval.id, actionDigest: approval.actionDigest, expectedRevision: approval.revision }));
  console.log('Native group smoke: two isolated commands held; dispatching one frozen two-member HTTP gesture.');
  const response = await post<{ outcomes: Array<{ approvalId: string; ok: boolean; state: string }> }>(`/api/projects/${project.id}/approvals/resolve`, { decision: 'approve', members: frozenMembers });
  assert.equal(response.outcomes.length, 2); assert(response.outcomes.every(outcome => outcome.ok && outcome.state === 'approved'));
  await until(() => sentinels.every(path => existsSync(path)), 'both approved native side effects');
  await Promise.all(actual.map(task => until(() => runtime.store.get<Task>('tasks', task.id)!.state === 'review', 'successful child terminal turn')));
  const decisions = runtime.store.list<Decision>('decisions', project.id);
  assert.equal(decisions.length, 2);
  assert.equal(new Set(decisions.map(decision => decision.id)).size, 2);
  assert.equal(new Set(decisions.map(decision => decision.signature)).size, 2);
  for (const approval of approvals) {
    const decision = decisions.find(row => row.approvalId === approval.id)!;
    assert(decision && decision.sessionId === approval.sessionId && decision.actionDigest === approval.actionDigest);
    assert.equal(decision.delivery, 'sent'); assert(runtime.governance.verifyDecision(decision));
    assert.equal(runtime.store.get<Approval>('approvals', approval.id)!.state, 'approved');
  }
  const audit = runtime.store.verifyAudit(); assert(audit.valid);
  evidence.result = 'passed'; evidence.holdMs = holdMs;
  evidence.sameProject = true; evidence.sameRegisteredParent = true; evidence.rootModelStarted = false;
  evidence.isolatedWorktrees = 2; evidence.nativePendingMembers = 2; evidence.groupHttpGestures = 1;
  evidence.effectsBeforeAndPending = [false, false]; evidence.effectsAfter = [true, true];
  evidence.members = decisions.map(() => ({ independentlySigned: true, signatureValid: true, delivery: 'sent', approvalState: 'approved', taskState: 'review' }));
  evidence.distinctDecisionIdsAndSignatures = true; evidence.audit = { valid: audit.valid, events: audit.events };
  evidence.processEnvironment = 'Approved runtime variables plus explicit scoped session credentials; unrelated host tokens and NODE_OPTIONS excluded.';
  evidence.limit = 'One frozen gesture produced two separately validated native dispatches. This is not an atomic execution transaction.';
} catch (error) {
  evidence.result = 'failed'; evidence.failure = error instanceof Error ? error.message : 'Unknown group smoke failure'; process.exitCode = 1;
} finally {
  await app.close(); rmSync(temporary, { recursive: true, force: true });
  const json = `${JSON.stringify(evidence, null, 2)}\n`;
  if (output) writeFileSync(output, json, { mode: 0o600 });
  console.log(json);
}
