import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  assertApprovalTransition, assertSessionTransition, assertTaskTransition, assertGitHubProposalTransition, validatePersonaMetadata, validateSkillVersion,
  canonicalize, collections, digest, freshEntity,
  type Approval, type Artifact, type AuditEntry, type Collection, type Decision,
  type Entity, type Observation, type Project, type Session, type Task, type Persona, type SkillVersion, type ProfileConnection, type GitHubProposal,
} from '../../domain/src/index.js';

const migrationSQL = `
CREATE TABLE entities (
  collection TEXT NOT NULL,
  id TEXT NOT NULL,
  project_id TEXT,
  revision INTEGER NOT NULL CHECK(revision >= 1),
  payload TEXT NOT NULL CHECK(json_valid(payload)),
  PRIMARY KEY(collection, id)
) STRICT;
CREATE INDEX entities_project ON entities(collection, project_id);
CREATE TABLE audit (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  collection TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  project_id TEXT,
  operation TEXT NOT NULL CHECK(operation IN ('create','update')),
  revision INTEGER NOT NULL,
  actor TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  previous_hash TEXT NOT NULL,
  hash TEXT NOT NULL
) STRICT;
CREATE INDEX audit_project ON audit(project_id, sequence);
CREATE TABLE source_keys (
  collection TEXT NOT NULL,
  source_key TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  PRIMARY KEY(collection, source_key)
) STRICT;
`;
const artifactVersionKeysSQL = `
INSERT INTO source_keys(collection,source_key,entity_id)
SELECT 'artifacts', json_array(json_extract(payload,'$.projectId'),json_extract(payload,'$.logicalKey'),json_extract(payload,'$.version')), id
FROM entities WHERE collection='artifacts';
`;
const registryVersionKeysSQL = `
INSERT INTO source_keys(collection,source_key,entity_id)
SELECT 'personas', json_array(json_extract(payload,'$.role'),json_extract(payload,'$.version')), id
FROM entities WHERE collection='personas';
INSERT INTO source_keys(collection,source_key,entity_id)
SELECT 'skills', json_array(COALESCE(json_extract(payload,'$.skillId'),json_extract(payload,'$.name')),json_extract(payload,'$.version')), id
FROM entities WHERE collection='skills';
`;

export class Store {
  readonly #db: DatabaseSync;
  #depth = 0;
  #savepoint = 0;
  #closed = false;

  constructor(databasePath: string) {
    if (databasePath !== ':memory:') {
      const directory = dirname(databasePath);
      if (!existsSync(directory)) mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
    this.#db = new DatabaseSync(databasePath, { enableForeignKeyConstraints: true, allowExtension: false, timeout: 1000 });
    try {
      this.#db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;');
      if (databasePath !== ':memory:') chmodSync(databasePath, 0o600);
      this.#migrate();
    } catch (error) { this.#db.close(); throw error; }
  }

  #migrate(): void {
    this.#db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT');
    const recorded = this.#db.prepare('SELECT version, checksum FROM schema_migrations ORDER BY version').all() as { version: number; checksum: string }[];
    const migrations = [{ version: 1, sql: migrationSQL }, { version: 2, sql: artifactVersionKeysSQL }, { version: 3, sql: registryVersionKeysSQL }];
    for (const row of recorded) {
      const migration = migrations.find(item => item.version === row.version);
      if (!migration) throw new Error(`Unsupported database migration version: ${row.version}`);
      if (row.checksum !== digest(migration.sql)) throw new Error(`Migration checksum mismatch: ${row.version}`);
    }
    for (const migration of migrations) {
      if (recorded.some(row => row.version === migration.version)) continue;
      if (recorded.some(row => row.version > migration.version)) throw new Error('Database migration history is incomplete');
      this.transaction(() => {
        this.#db.exec(migration.sql);
        this.#db.prepare('INSERT INTO schema_migrations(version,checksum,applied_at) VALUES(?,?,?)').run(migration.version, digest(migration.sql), new Date().toISOString());
      });
    }
  }

  #check(collection: Collection): void {
    if (this.#closed) throw new Error('Store is closed');
    if (!collections.includes(collection)) throw new Error(`Unknown collection: ${collection}`);
  }
  #projectId(collection: Collection, entity: Entity): string | null {
    return collection === 'projects' ? entity.id : 'projectId' in entity ? entity.projectId : null;
  }
  #validate(collection: Collection, entity: Entity): void {
    if (!entity.id || typeof entity.id !== 'string' || !Number.isSafeInteger(entity.revision) || entity.revision < 1 || !Number.isFinite(Date.parse(entity.createdAt)) || !Number.isFinite(Date.parse(entity.updatedAt))) throw new Error('Invalid entity identity/revision/timestamps');
    if (entity.schemaVersion !== undefined && entity.schemaVersion !== 1) throw new Error('Unsupported entity schema version');
    if (collection === 'personas') {
      const persona = entity as Persona;
      if (['authorityTemplate', 'toolScope', 'dataScope', 'escalationRules', 'expectedOutputs', 'completionContract', 'skillVersionIds'].some(key => Object.hasOwn(persona, key))) {
        validatePersonaMetadata(persona);
        for (const id of persona.skillVersionIds!) if (!this.get<SkillVersion>('skills', id)) throw new Error('Persona references a missing skill version');
      }
      return;
    }
    if (collection === 'skills') { validateSkillVersion(entity as SkillVersion); return; }
    if (collection === 'connections') {
      const connection = entity as ProfileConnection;
      if (Object.keys(connection).some(key => !['id','revision','createdAt','updatedAt','schemaVersion','provider','login','accountId','state','capabilities','owners','credentialProvider'].includes(key)) || Object.keys(connection.capabilities ?? {}).some(key => !['read','repositoryCreate','issueCreate','administration','release'].includes(key))) throw new Error('Unsupported GitHub connection metadata');
      if (connection.provider !== 'gh-cli' || connection.credentialProvider !== 'gh-cli' || !connection.login || !Number.isSafeInteger(connection.accountId) || connection.accountId < 1 || !['connected', 'disconnected'].includes(connection.state)) throw new Error('Invalid GitHub connection identity');
      if (!connection.capabilities || ['read','repositoryCreate','issueCreate','administration','release'].some(key => typeof connection.capabilities[key as keyof ProfileConnection['capabilities']] !== 'boolean') || !Array.isArray(connection.owners) || connection.owners.some(owner => !owner || Object.keys(owner).some(key => !['login','id'].includes(key)) || !owner.login || !Number.isSafeInteger(owner.id) || owner.id < 1)) throw new Error('Invalid GitHub connection capability/owner metadata');
      return;
    }
    if (collection === 'projects') {
      const project = entity as Project;
      const rootTask = this.get<Task>('tasks', project.rootTaskId);
      if (rootTask && (rootTask.projectId !== project.id || rootTask.parentTaskId !== null)) throw new Error('Invalid project root task');
      if (project.githubConnectionId != null && !this.get<ProfileConnection>('connections', project.githubConnectionId)) throw new Error('Invalid project GitHub connection');
      if (project.githubRepositoryId != null && (!Number.isSafeInteger(project.githubRepositoryId) || project.githubRepositoryId < 1)) throw new Error('Invalid GitHub repository identity');
      return;
    }
    const projectId = this.#projectId(collection, entity);
    if (!projectId || !this.get<Project>('projects', projectId)) throw new Error('Missing project scope');
    const taskReference = (id: string | null | undefined): Task | undefined => {
      if (id == null) return;
      const task = this.get<Task>('tasks', id);
      if (!task || task.projectId !== projectId) throw new Error('Invalid cross-project task reference');
      return task;
    };
    const sessionReference = (id: string | null | undefined, taskId?: string): Session | undefined => {
      if (id == null) return;
      const session = this.get<Session>('sessions', id);
      if (!session || session.projectId !== projectId || (taskId && session.taskId !== taskId)) throw new Error('Invalid session binding');
      return session;
    };
    if (collection === 'githubProposals') {
      const proposal = entity as GitHubProposal;
      if (!proposal.taskId) throw new Error('Missing task identity');
      taskReference(proposal.taskId);
      if (!this.get<ProfileConnection>('connections', proposal.connectionId)) throw new Error('Invalid GitHub proposal connection');
      const project = this.get<Project>('projects', proposal.projectId)!;
      if (!this.get<GitHubProposal>('githubProposals', proposal.id) && project.githubConnectionId != null && project.githubConnectionId !== proposal.connectionId) throw new Error('GitHub proposal connection does not match project binding');
      if (!['repository.create','issue.create'].includes(proposal.kind) || !proposal.bootId || !/^sha256:[a-f0-9]{64}$/.test(proposal.actionDigest) || !Number.isFinite(Date.parse(proposal.expiresAt)) || !proposal.payload || typeof proposal.payload !== 'object' || Array.isArray(proposal.payload)) throw new Error('Invalid GitHub proposal action binding');
      assertGitHubProposalTransition(proposal.state, proposal.state);
      if (proposal.resolver !== undefined && proposal.resolver !== 'human') throw new Error('GitHub proposal resolver must be human');
      if (proposal.decision !== undefined && !['approve','deny'].includes(proposal.decision)) throw new Error('Invalid GitHub proposal decision');
      if (proposal.decidedAt !== undefined && !Number.isFinite(Date.parse(proposal.decidedAt))) throw new Error('Invalid GitHub proposal decision timestamp');
      for (const input of proposal.artifactInputs ?? []) {
        const artifact = this.get<Artifact>('artifacts', input.id);
        if (!artifact || artifact.projectId !== proposal.projectId || artifact.logicalKey !== input.logicalKey || artifact.version !== input.version || artifact.sourceCommit !== input.sourceCommit) throw new Error('GitHub proposal artifact binding mismatch');
      }
      if (proposal.planningArtifactId !== undefined) {
        const plan = this.get<Artifact>('artifacts', proposal.planningArtifactId);
        if (!plan || plan.projectId !== projectId || plan.taskId !== proposal.taskId || plan.logicalKey !== 'issue_proposals' || proposal.kind !== 'issue.create' || !Number.isSafeInteger(proposal.planningIssueIndex) || proposal.planningIssueIndex! < 0) throw new Error('Invalid issue planning artifact binding');
      } else if (proposal.planningIssueIndex !== undefined) throw new Error('Missing issue planning artifact binding');
    } else if (collection === 'tasks') {
      const task = entity as Task;
      assertTaskTransition(task.state, task.state);
      taskReference(task.parentTaskId);
      if (task.parentTaskId === task.id) throw new Error('Task cannot parent itself');
      sessionReference(task.sessionId, task.id);
    } else if (collection === 'sessions') {
      const session = entity as Session;
      if (!session.taskId) throw new Error('Missing task identity');
      taskReference(session.taskId);
      assertSessionTransition(session.state, session.state);
      if (session.connector !== 'codex' || !session.bootId) throw new Error('Invalid connector session');
      if (session.resumedFrom !== undefined) {
        if (!session.resumedFrom || session.resumedFrom === session.id) throw new Error('Invalid resumed session reference');
        sessionReference(session.resumedFrom, session.taskId);
      }
    } else if (collection === 'decisions') {
      const decision = entity as Decision;
      const approval = this.get<Approval>('approvals', decision.approvalId);
      if (!approval || approval.projectId !== projectId || approval.sessionId !== decision.sessionId || approval.actionDigest !== decision.actionDigest || approval.bootId !== decision.bootId || approval.policySnapshotId !== decision.policySnapshotId) throw new Error('Decision binding mismatch');
      if (decision.resolver !== 'human' || !['approve', 'deny'].includes(decision.decision) || !['intent', 'sent', 'uncertain', 'rejected'].includes(decision.delivery)) throw new Error('Invalid human decision');
      if (decision.policyChecks !== undefined && (!Array.isArray(decision.policyChecks) || decision.policyChecks.some(result => !result || typeof result.check !== 'string' || !result.check || result.outcome !== 'pass' || typeof result.summary !== 'string' || !result.summary || !Number.isFinite(Date.parse(result.checkedAt))))) throw new Error('Invalid recorded policy checks');
    } else {
      const scoped = entity as Entity & { taskId: string; sessionId?: string | null };
      if (!scoped.taskId) throw new Error('Missing task identity');
      taskReference(scoped.taskId);
      const session = sessionReference(scoped.sessionId, scoped.taskId);
      if (collection === 'approvals') {
        const approval = entity as Approval;
        assertApprovalTransition(approval.state, approval.state);
        // Exact native bytes may deliberately remain only in live memory under minimal retention.
        // The connector verifies the digest against those bytes at receipt and native delivery.
        if (!session || session.bootId !== approval.bootId || !approval.sourceEventId || !/^sha256:[a-f0-9]{64}$/.test(approval.actionDigest)) throw new Error('Approval action binding mismatch');
      }
      if (collection === 'observations') {
        const observation = entity as Observation;
        taskReference(observation.parentTaskId);
        if (!session || !observation.sourceTurnId) throw new Error('Invalid observation source');
        if (observation.terminalStatus !== undefined && observation.terminalStatus !== null && (typeof observation.terminalStatus !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/i.test(observation.terminalStatus))) throw new Error('Invalid observation terminal status');
      }
      if (collection === 'artifacts' && (!Number.isSafeInteger((entity as Artifact).version) || (entity as Artifact).version < 1)) throw new Error('Invalid artifact version');
      if (collection === 'artifacts' && (entity as Artifact).readableByTaskIds !== undefined) {
        const allowed = (entity as Artifact).readableByTaskIds;
        if (!Array.isArray(allowed) || new Set(allowed).size !== allowed.length || allowed.some(id => typeof id !== 'string' || !id)) throw new Error('Invalid artifact access scope');
        for (const id of allowed) taskReference(id);
      }
      if (collection === 'artifacts' && (entity as Artifact).inputArtifacts !== undefined) {
        const inputs = (entity as Artifact).inputArtifacts;
        if (!Array.isArray(inputs) || new Set(inputs.map(input => input.id)).size !== inputs.length) throw new Error('Invalid artifact input provenance');
        for (const input of inputs) {
          const artifact = this.get<Artifact>('artifacts', input.id);
          if (!artifact || artifact.id === entity.id || artifact.projectId !== projectId || artifact.logicalKey !== input.logicalKey || artifact.version !== input.version || artifact.sourceCommit !== input.sourceCommit) throw new Error('Artifact input binding mismatch');
        }
      }
      if (collection === 'artifacts' && (entity as Artifact).sourceSessionId !== undefined) sessionReference((entity as Artifact).sourceSessionId, scoped.taskId);
    }
  }
  #sourceKey(collection: Collection, entity: Entity): string | undefined {
    const record = entity as unknown as Record<string, unknown>;
    if (collection === 'approvals') return canonicalize([record.sessionId, record.sourceEventId]);
    if (collection === 'decisions') return canonicalize([record.approvalId]);
    if (collection === 'observations') return canonicalize([record.sessionId, record.sourceTurnId]);
    if (collection === 'artifacts') return canonicalize([record.projectId, record.logicalKey, record.version]);
    if (collection === 'skills') return canonicalize([record.skillId ?? record.name, record.version]);
    if (collection === 'personas') return canonicalize([record.role, record.version]);
    if (collection === 'events' && record.sourceId !== null) return canonicalize([record.sessionId, record.sourceId, record.type]);
    return;
  }

  create<T extends Entity>(collection: Collection, value: T, actor = 'system'): T {
    this.#check(collection);
    const payload = canonicalize(value);
    const entity = JSON.parse(payload) as T;
    if (entity.revision !== 1) throw new Error('New entity revision must be 1');
    return this.transaction(() => {
      this.#validate(collection, entity);
      const sourceKey = this.#sourceKey(collection, entity);
      if (sourceKey) this.#db.prepare('INSERT INTO source_keys(collection,source_key,entity_id) VALUES(?,?,?)').run(collection, sourceKey, entity.id);
      this.#db.prepare('INSERT INTO entities(collection,id,project_id,revision,payload) VALUES(?,?,?,?,?)').run(collection, entity.id, this.#projectId(collection, entity), entity.revision, payload);
      this.#appendAudit(collection, entity, actor, 'create');
      return JSON.parse(payload) as T;
    });
  }
  get<T extends Entity>(collection: Collection, id: string): T | undefined {
    this.#check(collection);
    const row = this.#db.prepare('SELECT payload FROM entities WHERE collection=? AND id=?').get(collection, id) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) as T : undefined;
  }
  list<T extends Entity>(collection: Collection, projectId?: string): T[] {
    this.#check(collection);
    const rows = projectId === undefined
      ? this.#db.prepare('SELECT payload FROM entities WHERE collection=? ORDER BY rowid').all(collection)
      : this.#db.prepare('SELECT payload FROM entities WHERE collection=? AND project_id=? ORDER BY rowid').all(collection, projectId);
    return rows.map(row => JSON.parse(row.payload as string) as T);
  }
  update<T extends Entity>(collection: Collection, id: string, expectedRevision: number, changes: Partial<T>, actor = 'system'): T {
    this.#check(collection);
    canonicalize(changes);
    return this.transaction(() => {
      const current = this.get<T>(collection, id);
      if (!current) throw new Error(`Entity not found: ${collection}/${id}`);
      if (current.revision !== expectedRevision) throw new Error('Revision conflict');
      const oldRecord = current as unknown as Record<string, unknown>;
      const changesRecord = changes as Record<string, unknown>;
      const identity = ['id', 'projectId', 'createdAt', 'revision', 'schemaVersion'];
      if (collection === 'tasks') identity.push('parentTaskId');
      if (collection === 'sessions') identity.push('taskId', 'connector', 'bootId', 'resumedFrom');
      for (const key of identity) if (Object.hasOwn(changesRecord, key) && changesRecord[key] !== oldRecord[key]) throw new Error(`Immutable identity field: ${key}`);
      if (collection === 'sessions') {
        for (const key of ['contextDigest', 'personaVersionId', 'artifactInputs', 'skillVersionIds', 'bindingRef']) {
          const initialized = oldRecord[key] !== undefined && (key !== 'bindingRef' || oldRecord[key] !== null);
          if (Object.hasOwn(changesRecord, key) && initialized && canonicalize(changesRecord[key]) !== canonicalize(oldRecord[key])) throw new Error(`Immutable session context field: ${key}`);
        }
      }
      if (['approvals', 'decisions', 'events', 'observations', 'personas', 'artifacts', 'skills', 'connections', 'githubProposals'].includes(collection)) {
        const mutable = new Set(['updatedAt', 'revision', ...(collection === 'approvals' ? ['state', 'reason'] : collection === 'decisions' ? ['delivery'] : collection === 'observations' ? ['state'] : collection === 'artifacts' ? ['status'] : collection === 'connections' ? ['state','capabilities','owners'] : collection === 'githubProposals' ? ['state','reason','externalUrl'] : [])]);
        if (collection === 'githubProposals') for (const key of ['signature','verificationKey','keyId','resolver','decision','decidedAt','reconciliationMarker']) if (oldRecord[key] === undefined) mutable.add(key);
        for (const key of Object.keys(changesRecord)) if (!mutable.has(key) && canonicalize(changesRecord[key]) !== canonicalize(oldRecord[key])) throw new Error(`Immutable ${collection} field: ${key}`);
      }
      const next = { ...current, ...changes, id: current.id, revision: current.revision + 1, updatedAt: new Date().toISOString() } as T;
      if (collection === 'projects') {
        const project = next as Project;
        const rootTask = this.get<Task>('tasks', project.rootTaskId);
        if (!rootTask || rootTask.projectId !== project.id || rootTask.parentTaskId !== null) throw new Error('Invalid project root task');
      }
      if (collection === 'tasks') assertTaskTransition((current as Task).state, (next as Task).state);
      if (collection === 'sessions') assertSessionTransition((current as Session).state, (next as Session).state);
      if (collection === 'approvals') assertApprovalTransition((current as Approval).state, (next as Approval).state);
      if (collection === 'githubProposals') assertGitHubProposalTransition((current as GitHubProposal).state, (next as GitHubProposal).state);
      if (collection === 'decisions') {
        const prior = (current as Decision).delivery;
        const after = (next as Decision).delivery;
        if (prior !== after && !(prior === 'intent' && after !== 'intent') && !(prior === 'sent' && after === 'uncertain')) throw new Error('Decision delivery is already consumed');
      }
      this.#validate(collection, next);
      const result = this.#db.prepare('UPDATE entities SET revision=?, payload=? WHERE collection=? AND id=? AND revision=?').run(next.revision, canonicalize(next), collection, id, expectedRevision);
      if (result.changes !== 1) throw new Error('Revision conflict');
      this.#appendAudit(collection, next, actor, 'update');
      return JSON.parse(canonicalize(next)) as T;
    });
  }

  transaction<T>(fn: () => T): T {
    if (this.#closed) throw new Error('Store is closed');
    const outer = this.#depth === 0;
    const name = `agcp_${++this.#savepoint}`;
    this.#db.exec(outer ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${name}`);
    this.#depth++;
    try {
      const value = fn();
      if (value && typeof value === 'object' && 'then' in value) throw new Error('Store transactions require a synchronous callback');
      this.#db.exec(outer ? 'COMMIT' : `RELEASE SAVEPOINT ${name}`);
      return value;
    } catch (error) {
      this.#db.exec(outer ? 'ROLLBACK' : `ROLLBACK TO SAVEPOINT ${name}; RELEASE SAVEPOINT ${name}`);
      throw error;
    } finally { this.#depth--; }
  }
  #appendAudit(collection: Collection, entity: Entity, actor: string, operation: 'create' | 'update'): void {
    const previous = this.#db.prepare('SELECT sequence,hash FROM audit ORDER BY sequence DESC LIMIT 1').get() as { sequence: number; hash: string } | undefined;
    const entry: Omit<AuditEntry, 'hash'> = {
      id: freshEntity('aud').id, sequence: (previous?.sequence ?? 0) + 1,
      collection, entityId: entity.id, projectId: this.#projectId(collection, entity), operation,
      revision: entity.revision, actor, timestamp: new Date().toISOString(),
      payloadDigest: digest(entity), previousHash: previous?.hash ?? 'genesis',
    };
    this.#db.prepare('INSERT INTO audit(sequence,id,collection,entity_id,project_id,operation,revision,actor,timestamp,payload_digest,previous_hash,hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(entry.sequence, entry.id, entry.collection, entry.entityId, entry.projectId, entry.operation, entry.revision, entry.actor, entry.timestamp, entry.payloadDigest, entry.previousHash, digest(entry));
  }
  audit(projectId?: string): AuditEntry[] {
    if (this.#closed) throw new Error('Store is closed');
    const rows = projectId === undefined ? this.#db.prepare('SELECT * FROM audit ORDER BY sequence').all() : this.#db.prepare('SELECT * FROM audit WHERE project_id=? ORDER BY sequence').all(projectId);
    return rows.map(row => ({ id: row.id, sequence: row.sequence, collection: row.collection, entityId: row.entity_id, projectId: row.project_id, operation: row.operation, revision: row.revision, actor: row.actor, timestamp: row.timestamp, payloadDigest: row.payload_digest, previousHash: row.previous_hash, hash: row.hash } as AuditEntry));
  }
  verifyAudit(): { valid: boolean; events: number; errors: string[] } {
    const events = this.audit();
    const errors: string[] = [];
    let previousHash = 'genesis';
    const latest = new Map<string, AuditEntry>();
    for (const [index, event] of events.entries()) {
      const { hash, ...unsigned } = event;
      if (event.sequence !== index + 1) errors.push(`Audit sequence missing or reordered at ${event.sequence}`);
      if (event.previousHash !== previousHash || digest(unsigned) !== hash) errors.push(`Audit hash mismatch at ${event.sequence}`);
      previousHash = hash;
      latest.set(`${event.collection}/${event.entityId}`, event);
    }
    for (const row of this.#db.prepare('SELECT collection,id,revision,payload FROM entities').all()) {
      const event = latest.get(`${row.collection}/${row.id}`);
      try {
        if (!event || event.revision !== row.revision || event.payloadDigest !== digest(JSON.parse(row.payload as string))) errors.push(`Entity audit mismatch: ${row.collection}/${row.id}`);
      } catch { errors.push(`Invalid entity payload: ${row.collection}/${row.id}`); }
      latest.delete(`${row.collection}/${row.id}`);
    }
    for (const key of latest.keys()) errors.push(`Audited entity missing: ${key}`);
    return { valid: errors.length === 0, events: events.length, errors };
  }
  close(): void {
    if (this.#closed) return;
    if (this.#depth) throw new Error('Cannot close store during transaction');
    this.#db.close(); this.#closed = true;
  }
}
