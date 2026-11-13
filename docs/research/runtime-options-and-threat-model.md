# Runtime options and local threat model

Research date: 2026-11-13. Owner: AGCP-003 ([issue #3](https://github.com/TwoBar/agentdash/issues/3)). Status: initial architecture research, retained as the pre-implementation recommendation. The native spikes have since completed; [accepted ADR 0002](../decisions/0002-runtime-and-connector.md) records the actual chosen implementation and supersedes proposed details below. This report alone is not implementation evidence.

Read alongside [ADR 0002](../decisions/0002-runtime-and-connector.md), [readiness](../READINESS.md), the [PRD](../../Agent-Governance-Control-Plane-PRD.md), and the [technical specification](../../Agent-Governance-Control-Plane-Technical-Spec.md). The integration agent must link both spike reports and record supported native action categories before accepting the runtime decision.

## Recommended first runtime

Use TypeScript, React and Vite for the Operations desk, a Node local service, SQLite behind an adapter, and an AGCP-owned Codex app-server child process over stdio. Start on macOS, the environment actually exercised; do not claim other OS support from portable language choices alone. Defer a desktop wrapper until packaging and credential-store evidence requires one.

Local observations, using synthetic values only:

| Check | Observed result | Interpretation |
|---|---|---|
| Node executable | `v22.20.0` | Available development baseline; exact version must be pinned when scaffolding |
| npm executable | `10.9.3` | Available package manager; use one npm lockfile and workspace layout |
| `node:sqlite` import | `DatabaseSync`, statements and backup available; experimental warning | Avoid a native npm addon initially; keep all driver usage behind the persistence adapter |
| SQLite engine query | `3.50.4` | Record the embedded version as well as Node; runtime patch review is a release gate |
| Synthetic SQLite exercise | In-memory STRICT table, parameter-bound insert and count succeeded | API availability only; not migration, durability or recovery evidence |
| `node:crypto` exercise | Ed25519 generated key, signature and verification round trip succeeded | API availability only; not proof of a completed approval protocol |
| Git executable | `2.50.1 (Apple Git-155)` | Worktree strategy still needs implementation and concurrent-writer tests |

Node's [versioned SQLite documentation](https://raw.githubusercontent.com/nodejs/node/v22.20.0/doc/api/sqlite.md) labels this API active development and describes synchronous database operations. Node's [versioned crypto documentation](https://raw.githubusercontent.com/nodejs/node/v22.20.0/doc/api/crypto.md) covers the built-in cryptographic primitives. Pinning limits accidental API drift; it does not excuse shipping an outdated runtime. Vite's [current requirements](https://vite.dev/guide/) include Node 22.12+, so the observed runtime meets its stated lower bound; lock actual package versions during scaffolding and verify their engine requirements.

Use a single service-owned database connection, short transactions, foreign keys, bound SQL parameters, disabled extension loading, and ordered numbered SQL migrations recorded with checksums. Start with rollback journaling (`journal_mode=DELETE`) and `synchronous=FULL`. Do not put the database on a network filesystem. Do not turn on WAL by habit: SQLite's [official WAL documentation](https://sqlite.org/wal.html#walreset) records a corruption race in earlier versions, including the locally embedded version, when concurrent connections write/checkpoint; fixes include 3.50.7 and 3.51.3. A patched runtime remains desirable before release even with this constrained configuration. Separate DB performance work from approval correctness; bound bulk operations before adding worker connections.

## Alternatives

| Option | Native process and UI boundary | Packaging and credentials | First-delivery consequence |
|---|---|---|---|
| Local browser + Node service | Node owns Codex child; browser has an authenticated loopback API and no native execution bridge | Uses installed browser/Node initially; OS credential provider requires separate implementation | Smallest initial build and one language across contracts; must implement and test HTTP authentication, origin checks and CSRF |
| Electron | Main process can own child; sandboxed renderer calls a narrow validated preload/IPC surface | Bundles Chromium and Node; provides a desktop lifecycle but does not automatically solve key custody | Viable later wrapper; introduces bundled-browser updates and renderer/main hardening before native approval evidence |
| Tauri | Rust core or tightly scoped sidecar owns child; WebView crosses capability-restricted IPC | Uses system WebView; Node connector may need a sidecar and a second toolchain | Viable distribution candidate; adds sidecar lifecycle and Rust boundary work to an otherwise TypeScript-first connector |

Electron's [security guidance](https://www.electronjs.org/docs/latest/tutorial/security) requires maintained framework versions, renderer isolation/sandboxing, CSP and sender validation. Tauri's [security model](https://v2.tauri.app/security/) distinguishes a privileged core from restricted WebView IPC and uses the OS WebView. Neither shell turns agent-controlled content into trusted instructions, supplies the application's authorization rules, or proves native approval recoverability. The local-browser recommendation is an implementation tradeoff, not a claim of stronger isolation than a correctly configured desktop shell.

## Trust boundaries and explicit limits

The trusted computing base is the local operator, service, connector adapter, session capability registry, SQLite adapter and trusted installed Codex executable. Agent output, tool output, repository content, persona text and classifier labels are untrusted data. Render text safely; never execute received HTML or interpret a message as approval or accepted task completion.

| Threat | Required control | Residual limit |
|---|---|---|
| A remote website calls localhost or exploits DNS rebinding | Bind literal `127.0.0.1`; validate exact Host including actual port; exact trusted Origin for mutations; CSRF token; no wildcard CORS | Origin controls constrain browsers; they do not authenticate arbitrary same-user programs |
| Agent impersonates another task or human | Separate operator and agent principals; opaque scoped capabilities; derive identity server-side; no agent decision capability in MVP | A compromised privileged service can still act as the operator |
| Stale/cross-project decision or replay | Immutable binding, digest, current revision, expiry, boot ID, authority check, signature and transactional consumption | A signed envelope proves service authorization, not execution success |
| Prompt/tool output injects UI script | Safe text rendering, restrictive CSP, no arbitrary HTML/inline scripts, URL validation, no external scripts | A browser extension or same-origin script compromise may control the operator's page |
| Pipe closes or service dies during approval | Uncertain/disconnected state, no automatic re-dispatch, revoke live capability on disconnect | Some already delivered action may have executed; do not imply rollback |
| Other local account reads state | Private data directory and restrictive permissions, no secrets in Git or logs | Administrator/root can inspect or alter processes, store and keys |
| Same-user malicious process or unrestricted agent command | State excluded from worktree; scoped harness sandbox where supported; process/credential isolation recorded | Loopback authentication and filesystem modes do not isolate hostile programs with the same OS user; robust containment would need an OS-enforced boundary |
| Audit store replaced or truncated | Hash-linked events and optional separately retained signed checkpoints | A local administrator can replace the whole database; no tamper-proof claim |
| Signing key lost or rotated | Fail closed, invalidate pending envelopes, retain public verification keys and key IDs | No recovery of lost private material or automatic continuation of old pending decisions |

The harness sandbox is separate from AGCP's governance rules. A worktree prevents accidental overlapping files; it is not a security sandbox. Any approval that materially expands native sandbox access must show that scope explicitly. If the observed native request cannot convey the reviewed action with sufficient immutable detail, that category remains unavailable.

## UI authentication and HTTP API plan

The first implementation may establish a random operator session on navigation to its served local page. The browser receives a cryptographically random 256-bit session identifier in an HttpOnly, `SameSite=Strict`, host-only cookie, scoped to `/api`. The service keeps its session record in memory with a short idle lifetime (initial recommendation: 30 minutes). This is local operator authentication within the above machine-user boundary, not proof of a person's physical presence. No startup secret is printed or stored in source.

`GET /api/session` returns a separate random CSRF token to an authenticated same-origin page and uses `Cache-Control: no-store`. Mutations require the cookie, exact non-null Origin matching the running local origin, `application/json`, and `X-AGCP-CSRF`. Reject missing/foreign/null Origin and unexpected Host. GET/HEAD must not mutate governance state. Do not return permissive CORS headers. Check origin/auth on any future WebSocket upgrade; use authenticated fetch streaming rather than putting bearer tokens in event-stream URLs. Logout and process restart revoke operator sessions. Browser-test cookie behavior on HTTP loopback; do not assume the Secure attribute works consistently across named localhost and literal loopback.

Agent authentication uses a different opaque 256-bit capability. Store only its hash plus project/task/session, service boot ID, allowed operations, expiry and revocation state. A 15-minute lifetime is an initial recommendation; rotation must be performed through an authenticated live session binding, not by caller-supplied IDs. Never place capability tokens in URLs, audit records or ordinary application logs. Never expose an operator cookie or signing material to an agent. A token is a bearer capability, so supported credential delivery still needs leakage review before MCP implementation.

Suggested operator API contracts, to implement only after the corresponding issues are unblocked:

| Surface | Input and authorization rule |
|---|---|
| `GET /api/projects` | Operator only; no agent token accepted as operator authentication |
| `POST /api/projects` | Validated name/workspace; service resolves and constrains real filesystem path |
| `GET /api/projects/:projectId/tasks` | Operator project access; graph response uses neutral IDs |
| `POST /api/approvals/:approvalId/decision` | `{ actionDigest, expectedRevision, decision, reason? }`; server derives resolver identity and verifies all stored bindings |
| `POST /api/approval-groups/decisions` | Explicit frozen `members: [{ approvalId, actionDigest, expectedRevision }]`; bounded size; duplicate member rejection; one result per selected member |
| `GET /api/events` | Authenticated redacted event stream with durable cursor; reconnect never supplies decision authority |
| `/mcp` | Separate agent-capability middleware; scope comes entirely from token; reject operator-cookie substitution and agent access to operator decisions |

An unknown ID should not reveal other-project content. Any later multi-project operator access model must scope both lookups and mutations, including nested artifact references and event cursors. MCP must derive the task's project even if a tool input repeats a project ID for convenience.

## Exact-action decision and recovery plan

The adapter snapshots the supported native request at receipt, never after the operator clicks. Preserve meaningful command/shell bytes, cwd, sandbox/permission scope and native action details without trimming or reinterpreting them. Keep native IDs inside the adapter; map them to a stable neutral source event and an immutable session binding. An opaque handle is not enough evidence of a command/diff unless the adapter can recover the same immutable details.

Use a versioned explicit JSON envelope with RFC 8785 canonicalization, UTF-8 bytes and SHA-256. [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785) supplies deterministic JSON serialization; enforce its input restrictions and reject duplicate keys/non-finite numbers rather than silently normalize them. Include a domain/version tag, project/task/session/connector binding, service boot ID, native source-event binding, action details and permission scope in the action digest. Cosmetic labels and risk summaries do not substitute for action details. Changing any governed field creates a new approval.

Sign a separate versioned decision envelope with Ed25519. Its signed bytes include decision ID, approval ID, project/task/session binding, native source-event binding, action digest, allowed decision, resolver identity, authority/policy snapshot, issued/expiry times, service boot ID, nonce and key ID. The bridge verifies stored pending state, current authority/policy, native binding, digest, expiry, signature and one-shot availability before constructing a supported Codex native response. Codex is not presumed to validate an AGCP signature. Only the single-action native response variants are eligible; session-wide acceptance and persistent permission amendments are outside a one-action approval.

A constrained first implementation can use an in-memory Ed25519 private key generated per service boot. Persist only its public key and key ID for historical verification. Do not export the private key into environment variables, source or a plaintext file. Every approval and session is bound to that boot. On restart, revoke capabilities, mark earlier live sessions/approvals disconnected, terminate owned orphan processes when feasible, and never resume/replay their pending approvals. This supports current-boot one-action decisions without pretending durable secure-key storage exists.

Within one transaction, compare pending revision/bindings, record the signed authorization, consume the nonce and create a dispatch intent with a unique constraint. Commit before writing the native response. After the write, record delivery; after an observed native lifecycle event, record the outcome separately. A successful pipe write is not proof of execution. Crash or disconnect after intent consumption is `delivery_unknown` until supported evidence resolves it. Never retry that response automatically. Reconciliation cannot restore authority merely because a native thread has the same ID.

This is at-most-one authorized delivery attempt, not exactly-once execution across SQLite and a subprocess. A crash before the write can consume a decision without executing it; a crash after the write can leave execution uncertain. The UI must show that uncertainty and request a new independent review only when a newly issued native action is actually pending. A human group gesture freezes displayed IDs/digests/revisions, runs the same checks independently, excludes new arrivals and reports partial outcomes; it cannot make multiple native executions atomic.

Use service timestamps and a maximum pending lifetime (initial recommendation: 10 minutes). Do not accept client time as expiry evidence. Compare monotonic time within a boot as well as wall-clock expiry; time rollback, unsupported clock state or restart must not extend authorization. The exact default and user-facing expiration behavior belong in the approval implementation issue.

## Keys, retention and workspaces

Durable signing keys, GitHub credentials and optional content-encryption keys must use an OS credential provider, with database references only. Apple's [Keychain services](https://developer.apple.com/documentation/security/keychain-services.md) is the initial macOS integration surface. The provider and access-control behavior remain unimplemented until tested; defer persistent credentials rather than adding a silent plaintext fallback. Per-boot signing does not provide long-lived identity or privileged-host tamper resistance. Loss of a later encryption key intentionally makes encrypted content unavailable unless the user has explicitly configured recovery.

Default persistence should retain structured governance metadata, immutable decision digests and redacted event summaries. Do not persist raw reasoning. Full prompts, command output and transcript bodies remain disabled until the retention/encrypted-content work is complete; a live in-memory inspector must state that activity will not survive restart. Once enabled, give each project explicit duration/size bounds, redaction and deletion controls, and exclude secret values from audit payloads. No encrypted-content or retention guarantee should appear as implemented merely because a storage interface exists. Existing Codex-owned retention is separate and must be disclosed according to observed connector behavior.

Use one writable worktree/branch per concurrent task; record its canonical real path, repository identity, base commit and owning task/session. Use an application-managed directory outside the source checkout. Git's [worktree documentation](https://git-scm.com/docs/git-worktree) describes linked working trees with shared repository metadata, so serialize repository-global operations and integration. Never remove a dirty/unrecognized worktree or overwrite an operator checkout. Branch merging and conflict resolution require their own reviewed integration step. Non-Git workspaces need isolated copies or serialized writers; do not silently permit concurrent mutation of the same directory.

## Parallel implementation boundaries after M0

Suggested module locations below are a plan, not existing files or installed commands. Keep independent ownership by package; integrate contracts before consumers.

| Owner / linked issue | Suggested modules | Contract boundary |
|---|---|---|
| Neutral contracts, AGCP-005 | `packages/domain/src/` | Stable IDs, versioned entities, separate task/session/approval states; no Codex wire types |
| Local foundation, AGCP-006–008 | `packages/store/src/`, `apps/server/src/` | SQLite transaction repository; actor resolved by auth; immutable audit events in same transaction as mutations |
| Codex sessions, AGCP-009–010 | `packages/connector-codex/src/process.ts`, `protocol.ts`, `adapter.ts` | Owned process lifecycle, generated version-specific wire types, normalized event mapping and capability matrix |
| Context and child policy, AGCP-011–012 | `packages/server/src/context/`, `sessions/`, `mcp/`, `workspaces/` | Compile digest/version references; scoped identity; policy-validated child proposal; isolated workspace before process start |
| Approval bridge, AGCP-013–015 | `packages/server/src/approvals/`, `crypto/`, `recovery/` | Pending state machine, canonicalization/signing, transactional consumption, delivery uncertainty and reconciliation |
| Operations desk, AGCP-014/016 | `apps/web/src/` | Typed operator client; inline/group actions; independent outcomes; inspector anchored to source event |

The connector-neutral interface should expose `startSession`, `sendMessage`, `subscribe`, `getState`, `submitNativeDecision` and `terminateSession`, returning normalized bindings/events. Unknown native event kinds should emit diagnostic capability gaps rather than fabricate support. Task completion acceptance is separate from terminal turn/session lifecycle; observation labels cannot grant authority or accept a task.

Security evidence must include wrong-project/task/session IDs, forged parent claims, wrong token type, expired/revoked/rotated capability, malformed input, wrong Host/Origin/CSRF, action changes, signature mismatch, replay, concurrent approve/deny, changed policy, native disconnect, restart before/after dispatch and expired group members. Use synthetic fixtures and deterministic clocks/fault injection. Mock tests establish application transitions; native approval claims additionally require the supported-release spike and end-to-end harness evidence.

## Owned deferrals and release gates

| Decision / limit | Owner and blocking work |
|---|---|
| Native version, categories and coexistence support | AGCP-001/002 evidence, accepted by AGCP-003; unsupported coexistence stays unavailable |
| Exact runtime dependencies and migration implementation | AGCP-004/006; pin versions/lockfile and run clean-install, type/build and migration checks |
| Persistent OS key storage and encrypted optional content | AGCP-015 and AGCP-024 release review; per-boot decisions may precede it only with restart invalidation and no persistent credentials |
| Retention defaults and redaction behavior | AGCP-010/015/024; no durable sensitive transcript storage before implementation evidence |
| Runtime/SQLite patch currency and packaging | AGCP-024; include embedded library version and journal mode in release evidence |
| Licensing/distribution | Repository owner chooses the license; AGCP-003 records an explicit release-blocking follow-up before closure. No license is selected by this recommendation |
| GitHub app authorization model | AGCP-022 and release review; developer `gh` login is not app credential design |

Public repository visibility supplies no project-selected license. Do not create a license or publish distributable packages on the user's behalf without their explicit choice. Development may continue with the existing repository status while the owned release gate remains visible.

## Verification scope

This report checked the installed runtime APIs with synthetic in-memory exercises and reviewed primary runtime, desktop-shell, SQLite, canonicalization, origin and OS credential documentation. The local documentation checker must pass after integration. It does not prove native approval behavior, browser authentication, persistent key custody, migration recovery, sandbox isolation or cross-platform packaging. Those remain separate evidence gates above.
