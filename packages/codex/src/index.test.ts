import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { CodexConnector, type ConnectorEvent, type ConnectorApproval } from './index.js';

// Adapter tests use a SYNTHETIC subprocess protocol double; live enforcement evidence is separate.
async function until<T>(get: () => T | undefined | false): Promise<T> {
  for (let i = 0; i < 300; i++) { const value = get(); if (value) return value; await delay(10); }
  throw new Error('Synthetic adapter test timed out.');
}
function setup(scenario = 'command', unsupported = false, persistent = false) {
  const directory = mkdtempSync(join(tmpdir(), 'agentdash-connector-test-'));
  const executable = join(directory, unsupported ? 'unsupported-codex' : `codex-${scenario}`);
  copyFileSync(fileURLToPath(new URL('./protocol.fixture.mjs', import.meta.url)), executable);
  chmodSync(executable, 0o700);
  const events: ConnectorEvent[] = [];
  const stateDirectory = persistent ? join(directory, 'bindings') : undefined;
  const connector = new CodexConnector({ executable, stateDirectory, onEvent: event => events.push(event) });
  return {
    directory, executable, stateDirectory, connector, events,
    start: async (sessionId = 'session-a') => connector.startSession({
      sessionId, cwd: directory, instructions: 'Synthetic registered task.',
      environment: { AGCP_SESSION_CAP: 'synthetic-private-capability-token', ...(persistent ? { AGCP_FIXTURE_HISTORY_FILE: join(directory, 'history.synthetic.json') } : {}) },
      ...(persistent ? { scope: { projectId: 'project-a', taskId: 'task-a' } } : {}),
      mcpServers: { agentdash: { url: 'http://127.0.0.1:4317/mcp', bearer_token_env_var: 'AGCP_SESSION_CAP' } },
    }),
    approval: async (sessionId = 'session-a') => (await until(() => events.find(event => event.type === 'approval.requested' && event.sessionId === sessionId))) .approval as ConnectorApproval,
    cleanup: async () => { await connector.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}

test('version probe rejects every untested CLI build', async () => {
  const s = setup('command', true);
  try {
    assert.deepEqual(await s.connector.probe(), { available: false, version: '0.0.0', reason: 'Requires tested Codex CLI 0.163.0-alpha.11.1.' });
    await assert.rejects(s.start(), /Requires tested/);
  } finally { await s.cleanup(); }
});

test('liveness requires this adapter initialized ownership and becomes false on disconnect', async () => {
  const s = setup();
  try {
    assert.equal(s.connector.isSessionAlive('session-a'), false);
    await s.start();
    assert.equal(s.connector.isSessionAlive('session-a'), true);
    assert.equal(s.connector.isSessionAlive('foreign-session'), false);
    await s.connector.terminate('session-a');
    assert.equal(s.connector.isSessionAlive('session-a'), false);
  } finally { await s.cleanup(); }
});

test('numeric callback ID zero supports exact digest, session and one-shot checks', async () => {
  const s = setup();
  try {
    const { bindingRef } = await s.start();
    assert.match(bindingRef, /^[0-9a-f-]{36}$/);
    await s.connector.sendMessage('session-a', 'Synthetic request.');
    const approval = await s.approval();
    await assert.rejects(s.connector.resolveApproval('session-a', approval.key, 'sha256:mismatch', 'approve'), /digest mismatch/);
    await assert.rejects(s.connector.resolveApproval('unregistered', approval.key, approval.digest, 'approve'), /disconnected/);
    await assert.rejects(s.connector.sendMessage('session-a', 'overlap'), /active turn/);
    await s.connector.resolveApproval('session-a', approval.key, approval.digest, 'approve');
    await until(() => s.events.find(event => event.type === 'turn.completed'));
    await assert.rejects(s.connector.resolveApproval('session-a', approval.key, approval.digest, 'approve'), /missing or already consumed/);
    assert(s.events.some(event => event.text === '{"decision":"accept"}'));
    assert(!JSON.stringify(s.events).includes('synthetic-native-thread'));
  } finally { await s.cleanup(); }
});

test('denial selects cancel when decline is not advertised', async () => {
  const s = setup();
  try {
    await s.start(); await s.connector.sendMessage('session-a', 'Synthetic request.');
    const a = await s.approval();
    await s.connector.resolveApproval('session-a', a.key, a.digest, 'deny');
    await until(() => s.events.find(event => event.type === 'turn.completed'));
    assert(s.events.some(event => event.text === '{"decision":"cancel"}'));
  } finally { await s.cleanup(); }
});

test('denial uses one-action decline when it is advertised', async () => {
  const s = setup('decline-option');
  try {
    await s.start(); await s.connector.sendMessage('session-a', 'Synthetic request.');
    const a = await s.approval();
    await s.connector.resolveApproval('session-a', a.key, a.digest, 'deny');
    await until(() => s.events.find(event => event.type === 'turn.completed'));
    assert(s.events.some(event => event.text === '{"decision":"decline"}'));
  } finally { await s.cleanup(); }
});

test('same numeric native IDs in separate process generations cannot cross-resolve', async () => {
  const s = setup();
  try {
    await Promise.all([s.start('session-a'), s.start('session-b')]);
    await Promise.all([s.connector.sendMessage('session-a', 'A'), s.connector.sendMessage('session-b', 'B')]);
    const [a, b] = await Promise.all([s.approval('session-a'), s.approval('session-b')]);
    assert.notEqual(a.key, b.key);
    await assert.rejects(s.connector.resolveApproval('session-a', b.key, b.digest, 'approve'), /missing/);
    await s.connector.resolveApproval('session-a', a.key, a.digest, 'approve');
    await until(() => s.events.find(event => event.type === 'turn.completed' && event.sessionId === 'session-a'));
    assert(!s.events.some(event => event.type === 'approval.resolved' && event.sessionId === 'session-b'));
    await s.connector.resolveApproval('session-b', b.key, b.digest, 'deny');
  } finally { await s.cleanup(); }
});

for (const scenario of ['network', 'permissions', 'file', 'mcp', 'input', 'unknown', 'missing-command', 'relative-cwd', 'wrong-turn', 'wrong-thread', 'stdin']) {
  test(`unsupported or incomplete ${scenario} request grants no approval`, async () => {
    const s = setup(scenario);
    try {
      await s.start(); await s.connector.sendMessage('session-a', 'Synthetic unavailable request.');
      await until(() => s.events.find(event => event.type === 'turn.completed'));
      assert(!s.events.some(event => event.type === 'approval.requested'));
      assert(s.events.some(event => event.supported === false));
      const texts = s.events.map(event => event.text ?? '').join('\n');
      assert(!texts.includes('"decision":"accept"'));
      if (scenario === 'permissions') assert(texts.includes('"permissions":{},"scope":"turn"'));
      if (scenario === 'mcp') assert(texts.includes('"action":"decline"'));
    } finally { await s.cleanup(); }
  });
}

test('unregistered inherited MCP servers block startup', async () => {
  const s = setup('unexpected-mcp');
  try { await assert.rejects(s.start(), /Unexpected inherited MCP/); }
  finally { await s.cleanup(); }
});

test('reasoning is excluded, text is bounded, and session credentials are redacted', async () => {
  const s = setup();
  try {
    await s.start(); await s.connector.sendMessage('session-a', 'Synthetic request.');
    await s.approval();
    const serialized = JSON.stringify(s.events);
    for (const secret of ['RAW_REASONING_MARKER', 'synthetic-private-capability-token', 'synthetic-bearer-token', 'sk-syntheticVeryLongApiKey123456', 'synthetic-config-secret']) assert(!serialized.includes(secret));
    assert(s.events.some(event => event.text?.includes('[redacted]')));
    assert(s.events.every(event => !event.text || event.text.length <= 8000));
  } finally { await s.cleanup(); }
});

for (const scenario of ['disconnect', 'native-cleared', 'turn-ended']) {
  test(`${scenario} invalidates a formerly pending native callback`, async () => {
    const s = setup(scenario);
    try {
      await s.start(); await s.connector.sendMessage('session-a', 'Synthetic request.');
      const a = await s.approval();
      await until(() => s.events.find(event => event.type === 'session.disconnected' || event.type === 'approval.resolved'));
      await assert.rejects(s.connector.resolveApproval('session-a', a.key, a.digest, 'approve'), /disconnected|missing or already consumed/);
    } finally { await s.cleanup(); }
  });
}

test('malformed native output terminates the connector generation', async () => {
  const s = setup('malformed');
  try {
    await s.start();
    await s.connector.sendMessage('session-a', 'Synthetic request.').catch(() => {});
    await until(() => s.events.find(event => event.type === 'session.failed'));
    await assert.rejects(s.connector.sendMessage('session-a', 'Retry'), /disconnected/);
  } finally { await s.cleanup(); }
});


test('concurrent duplicate registration cannot create a second native process', async () => {
  const s = setup();
  try {
    const results = await Promise.allSettled([s.start(), s.start()]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter(result => result.status === 'rejected').length, 1);
    assert.equal(s.events.filter(event => event.type === 'session.started').length, 1);
  } finally { await s.cleanup(); }
});

test('closing during version probe cannot launch a process afterward', async () => {
  const s = setup();
  try {
    const opening = s.start();
    await s.connector.close();
    await assert.rejects(opening, /closing/);
    assert(!s.events.some(event => event.type === 'session.started'));
  } finally { await s.cleanup(); }
});


test('command phases have distinct stable source IDs and replay keeps its completion identity', async () => {
  const s = setup();
  try {
    await s.start(); await s.connector.sendMessage('session-a', 'Synthetic request.');
    const a = await s.approval();
    await s.connector.resolveApproval('session-a', a.key, a.digest, 'approve');
    await until(() => s.events.find(event => event.type === 'turn.completed'));
    const commands = s.events.filter(event => event.activityKind === 'command');
    assert.equal(commands.length, 3);
    assert.notEqual(commands[0].sourceId, commands[1].sourceId);
    assert.equal(commands[1].sourceId, commands[2].sourceId);
    assert.equal(commands[1].text, 'synthetic-result');
  } finally { await s.cleanup(); }
});


test('unrelated host credentials and NODE_OPTIONS are excluded while explicit session capabilities are forwarded', async () => {
  const names = ['AWS_SECRET_ACCESS_KEY', 'AGCP_UNRELATED_HOST_SECRET', 'NODE_OPTIONS'] as const;
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  process.env.AWS_SECRET_ACCESS_KEY = 'synthetic-host-cloud-secret';
  process.env.AGCP_UNRELATED_HOST_SECRET = 'synthetic-unrelated-host-secret';
  process.env.NODE_OPTIONS = '--no-warnings';
  const s = setup('env-boundary');
  try {
    assert((await s.connector.probe()).available);
    await s.start();
    assert(s.events.some(event => event.type === 'session.started'));
    await s.connector.sendMessage('session-a', 'Synthetic environment check.');
    await s.approval();
    assert(!JSON.stringify(s.events).includes('synthetic-private-capability-token'));
  } finally {
    for (const name of names) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; }
    await s.cleanup();
  }
});


function recoveryOptions(s: ReturnType<typeof setup>, bindingRef: string, sessionId = 'session-b', previousSessionId = 'session-a') {
  return { sessionId, previousSessionId, bindingRef, cwd: s.directory, instructions: 'Fresh synthetic context; prior authorization is invalid.',
    scope: { projectId: 'project-a', taskId: 'task-a' }, environment: { AGCP_SESSION_CAP: 'fresh-synthetic-capability-token', AGCP_FIXTURE_HISTORY_FILE: join(s.directory, 'history.synthetic.json') },
    mcpServers: { agentdash: { url: 'http://127.0.0.1:4317/mcp', bearer_token_env_var: 'AGCP_SESSION_CAP' } } };
}

test('private mapping persists only identifiers and metadata; history is stable, filtered, and never emits live effects', async () => {
  const s = setup('command', false, true);
  try {
    await s.start(); await s.connector.sendMessage('session-a', 'Synthetic private instructions not retained.');
    const a = await s.approval(); await s.connector.resolveApproval('session-a', a.key, a.digest, 'approve');
    await until(() => s.events.find(event => event.type === 'turn.completed'));
    const count = s.events.length;
    const first = await s.connector.getHistory('session-a'); const again = await s.connector.getHistory('session-a');
    assert.deepEqual(first, again); assert.equal(s.events.length, count);
    assert(first.entries.every(entry => entry.originSessionId === 'session-a' && !entry.text));
    assert(first.gaps.length); assert.equal(first.complete, false);
    const historyCommand = first.entries.find(entry => entry.activityKind === 'command')!;
    assert.equal(historyCommand.sourceId, s.events.find(event => event.summary.includes('Command activity ended'))!.sourceId);
    const content = await s.connector.getHistory('session-a', { includeText: true });
    assert(content.entries.some(entry => entry.text === 'synthetic-result'));
    assert(!JSON.stringify(content).includes('RAW_REASONING_MARKER'));
    const persisted = readdirSync(s.stateDirectory!).map(file => readFileSync(join(s.stateDirectory!, file), 'utf8')).join('');
    for (const excluded of ['Synthetic private instructions not retained', 'synthetic-private-capability-token', 'synthetic-result', a.key, 'RAW_REASONING_MARKER']) assert(!persisted.includes(excluded));
  } finally { await s.cleanup(); }
});

test('fresh connector resumes only the scoped stopped binding and never restores former callbacks', async () => {
  const s = setup('command', false, true); const resumedEvents: ConnectorEvent[] = [];
  const second = new CodexConnector({ executable: s.executable, stateDirectory: s.stateDirectory, onEvent: event => resumedEvents.push(event) });
  try {
    const { bindingRef } = await s.start(); await s.connector.sendMessage('session-a', 'Synthetic pending request.');
    const old = await s.approval();
    await assert.rejects(second.resumeSession(recoveryOptions(s, bindingRef)), /still running|ownership is uncertain/);
    await s.connector.close();
    for (const mutation of [{ scope: { projectId: 'foreign-project', taskId: 'task-a' } }, { scope: { projectId: 'project-a', taskId: 'foreign-task' } }, { previousSessionId: 'foreign-session' }, { cwd: tmpdir() }]) await assert.rejects(second.resumeSession({ ...recoveryOptions(s, bindingRef), ...mutation }), /does not match/);
    const result = await second.resumeSession(recoveryOptions(s, bindingRef));
    assert.equal(result.bindingRef, bindingRef); assert(result.history.gaps.some(gap => /unfinished|Former/.test(gap.summary)));
    assert(result.history.entries.every(entry => entry.originSessionId === 'session-a'));
    assert(!resumedEvents.some(event => event.type === 'approval.requested'));
    await assert.rejects(second.resolveApproval('session-b', old.key, old.digest, 'approve'), /missing or already consumed/);
    await second.sendMessage('session-b', 'Fresh synthetic request.');
    const fresh = (await until(() => resumedEvents.find(event => event.type === 'approval.requested'))).approval!;
    assert.notEqual(fresh.key, old.key);
    await assert.rejects(second.resolveApproval('session-b', old.key, fresh.digest, 'approve'), /missing/);
    await second.resolveApproval('session-b', fresh.key, fresh.digest, 'deny');
    await until(() => resumedEvents.find(event => event.type === 'turn.completed'));
    const history = await second.getHistory('session-b');
    assert(history.entries.some(entry => entry.originSessionId === 'session-b'));
    assert(!JSON.stringify(history).includes('synthetic-native-thread'));
  } finally { await second.close(); await s.cleanup(); }
});

test('recovery refuses missing private mapping and never adopts a legacy unscoped native thread', async () => {
  const s = setup();
  try { await assert.rejects(s.connector.resumeSession(recoveryOptions(s, '00000000-0000-0000-0000-000000000000')), /No verified native recovery/); }
  finally { await s.cleanup(); }
});

test('history pagination retains stable entries across pages without replaying live approvals', async () => {
  const s = setup('history-paginated', false, true);
  try {
    await s.start();
    for (let i = 0; i < 2; i++) {
      await s.connector.sendMessage('session-a', 'Synthetic turn');
      const a = (await until(() => s.events.filter(event => event.type === 'approval.requested')[i])).approval!;
      await s.connector.resolveApproval('session-a', a.key, a.digest, 'approve');
      await until(() => s.events.filter(event => event.type === 'turn.completed').length === i + 1);
    }
    const result = await s.connector.getHistory('session-a');
    assert.equal(result.entries.filter(entry => entry.type === 'turn.completed').length, 2);
    assert.equal(new Set(result.entries.map(entry => entry.sourceId)).size, result.entries.length);
    assert(!result.entries.some(entry => entry.type === 'approval.requested'));
  } finally { await s.cleanup(); }
});
