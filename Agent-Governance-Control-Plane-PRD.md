# Agent Governance Control Plane

## Product requirements document

**Status:** Draft v0.3 — incorporates the 2026-11-13 workspace and GitHub connection reviews  
**Scope:** A personal, local-first development control plane with Codex as the first supported execution connector.

## 1. Product summary

Agent Governance Control Plane (AGCP) lets one person run and govern many AI coding-agent sessions through one project-scoped workspace. It centralizes agent tasks, live status, artifacts, delegation, and—most importantly—approval requests that would otherwise be handled in separate harness UIs.

AGCP is not a replacement coding harness. Codex executes the work; AGCP coordinates sessions and becomes the human-facing interface for governed actions.

## 2. Problem

Modern coding agents regularly pause for decisions: tool use, command execution, credentials, file changes, Git operations, external side effects, and deployment. With many concurrent agents, the operator must jump among sessions, loses visibility of the overall plan, and cannot consistently retain accountability.

Existing harness approval prompts are session-local. They do not provide a shared decision queue, an explicit delegation graph, or a durable governance record across an entire project.

## 3. Product vision

One project dashboard is the control plane for a hierarchy of agents running in one or more harnesses. Every governed action remains an atomic node with traceable provenance. Agents can evaluate or resolve nodes on behalf of a human only within explicit authority boundaries; all other nodes escalate through their parent chain to the human.

The dashboard and Codex are complementary views into one governance system, not separate operating modes. A user may work iteratively in a Codex session while the same session remains registered to the project tree and reports its activity, decisions, artifacts, and escalation state to AGCP.

## 4. Goals

- Create and govern a development project from one workspace.
- Launch, observe, and communicate with multiple Codex sessions as registered agents.
- Translate Codex approval pauses into a unified approval inbox; Codex must remain paused until a valid resolution returns.
- Preserve atomic approval nodes while supporting parent-agent recommendations and optional human-approved bundles.
- Make the complete delegation and decision path inspectable without forcing users to read raw reasoning.
- Define reusable personas, skills, and context protocols that produce predictable project artifacts.
- Integrate with GitHub as the engineering system of record.
- Keep rich governance state separate from source repositories and local-first by default.

## 5. Non-goals for MVP

- Supporting more than one execution harness.
- Building a universal command interceptor for arbitrary local software.
- Replacing GitHub issues, pull requests, or CI/CD.
- Autonomous production deployment or unrestricted credential delegation.
- Enterprise multi-user administration, SSO, billing, or organization-wide policy management.

## 6. Target user

An individual developer/product builder using multiple coding-agent sessions on one software project, who wants a coherent agent structure and one place to approve consequential work.

## 7. Core user journeys

### 7.1 Create a project

1. User optionally connects GitHub once in profile settings. That account connection is reusable across projects; repository bindings belong to individual projects.
2. User creates a project. If GitHub is connected, project setup offers creation of a repository for that project, with the permitted owner/organization, name, and visibility reviewed before the governed write. Linking an existing permitted repository is also supported. Without GitHub, the project remains local.
3. AGCP creates or links the approved repository when requested, creates a root project node, and starts the project orchestrator persona in Codex.
4. User chats with the orchestrator to establish vision, constraints, and roadmap.
5. The orchestrator proposes a work tree and requests specialist agents as needed.

### 7.2 Delegate work

1. A parent agent requests a child role and objective through AGCP's agent-control tools.
2. AGCP validates spawn policy, budget, depth, and permissions.
3. AGCP registers the child node, compiles its session context, starts a Codex session, and returns its task identity to the parent.
4. Status, artifacts, messages, and approval nodes attach to that child in the project tree.

### 7.3 Resolve an approval

1. Codex pauses at a native approval point.
2. The local bridge converts it to an immutable normalized approval node and holds the Codex session.
3. Parent agents evaluate the node in ascending order of authority. They may approve, reject, ask for clarification, reduce scope, split the node, or escalate.
4. If no parent can validly resolve it, AGCP presents it to the human.
5. A valid decision returns to the original paused session. The decision is bound to that exact action and cannot be replayed for another action.

### 7.4 Route conversation and decision requests

Not every important interruption is a native harness approval. A child may end a turn with an architecture question, missing-input request, trade-off, blocker, proposed decision, progress report, or completion claim.

AGCP automatically reports meaningful child turn endings to the parent-agent inbox. It classifies the turn as likely awaiting input, proposed decision, completion, progress, or ambiguous. Classification is advisory: the parent decides whether to reply into the child thread, ask for revision, accept completion, escalate to its parent, or leave the session idle. The flow must not depend on each agent remembering to invoke a special tool.

### 7.5 Inspect an approval in context

Selecting an approval opens an AGCP session inspector, anchored on the exact pending event. The approval remains pinned while the user reviews the relevant preceding agent messages, tool calls, command results, changed files/diff, parent assessment, task context, and decision path. The full event transcript remains expandable. AGCP owns this review experience; opening a separate native Codex UI is an optional future convenience, not a requirement.

### 7.6 Produce engineering outputs

Personas follow declared context protocols. For example, a codebase analyst publishes a codebase map to AGCP; an issue-planning agent must retrieve the current roadmap and codebase map before proposing GitHub issues. GitHub contains the resulting code, issues, PRs, documentation, and releases—not the complete internal coordination trace.

## 8. Functional requirements

### Project control plane

- Project-scoped tree of objectives, tasks, agents, artifacts, and approval nodes.
- Chat with any registered agent from AGCP.
- Agent lifecycle: requested, provisioned, running, waiting for approval, blocked, completed, failed, cancelled.
- Agent inboxes for asynchronous parent/child messages, approval reviews, blockers, and completion reports.
- Project dashboard defaults to actionable items, grouped by workstream/objective and sortable by risk, urgency, owner, and status.
- Session inspector with Activity, Changes, Context, and Decision Path views.

### Personas and skills

- Versioned persona templates define mandate, role instructions, authority, tool/data scope, escalation policy, required inputs, expected outputs, and completion/reporting contract.
- Skills are reusable procedures attached to personas; the same skill may be used by several personas.
- MVP persona library: project orchestrator, architect, senior implementer, junior implementer, codebase analyst, security reviewer, test engineer, release reviewer, and research agent.
- User can clone and edit personas, with version history used by each session.

### Artifact registry

- AGCP owns a project-level registry for artifacts and their versions, status, provenance, freshness, access scope, and external references.
- Agents resolve logical inputs such as `current_roadmap` and `codebase_map` through the registry, rather than fixed repository paths.
- Registry supports references to GitHub files, issues, pull requests, commits, and AGCP-native documents.

### Approval governance

- An approval node contains: action description, immutable action digest, requested capability, target/resource, impact, reversibility, risk, source session, parent task, expiry, decision options, evidence links, and recommendation.
- Default card exposes what, why, impact, risk, recommended decision, and current owner.
- The Operations desk is the default workspace direction. Approval notifications include direct Approve and Deny controls plus Inspect for deeper context.
- Each approval segment has Approve all with a member count and optional individual exclusion. The human gesture applies only to the displayed selected pending nodes, preserves exact-action validation and separate outcomes, and excludes questions and context blockers.
- An expandable decision path shows every parent judgment, policy check, authority limit, escalation reason, and evidence link.
- Atomic nodes are permanent. A bundle is a recommendation over member nodes, not a replacement; the human can inspect or remove members.
- Policies define human-only categories, delegable categories, maximum delegation depth, expiry, and fail-closed behavior.
- A child approval routes to the nearest eligible parent agent first. AGCP can wake or resume that parent for a bounded review turn; an unavailable, unauthorized, or timed-out parent causes escalation, not an indefinite child block.

### GitHub integration

- Connect/disconnect GitHub at profile level; project creation reuses the authorized connection without asking for credentials per project.
- Each project owns its repository binding. A profile connection is not a global repository selection or blanket approval for agent writes.
- Create or link repositories in MVP if GitHub authorization is configured.
- Local Git availability and GitHub account authorization are separate; local-only projects work without a GitHub connection. See [ADR 0004](docs/decisions/0004-profile-github-and-project-repositories.md).
- Surface and govern selected GitHub side effects: repository creation, issue creation, pull-request creation, merge, collaborator or permissions changes, and releases.
- Link project tree nodes and artifacts to GitHub issues, PRs, commits, and files.

## 9. Trust, safety, and audit requirements

- A parent may resolve a child node only if both authority and relevant policy conditions are satisfied.
- All resolutions record agent/human identity, policy version, timestamp, exact action digest, and authority chain.
- No action may proceed after disconnect, invalid signature, mismatched digest, or expiry; default is deny/timeout.
- An approval response may authorize only the exact pending request and one permitted decision type.
- Agents cannot self-grant roles, expand their tool scope, change parentage, or create unregistered sub-agents.
- Raw prompts, reasoning, source code, and secrets remain local by default; remote synchronization is opt-in and selectively scoped.

## 10. Success metrics

- Median time from approval request to resolution.
- Share of governed actions resolved by policy or delegated parent versus human.
- Human context-switches avoided per project.
- Approval-action binding failures: target zero.
- Percentage of completed tasks with traceable artifact and decision provenance.
- Successful Codex pause/resume rate.

## 11. MVP acceptance criteria

1. A user creates a local project, starts an orchestrator in Codex, and sees it as the root task node.
2. The orchestrator requests a specialist sub-agent; AGCP registers and starts it only after policy validation.
3. A Codex approval appears in AGCP and the original Codex session demonstrably remains paused.
4. A human resolution resumes or rejects exactly the intended Codex action.
5. The dashboard shows the task tree, approval decision path, and a linked artifact record.
6. A persona requires a registered artifact before proceeding, and AGCP blocks or escalates when it is absent/stale.
7. A child turn ending in an apparent question or blocker automatically reaches the parent inbox without relying on a child MCP call.
8. An approval card opens a session inspector showing the request's relevant activity and decision ancestry.

## 12. Roadmap

**MVP:** local AGCP, Codex connector, task tree, persona templates, artifact registry, native approval bridge, inline and manually grouped human approvals, basic GitHub integration.  
**Next:** delegated parent-agent approvals, recommendation bundles, configurable policies, richer GitHub actions, project export/import.  
**Later:** additional harness adapters, harness-selection routing, shared workspaces, enterprise controls, policy packs, and analytics.
