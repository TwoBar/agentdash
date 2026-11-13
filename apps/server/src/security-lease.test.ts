import assert from 'node:assert/strict';
import test from 'node:test';
import { Capabilities } from './security.js';

test('authentication alone never slides capability expiry; only trusted lease renewal does', () => {
  let now = 1_000; const capabilities = new Capabilities('synthetic-boot', () => now); const token = capabilities.issue({ projectId: 'p', taskId: 't', sessionId: 's' });
  now += 14 * 60_000; capabilities.authenticate(`Bearer ${token}`); now += 60_000;
  assert.throws(() => capabilities.authenticate(`Bearer ${token}`)); assert.equal(capabilities.renewSession('s'), false);
  assert.equal(capabilities.renewSession('s', true), true); assert.equal(capabilities.authenticate(`Bearer ${token}`).sessionId, 's');
});

test('trusted renewal is session-scoped and stops at an absolute eight-hour lifetime', () => {
  let now = 1_000; const started = now; const capabilities = new Capabilities('synthetic-boot', () => now);
  const first = capabilities.issue({ projectId: 'p', taskId: 't', sessionId: 's' }); const other = capabilities.issue({ projectId: 'other', taskId: 'other', sessionId: 'other' });
  now += 14 * 60_000; assert.equal(capabilities.renewSession('s'), true); now += 2 * 60_000;
  assert.doesNotThrow(() => capabilities.authenticate(`Bearer ${first}`)); assert.throws(() => capabilities.authenticate(`Bearer ${other}`));
  now = started + 8 * 60 * 60_000 - 1; assert.equal(capabilities.renewSession('s', true), true); capabilities.authenticate(`Bearer ${first}`);
  now += 1; assert.equal(capabilities.renewSession('s', true), false); assert.throws(() => capabilities.authenticate(`Bearer ${first}`));
});

test('revoked, absent and former-boot capabilities cannot be resurrected by trusted renewal', () => {
  const capabilities = new Capabilities('synthetic-boot'); const token = capabilities.issue({ projectId: 'p', taskId: 't', sessionId: 's' }); capabilities.revokeSession('s');
  assert.equal(capabilities.renewSession('s', true), false); assert.equal(capabilities.renewSession('missing', true), false); assert.throws(() => capabilities.authenticate(`Bearer ${token}`));
  const restarted = new Capabilities('another-boot'); assert.equal(restarted.renewSession('s', true), false); assert.throws(() => restarted.authenticate(`Bearer ${token}`));
});

test('wall-clock rollback cannot extend idle or absolute capability deadlines', () => {
  let wall = 1_000_000; let monotonic = 1_000;
  const capabilities = new Capabilities('synthetic-boot', () => wall, () => monotonic);
  const token = capabilities.issue({ projectId: 'p', taskId: 't', sessionId: 's' });
  monotonic += 15 * 60_000; wall -= 60_000;
  assert.throws(() => capabilities.authenticate(`Bearer ${token}`)); assert.equal(capabilities.renewSession('s'), false);
  assert.equal(capabilities.renewSession('s', true), true); assert.doesNotThrow(() => capabilities.authenticate(`Bearer ${token}`));
  monotonic = 1_000 + 8 * 60 * 60_000; wall -= 60_000;
  assert.equal(capabilities.renewSession('s', true), false); assert.throws(() => capabilities.authenticate(`Bearer ${token}`));
});
