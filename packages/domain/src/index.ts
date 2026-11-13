import { createHash, randomUUID } from 'node:crypto';

export interface BaseEntity {
  id: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  schemaVersion?: 1;
}

export type TaskState = 'requested' | 'ready' | 'running' | 'waiting_approval' | 'blocked' | 'review' | 'completed' | 'failed' | 'cancelled';
export type SessionState = 'starting' | 'idle' | 'running' | 'waiting_approval' | 'disconnected' | 'failed' | 'terminated';
export type ApprovalState = 'pending' | 'approved' | 'denied' | 'expired' | 'disconnected' | 'unavailable' | 'uncertain';
export type Classification = 'awaiting_input' | 'decision_proposal' | 'blocker' | 'completion_claim' | 'progress_update' | 'ambiguous';
export type ObservationClassification = Classification;
export type ApprovalDecision = 'approve' | 'deny';

export interface Project extends BaseEntity { name: string; workspace: string; rootTaskId: string; githubRepo: string | null }
export interface Task extends BaseEntity {
  projectId: string; parentTaskId: string | null; name: string; objective: string; personaId: string;
  state: TaskState; sessionId: string | null; workspace: string | null;
  authorityGrantId?: string | null;
}
export interface Session extends BaseEntity {
  projectId: string; taskId: string; connector: 'codex'; state: SessionState; bootId: string;
  error: string | null; bindingRef?: string | null;
  contextDigest?: string; personaVersionId?: string;
  artifactInputs?: Array<{ id: string; logicalKey: string; version: number; sourceCommit: string | null }>;
}
export interface Approval extends BaseEntity {
  projectId: string; taskId: string; sessionId: string; sourceEventId: string; actionDigest: string;
  summary: string; kind: 'command'; command: string; cwd: string; target: string; impact: string;
  risk: 'low' | 'medium' | 'high'; state: ApprovalState; expiresAt: string; policySnapshotId: string;
  bootId: string; reason: string | null;
}
export interface Decision extends BaseEntity {
  projectId: string; approvalId: string; sessionId: string; actionDigest: string;
  decision: ApprovalDecision; resolver: 'human'; policySnapshotId: string; bootId: string;
  issuedAt: string; expiresAt: string; keyId: string; signature: string; verificationKey?: string;
  delivery: 'intent' | 'sent' | 'uncertain' | 'rejected';
}
export interface ActivityEvent extends BaseEntity {
  projectId: string; taskId: string; sessionId: string | null; type: string; summary: string;
  text: string | null; sourceId: string | null;
}
export interface Artifact extends BaseEntity {
  projectId: string; taskId: string; logicalKey: string; version: number;
  status: 'draft' | 'approved' | 'stale'; summary: string; content: string | null;
  externalRef: string | null; sourceCommit: string | null; expiresAt: string | null;
}
export interface Observation extends BaseEntity {
  projectId: string; taskId: string; parentTaskId: string | null; sessionId: string;
  sourceTurnId: string; classification: Classification; summary: string;
  state: 'unread' | 'read' | 'replied'; deadlineAt: string | null;
}
export interface Persona extends BaseEntity {
  name: string; role: string; mandate: string; instructions: string; requiredArtifacts: string[];
  skills: string[]; authority: string; version: number;
}

// Reserved neutral contracts do not confer delegated authority in the MVP.
export interface SkillVersion extends BaseEntity {
  name: string; version: number; procedure: string; requiredCapabilities: string[];
  inputSchema: Record<string, unknown>; outputSchema: Record<string, unknown>;
}
export interface AuthorityGrant extends BaseEntity {
  projectId: string; issuer: string; granteeTaskId: string; capabilities: string[];
  targets: string[]; limits: Record<string, unknown>; expiresAt: string; delegationDepth: number;
}
export interface AgentMessage extends BaseEntity {
  projectId: string; sourceTaskId: string; destinationTaskId: string; sourceTurnId: string;
  kind: 'approval_review' | 'question' | 'blocker' | 'reply' | 'status';
  summary: string; payload: Record<string, unknown>; state: 'unread' | 'read' | 'replied'; deadlineAt: string | null;
}

export interface CollectionEntityMap {
  projects: Project; tasks: Task; sessions: Session; approvals: Approval; decisions: Decision;
  events: ActivityEvent; artifacts: Artifact; observations: Observation; personas: Persona;
}
export type Collection = keyof CollectionEntityMap;
export type Entity = CollectionEntityMap[Collection];
export const collections: readonly Collection[] = ['projects', 'tasks', 'sessions', 'approvals', 'decisions', 'events', 'artifacts', 'observations', 'personas'];

export interface AuditEntry {
  id: string; sequence: number; collection: Collection; entityId: string; projectId: string | null;
  operation: 'create' | 'update'; revision: number; actor: string; timestamp: string;
  payloadDigest: string; previousHash: string; hash: string;
}

export function freshEntity(prefix: string): BaseEntity {
  if (!/^[a-z][a-z0-9_]*$/i.test(prefix)) throw new Error('Invalid entity ID prefix');
  const now = new Date().toISOString();
  return { id: `${prefix}_${randomUUID()}`, revision: 1, createdAt: now, updatedAt: now, schemaVersion: 1 };
}

function validUnicode(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

/** Strict, recursively sorted JSON bytes. Reject values JSON.stringify would silently lose. */
export function canonicalize(value: unknown): string {
  const ancestors = new Set<object>();
  function encode(item: unknown): string {
    if (item === null) return 'null';
    if (typeof item === 'string') {
      if (!validUnicode(item)) throw new Error('Canonical JSON requires valid Unicode');
      return JSON.stringify(item);
    }
    if (typeof item === 'boolean') return item ? 'true' : 'false';
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new Error('Canonical JSON requires finite numbers');
      return JSON.stringify(item);
    }
    if (typeof item !== 'object') throw new Error(`Unsupported canonical JSON value: ${typeof item}`);
    if (ancestors.has(item)) throw new Error('Canonical JSON cannot contain cycles');
    ancestors.add(item);
    try {
      if (Object.getOwnPropertySymbols(item).length) throw new Error('Canonical JSON cannot contain symbol keys');
      if (Array.isArray(item)) {
        const values: string[] = [];
        for (let i = 0; i < item.length; i++) {
          if (!Object.hasOwn(item, i)) throw new Error('Canonical JSON cannot contain array holes');
          values.push(encode(item[i]));
        }
        return `[${values.join(',')}]`;
      }
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) throw new Error('Canonical JSON requires plain objects');
      const record = item as Record<string, unknown>;
      return `{${Object.keys(record).sort().map(key => {
        const descriptor = Object.getOwnPropertyDescriptor(record, key)!;
        if (!('value' in descriptor)) throw new Error('Canonical JSON cannot contain accessors');
        return `${encode(key)}:${encode(descriptor.value)}`;
      }).join(',')}}`;
    } finally { ancestors.delete(item); }
  }
  return encode(value);
}

export function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalize(value), 'utf8').digest('hex')}`;
}
export function actionDigest(action: { kind: 'command'; command: string; cwd: string }): string {
  if (action.kind !== 'command' || typeof action.command !== 'string' || typeof action.cwd !== 'string') throw new Error('Invalid command action');
  return digest({ kind: action.kind, command: action.command, cwd: action.cwd });
}

export const taskTransitions: Readonly<Record<TaskState, readonly TaskState[]>> = {
  requested: ['ready', 'running', 'blocked', 'cancelled', 'failed'],
  ready: ['running', 'blocked', 'cancelled', 'failed'],
  running: ['waiting_approval', 'blocked', 'review', 'failed', 'cancelled'],
  waiting_approval: ['running', 'blocked', 'failed', 'cancelled'],
  blocked: ['ready', 'running', 'review', 'failed', 'cancelled'],
  review: ['running', 'ready', 'blocked', 'completed', 'failed', 'cancelled'],
  completed: [], failed: ['ready', 'running', 'cancelled'], cancelled: [],
};
export const sessionTransitions: Readonly<Record<SessionState, readonly SessionState[]>> = {
  starting: ['idle', 'running', 'disconnected', 'failed', 'terminated'],
  idle: ['running', 'disconnected', 'failed', 'terminated'],
  running: ['idle', 'waiting_approval', 'disconnected', 'failed', 'terminated'],
  waiting_approval: ['running', 'idle', 'disconnected', 'failed', 'terminated'],
  disconnected: ['terminated'], failed: ['terminated'], terminated: [],
};
export const approvalTransitions: Readonly<Record<ApprovalState, readonly ApprovalState[]>> = {
  pending: ['approved', 'denied', 'expired', 'disconnected', 'unavailable', 'uncertain'],
  approved: ['uncertain'], denied: ['uncertain'], expired: [], disconnected: [], unavailable: [], uncertain: [],
};
export function assertTaskTransition(from: TaskState, to: TaskState): void {
  if (!Object.hasOwn(taskTransitions, from) || !Object.hasOwn(taskTransitions, to) || (from !== to && !taskTransitions[from].includes(to))) throw new Error(`Invalid task transition: ${from} -> ${to}`);
}
export function assertSessionTransition(from: SessionState, to: SessionState): void {
  if (!Object.hasOwn(sessionTransitions, from) || !Object.hasOwn(sessionTransitions, to) || (from !== to && !sessionTransitions[from].includes(to))) throw new Error(`Invalid session transition: ${from} -> ${to}`);
}
export function assertApprovalTransition(from: ApprovalState, to: ApprovalState): void {
  if (!Object.hasOwn(approvalTransitions, from) || !Object.hasOwn(approvalTransitions, to) || (from !== to && !approvalTransitions[from].includes(to))) throw new Error(`Invalid approval transition: ${from} -> ${to}`);
}
