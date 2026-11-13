import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { actionDigest, digest, freshEntity, type ActivityEvent, type Approval, type Artifact, type Decision, type Project, type Session, type Task, type Persona, type SkillVersion, type Observation, type ProfileConnection, type GitHubProposal } from '../../domain/src/index.js';
import { Store } from './index.js';

function graph(store: Store, name = 'Synthetic project') {
  const taskId = freshEntity('tsk').id;
  const project = store.create<Project>('projects', { ...freshEntity('prj'), name, workspace: '/synthetic', rootTaskId: taskId, githubRepo: null });
  const task = store.create<Task>('tasks', { ...freshEntity('tsk'), id: taskId, projectId: project.id, parentTaskId: null, name: 'Synthetic task', objective: 'Test only', personaId: 'synthetic-persona', state: 'ready', sessionId: null, workspace: null });
  const session = store.create<Session>('sessions', { ...freshEntity('ses'), projectId: project.id, taskId: task.id, connector: 'codex', state: 'idle', bootId: 'synthetic-boot', error: null, bindingRef: null });
  return { project, task, session };
}
function pending(store: Store, base = graph(store)): Approval {
  const action = { kind: 'command' as const, command: 'printf synthetic', cwd: '/synthetic' };
  return store.create<Approval>('approvals', { ...freshEntity('apr'), projectId: base.project.id, taskId: base.task.id, sessionId: base.session.id, sourceEventId: freshEntity('evt').id, actionDigest: actionDigest(action), summary: 'Synthetic action', ...action, target: 'scratch file', impact: 'synthetic write', risk: 'low', state: 'pending', expiresAt: new Date(Date.now() + 60_000).toISOString(), policySnapshotId: 'policy-human-v1', bootId: base.session.bootId, reason: null });
}
function decision(approval: Approval): Decision {
  return { ...freshEntity('dec'), projectId: approval.projectId, approvalId: approval.id, sessionId: approval.sessionId, actionDigest: approval.actionDigest, decision: 'approve', resolver: 'human', policySnapshotId: approval.policySnapshotId, bootId: approval.bootId, issuedAt: new Date().toISOString(), expiresAt: approval.expiresAt, keyId: 'synthetic-key', signature: 'synthetic-not-valid-signature', verificationKey: 'synthetic-public-key', delivery: 'intent' };
}
function disk() {
  const directory = mkdtempSync(join(tmpdir(), 'agentdash-store-'));
  return { path: join(directory, 'private', 'governance.sqlite'), cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

test('graph persists across reopen with private file permissions and verified migrations/audit', () => {
  const file = disk();
  try {
    let store = new Store(file.path);
    const { project, task } = graph(store);
    store.update<Task>('tasks', task.id, 1, { state: 'running' });
    assert.equal(store.verifyAudit().valid, true);
    assert.equal(statSync(file.path).mode & 0o777, 0o600);
    store.close();
    store = new Store(file.path);
    assert.equal(store.get<Project>('projects', project.id)?.rootTaskId, task.id);
    assert.equal(store.get<Task>('tasks', task.id)?.state, 'running');
    assert.equal(store.verifyAudit().events, 4);
    store.close();
    const raw = new DatabaseSync(file.path);
    assert.equal(raw.prepare('PRAGMA journal_mode').get()?.journal_mode, 'delete');
    assert.equal(raw.prepare('SELECT count(*) AS count FROM schema_migrations').get()?.count, 3);
    raw.close();
  } finally { file.cleanup(); }
});

test('revision CAS rejects stale writers and identity/action changes without additional audit', () => {
  const store = new Store(':memory:');
  try {
    const approval = pending(store); const count = store.audit().length;
    assert.throws(() => store.update<Approval>('approvals', approval.id, 1, { command: 'unexpected action' }), /Immutable/);
    assert.throws(() => store.update<Approval>('approvals', approval.id, 1, { sessionId: 'foreign-session' }), /Immutable/);
    assert.equal(store.audit().length, count);
    const result = store.update<Approval>('approvals', approval.id, 1, { state: 'approved' }, 'human');
    assert.equal(result.revision, 2);
    assert.throws(() => store.update<Approval>('approvals', approval.id, 1, { state: 'denied' }, 'human'), /Revision conflict/);
    assert.throws(() => store.update<Approval>('approvals', approval.id, 2, { state: 'pending' }), /Invalid approval transition/);
    assert.equal(store.audit().length, count + 1);
  } finally { store.close(); }
});

test('cross-project parent/session/decision references and missing identity fail closed', () => {
  const store = new Store(':memory:');
  try {
    const first = graph(store); const second = graph(store, 'Other project');
    assert.throws(() => store.create<Task>('tasks', { ...first.task, ...freshEntity('tsk'), parentTaskId: second.task.id }), /cross-project/);
    assert.throws(() => store.update<Task>('tasks', first.task.id, 1, { sessionId: second.session.id }), /session binding/);
    const approval = pending(store, first);
    assert.throws(() => store.create<Decision>('decisions', { ...decision(approval), projectId: second.project.id }), /binding mismatch/);
    assert.throws(() => store.create<Session>('sessions', { ...first.session, ...freshEntity('ses'), taskId: '' }), /Missing task/);
    assert.throws(() => store.update<Project>('projects', first.project.id, 1, { rootTaskId: second.task.id }), /root task/);
  } finally { store.close(); }
});

test('duplicate native approvals, terminal observations and decisions cannot duplicate effects', () => {
  const store = new Store(':memory:');
  try {
    const base = graph(store); const approval = pending(store, base);
    const count = store.audit().length;
    assert.throws(() => store.create<Approval>('approvals', { ...approval, ...freshEntity('apr') }), /UNIQUE/);
    assert.equal(store.audit().length, count);
    const resolution = decision(approval);
    store.create('decisions', resolution);
    assert.throws(() => store.create('decisions', { ...resolution, ...freshEntity('dec') }), /UNIQUE/);
    store.create('observations', { ...freshEntity('obs'), projectId: base.project.id, taskId: base.task.id, parentTaskId: null, sessionId: base.session.id, sourceTurnId: 'turn-one', classification: 'completion_claim', summary: 'Synthetic claim', state: 'unread', deadlineAt: null });
    assert.throws(() => store.create('observations', { ...freshEntity('obs'), projectId: base.project.id, taskId: base.task.id, parentTaskId: null, sessionId: base.session.id, sourceTurnId: 'turn-one', classification: 'progress_update', summary: 'Repeated terminal', state: 'unread', deadlineAt: null }), /UNIQUE/);
    assert.equal(store.get<Task>('tasks', base.task.id)?.state, 'ready');
    assert.equal(store.verifyAudit().valid, true);
  } finally { store.close(); }
});

test('activity source idempotency is scoped to session and event type', () => {
  const store = new Store(':memory:');
  try {
    const base = graph(store);
    const event: ActivityEvent = { ...freshEntity('evt'), projectId: base.project.id, taskId: base.task.id, sessionId: base.session.id, type: 'turn.completed', summary: 'Synthetic terminal', text: null, sourceId: 'terminal-1' };
    store.create('events', event);
    assert.throws(() => store.create('events', { ...event, ...freshEntity('evt') }), /UNIQUE/);
    store.create('events', { ...event, ...freshEntity('evt'), type: 'turn.failed' });
    assert.equal(store.list('events', base.project.id).length, 2);
  } finally { store.close(); }
});

test('outer rollback undoes nested writes and audit; inner rollback can be caught safely', () => {
  const store = new Store(':memory:');
  try {
    assert.throws(() => store.transaction(() => { graph(store); throw new Error('Synthetic abort'); }), /Synthetic abort/);
    assert.equal(store.list('projects').length, 0); assert.equal(store.audit().length, 0);
    const base = graph(store); const count = store.audit().length;
    store.transaction(() => {
      store.update<Task>('tasks', base.task.id, 1, { state: 'running' });
      assert.throws(() => store.transaction(() => { store.update<Task>('tasks', base.task.id, 2, { state: 'blocked' }); throw new Error('Inner abort'); }), /Inner abort/);
      assert.equal(store.get<Task>('tasks', base.task.id)?.state, 'running');
      store.update<Task>('tasks', base.task.id, 2, { state: 'review' });
    });
    assert.equal(store.audit().length, count + 2); assert.equal(store.verifyAudit().valid, true);
    assert.throws(() => store.transaction(() => Promise.resolve('unsafe')), /synchronous/);
  } finally { store.close(); }
});

test('audit insertion failure rolls entity/source effects back atomically', () => {
  const file = disk(); const store = new Store(file.path);
  try {
    const raw = new DatabaseSync(file.path);
    raw.exec("CREATE TRIGGER synthetic_failure BEFORE INSERT ON audit BEGIN SELECT RAISE(ABORT, 'synthetic disk failure'); END");
    assert.throws(() => graph(store), /synthetic disk failure/);
    assert.equal(store.list('projects').length, 0); assert.equal(store.audit().length, 0);
    raw.exec('DROP TRIGGER synthetic_failure'); raw.close();
    graph(store); assert.equal(store.verifyAudit().valid, true);
  } finally { store.close(); file.cleanup(); }
});

test('one-shot decision delivery cannot return to intent; lost certainty remains explicit', () => {
  const store = new Store(':memory:');
  try {
    const approval = pending(store); const resolution = store.create('decisions', decision(approval));
    store.update<Decision>('decisions', resolution.id, 1, { delivery: 'sent' });
    store.update<Decision>('decisions', resolution.id, 2, { delivery: 'uncertain' });
    assert.throws(() => store.update<Decision>('decisions', resolution.id, 3, { delivery: 'intent' }), /consumed/);
    assert.throws(() => store.update<Decision>('decisions', resolution.id, 3, { signature: 'replacement' }), /Immutable/);
    assert.equal(store.get<Decision>('decisions', resolution.id)?.verificationKey, 'synthetic-public-key');
  } finally { store.close(); }
});

test('minimal-retention approval placeholder preserves original immutable native digest', () => {
  const store = new Store(':memory:');
  try {
    const base = graph(store); const template = pending(store, base);
    const different = store.create<Approval>('approvals', { ...template, ...freshEntity('apr'), sourceEventId: 'retained-placeholder', command: '[live action omitted by minimal retention]' });
    assert.equal(different.actionDigest, template.actionDigest);
    assert.throws(() => store.update<Approval>('approvals', different.id, 1, { command: template.command }), /Immutable/);
    assert.equal(store.audit().some(event => 'command' in event), false);
  } finally { store.close(); }
});

test('audit verification detects metadata edits, missing entries and data-only tampering', () => {
  const file = disk(); const store = new Store(file.path);
  try {
    const base = graph(store); const raw = new DatabaseSync(file.path);
    raw.prepare('UPDATE audit SET actor=? WHERE sequence=1').run('altered');
    assert.equal(store.verifyAudit().valid, false);
    raw.prepare('UPDATE audit SET actor=? WHERE sequence=1').run('system');
    assert.equal(store.verifyAudit().valid, true);
    raw.exec('UPDATE audit SET sequence=-1 WHERE sequence=1; UPDATE audit SET sequence=1 WHERE sequence=2; UPDATE audit SET sequence=2 WHERE sequence=-1');
    assert.match(store.verifyAudit().errors.join(' '), /hash mismatch/);
    raw.exec('UPDATE audit SET sequence=-1 WHERE sequence=1; UPDATE audit SET sequence=1 WHERE sequence=2; UPDATE audit SET sequence=2 WHERE sequence=-1');
    assert.equal(store.verifyAudit().valid, true);
    const task = store.get<Task>('tasks', base.task.id)!;
    raw.prepare('UPDATE entities SET payload=? WHERE collection=? AND id=?').run(JSON.stringify({ ...task, objective: 'tampered' }), 'tasks', task.id);
    assert.match(store.verifyAudit().errors.join(' '), /Entity audit mismatch/);
    raw.exec('DELETE FROM audit WHERE sequence=2');
    assert.match(store.verifyAudit().errors.join(' '), /sequence missing|hash mismatch/);
    raw.close();
  } finally { store.close(); file.cleanup(); }
});

test('migration checksum tampering and future schema versions prevent opening', () => {
  const file = disk();
  try {
    new Store(file.path).close();
    const raw = new DatabaseSync(file.path);
    const checksum = raw.prepare('SELECT checksum FROM schema_migrations WHERE version=1').get()?.checksum as string;
    raw.prepare('UPDATE schema_migrations SET checksum=? WHERE version=1').run('altered');
    assert.throws(() => new Store(file.path), /checksum mismatch/);
    raw.prepare('UPDATE schema_migrations SET checksum=? WHERE version=1').run(checksum);
    raw.prepare('INSERT INTO schema_migrations VALUES(?,?,?)').run(99, 'future', new Date().toISOString());
    assert.throws(() => new Store(file.path), /Unsupported database migration/);
    raw.close();
  } finally { file.cleanup(); }
});

test('snapshots do not expose mutable store references and closing is deterministic', () => {
  const store = new Store(':memory:'); const base = graph(store);
  const task = store.get<Task>('tasks', base.task.id)!; task.objective = 'mutated caller object';
  assert.equal(store.get<Task>('tasks', base.task.id)?.objective, 'Test only');
  assert.throws(() => store.transaction(() => store.close()), /during transaction/);
  store.close(); store.close();
  assert.throws(() => store.get('projects', base.project.id), /closed/);
});

test('artifact versions are unique per project/logical key and approved content/provenance remain immutable', () => {
  const store = new Store(':memory:');
  try {
    const first = graph(store); const second = graph(store, 'Other artifact project');
    const artifact: Artifact = { ...freshEntity('art'), projectId: first.project.id, taskId: first.task.id, logicalKey: 'codebase_map', version: 1, status: 'draft', summary: 'Synthetic map', content: 'Synthetic immutable content', externalRef: null, sourceCommit: 'a'.repeat(40), expiresAt: null };
    store.create('artifacts', artifact); const before = store.audit().length;
    assert.throws(() => store.create('artifacts', { ...artifact, ...freshEntity('art') }), /UNIQUE/);
    assert.equal(store.audit().length, before);
    store.create('artifacts', { ...artifact, ...freshEntity('art'), logicalKey: 'current_roadmap' });
    store.create('artifacts', { ...artifact, ...freshEntity('art'), projectId: second.project.id, taskId: second.task.id });
    store.create('artifacts', { ...artifact, ...freshEntity('art'), version: 2 });
    const approved = store.update<Artifact>('artifacts', artifact.id, 1, { status: 'approved' });
    for (const changes of [{ version: 99 }, { logicalKey: 'other_key' }, { content: 'Replacement' }, { sourceCommit: 'b'.repeat(40) }, { expiresAt: new Date().toISOString() }]) assert.throws(() => store.update<Artifact>('artifacts', artifact.id, approved.revision, changes), /Immutable/);
    store.update<Artifact>('artifacts', artifact.id, approved.revision, { status: 'stale' });
    assert.equal(store.verifyAudit().valid, true);
  } finally { store.close(); }
});

test('artifact uniqueness migration backfills earlier version records before accepting writes', () => {
  const file = disk();
  try {
    const first = new Store(file.path); const base = graph(first);
    const artifact: Artifact = { ...freshEntity('art'), projectId: base.project.id, taskId: base.task.id, logicalKey: 'synthetic_key', version: 1, status: 'draft', summary: 'Synthetic prior schema', content: null, externalRef: null, sourceCommit: null, expiresAt: null };
    first.create('artifacts', artifact); first.close();
    const raw = new DatabaseSync(file.path);
    raw.exec("DELETE FROM source_keys WHERE collection='artifacts'; DELETE FROM schema_migrations WHERE version>=2"); raw.close();
    const migrated = new Store(file.path);
    assert.throws(() => migrated.create('artifacts', { ...artifact, ...freshEntity('art') }), /UNIQUE/);
    assert.equal(migrated.verifyAudit().valid, true); migrated.close();
  } finally { file.cleanup(); }
});

test('session compiled context and opaque connector binding are initialized once and cannot be replaced', () => {
  const store = new Store(':memory:');
  try {
    const base = graph(store);
    const inputs = [{ id: 'synthetic-artifact', logicalKey: 'current_roadmap', version: 1, sourceCommit: 'a'.repeat(40) }];
    const context = { contextDigest: `sha256:${'b'.repeat(64)}`, personaVersionId: 'persona_synthetic_v1', artifactInputs: inputs, bindingRef: 'synthetic-original-generation' };
    const initialized = store.update<Session>('sessions', base.session.id, 1, context);
    const unchanged = store.update<Session>('sessions', base.session.id, initialized.revision, { ...context, artifactInputs: inputs.map(input => ({ ...input })) });
    for (const changes of [{ contextDigest: `sha256:${'c'.repeat(64)}` }, { personaVersionId: 'persona_replacement_v2' }, { artifactInputs: [] }, { artifactInputs: [{ ...inputs[0], version: 2 }] }, { bindingRef: 'synthetic-other-generation' }, { bindingRef: null }]) assert.throws(() => store.update<Session>('sessions', base.session.id, unchanged.revision, changes), /Immutable session context/);
    assert.throws(() => store.update<Session>('sessions', base.session.id, unchanged.revision, { contextDigest: undefined }), /Unsupported canonical JSON/);
    const running = store.update<Session>('sessions', base.session.id, unchanged.revision, { state: 'running' });
    assert.deepEqual(running.artifactInputs, inputs); assert.equal(running.contextDigest, context.contextDigest);
    assert.equal(store.verifyAudit().valid, true);
  } finally { store.close(); }
});

test('missing identity, unsupported schema and cyclic/reparented task graph inputs are rejected', () => {
  const store = new Store(':memory:');
  try {
    const base = graph(store);
    assert.throws(() => store.create<Task>('tasks', { ...base.task, ...freshEntity('tsk'), id: '' }), /Invalid entity identity/);
    assert.throws(() => store.create<Task>('tasks', { ...base.task, ...freshEntity('tsk'), schemaVersion: 2 as never }), /Unsupported entity schema/);
    const self = freshEntity('tsk');
    assert.throws(() => store.create<Task>('tasks', { ...base.task, ...self, parentTaskId: self.id }), /reference|parent itself/);
    const child = store.create<Task>('tasks', { ...base.task, ...freshEntity('tsk'), parentTaskId: base.task.id, sessionId: null });
    assert.throws(() => store.update<Task>('tasks', base.task.id, base.task.revision, { parentTaskId: child.id }), /Immutable identity/);
    assert.equal(store.get<Task>('tasks', base.task.id)?.parentTaskId, null);
    const event = store.create<ActivityEvent>('events', { ...freshEntity('evt'), projectId: base.project.id, taskId: base.task.id, sessionId: base.session.id, sourceId: 'synthetic-versioned-event', type: 'synthetic.metadata', summary: 'Synthetic', text: null });
    assert.equal(event.schemaVersion, 1); assert.equal(event.sourceId, 'synthetic-versioned-event');
  } finally { store.close(); }
});

test('offline database copy restores graph and verifiable audit without claiming native callback recovery', () => {
  const original = disk(); const backup = disk();
  try {
    const store = new Store(original.path); const base = graph(store); store.close();
    new Store(backup.path).close(); copyFileSync(original.path, backup.path);
    const restored = new Store(backup.path);
    assert.equal(restored.get<Project>('projects', base.project.id)?.rootTaskId, base.task.id);
    assert.equal(restored.get<Task>('tasks', base.task.id)?.projectId, base.project.id);
    assert.equal(restored.verifyAudit().valid, true); restored.close();
  } finally { original.cleanup(); backup.cleanup(); }
});

test('reusable skill versions and rich personas persist immutable attachments without broadening live sessions', () => {
  const file = disk(); let store = new Store(file.path);
  try {
    const skill = store.create<SkillVersion>('skills', { ...freshEntity('skl'), skillId: 'synthetic_evidence', name: 'Synthetic evidence procedure', version: 1, procedure: 'Inspect approved context and report evidence', inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, requiredCapabilities: ['get_task_context','report_status'] });
    const template: Persona = { ...freshEntity('per'), name: 'Synthetic researcher', role: 'synthetic-research', mandate: 'Investigate bounded evidence', instructions: 'Report evidence', requiredArtifacts: [], skills: [skill.name], authority: 'No human authority', version: 1, authorityTemplate: { mode: 'human-only', capabilities: ['get_task_context','report_status'] }, toolScope: ['get_task_context','report_status'], dataScope: ['current-project'], escalationRules: ['Escalate blockers to operator'], expectedOutputs: ['Evidence summary'], completionContract: 'Human acceptance required', skillVersionIds: [skill.id] };
    const persona = store.create<Persona>('personas', template);
    store.create<Persona>('personas', { ...template, ...freshEntity('per'), role: 'synthetic-analyst', name: 'Synthetic analyst' });
    assert.throws(() => store.create<SkillVersion>('skills', { ...skill, ...freshEntity('skl') }), /UNIQUE/);
    assert.throws(() => store.create<Persona>('personas', { ...template, ...freshEntity('per') }), /UNIQUE/);
    assert.throws(() => store.update<SkillVersion>('skills', skill.id, 1, { procedure: 'Silently replace procedure' }), /Immutable/);
    assert.throws(() => store.update<Persona>('personas', persona.id, 1, { skillVersionIds: [] }), /Immutable/);
    assert.throws(() => store.create<Persona>('personas', { ...template, ...freshEntity('per'), version: 2, skillVersionIds: ['missing-skill'] }), /missing skill/);
    assert.throws(() => store.create<Persona>('personas', { ...template, ...freshEntity('per'), version: 2, expectedOutputs: undefined }), /Unsupported canonical/);
    const next = store.create<SkillVersion>('skills', { ...skill, ...freshEntity('skl'), version: 2, procedure: 'A new reviewed procedure version' });
    store.create<Persona>('personas', { ...template, ...freshEntity('per'), version: 2, skillVersionIds: [next.id] });
    assert.deepEqual(store.get<Persona>('personas', persona.id)?.skillVersionIds, [skill.id]);
    store.close(); store = new Store(file.path);
    assert.equal(store.list('skills').length, 2); assert.deepEqual(store.get<Persona>('personas', persona.id)?.skillVersionIds, [skill.id]); assert.equal(store.verifyAudit().valid, true);
  } finally { store.close(); file.cleanup(); }
});

test('observation terminal status is additive, immutable and does not rewrite legacy audit records', () => {
  const file = disk(); let store = new Store(file.path);
  try {
    const base = graph(store);
    const legacy = store.create<Observation>('observations', { ...freshEntity('obs'), projectId: base.project.id, taskId: base.task.id, parentTaskId: null, sessionId: base.session.id, sourceTurnId: 'legacy-turn', classification: 'ambiguous', summary: 'Synthetic legacy', state: 'unread', deadlineAt: null });
    const modern = store.create<Observation>('observations', { ...legacy, ...freshEntity('obs'), sourceTurnId: 'failed-turn', terminalStatus: 'failed', classification: 'blocker' });
    const oldHash = store.audit().find(entry => entry.entityId === legacy.id)!.hash;
    assert.throws(() => store.update<Observation>('observations', modern.id, 1, { terminalStatus: 'completed' }), /Immutable/);
    store.close(); store = new Store(file.path);
    assert.equal(store.get<Observation>('observations', legacy.id)?.terminalStatus, undefined);
    assert.equal(store.get<Observation>('observations', modern.id)?.terminalStatus, 'failed');
    assert.equal(store.audit().find(entry => entry.entityId === legacy.id)!.hash, oldHash); assert.equal(store.verifyAudit().valid, true);
  } finally { store.close(); file.cleanup(); }
});

test('artifact task-read scope must reference same-project tasks and cannot be rewritten', () => {
  const store = new Store(':memory:');
  try {
    const first = graph(store); const second = graph(store, 'Other project');
    const artifact: Artifact = { ...freshEntity('art'), projectId: first.project.id, taskId: first.task.id, logicalKey: 'synthetic_scoped', version: 1, status: 'draft', summary: 'Synthetic', content: null, externalRef: null, sourceCommit: null, expiresAt: null, readableByTaskIds: [first.task.id] };
    store.create('artifacts', artifact);
    assert.throws(() => store.create('artifacts', { ...artifact, ...freshEntity('art'), version: 2, readableByTaskIds: [second.task.id] }), /cross-project/);
    assert.throws(() => store.update<Artifact>('artifacts', artifact.id, 1, { readableByTaskIds: [] }), /Immutable/);
  } finally { store.close(); }
});

function connection(): ProfileConnection {
  return { ...freshEntity('con'), provider: 'gh-cli', credentialProvider: 'gh-cli', login: 'synthetic-login', accountId: 100, state: 'connected', capabilities: { read: true, repositoryCreate: true, issueCreate: true, administration: false, release: false }, owners: [{ login: 'synthetic-login', id: 100 }] };
}
test('profile connections preserve account/provider identity while human settings may narrow capabilities', () => {
  const store = new Store(':memory:');
  try {
    const profile = store.create('connections', connection());
    assert.throws(() => store.create('connections', { ...connection(), rawCredential: 'synthetic-never-store' } as ProfileConnection), /Unsupported GitHub connection metadata/);
    assert.throws(() => store.update<ProfileConnection>('connections', profile.id, 1, { login: 'other-user' }), /Immutable/);
    assert.throws(() => store.update<ProfileConnection>('connections', profile.id, 1, { accountId: 999 }), /Immutable/);
    assert.throws(() => store.update<ProfileConnection>('connections', profile.id, 1, { credentialProvider: 'plaintext' as never }), /Immutable/);
    const changed = store.update<ProfileConnection>('connections', profile.id, 1, { state: 'disconnected', capabilities: { ...profile.capabilities, repositoryCreate: false } }, 'human');
    assert.equal(changed.accountId, 100); assert.equal(changed.capabilities.repositoryCreate, false); assert.equal(store.verifyAudit().valid, true);
  } finally { store.close(); }
});

test('GitHub proposals preserve exact scope/action and consume dispatch once with explicit reconciliation', () => {
  const store = new Store(':memory:');
  try {
    const first = graph(store); const other = graph(store, 'Other project'); const profile = store.create('connections', connection());
    store.update<Project>('projects', first.project.id, 1, { githubConnectionId: profile.id, githubRepositoryId: 123 });
    const proposal: GitHubProposal = { ...freshEntity('ghp'), projectId: first.project.id, taskId: first.task.id, connectionId: profile.id, kind: 'issue.create', payload: { repositoryId: 123, title: 'Synthetic issue' }, actionDigest: digest({ title: 'Synthetic issue' }), state: 'pending', expiresAt: new Date(Date.now() + 60_000).toISOString(), reason: null, externalUrl: null, bootId: 'synthetic-boot' };
    const pending = store.create('githubProposals', proposal);
    assert.throws(() => store.create('githubProposals', { ...proposal, ...freshEntity('ghp'), taskId: other.task.id }), /cross-project/);
    assert.throws(() => store.create('githubProposals', { ...proposal, ...freshEntity('ghp'), connectionId: 'missing' }), /connection/);
    assert.throws(() => store.update<GitHubProposal>('githubProposals', pending.id, 1, { payload: { title: 'Changed action' } }), /Immutable/);
    assert.throws(() => store.update<GitHubProposal>('githubProposals', pending.id, 1, { state: 'succeeded' }), /Invalid GitHub proposal transition/);
    const dispatched = store.update<GitHubProposal>('githubProposals', pending.id, 1, { state: 'dispatching', signature: 'synthetic-signature', verificationKey: 'synthetic-public-key', keyId: 'synthetic-key', resolver: 'human', decision: 'approve', decidedAt: new Date().toISOString(), reconciliationMarker: 'synthetic-marker' });
    assert.throws(() => store.update<GitHubProposal>('githubProposals', dispatched.id, dispatched.revision, { state: 'pending' }), /Invalid GitHub proposal/);
    assert.throws(() => store.update<GitHubProposal>('githubProposals', dispatched.id, dispatched.revision, { signature: 'replaced-signature' }), /Immutable/);
    const uncertain = store.update<GitHubProposal>('githubProposals', dispatched.id, dispatched.revision, { state: 'uncertain' });
    const reconciled = store.update<GitHubProposal>('githubProposals', uncertain.id, uncertain.revision, { state: 'succeeded', externalUrl: 'https://github.com/synthetic/project/issues/1' });
    assert.equal(reconciled.signature, 'synthetic-signature'); assert.equal(store.verifyAudit().valid, true);
  } finally { store.close(); }
});

test('registry migration backfills legacy persona identity without changing old metadata or audit bytes', () => {
  const file = disk(); let store = new Store(file.path);
  try {
    const persona: Persona = { ...freshEntity('per'), name: 'Synthetic legacy', role: 'legacy-role', mandate: 'Synthetic', instructions: 'Synthetic', requiredArtifacts: [], skills: [], authority: 'Human only', version: 1 };
    store.create('personas', persona); const oldHash = store.audit()[0].hash; store.close();
    const raw = new DatabaseSync(file.path); raw.exec("DELETE FROM source_keys WHERE collection='personas'; DELETE FROM schema_migrations WHERE version=3"); raw.close();
    store = new Store(file.path);
    assert.deepEqual(store.get<Persona>('personas', persona.id), persona);
    assert.equal(store.audit()[0].hash, oldHash); assert.equal(store.verifyAudit().valid, true);
    assert.throws(() => store.create('personas', { ...persona, ...freshEntity('per') }), /UNIQUE/);
  } finally { store.close(); file.cleanup(); }
});

test('resumed session references are immutable and cannot cross original project/task identity', () => {
  const store = new Store(':memory:');
  try {
    const own = graph(store); const foreign = graph(store, 'Foreign original session');
    const resumed = store.create<Session>('sessions', { ...own.session, ...freshEntity('ses'), bootId: 'new-synthetic-boot', resumedFrom: own.session.id });
    assert.throws(() => store.create<Session>('sessions', { ...own.session, ...freshEntity('ses'), resumedFrom: foreign.session.id }), /session binding/);
    assert.throws(() => store.update<Session>('sessions', resumed.id, 1, { resumedFrom: foreign.session.id }), /Immutable/);
    assert.equal(store.get<Session>('sessions', resumed.id)?.resumedFrom, own.session.id); assert.equal(store.verifyAudit().valid, true);
  } finally { store.close(); }
});

test('decision policy checks are immutable passed evidence and cannot record invented failed or malformed outcomes', () => {
  const store = new Store(':memory:');
  try {
    const approval = pending(store); const resolution = decision(approval);
    const checks = [{ check: 'exact_action', outcome: 'pass' as const, summary: 'Synthetic exact binding was verified', checkedAt: new Date().toISOString() }];
    const recorded = store.create<Decision>('decisions', { ...resolution, policyChecks: checks });
    assert.throws(() => store.update<Decision>('decisions', recorded.id, 1, { policyChecks: [] }), /Immutable/);
    const another = pending(store);
    assert.throws(() => store.create<Decision>('decisions', { ...decision(another), policyChecks: [{ ...checks[0], outcome: 'fail' as never }] }), /Invalid recorded policy checks/);
    assert.equal(store.get<Decision>('decisions', recorded.id)?.policyChecks?.[0].outcome, 'pass');
  } finally { store.close(); }
});
