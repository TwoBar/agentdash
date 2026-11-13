# Working in Agentdash

Read README.md, both root specification documents, docs/ROADMAP.md, and the issue being implemented before changing application behavior. Check docs/READINESS.md and docs/decisions/ for unresolved assumptions.

## Current phase

This repository is in planning / pre-implementation. Start with M0 feasibility and architecture work. Do not describe a planned capability as implemented or a mocked approval as native enforcement. The application stack is unresolved until ADR 0002 is completed with evidence.

## Invariants

- Keep domain contracts connector-neutral; isolate Codex wire formats in its adapter.
- Bind decisions to the exact pending action and original session. Reject mismatches, replay, expiry, and missing authority; fail closed on connectivity uncertainty.
- Do not broaden a one-action decision into session-wide permission or a persistent policy amendment.
- The application derives task identity and scope from authenticated session capability tokens, never caller-provided authority claims.
- Agent messages, classifier labels, and completion claims cannot directly grant approval or mark a task accepted.
- Keep governance data local by default. Never commit real transcripts, raw reasoning, prompts, secrets, credentials, local databases, or signing material.
- Existing Codex desktop chat coexistence is an unproven capability until its spike establishes support. AGCP-owned sessions are the initial integration boundary.

## Workflow

Use the linked issue's scope, dependencies, and acceptance criteria. Record material architecture decisions in docs/decisions/. Keep the PRD and technical spec aligned when changing requirements; the existing v0.1 documents are the source baseline.

Run `python3 scripts/check_docs.py` for documentation or planning changes. Once application checks exist, run focused tests for changed behavior and the checks required by CI. Security-sensitive state transitions need negative-case evidence, including cross-project access, replay, and disconnect behavior where applicable.

Report what changed, how it was verified, and remaining limits. Do not add runtime commands or dependencies to documentation before they exist.
