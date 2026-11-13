# Agent Governance Control Plane

## Technical specification — Codex-first MVP

**Status:** Draft v0.2 — incorporates the 2026-11-13 workspace vision review  
**Architecture principle:** AGCP is a local-first control plane. Codex is the first execution harness. A connector adapter boundary permits future harness support without changing governance semantics.

## 1. System boundaries

| Component | Responsibility |
|---|---|
| AGCP desktop/local service | Project state, agent graph, persona/skill registry, artifact registry, policy evaluation, UI/API, audit log |
| AGCP web/desktop UI | Project tree, agent chat, approval inbox, decision-path inspection, settings |
| Codex connector | Starts/manages Codex sessions, maps native events to AGCP events, delivers context and decisions |
| Local approval bridge | Holds a pending Codex approval; verifies AGCP decision binding and returns the resolution to Codex |
| AGCP MCP server | Tools used by Codex agents to register artifacts, request children, report status, fetch context, and propose governed external actions |
| GitHub integration | Repository, issues, pull requests, commits, releases, and external artifact references |

## 2. Architectural rules

1. AGCP owns canonical project governance state.
2. GitHub owns canonical source-control and engineering collaboration artifacts.
3. Codex owns execution within its session, but a governed native approval cannot pass until the bridge returns a valid resolution.
4. Every agent, task, approval, artifact, policy, persona, and decision has a stable ID and immutable event history.
5. Connector-neutral domain events and approval schema are mandatory; Codex-specific details live only in the connector.
6. Actions fail closed when identity, binding, policy, or connectivity cannot be verified.
7. AGCP and Codex are two interfaces to the same registered session and governance lifecycle; they are not separate policy modes.

## 3. Core domain model

### Project graph

```text
Project
  └─ Task node (root orchestrator)
       ├─ Task node (strategy)
       ├─ Task node (codebase analysis)
       │    └─ Artifact: codebase map
       └─ Task node (issue planning)
            └─ GitHub issue references
```

### Main entities

| Entity | Key fields |
|---|---|
| Project | id, name, workspace, GitHub binding, policy set, root_task_id |
| Task | id, project_id, parent_task_id, objective, state, persona_version_id, session_binding, authority_grant_id |
| Agent session | id, task_id, harness, external_session_id, connector_id, state, capability_token_ref |
| Persona version | id, persona_id, instructions, mandate, authority template, context protocol, skills, tool/data constraints |
| Skill version | id, name, procedure, input/output schema, capability requirements |
| Artifact | id, project_id, logical_key, version, provenance, freshness, access classification, content/external_ref |
| Approval node | id, task_id, source_event_id, action_digest, state, risk, target, options, expiry, policy_snapshot_id |
| Decision | id, approval_id, resolver identity, decision, reason, evidence refs, policy/authority snapshot, signature |
| Authority grant | id, issuer, grantee task/persona, capability categories, targets, limits, expiry, delegation depth |
| Agent message | id, source_task_id, destination_task_id, kind, payload, source_turn_id, state, deadline |
| Turn observation | id, session_id, turn_id, terminal status, summary, classification, evidence refs, parent-routing state |
| Audit event | id, entity type/id, event type, actor, timestamp, payload digest, prior-event hash |

## 4. Persona compilation

At session creation, AGCP compiles a deterministic context package:

```text
session_context = {
  identity: {task_id, agent_session_id, parent_task_id},
  persona: {version, mandate, instructions, skills},
  task: {objective, acceptance_criteria, constraints},
  authority: {grant, escalation_rules, capability_token_reference},
  required_context: resolved artifact references and versions,
  reporting: output schema and completion contract,
  AGCP_MCP: local endpoint and scoped credentials
}
```

The connector passes this package into the Codex session using its supported session-initialization mechanism. The full package is recorded as a digest plus version references; sensitive values are not written to ordinary logs.

## 5. AGCP MCP tool surface

The initial MCP server exposes narrow, scoped tools to each session:

| Tool | Purpose |
|---|---|
| `get_task_context` | Retrieve assigned objective, parent summary, and approved context references |
| `resolve_artifact` | Resolve logical artifact keys to the current permitted version |
| `register_artifact` | Publish an artifact with provenance and requested freshness/status |
| `request_subagent` | Propose a child role, objective, required skills, and authority request |
| `get_child_status` | Read limited status of registered children |
| `report_status` | Report progress, blockers, and completion against structured state |
| `request_decision` | Ask for a governed decision not otherwise represented by a native harness checkpoint |
| `link_github_artifact` | Attach permitted GitHub issue/PR/commit references to a task or artifact |

The MCP server never trusts a caller-supplied parent or authority claim. It derives identity and scope from the session capability token.

## 6. Codex connector and approval bridge

### Connector contract

The Codex connector implements a normalized interface:

```text
startSession(context) -> SessionBinding
sendMessage(session, message) -> accepted
getSessionState(session) -> state
subscribe(session, handler) -> subscription
submitNativeDecision(pendingApproval, signedDecision) -> result
terminateSession(session) -> result
```

The exact implementation must use only Codex-supported session and approval interfaces. If Codex cannot expose a stoppable native approval at a requested action, AGCP labels that capability as unavailable rather than claiming enforcement.

### Normalized pending approval

```json
{
  "approval_id": "apr_...",
  "source": {"harness": "codex", "session_id": "...", "native_id": "..."},
  "task_id": "tsk_...",
  "action": {"kind": "tool_call", "summary": "Apply migration to staging", "digest": "sha256:..."},
  "target": {"type": "environment", "id": "staging"},
  "risk": {"level": "high", "reasons": ["write", "schema_change"]},
  "allowed_decisions": ["approve", "deny"],
  "expires_at": "...",
  "state": "pending"
}
```

### Decision binding

A decision sent back to Codex contains the approval ID, native ID, action digest, allowed decision, resolver identity, policy snapshot, authority grant reference, issued/expiry timestamps, and a cryptographic signature generated by the local AGCP service. The bridge verifies every field before delivery. A mismatch, duplicate, invalid signature, expired decision, or unavailable AGCP service results in no approval being granted.

## 7. Approval evaluation and escalation

```text
Codex pause
  → bridge creates pending node
  → policy categorizes action
  → nearest parent agent evaluates if authorized
      → resolve / reject / clarify / narrow / split
      → otherwise escalate to parent
  → human resolves if no valid delegate exists
  → bridge verifies and returns decision to Codex
  → audit event + task update
```

The resolver must satisfy both:

- Its authority grant permits the action class, target, amount/scope, and decision type.
- Required policy predicates are true, for example evidence attached, risk below threshold, no human-only category, and authority grant unexpired.

### Asynchronous parent review

When an approval reaches an eligible parent, AGCP writes an `approval_review` message to the parent's inbox. It may schedule a bounded parent review turn using that parent session's existing task context plus the immutable approval summary. The parent uses an AGCP-scoped resolution capability to approve, deny, narrow, split, clarify, or escalate. Parent review cannot change the child action digest; any material modification creates a replacement approval node. Parent unavailability, timeout, missing authority, or failure results in escalation according to policy.

## 8. Conversational turn observation and routing

Native approvals are structured harness events. Questions and completion claims expressed in agent messages are not equivalently reliable structured events and must not depend solely on a model calling a special MCP tool.

For every meaningful terminal or waiting turn, the connector persists the conversation event and AGCP produces a `TurnObservation`. A lightweight classifier assigns one or more advisory labels:

```text
awaiting_input | decision_proposal | blocker | completion_claim | progress_update | ambiguous
```

AGCP routes the observation to the parent inbox. `awaiting_input`, `decision_proposal`, and `blocker` trigger an alert. The parent agent or human can reply into the child thread, request more work, accept completion, escalate the issue, or take no action. The parent remains the final interpreter; classifier labels must never directly approve, terminate, or mutate the child task.

## 9. Session inspector

AGCP renders an application-owned session inspector from its persisted event ledger. An approval card opens the inspector anchored on its pending event. The inspector has:

- **Activity:** agent/user messages, tool activity, command output, errors, and timestamps.
- **Changes:** modified files, diffs, Git references, and verification evidence where available.
- **Context:** task objective, persona version, parent task, artifacts, authority, and workspace/sandbox summary.
- **Decision Path:** approval node, policy checks, authority chain, parent judgments, and resolution audit record.

The pending decision remains visible while inspecting context. A future native-Codex deep link may be additive, but AGCP's inspector is the review surface required for governance.

The Operations desk inbox also permits Approve and Deny directly on notification cards. Each approval segment has a counted Approve all action with member exclusion. A group gesture snapshots the displayed selected approval IDs and action digests; every member passes the normal one-shot decision checks and receives its own outcome/audit record. New arrivals are excluded, invalid members fail closed, and partial delivery remains explicit. This is not an atomic transaction across native executions. Questions and context blockers are not approval-group members. Manual human grouping is MVP; agent-curated recommendation bundles remain post-MVP. See [ADR 0003](docs/decisions/0003-operations-desk-and-group-approvals.md).

## 10. Artifact registry and context protocols

Artifacts are AGCP-native records with optional content or external references. A logical key can have many versions; resolution returns the latest approved, non-stale version that the caller may read.

Example protocol for `issue_planner`:

```text
required inputs: current_roadmap, codebase_map
preconditions: both approved; codebase_map derived from current default branch within defined freshness window
output: issue_proposals
side effect: GitHub issue creation only after required-input validation and governed approval
```

## 11. Security model

- Local service binds to loopback by default; inter-process traffic uses authenticated local channels.
- Session capability tokens are short-lived, scoped, and revocable.
- Secrets live in OS-backed secure storage where available; database holds references only.
- Sensitive prompt/content retention is configurable per project and default-minimal.
- The event ledger is append-only at the application layer, hash-linked, and exportable for audit.
- Repository access uses least-privilege GitHub tokens/app installations and separates read, write, administration, and release scopes.

## 12. Local persistence and portability

Suggested local database: SQLite with migrations for MVP. Store project metadata, task graph, persona/skill versions, artifact registry, approval state, and audit events locally. Keep blobs in a project-managed encrypted directory when content storage is enabled.

Export produces a portable project-governance archive with redaction options. Source code and credentials are never included by default. GitHub references remain references.

## 13. MVP implementation slices

### Slice 1 — Local project graph

- Project/task tree, one hard-coded orchestrator persona, local SQLite, basic desktop UI.
- Manual creation of child task nodes and task chat surface.

### Slice 2 — Codex sessions and MCP

- Start one Codex session from a task.
- Inject compiled context and expose `get_task_context`, `register_artifact`, `request_subagent`, and `report_status`.
- Validate/register child-session requests.

### Slice 3 — Approval bridge

- Receive one supported Codex native approval event.
- Render a pending approval card and hold/resume/reject its original session.
- Support direct card decisions and counted per-segment human group approval with member exclusion and independent validation/outcomes.
- Bind and audit a human resolution with fail-closed timeout.

### Slice 4 — Personas, artifacts, GitHub

- Versioned personas and context protocols.
- Artifact registry with `current_roadmap` and `codebase_map` demo flow.
- Optional repository creation/link and governed issue creation.

### Slice 5 — Delegated evaluation

- Authority grants, parent-agent recommendation/evaluation loop, escalation path, decision-path UI.
- Keep human-only categories enforced even when agent delegation is enabled.

### Slice 6 — Parent inbox and session inspection

- Persist terminal turn observations and route them to parent-agent inboxes.
- Classify conversational waiting/blocker/completion signals as advisory alerts.
- Support reply from parent/human to child session and show the full session-inspection flow anchored on an approval.

## 14. Open implementation decisions

- Exact Codex integration mechanism and which native approval events can be intercepted and resumed externally.
- Exact event coverage available for direct interaction with a registered Codex session, including whether all transcript/tool events can be mirrored without AGCP owning the visible chat client.
- Desktop stack and trusted local process model.
- Whether early agent chat is proxied through AGCP or uses a deep link/session embed into Codex.
- Formal policy language: declarative rules first, programmable policy later.
- Event-ledger integrity design and encryption-key recovery model.
- GitHub OAuth versus GitHub App authorization for personal MVP.
