import assert from 'node:assert/strict';
import test from 'node:test';
import { freshEntity, type Artifact } from '../../../packages/domain/src/index.js';
import { resolveArtifact, type ArtifactPolicyRequest, type ArtifactResolutionFailure } from './artifact-policy.js';

const request: ArtifactPolicyRequest = { projectId: 'project-one', taskId: 'task-one', logicalKey: 'codebase_map', now: Date.parse('2030-01-01T00:00:00Z'), sourceCommit: 'a'.repeat(40) };
function artifact(overrides: Partial<Artifact> = {}): Artifact {
  return { ...freshEntity('art'), projectId: 'project-one', taskId: 'author-task', logicalKey: 'codebase_map', version: 1, status: 'approved', summary: 'Synthetic map', content: null, externalRef: null, sourceCommit: 'a'.repeat(40), expiresAt: null, ...overrides };
}
function fail(artifacts: Artifact[], reason: ArtifactResolutionFailure, input = request) { assert.deepEqual(resolveArtifact(artifacts, input), { ok: false, reason }); }

test('approved readable current version resolves without mutation or external network access', () => {
  const content = artifact(); const before = JSON.stringify(content);
  const result = resolveArtifact([content], request);
  assert.deepEqual(result, { ok: true, artifact: content }); assert.equal(JSON.stringify(content), before);
  const external = artifact({ logicalKey: 'current_roadmap', externalRef: 'https://github.com/synthetic/project/issues/12', sourceCommit: null, content: null });
  assert.deepEqual(resolveArtifact([external], { ...request, logicalKey: 'current_roadmap' }), { ok: true, artifact: external });
});

test('missing, draft-only and foreign project records produce explicit safe outcomes', () => {
  fail([], 'missing'); fail([artifact({ status: 'draft' })], 'unapproved');
  fail([artifact({ projectId: 'other-project' })], 'missing');
  fail([artifact({ logicalKey: 'other_key' })], 'missing');
});

test('new publication supersedes older versions; a draft waits, an explicit stale version blocks fallback', () => {
  const original = artifact(); const newer = artifact({ version: 2, status: 'draft' });
  assert.deepEqual(resolveArtifact([original, newer], request), { ok: true, artifact: original });
  const approved = { ...newer, status: 'approved' as const };
  assert.deepEqual(resolveArtifact([original, approved], request), { ok: true, artifact: approved });
  fail([original, { ...approved, status: 'stale' }], 'stale');
});

test('task scope, access revocation and expiry cannot fall back to an older approved publication', () => {
  const original = artifact();
  fail([original, artifact({ version: 2, readableByTaskIds: [] })], 'access_denied');
  fail([original, artifact({ version: 2, readableByTaskIds: ['other-task'] })], 'access_denied');
  const scoped = artifact({ readableByTaskIds: [request.taskId] }); assert.equal(resolveArtifact([scoped], request).ok, true);
  fail([original, artifact({ version: 2, expiresAt: new Date(request.now!).toISOString() })], 'expired');
});

test('codebase map needs the caller worktree source commit, including against newer wrong-branch publications', () => {
  fail([artifact()], 'source_changed', { ...request, sourceCommit: null });
  fail([artifact()], 'source_changed', { ...request, sourceCommit: 'b'.repeat(40) });
  fail([artifact(), artifact({ version: 2, sourceCommit: 'b'.repeat(40) })], 'source_changed');
});

test('malformed policy metadata, duplicate versions and invalid clock fail closed', () => {
  fail([artifact({ expiresAt: 'invalid-date' })], 'invalid');
  fail([artifact({ readableByTaskIds: ['task-one', 'task-one'] })], 'invalid');
  fail([artifact(), artifact()], 'invalid');
  fail([artifact()], 'invalid', { ...request, now: NaN });
});
