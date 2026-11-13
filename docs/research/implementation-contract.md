# Initial implementation contract

Status: coordination design for the first local build. Source scope: issues AGCP-004 through AGCP-018, gated by ADR 0002. The runtime scaffold begins only after the native feasibility findings are recorded.

## Ownership

- Root: root manifests/CI, HTTP service, authenticated UI boundary, application orchestration, one-shot governance and MCP composition.
- Domain/store agent: `packages/domain/src/` and `packages/store/src/`, including meaningful persistence/transition tests.
- Connector agent: `packages/codex/src/`, including supported-version protocol mapping and focused fail-closed tests.
- UI agent: `apps/web/`, including Operations desk, scoped inline/group approval, task chat, artifacts and personas.

All agents use one coordinated branch and disjoint directories. Root integrates, tests, and manages GitHub. No agent independently commits or changes root dependencies.

## Shared entity shape

Domain definitions live in `packages/domain/src/index.ts`. Every entity has `id`, `revision`, `createdAt`, and `updatedAt`. Project-scoped entities have `projectId`. Timestamps are ISO strings. No Codex wire types appear in domain contracts.

- Project: `name`, `workspace`, `rootTaskId`, `githubRepo: string | null`.
- Task: `projectId`, `parentTaskId: string | null`, `name`, `objective`, `personaId`, `state`, `sessionId: string | null`, `workspace: string | null`.
- Session: `projectId`, `taskId`, `connector: 'codex'`, `state`, `bootId`, `error: string | null`. Connector keeps native identifiers internally; persisted session may have an opaque `bindingRef: string | null`.
- Approval: `projectId`, `taskId`, `sessionId`, `sourceEventId`, `actionDigest`, `summary`, `kind: 'command'`, `command`, `cwd`, `target`, `impact`, `risk: 'low' | 'medium' | 'high'`, `state`, `expiresAt`, `policySnapshotId`, `bootId`, `reason: string | null`.
- Decision: `projectId`, `approvalId`, `sessionId`, `actionDigest`, `decision: 'approve' | 'deny'`, `resolver: 'human'`, `policySnapshotId`, `bootId`, `issuedAt`, `expiresAt`, `keyId`, `signature`, `delivery: 'intent' | 'sent' | 'uncertain' | 'rejected'`.
- ActivityEvent: `projectId`, `taskId`, `sessionId: string | null`, `type`, `summary`, `text: string | null`, `sourceId: string | null`. Reasoning and raw protocol dumps are excluded. Minimal metadata is the default; users opt into local session text retention.
- Artifact: `projectId`, `taskId`, `logicalKey`, `version: number`, `status: 'draft' | 'approved' | 'stale'`, `summary`, `content: string | null`, `externalRef: string | null`, `sourceCommit: string | null`, `expiresAt: string | null`.
- Observation: `projectId`, `taskId`, `parentTaskId: string | null`, `sessionId`, `sourceTurnId`, `classification`, `summary`, `state: 'unread' | 'read' | 'replied'`, `deadlineAt: string | null`.
- Persona: global versioned record with `name`, `role`, `mandate`, `instructions`, `requiredArtifacts: string[]`, `skills: string[]`, `authority: string`, `version: number`.

Task states: `requested`, `ready`, `running`, `waiting_approval`, `blocked`, `review`, `completed`, `failed`, `cancelled`. Native turn completion becomes task `review`, not accepted completion. Session states: `starting`, `idle`, `running`, `waiting_approval`, `disconnected`, `failed`, `terminated`. Approval states: `pending`, `approved`, `denied`, `expired`, `disconnected`, `unavailable`, `uncertain`.

## Store boundary

`Store` in `packages/store/src/index.ts`, constructed as `new Store(databasePath)`:

- `create<T extends Entity>(collection, value: T, actor?: string): T`
- `get<T extends Entity>(collection, id): T | undefined`
- `list<T extends Entity>(collection, projectId?: string): T[]`
- `update<T extends Entity>(collection, id, expectedRevision, changes: Partial<T>, actor?: string): T` increments revision and updatedAt; rejects revision mismatch and immutable identity changes. Approval action/binding fields are immutable.
- `transaction<T>(fn: () => T): T` commits state/audit together, rolls back on throw; supports nested operations.
- `audit(projectId?: string): AuditEntry[]`, `verifyAudit(): { valid: boolean; events: number; errors: string[] }`, `close()`.

Collections: `projects`, `tasks`, `sessions`, `approvals`, `decisions`, `events`, `artifacts`, `observations`, `personas`. Use a single SQLite connection, rollback journal and FULL synchronous mode. Writes automatically append hash-linked audit metadata; avoid recording content/secrets in audit payloads. No plaintext signing keys. The application validates actor scope; store protects identities, revisions, immutable action data and transactions.

## Connector boundary

`CodexConnector` in `packages/codex/src/index.ts`, neutral callback events and no store dependency:

- Constructor `new CodexConnector({ executable?: string, onEvent: (event: ConnectorEvent) => void })`.
- `probe(): Promise<{ available: boolean; version: string | null; reason: string | null }>`.
- `startSession({ sessionId, cwd, instructions, model?: string, mcpServers?: Record<string, unknown> }): Promise<{ bindingRef: string }>`; initial read-only sandbox, human reviewer, interactive native approvals. No built-in unregistered child spawning.
- `sendMessage(sessionId, text): Promise<{ turnId: string }>`; `interrupt(sessionId): Promise<void>`; `terminate(sessionId): Promise<void>`; `close(): Promise<void>`.
- `resolveApproval(sessionId, approvalKey, actionDigest, decision: 'approve' | 'deny'): Promise<void>` verifies it still owns that exact pending request and one-shot action digest before native send.

ConnectorEvent: `sessionId`, `type` from `session.started | session.disconnected | session.failed | turn.started | turn.completed | activity | approval.requested | approval.resolved`, `sourceId`, `summary`, optional `text`, `turnId`, `terminalStatus`, `changes`. Approval payload: `key` (opaque callback map key), `kind: 'command'`, `command`, `cwd`, `digest` (shared canonical hash), `summary`. Add `supported: false` + reason for unavailable categories; never reconstruct a command from a model summary. Unknown native requests get a safe refusal/error; only command approval without network permission bundling is initially supported.

Use JSON-RPC server request identity including its process generation, not itemId alone. Forward only one-action accept/decline, never session grants or execpolicy changes. Lost processes invalidate every pending callback; uncertain delivery is never replayed. Schema/version support must match the spike evidence.

## HTTP / UI contract

Same-origin local service on `127.0.0.1:4317` by default. UI is Vite middleware in development, built static assets in production. All mutation calls require the authenticated HttpOnly cookie, exact Origin, JSON and `X-AGCP-CSRF`. `GET /api/session` returns `{ csrfToken }` to authenticated same-origin UI. Errors are `{ error: { code, message } }` with suitable HTTP status.

`GET /api/state?projectId=...` returns `{ projects, project, tasks, sessions, approvals, events, artifacts, observations, personas, status, audit }`. `status` includes `codexAvailable`, `codexVersion`, `connectorReason`, `bootId`, `retention: 'minimal' | 'local-content'`, `limitations: string[]`. No native approval callback IDs or credentials are sent to the browser.

Mutation endpoints (all under `/api`):

- `POST /projects` with `{ name, workspace, objective, githubRepo? }` creates a project/root task (does not launch a model until requested).
- `POST /projects/:projectId/tasks` with `{ parentTaskId, name, objective, personaId }` creates a scoped child task.
- `POST /projects/:projectId/tasks/:taskId/start` with `{ model? }` starts its registered session and initial objective. Child writers use isolated Git worktrees; unavailable isolation blocks launch.
- `POST /projects/:projectId/tasks/:taskId/message` with `{ text }` routes to that registered session. `POST .../interrupt` and `POST .../terminate` control it.
- `POST /projects/:projectId/tasks/:taskId/accept` accepts completion only through the human operator boundary.
- `POST /projects/:projectId/approvals/resolve` with `{ decision: 'approve' | 'deny', members: [{ approvalId, actionDigest, expectedRevision }] }` returns `{ outcomes: [{ approvalId, ok, state, error? }] }`. Groups are a frozen snapshot with per-member independent results; no questions/blockers included. UI must show mixed outcomes.
- `POST /projects/:projectId/artifacts` with `{ taskId, logicalKey, summary, content?, externalRef?, sourceCommit? }` registers a draft. `POST .../artifacts/:id/approve` and `POST .../artifacts/:id/stale` update status.
- `POST /projects/:projectId/observations/:id/reply` with `{ text }` replies to source child; `POST .../observations/:id/read` marks read.
- `POST /personas` with `{ sourceId, name, instructions }` clones a new immutable version for future sessions.
- `POST /settings/retention` with `{ retention: 'minimal' | 'local-content' }` explicitly opts into local message/tool content persistence. Minimal mode keeps transient live content in memory and persisted metadata only.

UI has project selection/creation, the accepted Operations desk, a registered task tree, optional agent chat, pending approval groups, question/blocker inbox, inspection tabs, artifacts and personas. No seeded fake execution state. Show disconnected/unavailable states plainly. Poll state with bounded interval; do not erase typed drafts on background refresh. No default external side effects or automatic model launches on opening UI.
