# ADR 0003: Operations desk with inline and grouped human approvals

Date: 2026-11-13. Status: accepted in the user vision review. Implementation owner: AGCP-014 / M3.

## Context

The user selected the Operations desk direction and accepted its layout, persona divisions, and organization. They requested an approval button on each notification so reviewing and approving common actions does not require opening the session inspector, plus an Approve all action at the bottom of each notification segment. The remainder of the direction stays as reviewed.

## Decision

- Use Operations desk as the default workspace direction, retaining the agent tree, actionable notification groups, and evidence inspector.
- Approval cards show the action, requesting agent, target, impact, risk, and direct Approve and Deny actions. Inspect remains available for deeper evidence.
- Each approval segment exposes Approve all with the number of included pending actions. The user may exclude individual members; then the control states Approve selected with the count.
- Clicking a group action freezes the displayed member IDs and action digests. Newly arriving actions are excluded. Each member is validated, authorized once, and audited separately under the same human gesture.
- Expired, changed, disconnected, already-resolved, or otherwise invalid members cannot be approved. Partial outcomes are shown per member; the UI must not imply a transaction across independent harness executions.
- Questions, conversational decisions, and stale-context blockers stay separate from actionable approval groups and are never resolved by Approve all.

## Release scope and consequences

Direct notification approvals and manual grouped human approval belong to M3 in the MVP. This extends ADR 0001's human-governed scope without granting agents resolution authority. Agent-curated recommendation bundles and delegated authority remain M7; AGCP-027 builds on the manual grouping foundation.

The reviewed concept uses synthetic sessions and local interactions. It is design evidence, not proof that native enforcement or batch delivery has been implemented.

Sources: [PRD](../../Agent-Governance-Control-Plane-PRD.md), [technical specification](../../Agent-Governance-Control-Plane-Technical-Spec.md), [roadmap](../ROADMAP.md), and [AGCP-014](https://github.com/TwoBar/agentdash/issues/14).
