# ADR 0001: Sequence a human-governed MVP before delegated authorization

Date: 2026-11-13. Status: accepted for the initial implementation plan; revise through a new decision when product scope changes.

## Context

The supplied PRD's roadmap places delegated parent-agent approvals in “Next,” while its journeys describe the full future authority chain. Technical slice 5 includes delegated evaluation before slice 6's parent inbox and inspector. PRD MVP acceptance criteria 7 and 8 require automatic turn routing and a session inspector, but no MVP criterion requires delegated resolution.

## Decision

The MVP delivers human resolution of native approvals, policy-validated child creation, parent messages/recommendations, artifact protocols, and optional governed GitHub writes. Automatic child turn routing and the application-owned inspector are required MVP work. Human-only policy applies throughout.

Implement neutral authority and policy references from the foundation, while withholding agent resolution authority until M7. M7 adds grant evaluation, bounded parent review, escalation, and human-only enforcement. “Clarify,” “narrow,” and “split” are workflow outcomes; an action change creates a new approval and never reuses an old action digest.

Move the native-approval feasibility proof before application scaffolding. Begin with AGCP-owned Codex sessions. Concurrent direct/native UI use remains an explicit M0 capability question and a recorded MVP limitation if unsupported.

## Consequences

The first release has a smaller authorization surface while still satisfying all eight stated MVP criteria. This is the execution order for the initial backlog; it does not silently rewrite the source v0.1 documents. Future specification revisions should incorporate this sequence explicitly.

Source: [PRD](../../Agent-Governance-Control-Plane-PRD.md), sections 7, 11, 12; [technical specification](../../Agent-Governance-Control-Plane-Technical-Spec.md), sections 7, 8, 9, 13, 14.
