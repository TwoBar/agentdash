# First local development build

Verified 2026-11-13. This is an experimental implementation checkpoint, not MVP release acceptance. The v0.1 PRD and technical specification remain the scope baseline, interpreted by ADRs 0001–0003.

## Integrated result

Operations desk now drives a real same-origin local service, a persistent SQLite graph and AGCP-owned Codex sessions. It supports notification-level Approve/Deny and counted group approval with exclusions, separate signed decisions, task trees, nine initial personas, draft/approved artifacts, an approval-anchored inspector and advisory parent inboxes. Scoped MCP can register isolated child sessions. Agent messages cannot approve actions or accept task completion.

## Verification

A disposable source copy completed `npm ci` and `npm run check` with Node 22.20.0/npm 10.9.3: **95 tests passed**, type checks and production UI/server builds passed, documentation links/dependencies passed, and npm reported zero known dependency vulnerabilities at install time. CI repeats these checks on Linux without native model calls. Tests cover replay, cross-project identity, signature/action mismatch, deadlines, disconnect, restart, malformed protocol/output, process isolation, audit corruption, private data paths and overlapping boots.

Native experiments used only synthetic scratch projects on Codex 0.163.0-alpha.11.1:

- [Command approval proof](native-approval-feasibility.md): withheld responses prevented harmless sentinel effects, accept/deny targeted original actions, replay was rejected, and disconnect/restart limits were measured.
- [Integrated HTTP/MCP proof](fixtures/approval/application-spawn-observations.json): operator authentication/CSRF, signed decisions and native effects; a real root tool call registered an isolated child, whose terminal question automatically reached its parent. Claims remained unaccepted.
- [Two-member group proof](fixtures/approval/group-observations.json): both effects absent during a 2,002 ms hold, one frozen HTTP gesture, two separately verified signatures and two observed effects; audit valid. Native execution is not a cross-command transaction.
- [Root artifact proof](fixtures/approval/artifact-observations.json): actual scoped context retrieval and draft artifact publication with source-commit provenance.
- [Event coverage](session-event-coverage.md): terminal questions, failed/interrupted turns, command/file evidence and history limits were observed. Native materialized history can omit an interrupted in-flight command.

The UI was exercised against the service with a real native paused command and synthetic project/artifact/persona data. A single-member browser approval and a two-member native HTTP group were exercised separately; a multi-member browser combination matrix and mobile device verification remain release work. See the [UI verification report](operations-desk-verification.md) for the exact scope, including the remaining keyboard-only tree smoke and post-audit dock checks.

## Work that remains open

| Area | Remaining work / issue |
|---|---|
| Owned-session recovery | Application resume/rebind, history-gap reconciliation, capability renewal and prolonged failure/uncertain-delivery recovery: AGCP-009/010/015/024 |
| Registered child recovery | Reconcile an existing isolated worktree before retrying failed/terminated child provisioning: AGCP-012 |
| Inspection | Complete durable policy evaluations/resolver ancestry and broader recovered evidence: AGCP-016 |
| Conversation routing | Preserve structured terminal status in observations, classify uncertainty/decision proposals/waiting states, and verify full parent/human continuation with timeout/busy cases: AGCP-017/018 |
| Reproducible context | Complete skill procedures, persona metadata, artifact permissions/freshness and governed issue-planning integration: AGCP-019/020/021 |
| GitHub | Application authorization, engineering reference resolution and exact-proposal writes: AGCP-022/023 |
| Release | OS credential/encrypted-content storage, supported-version/runtime patch review, all eight acceptance journeys, packaging, onboarding/recovery and owner-selected license: AGCP-024/025 |

GitHub issues own current status. The [contract/lifecycle report](contracts-and-state.md), [accepted runtime decision](../decisions/0002-runtime-and-connector.md) and [README](../../README.md) document the implemented boundary. Existing desktop chat attachment and non-command native approval categories remain unavailable.
