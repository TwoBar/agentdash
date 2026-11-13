/** Focused root context/artifact proof: npx tsx scripts/spikes/native-approval-artifact.ts --live */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Runtime } from '../../apps/server/src/runtime.js';
import { createApplication } from '../../apps/server/src/app.js';
import type { Artifact, Project, Task } from '../../packages/domain/src/index.js';
if (!process.argv.includes('--live')) { console.log('Pass --live to test a native root retrieving context and publishing a draft artifact stub.'); process.exit(0); }
const outputIndex = process.argv.indexOf('--output');
const output = outputIndex < 0 ? null : resolve(process.argv[outputIndex + 1]);
const temporary = mkdtempSync(join(tmpdir(), 'agentdash-native-artifact-'));
const workspace = join(temporary, 'workspace'); const dataDirectory = join(temporary, 'state'); const assets = join(temporary, 'assets');
for (const directory of [workspace, dataDirectory, assets]) mkdirSync(directory, { mode: 0o700 });
writeFileSync(join(assets, 'index.html'), '<!doctype html><title>Synthetic artifact test</title>');
execFileSync('git', ['init', '--quiet', workspace]);
writeFileSync(join(workspace, 'README.md'), '# Synthetic artifact provenance workspace\n');
execFileSync('git', ['-C', workspace, 'add', 'README.md']);
execFileSync('git', ['-C', workspace, '-c', 'user.name=Synthetic Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'Synthetic artifact workspace']);
const head = execFileSync('git', ['-C', workspace, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const runtime = new Runtime({ dataDirectory });
const app = await createApplication({ runtime, port: 0, development: false, staticDirectory: assets });
const actualToolCalls: string[] = [];
app.server.prependListener('request', (request) => {
  if (request.url !== '/mcp' || request.method !== 'POST') return;
  let body = '';
  request.on('data', chunk => { body += chunk.toString(); });
  request.on('end', () => {
    try { const call = JSON.parse(body); if (call.method === 'tools/call' && ['get_task_context', 'register_artifact'].includes(call.params?.name)) actualToolCalls.push(call.params.name); }
    catch { /* No raw bodies, headers, or credentials are retained. */ }
    body = '';
  });
});
const evidence: Record<string, unknown> = { kind: 'sanitized-live-root-artifact-observations', date: new Date().toISOString().slice(0, 10) };
try {
  await runtime.probe(); assert(runtime.probeStatus.available); evidence.cliVersion = runtime.probeStatus.version;
  const navigation = await fetch(app.origin); assert.equal(navigation.status, 200);
  const cookie = navigation.headers.get('set-cookie')!.split(';')[0]; await navigation.text();
  const auth = await fetch(app.origin + '/api/session', { headers: { Cookie: cookie, Origin: app.origin } });
  const csrf = (await auth.json() as { csrfToken: string }).csrfToken;
  const post = async <T>(path: string, body: unknown): Promise<T> => {
    const response = await fetch(app.origin + path, { method: 'POST', headers: { Cookie: cookie, Origin: app.origin, 'Content-Type': 'application/json', 'X-AGCP-CSRF': csrf }, body: JSON.stringify(body) });
    assert(response.ok, `Artifact smoke HTTP status ${response.status}`); return await response.json() as T;
  };
  const project = await post<Project>('/api/projects', {
    name: 'Synthetic native artifact', workspace,
    objective: 'Synthetic AGCP MCP integration test. First call get_task_context exactly once and verify it is this registered root task without printing the returned context. Then call register_artifact exactly once with logicalKey synthetic_stub, summary Synthetic provenance stub, and content synthetic content. Do not approve the artifact, execute commands, edit source files, create children, or retry tool calls. End your turn after the tool result.',
  });
  await post(`/api/projects/${project.id}/tasks/${project.rootTaskId}/start`, {});
  for (let i = 0; i < 6000 && runtime.store.get<Task>('tasks', project.rootTaskId)!.state !== 'review'; i++) await delay(20);
  assert.equal(runtime.store.get<Task>('tasks', project.rootTaskId)!.state, 'review');
  const artifacts = runtime.store.list<Artifact>('artifacts', project.id); assert.equal(artifacts.length, 1);
  const artifact = artifacts[0];
  assert.equal(artifact.logicalKey, 'synthetic_stub'); assert.equal(artifact.status, 'draft'); assert.equal(artifact.version, 1);
  assert.equal(artifact.taskId, project.rootTaskId); assert.equal(artifact.projectId, project.id); assert.equal(artifact.sourceCommit, head);
  assert.equal(artifact.summary, 'Synthetic provenance stub'); assert.equal(artifact.content, 'synthetic content');
  assert.equal(actualToolCalls.filter(name => name === 'get_task_context').length, 1);
  assert.equal(actualToolCalls.filter(name => name === 'register_artifact').length, 1);
  assert.equal(runtime.store.list('decisions').length, 0); assert.equal(runtime.store.list('approvals').length, 0);
  const audit = runtime.store.verifyAudit(); assert(audit.valid);
  evidence.result = 'passed'; evidence.actualToolCalls = actualToolCalls;
  evidence.artifact = { logicalKey: artifact.logicalKey, status: artifact.status, version: artifact.version, taskAndProjectBoundToAuthenticatedRoot: true, sourceCommitMatchesScratchHead: true, syntheticContentMatchesRequest: true };
  evidence.taskState = 'review'; evidence.selfApprovalGranted = false; evidence.nativeActionsAuthorized = 0;
  evidence.audit = { valid: audit.valid, events: audit.events };
  evidence.note = 'Artifact creation was observed through actual native MCP tools/call plus persisted scoped provenance, not an agent completion claim. Raw requests, context, source paths, IDs, credentials and prompts are omitted.';
} catch (error) {
  evidence.result = 'failed'; evidence.failure = error instanceof Error ? error.message : 'Unknown artifact smoke failure'; process.exitCode = 1;
} finally {
  await app.close(); rmSync(temporary, { recursive: true, force: true });
  const json = `${JSON.stringify(evidence, null, 2)}\n`; if (output) writeFileSync(output, json, { mode: 0o600 }); console.log(json);
}
