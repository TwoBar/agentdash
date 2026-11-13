# ADR 0004: Profile GitHub connection and project repositories

Date: 2026-11-13. Status: accepted product requirement, implementation pending. Owners: AGCP-022 and AGCP-023 / M5.

## Context

The user clarified that GitHub is connected at profile level and repositories are generated per project when connected. The current experimental build only stores an optional manual `owner/repository` reference; it does not authenticate the application or create remote repositories.

## Decision

- Connect and disconnect GitHub in profile settings. Reuse that authorized account connection across projects.
- Keep repository identity/binding on each project. Connecting an account does not select a global repository.
- Connected project setup offers creation of a repository for that project, with permitted owner, name and visibility, or linking an existing permitted repository. Local project setup works with GitHub disconnected.
- Repository creation remains an exact human-approved proposal. Profile connection does not grant blanket agent authority; changed account, owner, name, visibility or permissions invalidate the old write authorization.
- Store credential references separately from project repository bindings. Credentials never enter source repositories, task/session context, agent capabilities or normal logs. Revalidate account and target access at execution; revocation fails closed for remote actions.
- Local Git workspace availability and remote GitHub authorization are distinct capabilities.

## Consequences and remaining work

AGCP-022 owns profile connection/status/disconnection and permitted repository linking/reference reads. AGCP-023 owns per-project repository creation and exact-proposal writes. Test two projects using one connected account with distinct repository bindings, account revocation/mismatch, local-only operation, denied/changed proposals and ambiguous network completion without duplicate creation.

OAuth versus GitHub App and the secure credential provider still need an implementation decision with evidence. This ADR selects product ownership and workflow, not an authentication protocol or a completed integration. The developer's existing `gh` login does not imply an application profile connection.

Sources: [PRD](../../Agent-Governance-Control-Plane-PRD.md), [technical specification](../../Agent-Governance-Control-Plane-Technical-Spec.md), [AGCP-022](https://github.com/TwoBar/agentdash/issues/22), [AGCP-023](https://github.com/TwoBar/agentdash/issues/23).
