# ADR 0002: Runtime, process model, and Codex connector

Date: 2026-11-13. Status: proposed / unresolved. Owner: AGCP-003.

## Context

The technical spec suggests SQLite and a local UI/service but intentionally leaves the desktop stack, trusted process model, and Codex interface open. Selecting a full stack before proving native approval behavior risks building around an unenforceable integration.

## Proposed direction

Evaluate an AGCP-owned Codex app-server process over stdio as the first connector transport. Evaluate a TypeScript UI and local service, with SQLite persistence and a later desktop wrapper, against a packaged desktop shell from the start. These are candidates, not installed dependencies or finalized choices.

The [official app-server documentation](https://learn.chatgpt.com/docs/app-server) is the starting protocol reference. The exact supported release and generated schema belong in the spike report.

## Decision checklist

- Link AGCP-001 native approval evidence and AGCP-002 event/coexistence findings.
- Compare a local service/browser UI, Electron, and Tauri against subprocess control, authenticated IPC, packaging, OS credential storage, and maintenance cost.
- Select runtime versions, package manager, repository layout, database/migration approach, and initial OS support.
- Define authenticated UI/service and MCP boundaries, origin/CSRF protection if HTTP is used, and session token revocation.
- Specify canonical action bytes, digest scope, decision signature boundary, one-shot dispatch, and recovery policy. Codex receives a supported native response only after AGCP verifies its own envelope; do not assume Codex validates an AGCP signature.
- Decide workspace/worktree ownership before allowing concurrent writers.
- Define what the local threat model can and cannot protect, including same-user processes and privileged host access.
- Choose licensing/distribution direction; record deferred choices with owners.
- Update this ADR to accepted with evidence and consequences before closing AGCP-003.

## Current consequence

The repository deliberately has no application package manifest, runtime lockfile, or placeholder server. AGCP-004 creates the real scaffold once the decision is complete.
