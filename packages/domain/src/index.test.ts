import assert from 'node:assert/strict';
import test from 'node:test';
import { actionDigest, assertApprovalTransition, assertSessionTransition, assertTaskTransition, canonicalize, freshEntity } from './index.js';

test('canonical JSON sorts nested properties while preserving arrays and exact strings', () => {
  assert.equal(canonicalize({ z: [3, { b: 1, a: 'line\ntext' }], a: -0 }), '{"a":0,"z":[3,{"a":"line\\ntext","b":1}]}');
  assert.equal(canonicalize({ b: { d: 2, a: 1 }, a: 'x' }), canonicalize({ a: 'x', b: { a: 1, d: 2 } }));
  assert.equal(canonicalize('😀'), '"😀"');
});

test('canonical JSON rejects silently lossy, non-JSON and malformed Unicode inputs', () => {
  for (const value of [NaN, Infinity, undefined, BigInt(1), Symbol('x'), () => 1, { a: undefined }, new Date(), new Array(2), '\ud800', '\udc00', { ['\ud800']: 1 }]) assert.throws(() => canonicalize(value));
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  assert.throws(() => canonicalize(cyclic), /cycles/);
  assert.throws(() => canonicalize({ get secret() { throw new Error('Must not run getter'); } }), /accessors/);
  assert.throws(() => canonicalize({ [Symbol('hidden')]: 1 }), /symbol/);
  const shared = { x: 1 };
  assert.equal(canonicalize([shared, shared]), '[{"x":1},{"x":1}]');
});

test('action digest binds exact command bytes and cwd without lossy normalization', () => {
  const action = { kind: 'command' as const, command: 'printf synthetic', cwd: '/scratch/a' };
  assert.match(actionDigest(action), /^sha256:[0-9a-f]{64}$/);
  assert.equal(actionDigest(action), actionDigest({ cwd: action.cwd, command: action.command, kind: 'command' }));
  assert.notEqual(actionDigest(action), actionDigest({ ...action, command: `${action.command} ` }));
  assert.notEqual(actionDigest(action), actionDigest({ ...action, cwd: '/scratch/b' }));
});

test('task acceptance is distinct from turn completion and terminal states stay terminal', () => {
  assertTaskTransition('running', 'review');
  assertTaskTransition('review', 'completed');
  assertTaskTransition('review', 'running');
  assert.throws(() => assertTaskTransition('running', 'completed'), /Invalid task transition/);
  assert.throws(() => assertTaskTransition('completed', 'running'), /Invalid task transition/);
});

test('disconnected sessions and consumed approvals cannot silently resume or replay', () => {
  assertSessionTransition('waiting_approval', 'disconnected');
  assert.throws(() => assertSessionTransition('disconnected', 'running'));
  assertApprovalTransition('pending', 'approved');
  assertApprovalTransition('approved', 'uncertain');
  for (const state of ['approved', 'denied', 'expired', 'disconnected', 'unavailable', 'uncertain'] as const) assert.throws(() => assertApprovalTransition(state, 'pending'));
  assert.throws(() => assertApprovalTransition('denied', 'approved'));
});

test('fresh entity IDs are unique and server timestamps/revisions are initialized', () => {
  const first = freshEntity('tsk'); const second = freshEntity('tsk');
  assert.notEqual(first.id, second.id);
  assert.equal(first.revision, 1);
  assert.equal(first.schemaVersion, 1);
  assert.equal(first.createdAt, first.updatedAt);
  assert.throws(() => freshEntity('../unsafe'));
});
