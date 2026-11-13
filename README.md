# Agentdash

Agentdash is the working name for **Agent Governance Control Plane (AGCP)**: a personal, local-first workspace for coordinating Codex coding agents, reviewing approvals, and tracing decisions and artifacts across a project.

**Status: planning / pre-implementation.** The repository contains the product specification and an implementation backlog. There is no runnable application yet.

## Start here

- [Product requirements](Agent-Governance-Control-Plane-PRD.md)
- [Technical specification](Agent-Governance-Control-Plane-Technical-Spec.md)
- [Delivery roadmap](docs/ROADMAP.md)
- [Issue backlog and dependencies](docs/BACKLOG.md)
- [Readiness review and open decisions](docs/READINESS.md)
- [MVP scope decision](docs/decisions/0001-mvp-sequencing.md)
- [Accepted workspace and approval UX](docs/decisions/0003-operations-desk-and-group-approvals.md)
- [Runtime decision to resolve](docs/decisions/0002-runtime-and-connector.md)
- [Contributing](CONTRIBUTING.md)

[GitHub issues](https://github.com/TwoBar/agentdash/issues) track implementation progress; [milestones](https://github.com/TwoBar/agentdash/milestones) group the delivery sequence. The checked-in backlog is the initial planning baseline, not a live mirror of issue status.

## First delivery target

Prove that an AGCP-owned Codex session can pause on a supported native approval, remain paused, and execute or reject exactly the reviewed action. Record the supported protocol version, event coverage, and disconnect behavior before committing to the full application stack.

Then deliver a local project and task tree, registered sessions, a human approval inbox and session inspector, automatic parent inbox routing, versioned personas and artifacts, and optional governed GitHub operations.

## Development

Runtime, package manager, desktop shell, and application commands will be selected in milestone M0. No dependency installation or model access is needed for the current documentation checks:

```sh
python3 scripts/check_docs.py
```

Use a branch per issue and a pull request that links its acceptance criteria and verification evidence. Implementation starts with the M0 spikes in the backlog.

## Data boundaries

GitHub stores source code, engineering docs, issues, and PRs. The future application stores governance state locally. Session transcripts, prompts, secrets, capability tokens, signing keys, and local databases do not belong in this public repository. Use synthetic, sanitized fixtures for integration evidence.

No open-source license has been selected yet. Repository visibility does not grant an open-source license; license selection is tracked in M0.
