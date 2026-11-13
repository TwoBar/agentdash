import { z } from 'zod';
import { canonicalize, type Artifact, type ArtifactInput, type Session, type Task } from '../../../packages/domain/src/index.js';
import { Store } from '../../../packages/store/src/index.js';
import { resolveArtifact } from './artifact-policy.js';
import { requireCondition, type CapabilityPrincipal } from './security.js';

const issue = z.object({
  title: z.string().trim().min(1).max(256),
  body: z.string().max(29_000),
  labels: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
}).strict();
export type PlannedIssue = z.infer<typeof issue>;
export function parseIssuePlan(content: string | null): PlannedIssue[] {
  let value: unknown;
  try { value = JSON.parse(content ?? ''); } catch { /* Return a fixed message, never submitted content. */ }
  const parsed = z.array(issue).min(1).max(50).safeParse(value);
  requireCondition(parsed.success, 'issue_plan_invalid', 'Issue proposals must be a JSON list of one to fifty {title, body, labels?} objects.', 409);
  return parsed.data;
}
export function artifactInput(artifact: Artifact): ArtifactInput {
  return { id: artifact.id, logicalKey: artifact.logicalKey, version: artifact.version, sourceCommit: artifact.sourceCommit };
}
export function issueInputs(store: Store, projectId: string, taskId: string, commit: string | null, now = Date.now()): Artifact[] {
  return ['current_roadmap', 'codebase_map'].map(logicalKey => {
    const resolution = resolveArtifact(store.list<Artifact>('artifacts', projectId), { projectId, taskId, logicalKey, sourceCommit: commit, now });
    requireCondition(resolution.ok, 'context_blocked', `Issue planning requires readable, approved, current ${logicalKey}.`, 409);
    return resolution.artifact;
  });
}
export function validateIssuePlan(store: Store, projectId: string, artifactId: string, commit: string | null, now = Date.now()): { artifact: Artifact; issues: PlannedIssue[]; inputs: Artifact[] } {
  const artifact = store.get<Artifact>('artifacts', artifactId);
  requireCondition(artifact && artifact.projectId === projectId && artifact.logicalKey === 'issue_proposals', 'issue_plan_unavailable', 'This issue planning artifact is unavailable in the selected project.', 404);
  const sourceSession = artifact.sourceSessionId ? store.get<Session>('sessions', artifact.sourceSessionId) : undefined;
  requireCondition(sourceSession?.projectId === projectId && sourceSession.taskId === artifact.taskId, 'issue_plan_unavailable', 'The issue planning artifact lacks its original session provenance.', 409);
  const resolution = resolveArtifact(store.list<Artifact>('artifacts', projectId), { projectId, taskId: artifact.taskId, logicalKey: 'issue_proposals', sourceCommit: commit, now });
  requireCondition(resolution.ok && resolution.artifact.id === artifact.id && artifact.sourceCommit === commit, 'issue_plan_unavailable', 'The selected issue planning artifact must be approved, readable and current for its planning task and source commit.', 409);
  const inputs = issueInputs(store, projectId, artifact.taskId, commit, now);
  requireCondition(artifact.inputArtifacts?.length === 2 && canonicalize(artifact.inputArtifacts) === canonicalize(inputs.map(artifactInput)), 'context_changed', 'The exact issue-planning inputs changed. Resolve current inputs and publish a new plan.', 409);
  return { artifact, issues: parseIssuePlan(artifact.content), inputs };
}

/** Receipts are service-owned metadata, scoped to one live identity and never reconstructed from claims/history. */
export class IssuePlanning {
  private reads = new Map<string, Map<string, ArtifactInput>>();
  constructor(readonly store: Store, readonly now: () => number = Date.now) {}
  private session(principal: CapabilityPrincipal): void {
    const session = this.store.get<Session>('sessions', principal.sessionId);
    const task = this.store.get<Task>('tasks', principal.taskId);
    requireCondition(session && task && task.projectId === principal.projectId && task.sessionId === session.id && session.projectId === principal.projectId && session.taskId === task.id && session.bootId === principal.bootId && !['disconnected', 'terminated', 'failed'].includes(session.state), 'issue_session_unavailable', 'Issue-planning reads belong to the original live registered session.', 409);
  }
  recordRead(principal: CapabilityPrincipal, artifact: Artifact): void {
    this.session(principal);
    requireCondition(artifact.projectId === principal.projectId, 'issue_read_scope', 'The resolved artifact belongs to another project.', 403);
    if (!['current_roadmap', 'codebase_map'].includes(artifact.logicalKey)) return;
    const receipt = this.reads.get(principal.sessionId) ?? new Map<string, ArtifactInput>();
    receipt.set(artifact.logicalKey, artifactInput(artifact)); this.reads.set(principal.sessionId, receipt);
  }
  draft(principal: CapabilityPrincipal, commit: string | null, content: string | null): { content: string; inputArtifacts: ArtifactInput[] } {
    this.session(principal);
    const inputs = issueInputs(this.store, principal.projectId, principal.taskId, commit, this.now()).map(artifactInput);
    const receipts = this.reads.get(principal.sessionId);
    requireCondition(inputs.every(input => receipts?.has(input.logicalKey) && canonicalize(receipts.get(input.logicalKey)) === canonicalize(input)), 'issue_inputs_unread', 'Resolve current_roadmap and codebase_map through resolve_artifact in this session before publishing issue proposals.', 409);
    return { content: canonicalize(parseIssuePlan(content)), inputArtifacts: inputs };
  }
  forgetSession(sessionId: string): void { this.reads.delete(sessionId); }
}
