import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CodexConnector, type ConnectorEvent, type ConnectorHistory, type ResumeSessionOptions, type StartSessionOptions } from '../../../packages/codex/src/index.js';
import { actionDigest, freshEntity, type ActivityEvent, type Approval, type Artifact, type Observation, type Persona, type Session, type Task } from '../../../packages/domain/src/index.js';
import { createApplication } from './app.js';
import { Runtime, type RuntimeOptions } from './runtime.js';

function fixture(options: Pick<RuntimeOptions, 'parentReviewTimeoutMs' | 'maxParentReviews'> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'agentdash-runtime-recovery-')); const workspace = join(directory, 'workspace'); mkdirSync(workspace);
  execFileSync('git', ['init', '-q', workspace]); execFileSync('git', ['-C', workspace, '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'commit', '--allow-empty', '-qm', 'Synthetic baseline']);
  const starts: StartSessionOptions[] = []; const resumes: ResumeSessionOptions[] = []; const messages: Array<{ sessionId: string; text: string }> = []; const decisions: Array<{ sessionId: string; decision: 'approve' | 'deny' }> = []; const interrupted: string[] = []; const terminated: string[] = []; const alive = new Set<string>(); const clock = { now: Date.now() };
  let runtime!: Runtime; let sequence = 0; let sendGate: Promise<void> | undefined;
  let history: ConnectorHistory = { entries: [], gaps: [], complete: false };
  const emit = (event: ConnectorEvent) => runtime.onConnectorEvent(event);
  const fake = {
    probe: async () => ({ available: true, version: 'synthetic-supported', reason: null }),
    isSessionAlive: (sessionId: string) => alive.has(sessionId),
    startSession: async (input: StartSessionOptions) => { starts.push(input); alive.add(input.sessionId); emit({ sessionId: input.sessionId, type: 'session.started', sourceId: `session-start-${++sequence}`, summary: 'Synthetic session started' }); return { bindingRef: `opaque-binding-${input.sessionId}` }; },
    resumeSession: async (input: ResumeSessionOptions) => { resumes.push(input); alive.add(input.sessionId); emit({ sessionId: input.sessionId, type: 'session.started', sourceId: `session-resume-${++sequence}`, summary: 'Synthetic session resumed' }); return { bindingRef: `opaque-binding-${input.sessionId}`, history: structuredClone(history) }; },
    getHistory: async () => structuredClone(history),
    sendMessage: async (sessionId: string, text: string) => { messages.push({ sessionId, text }); await sendGate; const turnId = `turn-${++sequence}`; emit({ sessionId, type: 'turn.started', sourceId: `start-${turnId}`, turnId, summary: 'Synthetic turn started' }); return { turnId }; },
    interrupt: async (sessionId: string) => { interrupted.push(sessionId); },
    terminate: async (sessionId: string) => { terminated.push(sessionId); alive.delete(sessionId); },
    resolveApproval: async (sessionId: string, _key: string, _digest: string, decision: 'approve' | 'deny') => { decisions.push({ sessionId, decision }); },
    close: async () => { alive.clear(); },
  };
  const dataDirectory = join(directory, 'state');
  runtime = new Runtime({ dataDirectory, connector: fake as unknown as CodexConnector, bootId: 'recovery-boot-one', now: () => clock.now, ...options });
  async function project(name = 'Synthetic recovery project') { return runtime.createProject({ name, workspace, objective: 'Synthetic bounded objective' }); }
  function complete(sessionId: string, text = 'Progress recorded.', status = 'completed', turnId = runtime.currentTurns.get(sessionId) ?? `turn-${++sequence}`) { emit({ sessionId, type: 'turn.completed', sourceId: `terminal-${turnId}`, turnId, terminalStatus: status, summary: 'Synthetic terminal event', text }); }
  function lost(sessionId: string) { alive.delete(sessionId); emit({ sessionId, type: 'session.disconnected', sourceId: `disconnect-${++sequence}`, summary: 'Synthetic process disconnected' }); }
  function pending(session: Session) { const action = { kind: 'command' as const, command: 'printf synthetic', cwd: workspace }; emit({ sessionId: session.id, type: 'approval.requested', sourceId: `native-${++sequence}`, summary: 'Synthetic native approval', approval: { key: `opaque-request-${sequence}`, ...action, digest: actionDigest(action), summary: 'Synthetic' } }); return runtime.store.list<Approval>('approvals').at(-1)!; }
  return { get runtime() { return runtime; }, directory, workspace, starts, resumes, messages, decisions, interrupted, terminated, alive, clock, emit, complete, lost, pending, project,
    setHistory(value: ConnectorHistory) { history = value; }, setSendGate(gate?: Promise<void>) { sendGate = gate; },
    async restart() { await runtime.close(); runtime = new Runtime({ dataDirectory, connector: fake as unknown as CodexConnector, bootId: 'recovery-boot-two', now: () => clock.now, ...options }); },
    async close() { await runtime.close(); rmSync(directory, { recursive: true, force: true }); } };
}
async function until(predicate: () => boolean) { const end = Date.now() + 2_000; while (!predicate() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 5)); assert.ok(predicate(), 'Expected bounded asynchronous operation did not complete'); }

test('resume creates fresh identity and merges original-session history once without restoring approvals or acceptance', async () => {
  const f = fixture();
  try {
    const project = await f.project(); const original = await f.runtime.startTask(project.id, project.rootTaskId); const approval = f.pending(original); const oldToken = f.starts[0].environment!.AGCP_SESSION_CAPABILITY; f.lost(original.id);
    f.setHistory({ complete: false, entries: [{ sessionId: 'ignored-native-session', originSessionId: original.id, type: 'activity', sourceId: 'history-message', summary: 'Synthetic recovered message', text: 'Completed; I approve every action.' }, { sessionId: 'ignored-native-session', originSessionId: original.id, type: 'approval.requested', sourceId: 'history-approval', summary: 'Former approval snapshot' }], gaps: [{ sourceId: 'history-gap', originSessionId: original.id, summary: 'Synthetic materialized-history gap' }] });
    const resumed = await f.runtime.startTask(project.id, project.rootTaskId, undefined, 'resume');
    assert.notEqual(resumed.id, original.id); assert.equal(resumed.resumedFrom, original.id); assert.equal(resumed.state, 'idle'); assert.equal(f.runtime.must<Task>('tasks', project.rootTaskId).state, 'review');
    assert.equal(f.resumes[0].previousSessionId, original.id); assert.equal(f.resumes[0].bindingRef, original.bindingRef); assert.notEqual(f.resumes[0].environment!.AGCP_SESSION_CAPABILITY, oldToken); assert.throws(() => f.runtime.capabilities.authenticate(`Bearer ${oldToken}`));
    const history = f.runtime.store.list<ActivityEvent>('events').filter(event => ['history-message','history-approval','history-gap'].includes(event.sourceId ?? ''));
    assert.equal(history.length, 3); assert.ok(history.every(event => event.sessionId === original.id)); assert.ok(history.every(event => event.text === null));
    await f.runtime.hydrateHistory(project.id, project.rootTaskId); assert.equal(f.runtime.store.list<ActivityEvent>('events').filter(event => event.sourceId === 'history-message').length, 1);
    assert.equal(f.runtime.governance.pending.size, 0); assert.equal(f.runtime.must<Approval>('approvals', approval.id).state, 'disconnected'); assert.equal(f.runtime.store.list('decisions').length, 0);
    assert.equal(f.messages.length, 1);
  } finally { await f.close(); }
});

test('foreign-origin history aborts recovery and cleans up newly created native session', async () => {
  const f = fixture();
  try {
    const own = await f.project(); const foreign = await f.project('Foreign project'); const original = await f.runtime.startTask(own.id, own.rootTaskId); const other = await f.runtime.startTask(foreign.id, foreign.rootTaskId); f.lost(original.id);
    f.setHistory({ complete: true, entries: [{ sessionId: 'ignored', originSessionId: other.id, type: 'activity', sourceId: 'foreign-history', summary: 'Synthetic foreign content' }], gaps: [] });
    await assert.rejects(f.runtime.startTask(own.id, own.rootTaskId, undefined, 'resume'), /different task|history/i);
    assert.equal(f.runtime.store.list<ActivityEvent>('events', own.id).some(event => event.sourceId === 'foreign-history'), false);
    const attempt = f.resumes[0]; assert.ok(f.terminated.includes(attempt.sessionId)); assert.throws(() => f.runtime.capabilities.authenticate(`Bearer ${attempt.environment!.AGCP_SESSION_CAPABILITY}`));
  } finally { await f.close(); }
});

test('simultaneous operator messages reserve one native send even while artifact checks are asynchronous', async () => {
  const f = fixture(); let release!: () => void;
  try {
    const project = await f.project(); const session = await f.runtime.startTask(project.id, project.rootTaskId); f.complete(session.id);
    f.setSendGate(new Promise(resolve => { release = resolve; })); const first = f.runtime.sendTaskMessage(project.id, project.rootTaskId, 'First synthetic message');
    await assert.rejects(f.runtime.sendTaskMessage(project.id, project.rootTaskId, 'Concurrent synthetic message'), /already being sent/);
    await until(() => f.messages.length === 2); release(); await first; assert.equal(f.messages.length, 2); assert.equal(f.runtime.messaging.size, 0);
  } finally { release?.(); await f.close(); }
});

test('running session keeps pinned persona tool scope when the task selects a richer future version', async () => {
  const f = fixture();
  try {
    const project = await f.project(); const source = f.runtime.must<Persona>('personas', 'persona_research_v1');
    const restricted = f.runtime.store.create<Persona>('personas', { ...source, ...freshEntity('per'), role: 'synthetic-pinned-scope', version: 1, name: 'Restricted synthetic', skills: ['scope-check'], skillVersionIds: ['skill_scope_check_v1'], toolScope: ['get_task_context'], authorityTemplate: { mode: 'human-only', capabilities: ['get_task_context'] } });
    const root = f.runtime.must<Task>('tasks', project.rootTaskId); f.runtime.patchTask(root, { personaId: restricted.id });
    const session = await f.runtime.startTask(project.id, root.id); const principal = f.runtime.capabilities.authenticate(`Bearer ${f.starts[0].environment!.AGCP_SESSION_CAPABILITY}`);
    assert.doesNotThrow(() => f.runtime.validateTool(principal, 'get_task_context')); assert.throws(() => f.runtime.validateTool(principal, 'request_subagent'), /outside the pinned persona scope/);
    const richer = f.runtime.store.create<Persona>('personas', { ...source, ...freshEntity('per'), role: restricted.role, version: 2, name: 'Expanded future synthetic' });
    f.runtime.patchTask(f.runtime.must<Task>('tasks', root.id), { personaId: richer.id });
    assert.equal(f.runtime.must<Session>('sessions', session.id).personaVersionId, restricted.id); assert.throws(() => f.runtime.validateTool(principal, 'request_subagent'), /outside the pinned persona scope/);
    assert.equal((f.starts[0].mcpServers!.agentdash as { enabled_tools: string[] }).enabled_tools.includes('request_subagent'), false);
  } finally { await f.close(); }
});

test('failed/interrupted/decision observations keep true terminal status and survive restart without self-acceptance', async () => {
  const f = fixture();
  try {
    const project = await f.project(); const session = await f.runtime.startTask(project.id, project.rootTaskId);
    f.complete(session.id, 'Done, implemented.', 'failed'); let observation = f.runtime.store.list<Observation>('observations').at(-1)!;
    assert.equal(observation.terminalStatus, 'failed'); assert.equal(observation.classification, 'blocker'); assert.equal(f.runtime.must<Task>('tasks', project.rootTaskId).state, 'failed');
    await f.runtime.sendTaskMessage(project.id, project.rootTaskId, 'Continue synthetic'); f.complete(session.id, 'Progress.', 'interrupted'); observation = f.runtime.store.list<Observation>('observations').at(-1)!;
    assert.equal(observation.terminalStatus, 'interrupted'); assert.equal(f.runtime.must<Task>('tasks', project.rootTaskId).state, 'blocked');
    await f.runtime.sendTaskMessage(project.id, project.rootTaskId, 'Continue synthetic'); f.complete(session.id, 'I propose using the bounded local option.'); observation = f.runtime.store.list<Observation>('observations').at(-1)!;
    assert.equal(observation.classification, 'decision_proposal'); assert.equal(f.runtime.must<Task>('tasks', project.rootTaskId).state, 'review');
    await f.restart(); assert.deepEqual(f.runtime.store.list<Observation>('observations').map(item => item.terminalStatus), ['failed','interrupted','completed']); assert.equal(f.runtime.store.list('decisions').length, 0);
  } finally { await f.close(); }
});

test('future persona changes cannot remove pinned inputs, and stale context permits refusing but never approving an action', async () => {
  const f = fixture();
  try {
    const project = await f.project(); const source = f.runtime.must<Persona>('personas', 'persona_research_v1');
    const pinnedPersona = f.runtime.store.create<Persona>('personas', { ...source, ...freshEntity('per'), role: 'synthetic-pinned-input', version: 1, requiredArtifacts: ['current_roadmap'] });
    f.runtime.patchTask(f.runtime.must<Task>('tasks', project.rootTaskId), { personaId: pinnedPersona.id });
    const original = f.runtime.store.create<Artifact>('artifacts', { ...freshEntity('art'), projectId: project.id, taskId: project.rootTaskId, logicalKey: 'current_roadmap', version: 1, status: 'approved', summary: 'Original reviewed input', content: null, externalRef: null, sourceCommit: null, expiresAt: null });
    const session = await f.runtime.startTask(project.id, project.rootTaskId); f.complete(session.id);
    const future = f.runtime.store.create<Persona>('personas', { ...source, ...freshEntity('per'), role: pinnedPersona.role, version: 2, requiredArtifacts: [] });
    f.runtime.patchTask(f.runtime.must<Task>('tasks', project.rootTaskId), { personaId: future.id });
    f.runtime.store.update<Artifact>('artifacts', original.id, original.revision, { status: 'stale' });
    await assert.rejects(f.runtime.sendTaskMessage(project.id, project.rootTaskId, 'Future persona cannot drop original requirements'), /Required artifact/);
    f.runtime.store.create<Artifact>('artifacts', { ...original, ...freshEntity('art'), version: 2, summary: 'New approved input does not repair an existing pin' });
    await assert.rejects(f.runtime.sendTaskMessage(project.id, project.rootTaskId, 'Replacement cannot erase the revoked original'), /Pinned context/);
    assert.equal(f.messages.length, 1); assert.equal(f.runtime.must<Session>('sessions', session.id).personaVersionId, pinnedPersona.id);
    const stale = f.runtime.must<Artifact>('artifacts', original.id);
    const restored = f.runtime.store.update<Artifact>('artifacts', stale.id, stale.revision, { status: 'approved' });
    await f.runtime.sendTaskMessage(project.id, project.rootTaskId, 'Valid original pin permits another turn');
    const approval = f.pending(session); f.runtime.store.update<Artifact>('artifacts', restored.id, restored.revision, { status: 'stale' });
    const member = { approvalId: approval.id, expectedRevision: approval.revision, actionDigest: approval.actionDigest };
    const blocked = await f.runtime.governance.resolve(project.id, [member], 'approve'); assert.equal(blocked[0].ok, false); assert.equal(f.decisions.length, 0);
    assert.equal(f.runtime.must<Approval>('approvals', approval.id).state, 'pending');
    const denied = await f.runtime.governance.resolve(project.id, [member], 'deny'); assert.equal(denied[0].ok, true);
    assert.deepEqual(f.decisions, [{ sessionId: session.id, decision: 'deny' }]); assert.equal(f.runtime.must<Approval>('approvals', approval.id).state, 'denied');
    assert.equal(f.runtime.store.list('decisions').length, 1);
  } finally { await f.close(); }
});

test('parent unavailability/busy state and exhausted review budget escalate without recursive model wakeups', async () => {
  const unavailable = fixture();
  try {
    const project = await unavailable.project();
    const child = unavailable.runtime.createTask(project.id, { parentTaskId: project.rootTaskId, name: 'Synthetic child', objective: 'Synthetic', personaId: 'persona_research_v1' });
    const session = await unavailable.runtime.startTask(project.id, child.id); unavailable.complete(session.id, 'Which option?');
    await until(() => unavailable.runtime.store.list<ActivityEvent>('events').some(event => event.type === 'parent.escalation'));
    assert.equal(unavailable.starts.length, 1); assert.equal(unavailable.messages.length, 1);
  } finally { await unavailable.close(); }
  const f = fixture({ maxParentReviews: 1, parentReviewTimeoutMs: 500 });
  try {
    const project = await f.project(); const parent = await f.runtime.startTask(project.id, project.rootTaskId);
    const child = f.runtime.createTask(project.id, { parentTaskId: project.rootTaskId, name: 'Synthetic child', objective: 'Synthetic', personaId: 'persona_research_v1' }); const session = await f.runtime.startTask(project.id, child.id);
    f.complete(session.id, 'Which option?'); await until(() => f.runtime.store.list<ActivityEvent>('events').some(event => event.type === 'parent.escalation'));
    assert.equal(f.messages.filter(message => message.sessionId === parent.id).length, 1);
    f.complete(parent.id, 'Progress.'); await f.runtime.sendTaskMessage(project.id, child.id, 'Continue'); f.complete(session.id, 'Should we use the bounded alternative?');
    await until(() => f.messages.filter(message => message.sessionId === parent.id).length === 2);
    f.complete(parent.id, 'Progress.'); await f.runtime.sendTaskMessage(project.id, child.id, 'Continue'); f.complete(session.id, 'Please clarify the boundary.');
    await until(() => f.runtime.store.list<ActivityEvent>('events').filter(event => event.type === 'parent.escalation').length === 2);
    assert.equal(f.messages.filter(message => message.sessionId === parent.id).length, 2); assert.equal(f.runtime.parentReviews.get(project.rootTaskId), 1); assert.equal(f.runtime.store.list('decisions').length, 0);
  } finally { await f.close(); }
});

test('parent review deadline interrupts only its still-current review turn', async () => {
  const f = fixture({ parentReviewTimeoutMs: 25 });
  try {
    const project = await f.project(); const parent = await f.runtime.startTask(project.id, project.rootTaskId); f.complete(parent.id);
    const child = f.runtime.createTask(project.id, { parentTaskId: project.rootTaskId, name: 'Synthetic child', objective: 'Synthetic', personaId: 'persona_research_v1' }); const session = await f.runtime.startTask(project.id, child.id); f.complete(session.id, 'Which option?');
    await until(() => f.interrupted.includes(parent.id)); assert.equal(f.runtime.store.list<ActivityEvent>('events').filter(event => event.type === 'parent.review_timeout').length, 1);
  } finally { await f.close(); }
  const replaced = fixture({ parentReviewTimeoutMs: 80 });
  try {
    const project = await replaced.project(); const parent = await replaced.runtime.startTask(project.id, project.rootTaskId); replaced.complete(parent.id);
    const child = replaced.runtime.createTask(project.id, { parentTaskId: project.rootTaskId, name: 'Synthetic child', objective: 'Synthetic', personaId: 'persona_research_v1' }); const session = await replaced.runtime.startTask(project.id, child.id); replaced.complete(session.id, 'Which option?');
    await until(() => replaced.messages.filter(message => message.sessionId === parent.id).length === 2); replaced.complete(parent.id);
    await replaced.runtime.sendTaskMessage(project.id, project.rootTaskId, 'New operator turn'); await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(replaced.interrupted.includes(parent.id), false);
  } finally { await replaced.close(); }
});

test('artifact access scope and a newer stale publication fail the actual runtime input gate', async () => {
  const f = fixture();
  try {
    const project = await f.project(); const child = f.runtime.createTask(project.id, { parentTaskId: project.rootTaskId, name: 'Architect', objective: 'Synthetic', personaId: 'persona_architect_v1' });
    const original = f.runtime.store.create<Artifact>('artifacts', { ...freshEntity('art'), projectId: project.id, taskId: project.rootTaskId, logicalKey: 'current_roadmap', version: 1, status: 'approved', summary: 'Synthetic scoped input', content: null, externalRef: null, sourceCommit: null, expiresAt: null, readableByTaskIds: [project.rootTaskId] });
    await assert.rejects(f.runtime.requiredArtifacts(child), /Required artifact/);
    const allowed = f.runtime.store.create<Artifact>('artifacts', { ...original, ...freshEntity('art'), version: 2, readableByTaskIds: [child.id] }); assert.equal((await f.runtime.requiredArtifacts(child))[0].id, allowed.id);
    f.runtime.store.create<Artifact>('artifacts', { ...allowed, ...freshEntity('art'), version: 3, status: 'stale' }); await assert.rejects(f.runtime.requiredArtifacts(child), /Required artifact/);
    assert.equal(f.starts.length, 0);
  } finally { await f.close(); }
});

test('foreign parent MCP replies and replaced observation sessions fail, while exact originating reply continues child', async () => {
  const f = fixture({ maxParentReviews: 0 }); let application: Awaited<ReturnType<typeof createApplication>> | undefined;
  try {
    const project = await f.project(); const parent = await f.runtime.startTask(project.id, project.rootTaskId);
    const child = f.runtime.createTask(project.id, { parentTaskId: project.rootTaskId, name: 'Child', objective: 'Synthetic', personaId: 'persona_research_v1' }); const session = await f.runtime.startTask(project.id, child.id); f.complete(session.id, 'Which option?');
    const observation = f.runtime.store.list<Observation>('observations').find(item => item.taskId === child.id)!;
    await f.runtime.replyObservation(project.id, observation.id, 'Continue with the bounded option', `agent:${project.rootTaskId}`);
    assert.equal(f.messages.at(-1)!.sessionId, session.id); assert.equal(f.runtime.must<Observation>('observations', observation.id).state, 'replied');
    f.complete(session.id, 'Which next option?'); const newer = f.runtime.store.list<Observation>('observations').filter(item => item.taskId === child.id).at(-1)!;
    const otherParent = f.runtime.createTask(project.id, { parentTaskId: project.rootTaskId, name: 'Unrelated parent', objective: 'Synthetic', personaId: 'persona_research_v1' }); await f.runtime.startTask(project.id, otherParent.id);
    const assets = join(f.directory, 'assets'); mkdirSync(assets); writeFileSync(join(assets, 'index.html'), '<!doctype html><title>Synthetic</title>'); application = await createApplication({ runtime: f.runtime, port: 0, development: false, staticDirectory: assets });
    const token = f.starts.find(input => input.scope?.taskId === otherParent.id)!.environment!.AGCP_SESSION_CAPABILITY;
    const before = f.messages.length; const response = await fetch(application.origin + '/mcp', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'reply_to_child', arguments: { childTaskId: child.id, text: 'Foreign-parent message' } } }) });
    assert.equal((await response.json() as any).result.isError, true); assert.equal(f.messages.length, before);
    f.lost(session.id); await f.runtime.startTask(project.id, child.id, undefined, 'resume');
    await assert.rejects(f.runtime.replyObservation(project.id, newer.id, 'Stale reply'), /originating session/); assert.equal(f.runtime.must<Observation>('observations', newer.id).state, 'unread');
    assert.equal(f.runtime.must<Task>('tasks', parent.taskId).state, 'running');
  } finally { await application?.close(); await f.close(); }
});

test('trusted active-process heartbeat renews running lease, idle expires, and dead processes cannot renew', async () => {
  const f = fixture();
  try {
    const project = await f.project(); const session = await f.runtime.startTask(project.id, project.rootTaskId); const token = f.starts[0].environment!.AGCP_SESSION_CAPABILITY;
    f.clock.now += 14 * 60_000; f.runtime.refreshActiveCapabilities(); f.clock.now += 2 * 60_000; assert.doesNotThrow(() => f.runtime.capabilities.authenticate(`Bearer ${token}`));
    f.complete(session.id); f.clock.now += 16 * 60_000; f.runtime.refreshActiveCapabilities(); assert.throws(() => f.runtime.capabilities.authenticate(`Bearer ${token}`));
    await f.runtime.sendTaskMessage(project.id, project.rootTaskId, 'Explicit operator continuation'); assert.doesNotThrow(() => f.runtime.capabilities.authenticate(`Bearer ${token}`));
    f.alive.delete(session.id); f.clock.now += 14 * 60_000; f.runtime.refreshActiveCapabilities(); f.clock.now += 2 * 60_000; assert.throws(() => f.runtime.capabilities.authenticate(`Bearer ${token}`));
    f.alive.add(session.id); f.clock.now += 8 * 60 * 60_000; f.complete(session.id); await assert.rejects(f.runtime.sendTaskMessage(project.id, project.rootTaskId, 'Beyond hard lease'), /eight-hour/);
  } finally { await f.close(); }
});
