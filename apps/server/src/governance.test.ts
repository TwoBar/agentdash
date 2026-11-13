import assert from 'node:assert/strict';
import { createPublicKey, verify } from 'node:crypto';
import test from 'node:test';
import { type Approval, type Decision, type Session } from '../../../packages/domain/src/index.js';
import { Governance } from './governance.js';
import { governanceFixture } from './governance-fixtures.js';

test('one human decision binds the exact original session/action and preserves signed history', async () => {
  const f = governanceFixture();
  try {
    const approval = f.approval(); const outcomes = await f.governance.resolve(approval.projectId, [f.member(approval)], 'approve');
    assert.equal(outcomes[0].ok, true); assert.equal(outcomes[0].state, 'approved');
    assert.deepEqual(f.calls, [{ sessionId: approval.sessionId, key: `opaque-${approval.id}`, digest: approval.actionDigest, decision: 'approve' }]);
    const decision = f.store.list<Decision>('decisions')[0];
    assert.equal(decision.delivery, 'sent'); assert.equal(decision.resolver, 'human');
    assert.equal(f.governance.verifyDecision(decision), true);
    assert.equal(verify(null, Buffer.from(f.governance.verificationBytes(decision)), createPublicKey({ key: Buffer.from(decision.verificationKey!, 'base64'), type: 'spki', format: 'der' }), Buffer.from(decision.signature, 'base64')), true);
    const newBoot = new Governance(f.store, 'another-boot', async () => {});
    assert.equal(newBoot.verifyDecision(decision), false);
    assert.equal(f.store.verifyAudit().valid, true);
  } finally { f.close(); }
});

test('cross-project resolution, wrong digest and stale revision never dispatch or consume authority', async () => {
  const f = governanceFixture();
  try {
    const approval = f.approval(); const other = f.project('Other project');
    for (const [projectId, member] of [[other.project.id, f.member(approval)], [approval.projectId, { ...f.member(approval), actionDigest: `sha256:${'0'.repeat(64)}` }], [approval.projectId, { ...f.member(approval), expectedRevision: 99 }]] as const) {
      const outcomes = await f.governance.resolve(projectId, [member], 'approve');
      assert.equal(outcomes[0].ok, false);
      assert.equal(f.calls.length, 0); assert.equal(f.store.list('decisions').length, 0);
      assert.equal(f.store.get<Approval>('approvals', approval.id)?.state, 'pending');
    }
    assert.equal((await f.governance.resolve(approval.projectId, [f.member(approval)], 'deny'))[0].ok, true);
    assert.equal(f.calls[0].decision, 'deny');
  } finally { f.close(); }
});

test('wrong process boot, missing native ownership and disconnected session fail closed', async () => {
  const stale = governanceFixture({ governanceBoot: 'new-boot' });
  try { const approval = stale.approval(); assert.equal((await stale.governance.resolve(approval.projectId, [stale.member(approval)], 'approve'))[0].ok, false); assert.equal(stale.calls.length, 0); }
  finally { stale.close(); }
  const f = governanceFixture();
  try {
    const approval = f.approval(); const original = f.governance.pending.get(approval.id)!;
    f.governance.pending.delete(approval.id);
    assert.equal((await f.governance.resolve(approval.projectId, [f.member(approval)], 'approve'))[0].ok, false);
    f.governance.pending.set(approval.id, { ...original, sessionId: 'another-session' });
    assert.equal((await f.governance.resolve(approval.projectId, [f.member(approval)], 'approve'))[0].ok, false);
    f.governance.pending.set(approval.id, original);
    f.store.update<Session>('sessions', approval.sessionId, 1, { state: 'disconnected' });
    assert.equal((await f.governance.resolve(approval.projectId, [f.member(approval)], 'approve'))[0].ok, false);
    assert.equal(f.calls.length, 0); assert.equal(f.store.list('decisions').length, 0);
  } finally { f.close(); }
});

test('live command/cwd mismatch and changed policy cannot acquire a signed decision', async () => {
  const f = governanceFixture();
  try {
    for (const live of [{ command: 'unexpected command' }, { cwd: '/other-workspace' }]) {
      const approval = f.approval(undefined, {}, live);
      assert.equal((await f.governance.resolve(approval.projectId, [f.member(approval)], 'approve'))[0].ok, false);
    }
    const changedPolicy = f.approval(undefined, { policySnapshotId: 'different-policy' });
    assert.equal((await f.governance.resolve(changedPolicy.projectId, [f.member(changedPolicy)], 'approve'))[0].ok, false);
    assert.equal(f.calls.length, 0); assert.equal(f.store.list('decisions').length, 0);
  } finally { f.close(); }
});

test('signature tampering or a changed signed binding is rejected while delivery metadata may evolve', async () => {
  const f = governanceFixture();
  try {
    const approval = f.approval(); await f.governance.resolve(approval.projectId, [f.member(approval)], 'deny');
    const signed = f.store.list<Decision>('decisions')[0];
    const signature = Buffer.from(signed.signature, 'base64'); signature[0] ^= 1;
    for (const mutation of [{ signature: signature.toString('base64') }, { actionDigest: `sha256:${'0'.repeat(64)}` }, { sessionId: 'another-session' }, { approvalId: 'another-approval' }, { projectId: 'another-project' }, { decision: 'approve' as const }, { policySnapshotId: 'different-policy' }, { bootId: 'old-boot' }, { keyId: 'another-key' }, { expiresAt: new Date(f.clock.now + 60_000).toISOString() }]) assert.equal(f.governance.verifyDecision({ ...signed, ...mutation }), false);
    assert.equal(f.governance.verifyDecision({ ...signed, delivery: 'uncertain', revision: 999, updatedAt: '2035-01-01T00:00:00Z' }), true);
  } finally { f.close(); }
});

test('wall expiry and elapsed monotonic deadline reject approval even after wall clock rollback', async () => {
  for (const mode of ['wall', 'monotonic-with-wall-rollback'] as const) {
    const f = governanceFixture();
    try {
      const approval = f.approval();
      if (mode === 'wall') f.clock.now += 10 * 60_000;
      else { f.clock.now -= 60 * 60_000; f.clock.monotonic += 10 * 60_000; }
      assert.equal((await f.governance.resolve(approval.projectId, [f.member(approval)], 'approve'))[0].ok, false);
      assert.equal(f.calls.length, 0); assert.equal(f.store.list('decisions').length, 0);
    } finally { f.close(); }
  }
});

test('replay and concurrent approve/deny cannot create a second native delivery', async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const f = governanceFixture({ dispatch: async () => gate });
  try {
    const approval = f.approval(); const first = f.governance.resolve(approval.projectId, [f.member(approval)], 'approve');
    assert.equal(f.calls.length, 1);
    const raced = await f.governance.resolve(approval.projectId, [f.member(approval)], 'deny');
    assert.equal(raced[0].ok, false); assert.equal(f.store.list('decisions').length, 1);
    release(); assert.equal((await first)[0].ok, true);
    assert.equal((await f.governance.resolve(approval.projectId, [f.member(approval)], 'approve'))[0].ok, false);
    assert.equal(f.calls.length, 1);
  } finally { release(); f.close(); }
});

test('partial group reports each outcome and ignores new arrivals after the frozen snapshot', async () => {
  let arrival: Approval | undefined;
  let f!: ReturnType<typeof governanceFixture>;
  f = governanceFixture({ dispatch: async () => { arrival = f.approval(base); } });
  const base = f.project();
  try {
    const valid = f.approval(base); const expired = f.approval(base, { expiresAt: new Date(f.clock.now - 1).toISOString() });
    const selected = [f.member(valid), f.member(expired)];
    const outcomes = await f.governance.resolve(base.project.id, selected, 'approve');
    assert.deepEqual(outcomes.map(outcome => ({ id: outcome.approvalId, ok: outcome.ok })), [{ id: valid.id, ok: true }, { id: expired.id, ok: false }]);
    assert.equal(f.calls.length, 1); assert.equal(f.store.list('decisions').length, 1);
    assert.ok(arrival); assert.equal(f.store.get<Approval>('approvals', arrival.id)?.state, 'pending');
    assert.equal(f.governance.pending.has(arrival.id), true);
  } finally { f.close(); }
});

test('empty, duplicate and overlarge groups reject before any approval is delivered', async () => {
  const f = governanceFixture();
  try {
    const approval = f.approval();
    await assert.rejects(f.governance.resolve(approval.projectId, [], 'approve'), /between one and fifty/);
    await assert.rejects(f.governance.resolve(approval.projectId, [f.member(approval), f.member(approval)], 'approve'), /only once/);
    await assert.rejects(f.governance.resolve(approval.projectId, Array.from({ length: 51 }, () => f.member(approval)), 'approve'), /between one and fifty/);
    assert.equal(f.calls.length, 0); assert.equal(f.store.list('decisions').length, 0);
  } finally { f.close(); }
});

test('uncertain dispatch consumes authority and cannot be replayed after process reconnection', async () => {
  const f = governanceFixture({ dispatch: async () => { throw new Error('Synthetic pipe closed after write'); } });
  try {
    const approval = f.approval();
    assert.equal((await f.governance.resolve(approval.projectId, [f.member(approval)], 'approve'))[0].ok, false);
    assert.equal(f.store.get<Approval>('approvals', approval.id)?.state, 'uncertain');
    assert.equal(f.store.list<Decision>('decisions')[0].delivery, 'uncertain');
    assert.equal(f.governance.pending.has(approval.id), false);
    assert.equal((await f.governance.resolve(approval.projectId, [f.member(approval)], 'approve'))[0].ok, false);
    assert.equal(f.calls.length, 1); assert.equal(f.store.list('decisions').length, 1);
    const restarted = new Governance(f.store, 'new-boot', async () => { throw new Error('Must not dispatch'); });
    assert.equal((await restarted.resolve(approval.projectId, [f.member(approval)], 'approve'))[0].ok, false);
  } finally { f.close(); }
});

test('disconnect and deadline sweeping invalidate pending actions and expiry sends only one native deny', async () => {
  const f = governanceFixture();
  try {
    const disconnected = f.approval(); f.governance.invalidateSession(disconnected.sessionId);
    assert.equal(f.store.get<Approval>('approvals', disconnected.id)?.state, 'disconnected');
    assert.equal((await f.governance.resolve(disconnected.projectId, [f.member(disconnected)], 'approve'))[0].ok, false);
    const expired = f.approval(); f.clock.monotonic += 10 * 60_000;
    await f.governance.expire(); await f.governance.expire();
    assert.equal(f.store.get<Approval>('approvals', expired.id)?.state, 'expired');
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].decision, 'deny');
    assert.equal(f.store.list('decisions').length, 0);
    assert.equal(f.store.verifyAudit().valid, true);
  } finally { f.close(); }
});
