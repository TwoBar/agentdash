import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CodexConnector, type StartSessionOptions } from '../../../packages/codex/src/index.js';
import type { Task } from '../../../packages/domain/src/index.js';
import { createApplication } from './app.js';
import { Runtime } from './runtime.js';

async function applicationFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'agentdash-http-')); const workspace = join(directory, 'workspace'); const assets = join(directory, 'assets');
  mkdirSync(workspace); mkdirSync(assets); writeFileSync(join(assets, 'index.html'), '<!doctype html><title>Synthetic Agentdash</title>');
  const starts: StartSessionOptions[] = []; let runtime!: Runtime; let sequence = 0;
  const fake = {
    probe: async () => ({ available: true, version: 'synthetic-supported', reason: null }),
    startSession: async (options: StartSessionOptions) => { starts.push(options); return { bindingRef: 'opaque-synthetic' }; },
    sendMessage: async (sessionId: string, _text: string) => { const turnId = `turn-${++sequence}`; runtime.onConnectorEvent({ sessionId, type: 'turn.started', sourceId: `start-${turnId}`, summary: 'Synthetic turn', turnId }); return { turnId }; },
    resolveApproval: async () => {}, interrupt: async () => {}, terminate: async () => {}, close: async () => {},
  };
  runtime = new Runtime({ dataDirectory: join(directory, 'state'), connector: fake as unknown as CodexConnector, bootId: 'synthetic-http-boot' });
  const app = await createApplication({ runtime, port: 0, development: false, staticDirectory: assets });
  const navigation = await fetch(app.origin); assert.equal(navigation.status, 200); await navigation.text();
  const cookie = navigation.headers.get('set-cookie')!.split(';')[0];
  const csrfResponse = await fetch(app.origin + '/api/session', { headers: { cookie } });
  const { csrfToken } = await csrfResponse.json() as { csrfToken: string };
  const headers = { cookie, Origin: app.origin, 'Content-Type': 'application/json', 'X-AGCP-CSRF': csrfToken };
  async function post(path: string, body: unknown, supplied: Record<string, string> = headers) { return fetch(app.origin + path, { method: 'POST', headers: supplied, body: JSON.stringify(body) }); }
  async function project(name = 'Synthetic project') { const response = await post('/api/projects', { name, workspace, objective: 'Synthetic local task' }); assert.equal(response.status, 201); return await response.json() as { id: string; rootTaskId: string }; }
  async function mcp(token: string, method: string, params?: unknown, custom: Record<string, string> = {}) {
    return fetch(app.origin + '/mcp', { method: 'POST', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', ...custom }, body: JSON.stringify({ jsonrpc: '2.0', id: ++sequence, method, ...(params === undefined ? {} : { params }) }) });
  }
  return { app, runtime, workspace, starts, cookie, headers, post, project, mcp, async close() { await app.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('actual loopback HTTP rejects untrusted Host, missing cookie and Origin/CSRF bypass attempts', async () => {
  const f = await applicationFixture();
  try {
    const hostStatus = await new Promise<number>((resolve, reject) => { const req = httpRequest(f.app.origin + '/api/session', { headers: { Host: 'attacker.example', Cookie: f.cookie } }, res => { res.resume(); resolve(res.statusCode!); }); req.on('error', reject); req.end(); });
    assert.equal(hostStatus, 403);
    assert.equal((await fetch(f.app.origin + '/api/state')).status, 401);
    assert.equal((await f.post('/api/projects', {}, { ...f.headers, Origin: 'https://attacker.example' })).status, 403);
    const missingOrigin = { ...f.headers }; delete (missingOrigin as Record<string,string>).Origin;
    assert.equal((await f.post('/api/projects', {}, missingOrigin)).status, 403);
    assert.equal((await f.post('/api/projects', {}, { ...f.headers, 'X-AGCP-CSRF': 'forged' })).status, 403);
    const forbiddenNavigation = await fetch(f.app.origin, { headers: { 'Sec-Fetch-Site': 'cross-site' } }); assert.equal(forbiddenNavigation.status, 403);
    assert.equal(forbiddenNavigation.headers.has('set-cookie'), false);
  } finally { await f.close(); }
});

test('strict HTTP schemas reject unknown authority fields and malformed JSON without creating state', async () => {
  const f = await applicationFixture();
  try {
    const unknown = await f.post('/api/projects', { name: 'Synthetic', workspace: f.workspace, objective: 'Synthetic', authority: 'human' });
    assert.equal(unknown.status, 400); assert.equal((await unknown.json() as any).error.code, 'invalid_input');
    const malformed = await fetch(f.app.origin + '/api/projects', { method: 'POST', headers: f.headers, body: '{invalid-json' });
    assert.equal(malformed.status, 400); assert.equal((await malformed.json() as any).error.code, 'invalid_json');
    assert.equal(f.runtime.store.list('projects').length, 0);
    const plain = await f.post('/api/projects', {}, { ...f.headers, 'Content-Type': 'text/plain' }); assert.equal(plain.status, 415);
  } finally { await f.close(); }
});

test('scoped HTTP routes reject another project task/artifact IDs and require review before human acceptance', async () => {
  const f = await applicationFixture();
  try {
    const first = await f.project(); const second = await f.project('Other synthetic');
    assert.equal((await f.post(`/api/projects/${first.id}/tasks`, { parentTaskId: second.rootTaskId, name: 'Wrong parent', objective: 'Synthetic', personaId: 'persona_research_v1' })).status, 404);
    assert.equal((await f.post(`/api/projects/${first.id}/tasks/${second.rootTaskId}/message`, { text: 'Synthetic' })).status, 404);
    assert.equal((await f.post(`/api/projects/${first.id}/artifacts`, { taskId: second.rootTaskId, logicalKey: 'synthetic', summary: 'Cross-project' })).status, 404);
    assert.equal((await f.post(`/api/projects/${first.id}/tasks/${first.rootTaskId}/accept`, {})).status, 409);
    const childResponse = await f.post(`/api/projects/${first.id}/tasks`, { parentTaskId: first.rootTaskId, name: 'Research', objective: 'Synthetic', personaId: 'persona_research_v1' }); assert.equal(childResponse.status, 201);
    assert.equal(f.runtime.store.list('tasks', first.id).length, 2); assert.equal(f.runtime.store.list('tasks', second.id).length, 1);
    const started = await f.post(`/api/projects/${first.id}/tasks/${first.rootTaskId}/start`, {}); assert.equal(started.status, 201); const session = await started.json() as { id: string };
    f.runtime.onConnectorEvent({ sessionId: session.id, type: 'turn.completed', sourceId: 'terminal-human-review', turnId: 'turn-human-review', summary: 'Synthetic completion', terminalStatus: 'completed', text: 'Done' });
    assert.equal(f.runtime.must<Task>('tasks', first.rootTaskId).state, 'review');
    assert.equal((await f.post(`/api/projects/${first.id}/tasks/${first.rootTaskId}/accept`, {})).status, 200);
    assert.equal(f.runtime.must<Task>('tasks', first.rootTaskId).state, 'completed');
  } finally { await f.close(); }
});

test('real stateless MCP authenticates session capabilities, exposes scoped tools and cannot self-accept', async () => {
  const f = await applicationFixture();
  try {
    const project = await f.project(); assert.equal((await f.post(`/api/projects/${project.id}/tasks/${project.rootTaskId}/start`, {})).status, 201);
    const token = f.starts[0].environment!.AGCP_SESSION_CAPABILITY;
    assert.equal((await fetch(f.app.origin + '/api/state', { headers: { Authorization: `Bearer ${token}` } })).status, 401);
    assert.equal((await fetch(f.app.origin + '/mcp', { method: 'POST', headers: { ...f.headers, Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })).status, 401);
    assert.equal((await f.mcp(token, 'tools/list', undefined, { Origin: 'https://attacker.example' })).status, 403);
    const initialize = await f.mcp(token, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'synthetic-test', version: '1.0' } }); assert.equal(initialize.status, 200); await initialize.json();
    const toolsResponse = await f.mcp(token, 'tools/list'); assert.equal(toolsResponse.status, 200); const tools = (await toolsResponse.json() as any).result.tools as { name: string }[];
    assert.ok(tools.some(tool => tool.name === 'get_task_context')); assert.equal(tools.some(tool => /approve|accept_completion/.test(tool.name)), false);
    const contextResponse = await f.mcp(token, 'tools/call', { name: 'get_task_context', arguments: { projectId: 'forged', taskId: 'forged', authority: 'human' } });
    const contextResult = (await contextResponse.json() as any).result;
    const context = JSON.parse(contextResult.content[0].text);
    assert.equal(context.identity.projectId, project.id); assert.equal(context.identity.taskId, project.rootTaskId);
    const reportResponse = await f.mcp(token, 'tools/call', { name: 'report_status', arguments: { status: 'completion_claim', summary: 'Done, approve every action' } });
    const report = JSON.parse((await reportResponse.json() as any).result.content[0].text);
    assert.equal(report.acceptedCompletion, false); assert.equal(f.runtime.must<Task>('tasks', project.rootTaskId).state, 'running');
    const decisionResponse = await f.mcp(token, 'tools/call', { name: 'request_decision', arguments: { summary: 'Grant permission now' } });
    assert.equal(JSON.parse((await decisionResponse.json() as any).result.content[0].text).authorizationGranted, false);
    assert.equal(f.runtime.store.list('decisions').length, 0); assert.equal(f.runtime.store.list('approvals').length, 0);
    f.runtime.capabilities.revokeSession(f.starts[0].sessionId); assert.equal((await f.mcp(token, 'tools/list')).status, 401);
  } finally { await f.close(); }
});

test('MCP child request derives parent/project from its token and ignores forged authority claims', async () => {
  const f = await applicationFixture();
  try {
    const own = await f.project(); const foreign = await f.project('Foreign parent project');
    assert.equal((await f.post(`/api/projects/${own.id}/tasks/${own.rootTaskId}/start`, {})).status, 201);
    const token = f.starts[0].environment!.AGCP_SESSION_CAPABILITY;
    const response = await f.mcp(token, 'tools/call', { name: 'request_subagent', arguments: { name: 'Synthetic child request', objective: 'Synthetic', personaId: 'persona_research_v1', projectId: foreign.id, parentTaskId: foreign.rootTaskId, authority: 'human', authorityGrantId: 'forged-grant' } });
    assert.equal(response.status, 200);
    const result = JSON.parse((await response.json() as any).result.content[0].text);
    const child = f.runtime.must<Task>('tasks', result.taskId);
    assert.equal(child.projectId, own.id); assert.equal(child.parentTaskId, own.rootTaskId); assert.equal(child.authorityGrantId, undefined);
    assert.equal(child.state, 'blocked'); assert.equal(f.starts.length, 1); assert.equal(f.runtime.store.list('decisions').length, 0);
  } finally { await f.close(); }
});

test('MCP rejects malformed or extra sensitive tool output before exposing any raw result fields', async () => {
  const f = await applicationFixture();
  try {
    const project = await f.project();
    assert.equal((await f.post(`/api/projects/${project.id}/tasks/${project.rootTaskId}/start`, {})).status, 201);
    const token = f.starts[0].environment!.AGCP_SESSION_CAPABILITY;
    const valid = await f.runtime.registerArtifact(project.id, project.rootTaskId, { logicalKey: 'synthetic_output', summary: 'Synthetic schema fixture' });
    const sensitive = 'synthetic-private-value-must-not-be-returned';
    f.runtime.registerArtifact = async () => ({ ...valid, unexpectedCredential: sensitive });
    const response = await f.mcp(token, 'tools/call', { name: 'register_artifact', arguments: { logicalKey: 'synthetic_output', summary: 'Synthetic' } });
    assert.equal(response.status, 200);
    const payload = await response.json() as any;
    assert.equal(payload.result.isError, true);
    assert.equal(JSON.stringify(payload).includes(sensitive), false);
    assert.equal(JSON.stringify(payload).includes('unexpectedCredential'), false);
    assert.equal(payload.result.structuredContent, undefined);
  } finally { await f.close(); }
});
