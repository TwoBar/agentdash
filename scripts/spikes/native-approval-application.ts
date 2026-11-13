/** Full native application smoke. Run: npx tsx scripts/spikes/native-approval-application.ts --live [--output /tmp/evidence.json]
 * Starts the real HTTP service, scoped MCP, SQLite, governance signer, and Codex adapter.
 * Keeps all data in disposable OS temporary directories; emits sanitized outcomes only.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApplication } from '../../apps/server/src/app.js';
import { Runtime } from '../../apps/server/src/runtime.js';
import type { Approval, Decision, Project, Task, ActivityEvent, Observation } from '../../packages/domain/src/index.js';

if (!process.argv.includes('--live')) { console.log('Pass --live to run the real application against signed-in Codex.'); process.exit(0); }
const outputIndex = process.argv.indexOf('--output');
const output = outputIndex < 0 ? null : resolve(process.argv[outputIndex + 1]);
const temporary = mkdtempSync(join(tmpdir(), 'agentdash-native-application-'));
const dataDirectory = join(temporary, 'private-data'); const assets = join(temporary, 'assets');
mkdirSync(dataDirectory, { mode: 0o700 }); mkdirSync(assets, { mode: 0o700 });
writeFileSync(join(assets, 'index.html'), '<!doctype html><title>Synthetic local smoke</title>');
const runtime = new Runtime({ dataDirectory });
const unsupportedCategories: string[] = [];
const ingest = runtime.onConnectorEvent.bind(runtime);
runtime.onConnectorEvent = event => { if (event.supported === false && event.reason) unsupportedCategories.push(event.reason); ingest(event); };
const app = await createApplication({ runtime, port: 0, development: false, staticDirectory: assets });
const evidence: Record<string, unknown> = { kind: 'sanitized-live-application-observations', date: new Date().toISOString().slice(0, 10), components: ['HTTP operator boundary', 'session-scoped HTTP MCP', 'SQLite audit store', 'signed one-action governance', 'native CodexConnector'] };
const taskBranches = new Map<string, string>();
const contextCalls: Array<{ branch: string; ok: boolean; identityBound: boolean }> = [];
const coordinationCalls: Array<{ tool: string; ok: boolean; childRegistered: boolean }> = [];
const mcpDiagnostics: Array<Record<string, unknown>> = [];
const wireText = (value: unknown) => typeof value === 'string' ? value : value instanceof Uint8Array ? Buffer.from(value).toString('utf8') : '';
// Observe only this disposable server's get_task_context request/response in memory.
// Never inspect Authorization headers or persist any raw request/response.
app.server.prependListener('request', (request, response) => {
  if (request.url !== '/mcp' || request.method !== 'POST') return;
  let requestBody = ''; let responseBody = '';
  request.on('data', chunk => { requestBody += chunk.toString(); });
  const write = response.write; const end = response.end;
  response.write = function (this: ServerResponse, ...args: unknown[]) {
    if (args[0]) responseBody += wireText(args[0]);
    return write.apply(this, args as Parameters<typeof write>);
  } as typeof response.write;
  response.end = function (this: ServerResponse, ...args: unknown[]) {
    if (args[0]) responseBody += wireText(args[0]);
    return end.apply(this, args as Parameters<typeof end>);
  } as typeof response.end;
  response.on('finish', () => {
    try {
      const req = JSON.parse(requestBody);
      mcpDiagnostics.push({ method: req.method, tool: req.params?.name ?? null, status: response.statusCode, responseBytes: responseBody.length });
      if (req.method === 'tools/list') { const listed = JSON.parse(responseBody); mcpDiagnostics.push({ listedTools: listed.result?.tools?.map((tool: { name: string; annotations?: unknown }) => ({ name: tool.name, annotations: tool.annotations ?? null })) }); }
      if (req.method !== 'tools/call') return;
      const res = JSON.parse(responseBody);
      const text = res.result?.content?.find((item: { type?: string }) => item.type === 'text')?.text;
      const context = text ? JSON.parse(text) : null;
      if (req.params?.name === 'request_subagent') {
        const child = typeof context?.taskId === 'string' ? runtime.store.get<Task>('tasks', context.taskId) : undefined;
        coordinationCalls.push({ tool: 'request_subagent', ok: response.statusCode === 200 && !res.result?.isError && !res.error, childRegistered: !!child?.sessionId && child.sessionId === context?.sessionId && !!child.parentTaskId });
        return;
      }
      if (req.params?.name !== 'get_task_context') return;
      const ownTask = typeof context?.identity?.taskId === 'string' ? runtime.store.get<Task>('tasks', context.identity.taskId) : undefined;
      const branch = taskBranches.get(context?.identity?.taskId) ?? (ownTask?.parentTaskId && taskBranches.get(ownTask.parentTaskId) === 'spawn' ? 'spawn-child' : 'unrecognized');
      contextCalls.push({ branch, ok: response.statusCode === 200 && !res.result?.isError && !res.error, identityBound: branch !== 'unrecognized' && !!context?.identity?.sessionId });
    } catch { mcpDiagnostics.push({ responseParsed: false, status: response.statusCode, responseBytes: responseBody.length }); }
    requestBody = ''; responseBody = '';
  });
});
async function until<T>(read: () => T | false | undefined, label: string): Promise<T> {
  for (let i = 0; i < 6000; i++) { const value = read(); if (value) return value; await delay(20); }
  throw new Error(`Application smoke timed out: ${label}`);
}
let cookie = ''; let csrf = '';
async function post<T>(path: string, value: unknown): Promise<T> {
  const response = await fetch(app.origin + path, { method: 'POST', headers: { Cookie: cookie, Origin: app.origin, 'Content-Type': 'application/json', 'X-AGCP-CSRF': csrf }, body: JSON.stringify(value) });
  const body = await response.json() as T & { error?: { code?: string } };
  if (!response.ok) throw new Error(`HTTP smoke operation failed: ${response.status} ${body.error?.code ?? 'unknown'}`);
  return body;
}
try {
  await runtime.probe(); assert(runtime.probeStatus.available);
  evidence.cliVersion = runtime.probeStatus.version;
  const navigation = await fetch(app.origin + '/'); assert.equal(navigation.status, 200);
  cookie = navigation.headers.get('set-cookie')!.split(';')[0]; await navigation.text();
  const operatorSession = await fetch(app.origin + '/api/session', { headers: { Cookie: cookie, Origin: app.origin } });
  assert.equal(operatorSession.status, 200); csrf = (await operatorSession.json() as { csrfToken: string }).csrfToken;
  console.log('Application smoke: authenticated operator established.');
  const cases: Array<{ branch: 'accept' | 'deny'; project: Project; sentinel: string }> = [];
  for (const branch of ['accept', 'deny'] as const) {
    const workspace = join(temporary, `workspace-${branch}`); mkdirSync(workspace, { mode: 0o700 });
    execFileSync('git', ['init', '--quiet', workspace]);
    writeFileSync(join(workspace, 'README.md'), '# Synthetic approval smoke\n');
    execFileSync('git', ['-C', workspace, 'add', 'README.md']);
    execFileSync('git', ['-C', workspace, '-c', 'user.name=Synthetic Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'Synthetic initial workspace']);
    const objective = `Synthetic two-phase application validation. INITIAL TURN: invoke the registered agentdash MCP get_task_context tool exactly once to verify your scoped identity, then reply briefly and wait for the operator. Do not print the returned context. Do not run any shell command in the initial turn. If this MCP tool is unavailable, explicitly report that and stop. LATER TURN ONLY after the operator's message: execute exactly the requested touch command once using require_escalated in the read-only sandbox. No alternative tools, retries after denial, or agents.`;
    const project = await post<Project>('/api/projects', { name: `Synthetic ${branch}`, workspace, objective });
    taskBranches.set(project.rootTaskId, branch);
    cases.push({ branch, project, sentinel: join(workspace, `application-${branch}`) });
  }
  await Promise.all(cases.map(({ project }) => post(`/api/projects/${project.id}/tasks/${project.rootTaskId}/start`, {})));
  await Promise.all(cases.map(({ project }) => until(() => {
    const task = runtime.store.get<Task>('tasks', project.rootTaskId)!;
    return ['review', 'blocked', 'failed'].includes(task.state) ? task : undefined;
  }, 'MCP-only terminal turn')));
  for (const branch of ['accept', 'deny']) assert(contextCalls.some(call => call.branch === branch && call.ok && call.identityBound), 'Native AGCP MCP context call did not verify identity.');
  console.log('Application smoke: actual scoped context calls verified.');
  await Promise.all(cases.map(({ branch, project }) => post(`/api/projects/${project.id}/tasks/${project.rootTaskId}/message`, { text: `Proceed with phase two. Execute exactly this shell command once: touch application-${branch}. Request sandbox_permissions=require_escalated because the sandbox is read-only. Do not run any other command or use apply_patch/request_permissions. Do not retry after denial and do not spawn agents.` })));
  const approvals = await Promise.all(cases.map(({ project }) => until(() => runtime.store.list<Approval>('approvals', project.id).find(approval => approval.state === 'pending'), 'native pending approval')));
  for (let i = 0; i < cases.length; i++) {
    const { branch, sentinel } = cases[i]; const approval = approvals[i];
    const pending = runtime.governance.pending.get(approval.id)!;
    assert.equal(pending.command, `/bin/zsh -lc 'touch application-${branch}'`);
    assert(!existsSync(sentinel));
  }
  const began = Date.now(); await delay(2000);
  assert(cases.every(({ sentinel }) => !existsSync(sentinel)));
  const holdMs = Date.now() - began;
  for (const branch of ['accept', 'deny']) assert(contextCalls.some(call => call.branch === branch && call.ok && call.identityBound), 'Native AGCP MCP context call did not verify identity.');
  const resolved: Array<Record<string, unknown>> = [];
  for (let i = 0; i < cases.length; i++) {
    const { branch, project, sentinel } = cases[i]; const approval = approvals[i];
    const decision = branch === 'accept' ? 'approve' : 'deny';
    const response = await post<{ outcomes: Array<{ ok: boolean; state: string }> }>(`/api/projects/${project.id}/approvals/resolve`, { decision, members: [{ approvalId: approval.id, actionDigest: approval.actionDigest, expectedRevision: approval.revision }] });
    assert.equal(response.outcomes.length, 1); assert(response.outcomes[0].ok);
    if (branch === 'accept') await until(() => existsSync(sentinel), 'approved effect');
    else assert(!existsSync(sentinel));
    const signed = runtime.store.list<Decision>('decisions', project.id).find(row => row.approvalId === approval.id)!;
    assert(signed && runtime.governance.verifyDecision(signed)); assert.equal(signed.delivery, 'sent');
    const replay = await post<{ outcomes: Array<{ ok: boolean }> }>(`/api/projects/${project.id}/approvals/resolve`, { decision, members: [{ approvalId: approval.id, actionDigest: approval.actionDigest, expectedRevision: approval.revision }] });
    assert(!replay.outcomes[0].ok);
    resolved.push({ branch, approvalState: runtime.store.get<Approval>('approvals', approval.id)!.state, signatureValid: true, delivery: signed.delivery, replayRejected: true, sentinelAfterDecision: existsSync(sentinel) });
  }
  await Promise.all(cases.map(({ project }) => until(() => {
    const task = runtime.store.get<Task>('tasks', project.rootTaskId)!;
    return ['review', 'blocked', 'failed'].includes(task.state) ? task : undefined;
  }, 'terminal task state')));
  assert(existsSync(cases[0].sentinel)); assert(!existsSync(cases[1].sentinel));
  console.log('Application smoke: signed native accept/deny, replay, and sentinel outcomes verified.');
  if (process.argv.includes('--spawn')) {
    const workspace = join(temporary, 'workspace-spawn'); mkdirSync(workspace, { mode: 0o700 });
    execFileSync('git', ['init', '--quiet', workspace]);
    writeFileSync(join(workspace, 'README.md'), '# Synthetic registered child smoke\n');
    execFileSync('git', ['-C', workspace, 'add', 'README.md']);
    execFileSync('git', ['-C', workspace, '-c', 'user.name=Synthetic Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'Synthetic spawn workspace']);
    const project = await post<Project>('/api/projects', {
      name: 'Synthetic registered child', workspace,
      objective: 'Synthetic bounded registered-child integration test. First call AGCP get_task_context once and identify the research persona from availablePersonas. Then call AGCP request_subagent exactly once with name Synthetic Research, that research personaId, and child objective: First call get_task_context exactly once; then ask the parent Which synthetic color should I inspect, blue or green? Stop immediately after this question. Do not execute commands, edit files, create children, or call report tools. After the registered child is created, end your own turn briefly. Do not use native agents and do not create another child. If later notified of the child question, leave it for human attention without sending a reply or creating more work.',
    });
    taskBranches.set(project.rootTaskId, 'spawn');
    await post(`/api/projects/${project.id}/tasks/${project.rootTaskId}/start`, {});
    console.log('Application smoke: waiting for one registered research child.');
    const child = await until(() => runtime.store.list<Task>('tasks', project.id).find(task => task.parentTaskId === project.rootTaskId && !!task.sessionId && !!task.workspace), 'registered child session');
    const observation = await until(() => runtime.store.list<Observation>('observations', project.id).find(row => row.taskId === child.id && row.parentTaskId === project.rootTaskId && row.classification === 'awaiting_input'), 'automatic child question observation');
    await until(() => coordinationCalls.some(call => call.tool === 'request_subagent' && call.ok && call.childRegistered), 'successful native registered child MCP call');
    assert(contextCalls.some(call => call.branch === 'spawn-child' && call.ok && call.identityBound));
    assert.equal(child.personaId, 'persona_research_v1');
    assert.notEqual(child.workspace, project.workspace);
    assert(child.workspace!.startsWith(realpathSync(dataDirectory) + '/worktrees/'));
    const isolatedHead = execFileSync('git', ['-C', child.workspace!, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const parentHead = execFileSync('git', ['-C', project.workspace, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    assert.equal(isolatedHead, parentHead);
    assert.equal(runtime.store.list<Task>('tasks', project.id).filter(task => task.parentTaskId === project.rootTaskId).length, 1);
    assert(!runtime.store.list<Approval>('approvals', project.id).length);
    evidence.registeredChild = {
      requestSubagentActualToolCallSucceeded: true, parentAndSessionBindingsMatched: true,
      actualChildContextCallSucceeded: true, isolatedCommittedWorktree: true, exactlyOneChild: true,
      automaticObservation: observation.classification, observationRoutedToOriginalParent: true,
      taskAcceptedByAgent: runtime.store.get<Task>('tasks', child.id)!.state === 'completed',
      noNativeActionAuthorized: true,
    };
    assert.equal((evidence.registeredChild as { taskAcceptedByAgent: boolean }).taskAcceptedByAgent, false);
  }
  const ledger = runtime.store.verifyAudit(); assert(ledger.valid);
  const recordedEvents = runtime.store.list<ActivityEvent>('events');
  assert(recordedEvents.every(event => event.text === null));
  evidence.result = 'passed'; evidence.holdMs = holdMs; evidence.pendingEffects = { accept: false, deny: false };
  evidence.cases = resolved.map((item, i) => ({ ...item, taskState: runtime.store.get<Task>('tasks', cases[i].project.rootTaskId)!.state }));
  evidence.mcpContextCalls = contextCalls; evidence.coordinationCalls = coordinationCalls;
  evidence.audit = { valid: ledger.valid, events: ledger.events };
  evidence.minimalRetentionAllEventTextNull = true;
  evidence.note = 'Real HTTP operator authentication/CSRF, session bearer MCP, signing/audit and native approval. Only exact synthetic invocation results retained. Pipe delivery sent is separate from observed execution.';
} catch (error) {
  evidence.unsupportedCategories = unsupportedCategories; evidence.agentDiagnostics = [...runtime.liveTurns.values()].map(text => ({ mentionsUnavailable: /unavailable|not available|cannot|can't/i.test(text), mentionsTool: /tool|mcp/i.test(text), mentionedToolNames: [...new Set(text.match(/mcp__[a-zA-Z0-9_-]+/g) ?? [])] })); evidence.mcpDiagnostics = mcpDiagnostics; evidence.mcpContextCalls = contextCalls; evidence.result = 'failed'; evidence.failure = error instanceof Error ? error.message : 'Unknown application smoke failure'; process.exitCode = 1;
} finally {
  await app.close(); rmSync(temporary, { recursive: true, force: true });
  const json = `${JSON.stringify(evidence, null, 2)}\n`;
  if (output) writeFileSync(output, json, { mode: 0o600 });
  console.log(json);
}
