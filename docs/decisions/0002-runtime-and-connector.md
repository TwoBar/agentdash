# ADR 0002: Runtime, process model, and Codex connector

Date: 2026-11-13. Status: accepted for the first local development build. Owner: AGCP-003. This is an experimental local implementation decision, not release certification.

## Evidence and decision

The [native approval spike](../research/native-approval-feasibility.md) proved bounded hold, accept, deny, concurrent-request isolation, fresh approval after acceptance, EOF, and process-loss/restart behavior on Codex `0.163.0-alpha.11.1`. The [event spike](../research/session-event-coverage.md) proved an automatically observable terminal question, command results, file-change/diff activity, interrupted turns, history and fresh-process resume. Interrupted in-flight tool activity can be absent from native materialized history; preserve the local observed ledger and show gaps.

Use an AGCP-owned stdio app-server process per registered session. Native command approval is the initial supported category, only when the exact command/cwd and original callback binding are available. Network destination grants, file changes without immutable proposal binding, permission grants, app/MCP side-effect approvals and native desktop coexistence remain unavailable. A supported command authorizes an invocation, not a snapshot of scripts, environment or all resulting effects.

Use Node **22.20.0**, npm **10.9.3**, TypeScript **5.9.3**, React **19.3.1**, Vite **8.3.8**, and the installed Git toolchain. Pin exact dependencies and commit one npm lockfile. `node:sqlite` is experimental in this runtime; isolate it behind the store package, use one connection, rollback journaling (`DELETE`) and `synchronous=FULL`. Runtime/embedded SQLite patch currency is a release gate; the observed SQLite 3.50.4 must not use concurrent WAL writers/checkpoints.

The initial supported development host is macOS. Linux CI verifies portable code, not a cross-platform packaged product. A desktop shell is deferred. The [runtime comparison and threat model](../research/runtime-options-and-threat-model.md) documents alternatives and limits; the [implementation contract](../research/implementation-contract.md) defines parallel package boundaries.

## Alternatives

A local browser and Node service provide one language and direct subprocess ownership with the smallest initial packaging surface. Electron adds a maintained bundled browser/main-process IPC boundary; Tauri adds Rust/WebView capability and sidecar lifecycle work. Both remain viable distribution wrappers after the local workflow is validated. Neither supplies approval policy or a credential-storage design automatically.

## Trust and process model

The service binds literal loopback and serves UI/API from one origin. Validate exact Host for every request; operator mutations additionally require an authenticated HttpOnly SameSite=Strict cookie, exact non-null Origin, JSON and a separate CSRF token. Session cookies and CSRF tokens remain in memory and expire; no wildcard CORS, credential URLs or startup-secret logs. Same-user arbitrary programs and privileged host compromise are outside this boundary.

Agent MCP callers use separate short-lived opaque capabilities, stored only as token hashes and scoped to project/task/session/boot and allowed tools. Derive caller identity server-side; agent credentials never authorize operator decisions or accepted completion. Agent output and classifier labels remain untrusted advisory content. The owned AGCP MCP server exposes an explicit allow list of internal coordination tools with per-tool approval policy; those local metadata/context/child-request operations are authorized by scoped capabilities and application validation. This list contains no operator-decision or credentialed external-write tool. Unknown tools remain prompt/refused and native command actions retain human on-request approval.

A local process registry owns Codex children. Root sessions use the registered workspace; child sessions require isolated Git worktrees outside the source checkout before launch. A worktree prevents overlapping source changes and is not an OS security sandbox. Unsupported isolation blocks a child launch. Do not modify or remove dirty/unrecognized worktrees automatically.

## Exact-action decision and recovery

Canonical action bytes use recursively sorted strict JSON for `{kind, command, cwd}`, hashed with SHA-256. An approval additionally binds project/task/session, source event and opaque connector callback, service boot, policy, deadline and revision. The connector retains Codex wire identities privately, including process generation and numeric callback ID (zero is valid).

Generate an Ed25519 signing key in memory per service boot. Never export its private key to environment, plaintext storage, source or logs. Decisions include all immutable bindings, human resolver, issued/expiry timestamps and key/boot identity. Verify the signed envelope inside AGCP before sending a supported one-action response. Codex does not verify AGCP signatures. Honor available native options; Deny can map to cancel when decline is not advertised. Session grants and policy amendments are excluded.

Atomically record signed decision and dispatch intent, consume pending revision, commit, then attempt native delivery once. Persist delivery and execution evidence separately. An uncertain pipe write or process failure cannot be safely retried automatically; mark it uncertain. Group approval snapshots displayed IDs/digests/revisions and reports independent member outcomes. No exactly-once or cross-command transaction claim.

On service restart or signing-key loss, invalidate former live sessions/approvals and revoke capabilities. Former callbacks are never replayed or restored through thread history. Require a fresh registered session/new native pending action. Ephemeral signing is the supported initial mode; durable OS key storage remains separate work.

## Retention and owned deferrals

Default to persisted governance metadata and in-memory live activity. Never retain raw reasoning or log credentials. Explicit local-content retention must disclose plaintext local storage until encrypted blobs are implemented; default remains minimal. Codex itself retains its own local sessions independently.

Application state lives outside source checkouts in a private user data directory. Audit history is hash-linked with payload digests and can detect local record corruption within its stated limits; it cannot prevent whole-store rewriting by a privileged host actor.

The repository owner must select a distribution license before release. Development can proceed with private package metadata marked UNLICENSED; no license is selected on the user's behalf. Persistent OS credential storage, encrypted blobs, GitHub application authorization, native version/patch currency, prolonged recovery tests, and desktop packaging remain explicitly owned by AGCP-015/022/024/025. The developer's GitHub CLI authentication is not the application's authorization model.
