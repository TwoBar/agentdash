/** Actual disposable HTTP application recovery/continuation proof; no raw protocol or credentials retained.
 * npx tsx scripts/spikes/recovery-application.ts --live [--output /tmp/recovery-application.json]
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { ServerResponse } from 'node:http';
import { Runtime } from '../../apps/server/src/runtime.js';
import { createApplication } from '../../apps/server/src/app.js';
import type { ActivityEvent, Approval, Decision, Observation, Project, Session, Task } from '../../packages/domain/src/index.js';
if (!process.argv.includes('--live')) { console.log('Pass --live for actual signed-in native HTTP recovery and child continuation in disposable workspaces.'); process.exit(0); }
const index = process.argv.indexOf('--output'); const output = index < 0 ? null : resolve(process.argv[index + 1]);
const directory = mkdtempSync(join(tmpdir(), 'agentdash-recovery-app-')); const dataDirectory = join(directory, 'state'); const assets = join(directory, 'assets');
mkdirSync(dataDirectory, { mode: 0o700 }); mkdirSync(assets, { mode: 0o700 }); writeFileSync(join(assets, 'index.html'), '<!doctype html><title>Synthetic recovery</title>');
let runtime = new Runtime({ dataDirectory });
let app = await createApplication({ runtime, port: 0, development: false, staticDirectory: assets });
const tools: Array<{ name: string; ok: boolean; observationBound: boolean }> = [];
const wire = (value: unknown) => typeof value === 'string' ? value : value instanceof Uint8Array ? Buffer.from(value).toString('utf8') : '';
function observeMcp() { app.server.prependListener('request', (request, response) => {
  if (request.url !== '/mcp' || request.method !== 'POST') return;
  let input = ''; let result = ''; request.on('data', chunk => { input += wire(chunk); });
  const write = response.write; const end = response.end;
  response.write = function(this: ServerResponse, ...args: unknown[]) { result += wire(args[0]); return write.apply(this, args as Parameters<typeof write>); } as typeof response.write;
  response.end = function(this: ServerResponse, ...args: unknown[]) { result += wire(args[0]); return end.apply(this, args as Parameters<typeof end>); } as typeof response.end;
  response.on('finish', () => { try { const req = JSON.parse(input); const res = JSON.parse(result); if (req.method === 'tools/call') tools.push({ name: req.params?.name, ok: response.statusCode === 200 && !res.error && !res.result?.isError, observationBound: typeof req.params?.arguments?.observationId === 'string' }); } catch { /* Ephemeral bodies never retained. */ } input = ''; result = ''; });
}); }
observeMcp();
const evidence: Record<string, unknown> = { kind: 'sanitized-live-application-recovery', date: new Date().toISOString().slice(0,10) };
let cookie = ''; let csrf = '';
async function post<T>(path: string, body: unknown): Promise<T> { const response = await fetch(app.origin + path, { method: 'POST', headers: { Cookie: cookie, Origin: app.origin, 'Content-Type': 'application/json', 'X-AGCP-CSRF': csrf }, body: JSON.stringify(body) }); const value = await response.json() as T & { error?: { code?: string } }; if (!response.ok) throw new Error(`Synthetic HTTP ${response.status} ${value.error?.code ?? 'unknown'}`); return value; }
async function until<T>(read: () => T | false | undefined, label: string, milliseconds = 120_000): Promise<T> { const deadline = Date.now() + milliseconds; while (Date.now() < deadline) { const value = read(); if (value) return value; await delay(25); } throw new Error(`Synthetic timeout: ${label}`); }
function workspace(name: string) { const path = join(directory, name); mkdirSync(path, { mode: 0o700 }); execFileSync('git', ['init', '--quiet', path]); writeFileSync(join(path, 'README.md'), '# Synthetic recovery workspace\n'); execFileSync('git', ['-C', path, 'add', 'README.md']); execFileSync('git', ['-C', path, '-c', 'user.name=Synthetic Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'Synthetic baseline']); return path; }
const member = (a: Approval) => ({ approvalId: a.id, actionDigest: a.actionDigest, expectedRevision: a.revision });
try {
  await runtime.probe(); assert(runtime.probeStatus.available); evidence.cliVersion = runtime.probeStatus.version;
  const navigation = await fetch(app.origin); cookie = navigation.headers.get('set-cookie')!.split(';')[0]; await navigation.text();
  csrf = (await (await fetch(app.origin + '/api/session', { headers: { Cookie: cookie, Origin: app.origin } })).json() as { csrfToken: string }).csrfToken;
  const path = workspace('recovery'); const oldEffect = join(path, 'recovery-old'); const freshEffect = join(path, 'recovery-fresh');
  const project = await post<Project>('/api/projects', { name: 'Synthetic recovery', workspace: path, objective: 'Synthetic native recovery test. Execute exactly touch recovery-old once using sandbox_permissions=require_escalated because sandbox is read-only. No other commands, tools, edits, agents or retries. Stop after the single result.' });
  const base = `/api/projects/${project.id}/tasks/${project.rootTaskId}`;
  await post(base + '/start', {});
  const old = await until(() => runtime.store.list<Approval>('approvals', project.id).find(a => a.state === 'pending'), 'old pending');
  const oldSession = runtime.store.get<Task>('tasks', project.rootTaskId)!.sessionId!; assert(!existsSync(oldEffect)); await delay(1500); assert(!existsSync(oldEffect));
  await post(base + '/terminate', {}); assert.equal(runtime.store.get<Approval>('approvals', old.id)!.state, 'disconnected');
  if (process.argv.includes('--restart')) {
    const formerBoot = runtime.bootId; await app.close();
    runtime = new Runtime({ dataDirectory });
    assert.notEqual(runtime.bootId, formerBoot);
    app = await createApplication({ runtime, port: 0, development: false, staticDirectory: assets }); observeMcp();
    const renewedNavigation = await fetch(app.origin); cookie = renewedNavigation.headers.get('set-cookie')!.split(';')[0]; await renewedNavigation.text();
    csrf = (await (await fetch(app.origin + '/api/session', { headers: { Cookie: cookie, Origin: app.origin } })).json() as { csrfToken: string }).csrfToken;
    evidence.actualServiceRestart = true;
  }
  const resumed = await post<Session>(base + '/resume', {}); assert.notEqual(resumed.id, oldSession); assert.equal(resumed.state, 'idle');
  assert.equal(runtime.store.list<Approval>('approvals', project.id).filter(a => a.state === 'pending').length, 0); assert.equal(runtime.store.list<Decision>('decisions', project.id).length, 0);
  const first = await post<{ complete: boolean; entries: number; gaps: number }>(base + '/history', {});
  const count = runtime.store.list<ActivityEvent>('events', project.id).length; const again = await post<typeof first>(base + '/history', {}); assert.deepEqual(first, again); assert.equal(runtime.store.list<ActivityEvent>('events', project.id).length, count); assert(!first.complete); assert(first.gaps > 0); assert.equal(runtime.store.get<Task>('tasks', project.rootTaskId)!.state, 'review');
  const replay = await post<{ outcomes: Array<{ok:boolean}> }>(`/api/projects/${project.id}/approvals/resolve`, { decision: 'approve', members: [member(old)] }); assert(!replay.outcomes[0].ok); assert(!existsSync(oldEffect));
  await post(base + '/message', { text: 'Fresh synthetic recovery phase. Execute exactly touch recovery-fresh once using sandbox_permissions=require_escalated. This is a new action requiring a fresh human decision. Do not retry old commands, run other commands, edit files, use apply_patch or create agents.' });
  const fresh = await until(() => runtime.store.list<Approval>('approvals', project.id).find(a => a.state === 'pending'), 'fresh pending'); assert.equal(fresh.sessionId, resumed.id); assert.notEqual(fresh.id, old.id); assert(!existsSync(freshEffect));
  const decision = await post<{ outcomes: Array<{ok:boolean}> }>(`/api/projects/${project.id}/approvals/resolve`, { decision: 'approve', members: [member(fresh)] }); assert(decision.outcomes[0].ok);
  await until(() => existsSync(freshEffect), 'fresh effect'); await until(() => runtime.store.get<Task>('tasks', project.rootTaskId)!.state === 'review', 'resumed terminal');
  const signed = runtime.store.list<Decision>('decisions', project.id)[0]; assert(runtime.governance.verifyDecision(signed)); assert.equal(signed.delivery, 'sent'); assert(!existsSync(oldEffect));
  evidence.recovery = { actualHttpStartTerminateResumeHistory: true, freshSessionIdentity: true, formerApprovalDisconnected: true, formerDecisionRejected: true, historyStableAndNonAuthoritative: true, explicitHistoryGaps: first.gaps, freshNativeApprovalRequired: true, freshSignatureValid: true, delivery: signed.delivery, oldSentinel: false, freshSentinel: true, finalTaskState: 'review' };
  if (!process.argv.includes('--recovery-only')) {
  console.log('Application recovery passed; testing native parent/child continuation.');
  const parentProject = await post<Project>('/api/projects', { name: 'Synthetic continuation', workspace: workspace('continuation'), objective: 'Synthetic bounded parent-review test. In this initial turn call get_task_context exactly once without printing context, say Parent ready, then stop. Do not create agents, commands, edits or artifacts. On a later automatic registered-child question notification, call get_child_status for that exact child, then call reply_to_child exactly once with that childTaskId and the notified observationId, text: Inspect blue. This is a synthetic answer, not permission for native actions. Then stop. Do not accept tasks or create more work.' });
  const parentBase = `/api/projects/${parentProject.id}/tasks/${parentProject.rootTaskId}`; await post(parentBase + '/start', {}); await until(() => runtime.store.get<Task>('tasks', parentProject.rootTaskId)!.state === 'review', 'parent idle');
  const child = await post<Task>(`/api/projects/${parentProject.id}/tasks`, { parentTaskId: parentProject.rootTaskId, name: 'Synthetic Research', personaId: 'persona_research_v1', objective: 'Synthetic child question test. First call get_task_context once without printing context. Then ask exactly: Which synthetic color should I inspect, blue or green? End that turn immediately. When a later message says Inspect blue, respond exactly: Checked blue. End the turn. Never run commands, edit files, create agents, request approvals or mark your task accepted.' });
  await post(`/api/projects/${parentProject.id}/tasks/${child.id}/start`, {});
  const question = await until(() => runtime.store.list<Observation>('observations', parentProject.id).find(o => o.taskId === child.id && o.classification === 'awaiting_input'), 'child question');
  let automatic = true;
  try { await until(() => runtime.store.get<Observation>('observations', question.id)!.state === 'replied', 'automatic parent reply', 90_000); }
  catch { automatic = false; const current = runtime.store.get<Observation>('observations', question.id)!; if (current.state !== 'replied') await post(`/api/projects/${parentProject.id}/observations/${question.id}/reply`, { text: 'Inspect blue.' }); }
  await until(() => runtime.store.list<Observation>('observations', parentProject.id).find(o => o.taskId === child.id && o.sourceTurnId !== question.sourceTurnId && o.classification === 'progress_update'), 'continued child turn');
  assert.equal(runtime.store.get<Observation>('observations', question.id)!.state, 'replied'); assert.equal(runtime.store.get<Task>('tasks', child.id)!.state, 'review'); assert.equal(runtime.store.list<Approval>('approvals', parentProject.id).length, 0); assert.equal(runtime.store.list<Decision>('decisions', parentProject.id).length, 0);
  const actualReply = tools.some(t => t.name === 'reply_to_child' && t.ok && t.observationBound); if (automatic) assert(actualReply);
  evidence.continuation = { questionRoutedToOriginalParent: true, automaticParentReview: (runtime.parentReviews.get(parentProject.rootTaskId) ?? 0) > 0, actualParentGetChildStatus: tools.some(t => t.name === 'get_child_status' && t.ok), actualParentReplyToolWithObservation: actualReply, continuationVia: automatic ? 'native-parent-MCP' : 'authenticated-operator-HTTP-fallback', repliedObservation: true, distinctChildTurnCompleted: true, childTaskState: 'review', taskAccepted: false, nativeApprovalsGranted: 0 };
  }
  assert(runtime.store.verifyAudit().valid); assert(runtime.store.list<ActivityEvent>('events').every(e => e.text === null)); evidence.minimalRetentionAllEventTextNull = true; evidence.auditValid = true; evidence.result = 'passed';
} catch (error) { evidence.result = 'failed'; evidence.failure = error instanceof Error ? error.message : 'Unknown synthetic failure'; evidence.toolOutcomes = tools; process.exitCode = 1; }
finally { await app.close(); rmSync(directory, { recursive: true, force: true }); const json = JSON.stringify(evidence, null, 2) + '\n'; if (output) writeFileSync(output, json, { mode: 0o600 }); console.log(json); }
