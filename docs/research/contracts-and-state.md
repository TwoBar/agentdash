# Initial contracts, lifecycle and storage evidence

Reviewed 2026-11-13 against the live acceptance criteria for [AGCP-005](https://github.com/TwoBar/agentdash/issues/5), [AGCP-006](https://github.com/TwoBar/agentdash/issues/6) and [AGCP-007](https://github.com/TwoBar/agentdash/issues/7). This covers the experimental, single-user local build selected in [ADR 0002](../decisions/0002-runtime-and-connector.md), not release certification or delegated authority.

## Contract baseline

[Domain contracts](../../packages/domain/src/index.ts) define stable UUID-based entity IDs, revision counters and ISO timestamps. Newly created records use `schemaVersion: 1`; the store rejects other explicit versions. An omitted version is tolerated for internal compatibility, not advertised as an export/interchange contract. `ActivityEvent` carries project/task/session scope, normalized event type, source identity and bounded summary; optional text is separate from audit metadata.

The persisted collections are projects, tasks, sessions, approvals, decisions, activity events, artifacts, observations and immutable persona versions. Session context records pin a compilation digest, persona version and exact artifact IDs/versions/source commits. Each artifact version is unique within its project/logical key and is immutable except for approval/staleness status.

`SkillVersion`, `AuthorityGrant` and `AgentMessage` define neutral future-facing contracts; they are not enabled delegated resolvers or separate persisted collections. Authority limits are descriptive contract data until M7 implements and verifies their interpretation. Current scoped capabilities and human-only policy do not grant authority from a caller-supplied grant reference. Task authority references remain optional under the human-governed MVP.

Codex wire IDs and native request payloads stay inside [the adapter](../../packages/codex/src/index.ts). A normalized connector event includes an AGCP session ID, opaque source/turn identity and supported lifecycle/activity data. Unknown native notifications/items are ignored; raw reasoning is excluded. Unsupported native server requests receive a safe refusal/error and an unavailable diagnostic, never a fabricated approval. Only a supported exact command invocation produces an actionable approval.

Strict canonical serialization sorts object keys, preserves array order and exact command/cwd strings, and rejects unsupported/lossy values, cycles and invalid Unicode. Action digests identify invocation bytes; they do not snapshot scripts, environment or every resulting effect.

## Legal lifecycle transitions

Unchanged state is allowed for idempotent metadata updates. All other permitted transitions are below; other transitions throw before persistence. Identity, project and parent bindings cannot be changed to evade these rules.

| Task state | Permitted next states |
|---|---|
| requested | ready, running, blocked, cancelled, failed |
| ready | running, blocked, cancelled, failed |
| running | waiting_approval, blocked, review, failed, cancelled |
| waiting_approval | running, blocked, failed, cancelled |
| blocked | ready, running, review, failed, cancelled |
| review | running, ready, blocked, completed, failed, cancelled |
| failed | ready, running, cancelled |
| completed / cancelled | No different next state |

A normal native terminal turn moves the task to review. A failed/interrupted turn becomes failed/blocked. Advisory completion labels and MCP status reports cannot accept a task. Human acceptance uses the authenticated operator boundary, requires review, revokes the session capability and terminates the session. A completed task cannot receive another message or launch a replacement session.

| Session state | Permitted next states |
|---|---|
| starting | idle, running, disconnected, failed, terminated |
| idle | running, disconnected, failed, terminated |
| running | idle, waiting_approval, disconnected, failed, terminated |
| waiting_approval | running, idle, disconnected, failed, terminated |
| disconnected / failed | terminated |
| terminated | No different next state |

Disconnected native bindings are never resumed. A retry creates a new registered session. Late events from inactive/replaced sessions cannot mutate the current task. Session context and connector generation may be initialized once and then cannot be replaced.

| Approval state | Permitted next states |
|---|---|
| pending | approved, denied, expired, disconnected, unavailable, uncertain |
| approved / denied | uncertain |
| expired / disconnected / unavailable / uncertain | No different next state |

Approval action, session/source/boot/policy and expiry fields are immutable. Every group member is an independent one-shot decision. Decision delivery moves from intent to sent, uncertain or rejected; sent may become uncertain when delivery certainty is lost. No consumed decision can return to intent.

## Scope and identity

The operator can select any local project; project-scoped routes still verify nested task/artifact/observation IDs. MCP credentials establish one project/task/session/boot identity. Tool input cannot substitute another parent, project or authority. Operator cookies and session bearer credentials are distinct.

Parentage is checked on creation and is immutable afterward. A new task cannot reference itself or an absent/foreign parent; rejecting reparenting prevents later graph cycles. Policy additionally limits registered depth, children per parent and concurrent sessions, including startup reservations. There is no delete/reparent API in this initial lifecycle surface.

The service binds literal loopback, checks exact Host, and requires an authenticated HttpOnly SameSite=Strict cookie. Mutations additionally need exact Origin, JSON and a separate CSRF token. Capabilities expire after 15 minutes and are revocable; long-session renewal remains release work. Same-user arbitrary programs, browser compromise and privileged host access remain outside this boundary. Common credential redaction is not a promise to recognize every secret.

## Storage, backup and recovery limits

[The store](../../packages/store/src/index.ts) uses one SQLite connection, DELETE journaling, FULL synchronous mode, bound parameters, numbered checksummed migrations and nested savepoints. Entity mutation, source uniqueness and hash-linked audit metadata commit together. Artifact-version migration backfills uniqueness keys for earlier databases; ambiguous duplicate historical versions fail closed. Audit verification checks sequence/hash linkage and the latest digest of each entity. Startup refuses invalid integrity; this cannot prevent a privileged actor replacing the complete store and history.

The production entry point selects private application data outside source repositories and takes an exclusive instance lock. New state directories use mode 0700; the database and lock use mode 0600. Existing directories still depend on host permissions. Registered project workspaces cannot contain private state or be nested inside it. Worktrees prevent overlapping source edits; they are not an OS security boundary.

Default session text is transient memory; persisted activity contains metadata. Explicit local-content mode stores redacted content in plaintext locally, excludes raw reasoning and does not erase earlier retained text when switched off. Artifact content is an explicit registry write. No encrypted archive or automatic backup scheduler is implemented.

For an offline metadata backup, stop the service cleanly and copy its closed `governance.sqlite` into private storage. Do not copy a live SQLite file as though it were a consistent backup. Keep source/worktree files separately; the database contains absolute workspace references and is not a portable project export. Restore only with the service stopped, preserve the former file for inspection, and use the same configured workspace paths. Do not restore a stale `server.lock` as an active instance. Startup checks migrations/integrity and invalidates former live sessions/pending callbacks. Signing keys, capabilities and live text are not recovered, and historical signed decisions never become renewed approval authority. Export/import and more extensive backup/recovery tooling remain later work.

## Evidence and acceptance limits

| Issue | Evidence | Honest boundary |
|---|---|---|
| AGCP-005 | [Domain serialization/transition tests](../../packages/domain/src/index.test.ts), [store identity/schema/cycle tests](../../packages/store/src/index.test.ts), [adapter refusal tests](../../packages/codex/src/index.test.ts), [runtime advisory/nonacceptance tests](../../apps/server/src/runtime.test.ts) | Initial MVP contract/lifecycle baseline; reserved contracts do not implement M7 delegation or a portable export schema |
| AGCP-006 | [Migration, offline-copy, rollback/audit failure, duplicate-source and tamper tests](../../packages/store/src/index.test.ts), [restart/context tests](../../apps/server/src/runtime.test.ts) | Local corruption detection and metadata recovery; no privileged-host integrity, encrypted backup or restored native callbacks |
| AGCP-007 | [Actual HTTP/MCP boundary tests](../../apps/server/src/app.test.ts), [credential/CSRF tests](../../apps/server/src/security.test.ts), [graph depth/workspace/restart tests](../../apps/server/src/runtime.test.ts) | Authenticated single-user local operations; immutable parentage instead of reparent/delete; credentials intentionally require a new registered session after expiry/restart |

The [production entry-point tests](../../apps/server/src/index.test.ts) additionally cover configured data paths inside uncommitted Git checkouts and linked worktrees, an exclusive instance lock and clean shutdown. These foundational issues do not close later packaging, encrypted retention, delegated authority, complete decision provenance or prolonged recovery release gates.
