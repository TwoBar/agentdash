# Project readiness review

Reviewed 2026-11-13 against the supplied PRD v0.1 and technical specification v0.1. This section preserves the initial planning assessment; see the implementation update below for current evidence.

## Findings

The documents define a clear user, governance boundary, and eight useful MVP acceptance criteria. The project starts with two specification files and no application code. Its largest risk is native harness enforcement and recoverability, followed by session identity and local trust boundaries.

| Finding | Planning resolution | Evidence required |
|---|---|---|
| PRD roadmap defers delegated approvals, while technical slice 5 schedules them before inbox/inspection | Human approvals in MVP; delegated authority in M7; move inbox and inspector into core MVP | ADR 0001 and M3–M4 acceptance |
| Codex approval API, payload fidelity, and timeout behavior were unspecified | Evaluate app-server first; gate implementation on a native approval experiment | AGCP-001 |
| Simultaneous native Codex UI interaction is part of the vision but event mirroring/ownership is unknown | Start with AGCP-owned sessions; characterize shared/direct interaction and record limits | AGCP-002 |
| Desktop stack and trusted process model are open | Select runtime, package manager, UI shell, IPC, storage, and packaging together | AGCP-003 / ADR 0002 |
| Spec requires a signed exact-action decision but some native payloads may lack complete action details | Establish which event kinds have immutable, sufficient payloads; unsupported kinds remain unavailable | AGCP-001, AGCP-013 |
| Agent lifecycle blends task progress, turns, and accepted completion | Separate session lifecycle from task acceptance; observations are advisory | AGCP-005, AGCP-017 |
| MCP tools cannot be trusted to report every terminal turn | Capture terminal events in the connector and route observations independently | AGCP-010, AGCP-017 |
| Multiple agents share a source workspace unless isolation is explicit | Choose worktree/checkout ownership and conflict policy before concurrent writes | AGCP-012 |
| Hash-linked audit events alone do not protect against a local machine administrator rewriting the entire store | Define threat boundaries, checkpoints, retention, redaction, and key loss behavior; make limited integrity claims | AGCP-003, AGCP-006, AGCP-015 |
| Public repository license and distribution expectations are unspecified | Keep license choice open in M0; do not imply an open-source grant | AGCP-003 |

## Codex integration research starting point

The [official app-server documentation](https://learn.chatgpt.com/docs/app-server) describes client-driven threads/turns, streamed item events, and server-initiated command/file approval requests. Protocol schemas can be generated from a specific CLI version. These documented surfaces support investigating app-server as the adapter; they do not establish this project's enforcement, recovery, or shared-UI guarantees.

The local CLI reported `0.163.0-alpha.11.1` during setup. This is an observation, **not** a supported or pinned project version. M0 must select and record the version tested.

The research spikes must use supported interfaces, synthetic prompts, and an isolated workspace. Do not use hidden desktop databases, credential files, transcript scraping, or an MCP server as a substitute for native approval interception. A file-change request lacking an exact immutable diff must not be advertised as exact-diff authorization.

## Decisions still open

- Application runtime, dependency manager, UI shell, local service/process boundary, IPC authentication, and initial target OS.
- Supported Codex release, approval categories, terminal-event coverage, and shared native UI support.
- Canonical action serialization, signing algorithm, key storage, restart reconciliation, and expiry/clock policy.
- Retention defaults, redaction, encrypted content storage, and recovery or deliberate loss of keys.
- GitHub credential approach for the application: OAuth versus GitHub App versus explicitly scoped personal credentials. The developer's `gh` login is repository setup tooling, not the app's authorization design.
- Public repository license.

Each decision needs a short rationale, alternatives, consequences, and linked verification in an ADR. Only the first three research issues need to be ready now; future issues carry dependencies explicitly.

## Initial readiness baseline (superseded below)

Repository setup provides Git history, a linked remote, the roadmap, dependency-aware issues and milestones, contributor guidance, and documentation CI. Application development begins with M0. There are no runtime setup commands or application tests to run yet.

## Implementation update — 2026-11-13

M0 native command and event spikes passed on the exact tested CLI, and ADR 0002 now records the accepted experimental runtime. The integrated local build includes a persistent graph, owned sessions, scoped MCP, child worktrees, signed one-shot approvals, grouped human decisions, an inspector, advisory parent inboxes, and initial persona/artifact support. Unit/integration/security checks and native/browser exercises provide evidence; this is not a packaged release or a claim that all MVP criteria and long-running recovery cases are complete.

Read the [README](../README.md) for actual startup/check commands and explicit limitations. GitHub issues track remaining scope. License selection, runtime patch review, encrypted retention/persistent signing-key storage, controlled live GitHub writes, abrupt-crash/reboot and prolonged recovery tests, and distribution remain release work.


## Recovery and profile increment — 2026-11-13

The next increment fixes cookie expiry during active use, preserves browser drafts on failed operations, reports actionable workspace/context errors, and adds explicit folder/Git setup. Verified stopped-owner recovery creates a new scoped session and hydrates nonauthoritative history; dirty child worktrees survive validated reuse. Real native application tests cover graceful service restart and automatic parent MCP reply/child continuation. Agent leases renew only under service-owned liveness checks and retain an absolute eight-hour limit.

Complete persona/skill metadata, scoped artifact resolution and exact issue-planning provenance now connect to the profile GitHub/provider flow. The provider accepts only an explicitly connected OS-keyring-backed CLI account; each project has its own repository binding. Authenticated reference reads passed against an owned repository. Remote writes have negative-case integration and synthetic browser evidence, but no live creation claim. Existing desktop chats and non-command native approval categories remain unavailable. See [ADR 0005](decisions/0005-owned-session-recovery.md), [ADR 0006](decisions/0006-github-provider-and-exact-proposals.md) and the [increment verification report](research/recovery-profile-increment.md).
