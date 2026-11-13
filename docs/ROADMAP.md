# Delivery roadmap

Planning baseline: 2026-11-13. Product name: AGCP; repository/working name: Agentdash. M0 is complete for the pinned experimental local build. M1–M5 have integrated implementations, including verified stopped-session resume/history, retained worktree reuse, detailed inspection, bounded parent continuation, rich persona/skill versions and profile-level GitHub proposals. Structured nonterminal waiting coverage and controlled live GitHub writes remain open. M6 release acceptance/packaging and M7 remain incomplete. GitHub owns exact issue completion state. Milestones are ordered by evidence and dependencies, without invented delivery dates. See the [current increment evidence](research/recovery-profile-increment.md).

## Release boundary

M0–M6 produce the Codex-first, single-user, local-first MVP. Human resolution is the enforcement path. The MVP includes registered child sessions, automatic conversational parent inboxes, and an AGCP-owned session inspector. Parent recommendations may be shown, but parent agents cannot authorize child actions until the post-MVP delegated-authority milestone.

See [ADR 0001](decisions/0001-mvp-sequencing.md) for how this reconciles the two draft specifications. [The backlog](BACKLOG.md) maps each milestone to implementable issues.

The vision review selected **Operations desk** as the default layout. M3 includes approval buttons on notification cards and Approve all per segment, with optional member exclusion and a separate result for each exact action. See [ADR 0003](decisions/0003-operations-desk-and-group-approvals.md). Agent-curated recommendation bundles remain M7.

| Milestone | Deliverable | Exit evidence | Depends on |
|---|---|---|---|
| M0 — Feasibility and decisions | Native approval proof, event/coexistence report, runtime and threat-model decisions | Real supported approval stays pending until resolved; approve and deny behavior captured; capability limits and architecture recorded | None |
| M1 — Local foundation | Runtime scaffold, neutral contracts, SQLite/audit, authenticated local service, project tree | Clean setup works; graph survives restart; boundary and migration checks pass; local state stays outside Git | M0 |
| M2 — Registered Codex sessions | Connector lifecycle, persisted activity, compiled context, scoped MCP, registered child execution | Root and child sessions have durable bindings; policy rejects invalid spawns; reconnect and identity tests pass | M1 |
| M3 — Human governance | Bound approval state machine, inline/grouped human approvals, recovery, session inspector | Exact-action approve/deny and group-member validation pass; inspector remains anchored on the pending event | M2 |
| M4 — Conversation routing | Automatic turn observations, parent inbox, bounded review/reply scheduling | A child question/blocker reaches its parent without an MCP call; no classifier-driven authorization or task completion | M3 |
| M5 — Personas, artifacts, GitHub | Versioned personas/skills, artifact freshness protocols, optional governed repo/issue operations | Missing/stale inputs block work; GitHub writes require an exact approved proposal; unauthorized mode works locally | M4 |
| M6 — MVP release readiness | Acceptance suite, security/recovery review, packaging and onboarding | All eight PRD acceptance criteria demonstrated; limitations documented; no unresolved release-blocking security defect | M5 |
| M7 — Delegation and portability | Scoped parent decision authority, recommendation bundles, redacted export/import | Delegation cannot bypass human-only policy; atomic nodes survive bundles; export excludes credentials and source by default | M6 |

M5 connects GitHub once at profile level, then creates or links a separate repository per project when connected. Account connection and repository binding are separate; local-only operation remains supported. The experimental OS-keyring-backed CLI provider and exact-proposal flow are implemented; controlled live remote-write acceptance remains under AGCP-023/024. See [ADR 0004](decisions/0004-profile-github-and-project-repositories.md) and [ADR 0006](decisions/0006-github-provider-and-exact-proposals.md).

## First work queue

1. **AGCP-001:** prove native command approval pause/accept/deny and characterize disconnect behavior in an isolated scratch workspace.
2. **AGCP-002:** establish event coverage and whether a registered session can also be used in a native Codex interface without losing governance ownership.
3. **AGCP-003:** use those reports to finalize runtime/process architecture, threat boundaries, and licensing direction.
4. **AGCP-004:** scaffold the application and runtime CI using the resulting decision.

AGCP-001 and AGCP-002 are ready research tasks. AGCP-003 depends on their evidence. This was the initial queue; the resulting native evidence and accepted runtime decision are linked in ADR 0002. Remaining work is tracked in GitHub.

## MVP acceptance traceability

| PRD criterion | Implementation issues | Milestone |
|---|---|---|
| 1. Local project and registered root orchestrator | AGCP-007, AGCP-008, AGCP-009, AGCP-011 | M1–M2 |
| 2. Policy-validated registered specialist | AGCP-012 | M2 |
| 3. Native approval visible while Codex remains paused | AGCP-001, AGCP-013, AGCP-014 | M0, M3 |
| 4. Human decision reaches exactly the intended action | AGCP-013, AGCP-014, AGCP-015 | M3 |
| 5. Tree, decision path, linked artifact | AGCP-008, AGCP-016, AGCP-020 | M1, M3, M5 |
| 6. Required missing/stale artifact blocks or escalates | AGCP-021 | M5 |
| 7. Child question/blocker automatically reaches parent | AGCP-017, AGCP-018 | M4 |
| 8. Approval inspector includes activity and ancestry | AGCP-010, AGCP-016 | M2–M3 |

AGCP-024 verifies all eight together against a supported Codex version. Passing isolated mocks alone cannot close M6.

## Later exploration

Additional harnesses, routing between harnesses, shared workspaces, enterprise policy, and analytics remain outside the MVP and M7. Promote them to issues when user evidence supports a specific scope.
