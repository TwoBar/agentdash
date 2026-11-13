# Initial issue backlog

Planning baseline: 2026-11-13. GitHub is canonical for ongoing issue status. This document records the initial scope and dependencies; checked-in catalog: [backlog.json](planning/backlog.json).

P0 marks the critical path or security boundary; P1 is required milestone work; P2 is a follow-up enhancement. **Ready** means dependencies are satisfied at this baseline. All implementation is not started.

| ID | Work item | Milestone | Priority | Initial state | Depends on |
|---|---|---|---|---|---|
| AGCP-001 | Prove native Codex approval pause, accept, deny, and failure behavior | M0 | P0 | Ready | None |
| AGCP-002 | Map session events and direct Codex UI coexistence limits | M0 | P0 | Ready | None |
| AGCP-003 | Select runtime, trust boundaries, workspace strategy, and licensing direction | M0 | P0 | Blocked | AGCP-001, AGCP-002 |
| AGCP-004 | Scaffold the chosen application workspace and runtime CI | M1 | P0 | Blocked | AGCP-003 |
| AGCP-005 | Define neutral entities, events, and task/session state transitions | M1 | P0 | Blocked | AGCP-004 |
| AGCP-006 | Implement SQLite migrations, durable graph state, and hash-linked audit events | M1 | P0 | Blocked | AGCP-005 |
| AGCP-007 | Build authenticated local project/task APIs and scoped identity | M1 | P0 | Blocked | AGCP-006 |
| AGCP-008 | Create local project workspace UI and persistent task tree | M1 | P1 | Blocked | AGCP-007 |
| AGCP-009 | Implement owned Codex connector lifecycle and capability negotiation | M2 | P0 | Blocked | AGCP-007 |
| AGCP-010 | Ingest session activity and replay it into a durable inspector timeline | M2 | P0 | Blocked | AGCP-006, AGCP-009 |
| AGCP-011 | Compile initial persona context and expose scoped AGCP MCP tools | M2 | P0 | Blocked | AGCP-005, AGCP-007, AGCP-009 |
| AGCP-012 | Register policy-validated child sessions with isolated workspaces | M2 | P0 | Blocked | AGCP-009, AGCP-011 |
| AGCP-013 | Implement immutable approval records and one-shot decision binding | M3 | P0 | Blocked | AGCP-005, AGCP-006, AGCP-009 |
| AGCP-014 | Deliver human approval inbox and native accept/deny flow | M3 | P0 | Blocked | AGCP-008, AGCP-010, AGCP-013 |
| AGCP-015 | Harden approval expiry, disconnect, crash recovery and key loss | M3 | P0 | Blocked | AGCP-013, AGCP-014 |
| AGCP-016 | Build approval-anchored Activity, Changes, Context and Decision Path inspector | M3 | P1 | Blocked | AGCP-010, AGCP-014 |
| AGCP-017 | Observe terminal turns and route advisory signals into parent inboxes | M4 | P0 | Blocked | AGCP-010, AGCP-012 |
| AGCP-018 | Add parent/human inbox replies and bounded review-turn scheduling | M4 | P1 | Blocked | AGCP-014, AGCP-017 |
| AGCP-019 | Version persona and skill templates and ship the MVP role library | M5 | P1 | Blocked | AGCP-011 |
| AGCP-020 | Implement versioned logical artifact registry and permitted resolution | M5 | P1 | Blocked | AGCP-006, AGCP-011, AGCP-019 |
| AGCP-021 | Enforce required artifact context protocols before issue planning | M5 | P0 | Blocked | AGCP-019, AGCP-020 |
| AGCP-022 | Add optional GitHub authorization, repository linking and read-only references | M5 | P1 | Blocked | AGCP-007, AGCP-020 |
| AGCP-023 | Govern GitHub repository and issue creation with exact proposals | M5 | P0 | Blocked | AGCP-013, AGCP-014, AGCP-021, AGCP-022 |
| AGCP-024 | Verify all MVP journeys and security/recovery release gates | M6 | P0 | Blocked | AGCP-008, AGCP-012, AGCP-015, AGCP-016, AGCP-018, AGCP-021, AGCP-023 |
| AGCP-025 | Package the local MVP and document onboarding, recovery and limits | M6 | P1 | Blocked | AGCP-024 |
| AGCP-026 | Add bounded parent authority, delegated decisions and escalation | M7 | P1 | Backlog | AGCP-018, AGCP-025 |
| AGCP-027 | Add transparent recommendation bundles over immutable approval nodes | M7 | P2 | Backlog | AGCP-026 |
| AGCP-028 | Implement redacted project export/import and integrity validation | M7 | P2 | Backlog | AGCP-025 |

## Using the queue

Start AGCP-001 and AGCP-002. Their reports unblock AGCP-003; its accepted ADR unblocks scaffolding. Later issues may be developed in dependency order, but milestone closure also requires the roadmap exit evidence.

Initial labels reflect this graph. Keep GitHub labels and issue dependency references current as work completes; do not read the initial blocked label as a permanent state. No due dates, assignees, or completion claims are invented.

The two source specification documents remain the v0.1 baseline. [ADR 0001](decisions/0001-mvp-sequencing.md) resolves the MVP sequencing conflict. [ADR 0002](decisions/0002-runtime-and-connector.md) remains proposed.

## Acceptance and verification

Each linked issue contains outcome, scope, dependencies, acceptance criteria, verification steps and specification references. Model-backed experiments must leave an issue open when native evidence is unavailable. Human-only governance is MVP; delegated resolution and bundles are M7.
