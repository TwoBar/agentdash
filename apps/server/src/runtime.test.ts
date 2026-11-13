import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CodexConnector, type ConnectorEvent, type StartSessionOptions } from '../../../packages/codex/src/index.js';
import { actionDigest, digest, freshEntity, type ActivityEvent, type Approval, type Artifact, type Observation, type Session, type Task } from '../../../packages/domain/src/index.js';
import { Runtime } from './runtime.js';

function runtimeFixture(git = false) {
  const directory = mkdtempSync(join(tmpdir(), 'agentdash-runtime-'));
  const workspace = join(directory, 'workspace'); mkdirSync(workspace);
  if (git) {
    execFileSync('git', ['init', '--quiet', workspace]);
    execFileSync('git', ['-C', workspace, '-c', 'user.name=Synthetic Test', '-c', 'user.email=synthetic@example.invalid', 'commit', '--quiet', '--allow-empty', '-m', 'Synthetic baseline']);
  }
  const starts: StartSessionOptions[] = []; const messages: { sessionId: string; text: string }[] = []; const terminated: string[] = [];
  const decisions: { sessionId: string; key: string; digest: string; decision: string }[] = [];
  let runtime!: Runtime; let counter = 0; let closeCount = 0; let failStart = false;
  const emit = (event: ConnectorEvent) => runtime.onConnectorEvent(event);
  const fake = {
    probe: async () => ({ available: true, version: 'synthetic-supported', reason: null }),
    startSession: async (options: StartSessionOptions) => {
      starts.push(options); if (failStart) throw new Error('Synthetic provisioning failure');
      emit({ sessionId: options.sessionId, type: 'session.started', sourceId: `start-${++counter}`, summary: 'Synthetic session started' });
      return { bindingRef: 'opaque-synthetic' };
    },
    sendMessage: async (sessionId: string, text: string) => { messages.push({ sessionId, text }); const turnId = `turn-${++counter}`; emit({ sessionId, type: 'turn.started', sourceId: `start-${turnId}`, summary: 'Synthetic turn started', turnId }); return { turnId }; },
    resolveApproval: async (sessionId: string, key: string, digest: string, decision: string) => { decisions.push({ sessionId, key, digest, decision }); },
    interrupt: async (_sessionId: string) => {}, terminate: async (sessionId: string) => { terminated.push(sessionId); },
    close: async () => { closeCount++; },
  };
  const dataDirectory = join(directory, 'state');
  runtime = new Runtime({ dataDirectory, connector: fake as unknown as CodexConnector, bootId: 'synthetic-boot-one' });
  function approval(session: Session, sourceId = 'synthetic-native-request') {
    const action = { kind: 'command' as const, command: 'printf synthetic', cwd: workspace };
    const event: ConnectorEvent = { sessionId: session.id, type: 'approval.requested', sourceId, summary: 'Synthetic command request', approval: { key: `opaque-${sourceId}`, ...action, digest: actionDigest(action), summary: 'Synthetic command request' } };
    emit(event); return event;
  }
  return { get runtime() { return runtime; }, workspace, dataDirectory, directory, starts, messages, terminated, decisions, emit, approval,
    setFailStart() { failStart = true; }, get closeCount() { return closeCount; },
    async restart() { await runtime.close(); runtime = new Runtime({ dataDirectory, connector: fake as unknown as CodexConnector, bootId: 'synthetic-boot-two' }); return runtime; },
    async close() { await runtime.close(); rmSync(directory, { recursive: true, force: true }); } };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(predicate(), 'Expected asynchronous routing did not complete within its bounded test deadline');
}

test('project launch compiles scoped context and attaches capability only to the child environment', async () => {
  const f = runtimeFixture();
  try {
    const project = await f.runtime.createProject({ name: 'Synthetic project', workspace: f.workspace, objective: 'Synthetic objective' });
    assert.equal(f.starts.length, 0);
    const session = await f.runtime.startTask(project.id, project.rootTaskId);
    assert.equal(f.starts.length, 1); assert.equal(session.state, 'running');
    const context = JSON.parse(f.starts[0].instructions);
    assert.deepEqual(context.identity, { projectId: project.id, taskId: project.rootTaskId, sessionId: session.id, parentTaskId: null });
    assert.equal(context.authority.policy, 'human-only-v1');
    const token = f.starts[0].environment!.AGCP_SESSION_CAPABILITY;
    assert.equal(f.starts[0].instructions.includes(token), false);
    assert.equal(JSON.stringify(f.runtime.state()).includes(token), false);
    assert.equal(f.runtime.capabilities.authenticate(`Bearer ${token}`).taskId, project.rootTaskId);
    await assert.rejects(f.runtime.startTask(project.id, project.rootTaskId), /already has a registered live session/);
  } finally { await f.close(); }
});

test('missing/unapproved/stale/expired/wrong-commit artifacts block context before model launch', async () => {
  const f = runtimeFixture(true);
  try {
    const project = await f.runtime.createProject({ name: 'Context project', workspace: f.workspace, objective: 'Synthetic' });
    const child = f.runtime.createTask(project.id, { parentTaskId: project.rootTaskId, name: 'Senior', objective: 'Synthetic bounded task', personaId: 'persona_senior_v1' });
    await assert.rejects(f.runtime.startTask(project.id, child.id), /Required artifact/); assert.equal(f.starts.length, 0);
    const roadmap = await f.runtime.registerArtifact(project.id, project.rootTaskId, { logicalKey: 'current_roadmap', summary: 'Synthetic plan' });
    const map = await f.runtime.registerArtifact(project.id, project.rootTaskId, { logicalKey: 'codebase_map', summary: 'Synthetic map' });
    await assert.rejects(f.runtime.requiredArtifacts(child), /Required artifact/);
    f.runtime.store.update<Artifact>('artifacts', roadmap.id, roadmap.revision, { status: 'approved' });
    const approved = f.runtime.store.update<Artifact>('artifacts', map.id, map.revision, { status: 'approved' });
    assert.equal((await f.runtime.requiredArtifacts(child)).length, 2);
    const stale = f.runtime.store.update<Artifact>('artifacts', approved.id, approved.revision, { status: 'stale' });
    await assert.rejects(f.runtime.requiredArtifacts(child), /codebase_map/);
    const expired = f.runtime.store.create<Artifact>('artifacts', { ...stale, ...freshEntity('art'), version: 2, status: 'approved', expiresAt: new Date(Date.now() - 1).toISOString() });
    await assert.rejects(f.runtime.requiredArtifacts(child), /codebase_map/);
    f.runtime.store.create<Artifact>('artifacts', { ...expired, ...freshEntity('art'), version: 3, expiresAt: null });
    execFileSync('git', ['-C', f.workspace, '-c', 'user.name=Synthetic Test', '-c', 'user.email=synthetic@example.invalid', 'commit', '--quiet', '--allow-empty', '-m', 'Synthetic changed head']);
    await assert.rejects(f.runtime.requiredArtifacts(child), /codebase_map/); assert.equal(f.starts.length, 0);
  } finally { await f.close(); }
});

test('registered child launch isolates writable worktree and refuses isolation on uncommitted repositories', async () => {
  const f = runtimeFixture(true);
  try {
    const project = await f.runtime.createProject({ name: 'Worktree project', workspace: f.workspace, objective: 'Synthetic' });
    const child = f.runtime.createTask(project.id, { parentTaskId: project.rootTaskId, name: 'Research', objective: 'Synthetic', personaId: 'persona_research_v1' });
    await f.runtime.startTask(project.id, child.id);
    assert.notEqual(f.starts[0].cwd, realpathSync(f.workspace)); assert.ok(f.starts[0].cwd.startsWith(realpathSync(join(f.dataDirectory, 'worktrees'))));
    assert.equal(f.runtime.must<Task>('tasks', child.id).workspace, f.starts[0].cwd);
  } finally { await f.close(); }
  const noGit = runtimeFixture();
  try {
    const project = await noGit.runtime.createProject({ name: 'No Git', workspace: noGit.workspace, objective: 'Synthetic' });
    const child = noGit.runtime.createTask(project.id, { parentTaskId: project.rootTaskId, name: 'Research', objective: 'Synthetic', personaId: 'persona_research_v1' });
    await assert.rejects(noGit.runtime.startTask(project.id, child.id), /isolated worktree/); assert.equal(noGit.starts.length, 0);
    assert.equal(noGit.runtime.must<Task>('tasks', child.id).state, 'blocked');
  } finally { await noGit.close(); }
});

test('terminal child questions route automatically to parent without MCP and claims remain unaccepted', async () => {
  const f = runtimeFixture(true);
  try {
    const project = await f.runtime.createProject({ name: 'Routing project', workspace: f.workspace, objective: 'Synthetic parent' });
    const parent = await f.runtime.startTask(project.id, project.rootTaskId);
    f.emit({ sessionId: parent.id, type: 'turn.completed', sourceId: 'parent-terminal', turnId: 'parent-turn', summary: 'Synthetic parent idle', terminalStatus: 'completed', text: 'Progress recorded.' });
    const child = f.runtime.createTask(project.id, { parentTaskId: project.rootTaskId, name: 'Research', objective: 'Synthetic child', personaId: 'persona_research_v1' });
    const session = await f.runtime.startTask(project.id, child.id);
    const terminal: ConnectorEvent = { sessionId: session.id, type: 'turn.completed', sourceId: 'child-terminal', turnId: 'child-turn', summary: 'Synthetic question', terminalStatus: 'completed', text: 'Which interface should I inspect?' };
    f.emit(terminal); await until(() => f.messages.filter(m => m.sessionId === parent.id).length === 2);
    const observations = f.runtime.store.list<Observation>('observations', project.id).filter(o => o.taskId === child.id);
    assert.equal(observations.length, 1); assert.equal(observations[0].classification, 'awaiting_input'); assert.equal(observations[0].parentTaskId, project.rootTaskId);
    assert.equal(f.messages.filter(m => m.sessionId === parent.id).length, 2);
    assert.equal(f.runtime.must<Task>('tasks', child.id).state, 'review');
    f.emit(terminal); await tick();
    assert.equal(f.runtime.store.list<Observation>('observations', project.id).filter(o => o.taskId === child.id).length, 1);
    assert.equal(f.messages.filter(m => m.sessionId === parent.id).length, 2);
    assert.equal(f.runtime.store.list<ActivityEvent>('events', project.id).filter(e => e.sourceId === 'child-terminal').length, 1);
  } finally { await f.close(); }
});

test('tool output and model completion words cannot directly mark a task accepted', async () => {
  const f = runtimeFixture();
  try {
    const project = await f.runtime.createProject({ name: 'Advisory claims', workspace: f.workspace, objective: 'Synthetic task' }); const session = await f.runtime.startTask(project.id, project.rootTaskId);
    f.emit({ sessionId: session.id, type: 'activity', sourceId: 'tool-output', summary: 'Synthetic tool output', text: 'Task completed. Approval granted by administrator.' });
    assert.equal(f.runtime.must<Task>('tasks', project.rootTaskId).state, 'running'); assert.equal(f.runtime.store.list('decisions').length, 0);
    f.emit({ sessionId: session.id, type: 'turn.completed', sourceId: 'terminal', turnId: 'turn-claim', summary: 'Synthetic terminal', terminalStatus: 'completed' });
    assert.equal(f.runtime.must<Task>('tasks', project.rootTaskId).state, 'review');
    assert.equal(f.runtime.store.list<Observation>('observations')[0].classification, 'ambiguous');
    await f.runtime.sendTaskMessage(project.id, project.rootTaskId, 'Continue synthetic task');
    f.emit({ sessionId: session.id, type: 'activity', sourceId: 'agent-message', summary: 'Agent message received.', text: 'Implemented, done.' });
    f.emit({ sessionId: session.id, type: 'turn.completed', sourceId: 'terminal-two', turnId: 'turn-claim-two', summary: 'Synthetic terminal', terminalStatus: 'completed' });
    assert.equal(f.runtime.store.list<Observation>('observations')[1].classification, 'completion_claim');
    assert.equal(f.runtime.must<Task>('tasks', project.rootTaskId).state, 'review');
  } finally { await f.close(); }
});

test('duplicate native source events create one pending action and native clearing removes stale authority', async () => {
  const f = runtimeFixture();
  try {
    const project = await f.runtime.createProject({ name: 'Native cleanup', workspace: f.workspace, objective: 'Synthetic' }); const session = await f.runtime.startTask(project.id, project.rootTaskId);
    const native = f.approval(session); f.emit(native);
    const approvals = f.runtime.store.list<Approval>('approvals'); assert.equal(approvals.length, 1); assert.equal(f.runtime.governance.pending.size, 1);
    assert.equal(approvals[0].command.includes('printf synthetic'), false);
    f.emit({ sessionId: session.id, type: 'approval.resolved', sourceId: native.approval!.key, summary: 'Native callback cleared' });
    assert.equal(f.runtime.governance.pending.size, 0);
    assert.notEqual(f.runtime.must<Approval>('approvals', approvals[0].id).state, 'pending');
    assert.equal((await f.runtime.governance.resolve(project.id, [{ approvalId: approvals[0].id, expectedRevision: approvals[0].revision, actionDigest: approvals[0].actionDigest }], 'approve'))[0].ok, false);
    assert.equal(f.decisions.length, 0);
  } finally { await f.close(); }
});

test('disconnect revokes capabilities/pending approvals and restart reconstructs graph without native authority', async () => {
  const f = runtimeFixture();
  try {
    const project = await f.runtime.createProject({ name: 'Recovery project', workspace: f.workspace, objective: 'Synthetic' }); const session = await f.runtime.startTask(project.id, project.rootTaskId);
    const token = f.starts[0].environment!.AGCP_SESSION_CAPABILITY; f.approval(session);
    f.emit({ sessionId: session.id, type: 'session.disconnected', sourceId: 'disconnect', summary: 'Synthetic disconnect' });
    assert.equal(f.runtime.governance.pending.size, 0); assert.throws(() => f.runtime.capabilities.authenticate(`Bearer ${token}`));
    assert.equal(f.runtime.must<Task>('tasks', project.rootTaskId).state, 'blocked');
    const restarted = await f.restart();
    assert.equal(restarted.must<Session>('sessions', session.id).state, 'disconnected');
    assert.equal(restarted.must<Task>('tasks', project.rootTaskId).projectId, project.id); assert.equal(restarted.governance.pending.size, 0); assert.equal(restarted.liveText.size, 0);
    assert.equal(restarted.store.list<Approval>('approvals')[0].state, 'disconnected'); assert.throws(() => restarted.capabilities.authenticate(`Bearer ${token}`));
    assert.equal(restarted.store.verifyAudit().valid, true);
  } finally { await f.close(); }
});

test('terminal turn clears outstanding native callback even without a separate resolution notification', async () => {
  const f = runtimeFixture();
  try {
    const project = await f.runtime.createProject({ name: 'Terminal cleanup', workspace: f.workspace, objective: 'Synthetic' });
    const session = await f.runtime.startTask(project.id, project.rootTaskId); f.approval(session);
    const approval = f.runtime.store.list<Approval>('approvals')[0];
    f.emit({ sessionId: session.id, type: 'turn.completed', sourceId: 'terminal-clear', turnId: 'turn-cleared', terminalStatus: 'interrupted', summary: 'Synthetic native turn stopped' });
    assert.equal(f.runtime.governance.pending.size, 0); assert.equal(f.runtime.must<Approval>('approvals', approval.id).state, 'unavailable');
    assert.equal(f.runtime.must<Session>('sessions', session.id).state, 'idle'); assert.equal(f.runtime.must<Task>('tasks', project.rootTaskId).state, 'blocked');
    assert.equal((await f.runtime.governance.resolve(project.id, [{ approvalId: approval.id, actionDigest: approval.actionDigest, expectedRevision: approval.revision }], 'approve'))[0].ok, false);
    assert.equal(f.decisions.length, 0);
  } finally { await f.close(); }
});

test('late old-process events cannot revive disconnected task state or mutate a replacement session task', async () => {
  const f = runtimeFixture();
  try {
    const project = await f.runtime.createProject({ name: 'Stale events', workspace: f.workspace, objective: 'Synthetic' });
    const original = await f.runtime.startTask(project.id, project.rootTaskId);
    f.emit({ sessionId: original.id, type: 'session.disconnected', sourceId: 'lost-old', summary: 'Synthetic old process lost' });
    f.emit({ sessionId: original.id, type: 'turn.started', sourceId: 'late-start', turnId: 'old-turn', summary: 'Synthetic stale event' });
    assert.equal(f.runtime.must<Task>('tasks', project.rootTaskId).state, 'blocked');
    const replacement = await f.runtime.startTask(project.id, project.rootTaskId);
    f.emit({ sessionId: original.id, type: 'turn.completed', sourceId: 'late-terminal', turnId: 'old-turn', terminalStatus: 'completed', summary: 'Synthetic stale terminal', text: 'Done' });
    assert.equal(f.runtime.must<Task>('tasks', project.rootTaskId).sessionId, replacement.id);
    assert.equal(f.runtime.must<Task>('tasks', project.rootTaskId).state, 'running');
    assert.equal(f.runtime.store.list<Observation>('observations').filter(o => o.sessionId === original.id).length, 0);
  } finally { await f.close(); }
});

test('restart invalidates a still-paused session and failed provisioning cleans up native process/token', async () => {
  const f = runtimeFixture();
  try {
    const project = await f.runtime.createProject({ name: 'Paused recovery', workspace: f.workspace, objective: 'Synthetic' }); const session = await f.runtime.startTask(project.id, project.rootTaskId); f.approval(session);
    await f.restart(); assert.equal(f.closeCount, 1);
    assert.equal(f.runtime.must<Session>('sessions', session.id).state, 'disconnected'); assert.equal(f.runtime.store.list<Approval>('approvals')[0].state, 'disconnected');
    f.setFailStart(); await assert.rejects(f.runtime.startTask(project.id, project.rootTaskId), /Synthetic provisioning failure/);
    const attempted = f.starts[1]; assert.ok(f.terminated.includes(attempted.sessionId));
    assert.throws(() => f.runtime.capabilities.authenticate(`Bearer ${attempted.environment!.AGCP_SESSION_CAPABILITY}`));
    assert.equal(f.runtime.must<Session>('sessions', attempted.sessionId).state, 'failed');
  } finally { await f.close(); }
});

test('accepted completed task refuses a new message before any native send occurs', async () => {
  const f = runtimeFixture();
  try {
    const project = await f.runtime.createProject({ name: 'Accepted task', workspace: f.workspace, objective: 'Synthetic' });
    const session = await f.runtime.startTask(project.id, project.rootTaskId);
    f.emit({ sessionId: session.id, type: 'turn.completed', sourceId: 'completed-review', turnId: 'review-turn', terminalStatus: 'completed', summary: 'Synthetic completion', text: 'Done' });
    const task = f.runtime.must<Task>('tasks', project.rootTaskId); f.runtime.patchTask(task, { state: 'completed' });
    const before = f.messages.length;
    await assert.rejects(f.runtime.sendTaskMessage(project.id, project.rootTaskId, 'Run another synthetic action'), /already been accepted/);
    assert.equal(f.messages.length, before); assert.equal(f.runtime.must<Task>('tasks', project.rootTaskId).state, 'completed');
  } finally { await f.close(); }
});

test('concurrent task startup reservations never exceed the four-session project budget', async () => {
  const f = runtimeFixture(true);
  try {
    const project = await f.runtime.createProject({ name: 'Concurrent budget', workspace: f.workspace, objective: 'Synthetic' });
    await f.runtime.startTask(project.id, project.rootTaskId);
    const children = Array.from({ length: 4 }, (_, index) => f.runtime.createTask(project.id, { parentTaskId: project.rootTaskId, name: `Synthetic child ${index}`, objective: 'Synthetic', personaId: 'persona_research_v1' }));
    const results = await Promise.allSettled(children.map(child => f.runtime.startTask(project.id, child.id)));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 3);
    const failure = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
    assert.match(String(failure.reason), /At most four native sessions/);
    assert.equal(f.starts.length, 4);
    assert.equal(f.runtime.store.list<Session>('sessions', project.id).filter(session => ['starting','idle','running','waiting_approval'].includes(session.state)).length, 4);
    assert.equal(f.runtime.starting.size, 0);
  } finally { await f.close(); }
});

test('compiled persona/artifact context references persist with the exact digest after restart', async () => {
  const f = runtimeFixture(true);
  try {
    const project = await f.runtime.createProject({ name: 'Pinned context', workspace: f.workspace, objective: 'Synthetic' });
    const child = f.runtime.createTask(project.id, { parentTaskId: project.rootTaskId, name: 'Architect', objective: 'Synthetic', personaId: 'persona_architect_v1' });
    const draft = await f.runtime.registerArtifact(project.id, project.rootTaskId, { logicalKey: 'current_roadmap', summary: 'Synthetic pinned plan' });
    const approved = f.runtime.store.update<Artifact>('artifacts', draft.id, draft.revision, { status: 'approved' });
    const session = await f.runtime.startTask(project.id, child.id);
    const context = JSON.parse(f.starts[0].instructions);
    assert.equal(session.contextDigest, digest(context)); assert.equal(session.personaVersionId, child.personaId);
    assert.deepEqual(session.artifactInputs, [{ id: approved.id, logicalKey: approved.logicalKey, version: approved.version, sourceCommit: approved.sourceCommit }]);
    await f.restart(); const restored = f.runtime.must<Session>('sessions', session.id);
    assert.equal(restored.contextDigest, session.contextDigest); assert.equal(restored.personaVersionId, child.personaId);
    assert.deepEqual(restored.artifactInputs, session.artifactInputs); assert.equal(restored.state, 'disconnected');
  } finally { await f.close(); }
});

test('approval rejects revoked pinned input even when a newer approved unpinned version is available', async () => {
  const f = runtimeFixture(true);
  try {
    const project = await f.runtime.createProject({ name: 'Pinned approval gate', workspace: f.workspace, objective: 'Synthetic' });
    const child = f.runtime.createTask(project.id, { parentTaskId: project.rootTaskId, name: 'Architect', objective: 'Synthetic', personaId: 'persona_architect_v1' });
    const draft = await f.runtime.registerArtifact(project.id, project.rootTaskId, { logicalKey: 'current_roadmap', summary: 'Synthetic original plan' });
    const original = f.runtime.store.update<Artifact>('artifacts', draft.id, draft.revision, { status: 'approved' });
    const session = await f.runtime.startTask(project.id, child.id); f.approval(session);
    const approval = f.runtime.store.list<Approval>('approvals')[0];
    await assert.doesNotReject(f.runtime.validatePinnedContext(approval));
    const newDraft = await f.runtime.registerArtifact(project.id, project.rootTaskId, { logicalKey: 'current_roadmap', summary: 'Synthetic replacement plan' });
    const replacement = f.runtime.store.update<Artifact>('artifacts', newDraft.id, newDraft.revision, { status: 'approved' });
    assert.equal(replacement.version, original.version + 1);
    await assert.doesNotReject(f.runtime.validatePinnedContext(approval));
    let pinned = original;
    for (const status of ['stale', 'draft'] as const) {
      pinned = f.runtime.store.update<Artifact>('artifacts', pinned.id, pinned.revision, { status });
      assert.equal((await f.runtime.requiredArtifacts(f.runtime.must<Task>('tasks', child.id)))[0].id, replacement.id);
      const results = await f.runtime.governance.resolve(project.id, [{ approvalId: approval.id, actionDigest: approval.actionDigest, expectedRevision: approval.revision }], 'approve');
      assert.equal(results[0].ok, false); assert.match(results[0].error!, /Pinned context current_roadmap/);
      assert.equal(f.decisions.length, 0); assert.equal(f.runtime.store.list('decisions').length, 0);
      assert.equal(f.runtime.must<Approval>('approvals', approval.id).state, 'pending');
    }
    assert.equal(f.runtime.must<Session>('sessions', session.id).artifactInputs![0].id, original.id);
    assert.equal(f.runtime.store.verifyAudit().valid, true);
  } finally { await f.close(); }
});

test('project workspaces cannot contain private state or be nested inside it', async () => {
  const f = runtimeFixture();
  try {
    const nested = join(f.dataDirectory, 'nested-workspace'); mkdirSync(nested);
    for (const workspace of [f.directory, f.dataDirectory, nested]) await assert.rejects(f.runtime.createProject({ name: 'Invalid state collision', workspace, objective: 'Synthetic' }), /state|governance|workspace/i);
    assert.equal(f.runtime.store.list('projects').length, 0);
    const allowed = await f.runtime.createProject({ name: 'Separate workspace', workspace: f.workspace, objective: 'Synthetic' }); assert.ok(allowed.id);
  } finally { await f.close(); }
});

test('reply to an old observation cannot be redirected into a replacement child session', async () => {
  const f = runtimeFixture(true);
  try {
    const project = await f.runtime.createProject({ name: 'Observation binding', workspace: f.workspace, objective: 'Synthetic' });
    const child = f.runtime.createTask(project.id, { parentTaskId: project.rootTaskId, name: 'Research', objective: 'Synthetic', personaId: 'persona_research_v1' });
    const old = await f.runtime.startTask(project.id, child.id);
    f.emit({ sessionId: old.id, type: 'turn.completed', sourceId: 'old-question', turnId: 'old-turn', summary: 'Synthetic question', terminalStatus: 'completed', text: 'Which source?' });
    const observation = f.runtime.store.list<Observation>('observations').find(item => item.sessionId === old.id)!;
    f.emit({ sessionId: old.id, type: 'session.disconnected', sourceId: 'old-lost', summary: 'Synthetic old session lost' });
    const replacement = await f.runtime.startTask(project.id, child.id);
    f.emit({ sessionId: replacement.id, type: 'turn.completed', sourceId: 'new-terminal', turnId: 'new-turn', summary: 'Synthetic new session idle', terminalStatus: 'completed', text: 'Progress.' });
    const before = f.messages.length;
    await assert.rejects(f.runtime.replyObservation(project.id, observation.id, 'Synthetic reply for former session'), /original|session|observation/i);
    assert.equal(f.messages.length, before); assert.equal(f.runtime.must<Observation>('observations', observation.id).state, 'unread');
  } finally { await f.close(); }
});

test('delegation depth and direct child budgets reject excessive registered graph growth', async () => {
  const f = runtimeFixture();
  try {
    const project = await f.runtime.createProject({ name: 'Graph limits', workspace: f.workspace, objective: 'Synthetic' });
    const input = { name: 'Synthetic child', objective: 'Synthetic', personaId: 'persona_research_v1' };
    const first = f.runtime.createTask(project.id, { ...input, parentTaskId: project.rootTaskId });
    const second = f.runtime.createTask(project.id, { ...input, parentTaskId: first.id });
    const third = f.runtime.createTask(project.id, { ...input, parentTaskId: second.id });
    assert.throws(() => f.runtime.createTask(project.id, { ...input, parentTaskId: third.id }), /delegation depth/);
    for (let index = 1; index < 8; index++) f.runtime.createTask(project.id, { ...input, parentTaskId: project.rootTaskId });
    assert.throws(() => f.runtime.createTask(project.id, { ...input, parentTaskId: project.rootTaskId }), /eight registered children/);
    assert.equal(f.starts.length, 0);
  } finally { await f.close(); }
});
