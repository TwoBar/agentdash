import type { Artifact } from '../../../packages/domain/src/index.js';

export interface ArtifactPolicyRequest {
  projectId: string;
  taskId: string;
  logicalKey: string;
  now?: number;
  sourceCommit?: string | null;
}
export type ArtifactResolutionFailure = 'missing' | 'unapproved' | 'stale' | 'access_denied' | 'expired' | 'source_changed' | 'invalid';
export type ArtifactResolution = { ok: true; artifact: Artifact } | { ok: false; reason: ArtifactResolutionFailure };

/** Resolve only metadata already loaded by the authenticated caller; never fetch external content. */
export function resolveArtifact(artifacts: readonly Artifact[], request: ArtifactPolicyRequest): ArtifactResolution {
  if (!request.projectId || !request.taskId || !request.logicalKey || (request.now !== undefined && !Number.isFinite(request.now))) return { ok: false, reason: 'invalid' };
  const scoped = artifacts.filter(artifact => artifact.projectId === request.projectId && artifact.logicalKey === request.logicalKey);
  if (!scoped.length) return { ok: false, reason: 'missing' };
  if (scoped.some(artifact => !Number.isSafeInteger(artifact.version) || artifact.version < 1 || !['draft','approved','stale'].includes(artifact.status)) || new Set(scoped.map(artifact => artifact.version)).size !== scoped.length) return { ok: false, reason: 'invalid' };
  // A draft does not replace an approved publication. An explicit stale publication does.
  const published = scoped.filter(artifact => artifact.status !== 'draft').sort((left, right) => right.version - left.version);
  if (!published.length) return { ok: false, reason: 'unapproved' };
  const artifact = published[0];
  if (artifact.readableByTaskIds !== undefined && (!Array.isArray(artifact.readableByTaskIds) || artifact.readableByTaskIds.some(id => typeof id !== 'string' || !id) || new Set(artifact.readableByTaskIds).size !== artifact.readableByTaskIds.length)) return { ok: false, reason: 'invalid' };
  if (artifact.readableByTaskIds !== undefined && !artifact.readableByTaskIds.includes(request.taskId)) return { ok: false, reason: 'access_denied' };
  if (artifact.status === 'stale') return { ok: false, reason: 'stale' };
  if (artifact.expiresAt !== null) {
    const expiresAt = Date.parse(artifact.expiresAt);
    if (!Number.isFinite(expiresAt)) return { ok: false, reason: 'invalid' };
    if (expiresAt <= (request.now ?? Date.now())) return { ok: false, reason: 'expired' };
  }
  if (artifact.logicalKey === 'codebase_map' && (!request.sourceCommit || artifact.sourceCommit !== request.sourceCommit)) return { ok: false, reason: 'source_changed' };
  return { ok: true, artifact };
}
