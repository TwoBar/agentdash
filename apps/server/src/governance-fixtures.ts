import { actionDigest, freshEntity, type ActivityEvent, type Approval, type Project, type Session, type Task } from '../../../packages/domain/src/index.js';
import { Store } from '../../../packages/store/src/index.js';
import { Governance, type ApprovalMember } from './governance.js';

export function governanceFixture(options: { dispatch?: (sessionId: string, key: string, digest: string, decision: 'approve' | 'deny') => Promise<void>; governanceBoot?: string } = {}) {
  const store = new Store(':memory:');
  const clock = { now: Date.parse('2030-01-01T12:00:00Z'), monotonic: 1_000 };
  const calls: { sessionId: string; key: string; digest: string; decision: 'approve' | 'deny' }[] = [];
  const governance = new Governance(store, options.governanceBoot ?? 'boot-synthetic', async (sessionId, key, digest, decision) => {
    calls.push({ sessionId, key, digest, decision });
    await options.dispatch?.(sessionId, key, digest, decision);
  }, () => clock.now, () => clock.monotonic);
  function project(name = 'Synthetic project', bootId = 'boot-synthetic') {
    const rootId = freshEntity('tsk').id;
    const project = store.create<Project>('projects', { ...freshEntity('prj'), name, workspace: '/synthetic', rootTaskId: rootId, githubRepo: null });
    const task = store.create<Task>('tasks', { ...freshEntity('tsk'), id: rootId, projectId: project.id, parentTaskId: null, name: 'Synthetic task', objective: 'Test only', personaId: 'synthetic-persona', state: 'waiting_approval', sessionId: null, workspace: '/synthetic' });
    const session = store.create<Session>('sessions', { ...freshEntity('ses'), projectId: project.id, taskId: task.id, connector: 'codex', state: 'waiting_approval', bootId, error: null, bindingRef: 'opaque-synthetic' });
    return { project, task, session };
  }
  function approval(base = project(), overrides: Partial<Approval> = {}, live: { command?: string; cwd?: string; sessionId?: string } = {}) {
    const action = { kind: 'command' as const, command: 'printf synthetic', cwd: '/synthetic' };
    const event = store.create<ActivityEvent>('events', { ...freshEntity('evt'), projectId: base.project.id, taskId: base.task.id, sessionId: base.session.id, type: 'approval.requested', summary: 'Synthetic approval source', text: null, sourceId: freshEntity('native').id });
    const approval = store.create<Approval>('approvals', {
      ...freshEntity('apr'), projectId: base.project.id, taskId: base.task.id, sessionId: base.session.id,
      sourceEventId: event.id, actionDigest: actionDigest(action), summary: 'Synthetic exact command', ...action,
      target: 'synthetic target', impact: 'synthetic effect', risk: 'low', state: 'pending',
      expiresAt: new Date(clock.now + 10 * 60_000).toISOString(), policySnapshotId: 'human-only-v1', bootId: base.session.bootId, reason: null, ...overrides,
    });
    governance.addPending(approval.id, { key: `opaque-${approval.id}`, sessionId: base.session.id, command: action.command, cwd: action.cwd, ...live });
    return approval;
  }
  function member(approval: Approval): ApprovalMember { return { approvalId: approval.id, actionDigest: approval.actionDigest, expectedRevision: approval.revision }; }
  return { store, clock, calls, governance, project, approval, member, close: () => store.close() };
}
