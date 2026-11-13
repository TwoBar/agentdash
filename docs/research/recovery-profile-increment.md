# Recovery, context and GitHub profile increment

Verified 2026-11-13 on Node 22.20.0/npm 10.9.3 and native Codex CLI 0.163.0-alpha.11.1. This is an experimental local build checkpoint, not packaged MVP release acceptance. The initial backlog remains a historical baseline; GitHub issues own current completion state.

## User-visible fixes

The active-use operator cookie now refreshes with authenticated requests instead of expiring in the browser after thirty minutes while the server session remains active. Safe read bootstrap recovers an expired connection; mutations are never silently replayed. Polling is sequential and pauses appropriately. Connection loss disables approvals and preserves open form drafts. Missing workspace, Git and context errors identify a next action without exposing arbitrary connector diagnostics.

Project setup accepts existing directories and `~/` paths, or explicit folder creation and Git initialization. Git setup creates an empty baseline without staging existing files and refuses an already staged index. Service-managed Git operations disable hooks, signing, fsmonitor and inherited executable configuration; managed checkout refuses executable content filters or conditional configuration it cannot safely inspect. Native commands remain subject to their own reviewed approval. Project creation never launches a model. Shared GitHub connection belongs to profile settings; each project creates or links its own repository through separate review.

The inspector pins an approval while navigating activity/artifact context, shows the actual session's persona/input versions and original-session provenance, disables historical conversation controls, and displays recorded policy checks, signatures, human resolver and native delivery separately. Minimal retention preserves the reviewed command in memory after resolution; it does not persist that command merely to fill the inspector after restart. Keyboard tree navigation and detail focus were exercised in the browser.

## Real native recovery and continuation

The [recovery report](connector-recovery.md) and sanitized fixtures record actual owned-process evidence:

- A withheld old command had no sentinel effect; live/foreign ownership resume was rejected.
- Explicit stopped-owner resume created a fresh scoped application session and refused the former callback.
- A distinct new action required a fresh signed human approval; only its sentinel appeared.
- Actual HTTP application close/reopen against the same data directory preserved graph/history while invalidating live authority. Repeated history hydration deduplicated evidence and never created approval or acceptance authority.
- A real native parent received its child's automatic observation, called the scoped child-status/reply tools, and continued the child into a new turn. Completion remained unaccepted and no native action was authorized by the parent.

Child worktree tests preserve dirty tracked/untracked files and validate Git ownership before reuse; unknown, foreign and symlinked paths are refused untouched. Agent capability leases renew only inside the service for confirmed owned liveness, retain wall/monotonic checks and an absolute eight-hour lifetime, and cannot be renewed by an MCP caller.

## Persona, artifact and issue planning

Nine complete immutable persona versions include mandate, instructions, required inputs/outputs, escalation, tool scope, authority and reporting contracts. Skills are real versioned procedures. Session compilation pins persona/skill versions, and continuation cannot gain future-template permissions.

Artifact resolution checks project, task read scope, newest published version, approval/status, expiry and task source commit. An unpublished draft does not supersede approved input; an invalid published version cannot fall back around revocation. Existing pinned approval context remains exact and is rechecked for revocation/freshness without silently substituting newer content.

The HTTP MCP integration test resolves both logical planning inputs from the actual session, publishes a draft `issue_proposals` JSON list with service-derived immutable input references and originating session, approves the artifact as the operator, prepares one indexed issue, and separately approves that exact remote proposal. The provider in this test is synthetic. Negative cases cover forged read claims, missing/stale/unreadable/foreign inputs, replacement sessions, changed worktree HEAD, context revocation during dispatch checks and replay. Artifact approval alone cannot write to GitHub.

## GitHub evidence boundary

The implemented provider explicitly verifies an OS-keyring-backed GitHub CLI account, authenticated identity and available scopes. Tokens never enter the database, source, agent environment or session context. Write transport transiently retrieves the specifically connected keyring token, verifies its identity and uses that same token for a fixed-host HTTPS request. An unrelated active-account switch cannot change the actor of that write; redirects are refused. Read, repository creation and issue creation are distinct; administration/releases/merge/PR writes remain unavailable. See [ADR 0006](../decisions/0006-github-provider-and-exact-proposals.md).

A live GET-only smoke used the provider against the owned Agentdash repository and verified account/repository identity plus issue, file and commit references, with zero remote writes. Unit/integration tests and the synthetic browser provider exercise approved/denied/changed proposals, target/account/project mismatch, private visibility scope, uncertain completion, concurrent decisions and restart. Uncertain dispatch is never automatically resent; read-only reconciliation requires the exact marker and content. No test repository or issue was created in the real account for these checks. Controlled live creation remains open under AGCP-023/024.

## Browser verification

The explicit disposable `apps/web/qa/server.ts` harness runs real HTTP authentication, SQLite, state and governance with clearly labeled synthetic connector/GitHub providers. It is never imported by production. Browser checks exercised:

- Two displayed command approvals: exclude one, inspect the other through Context/artifact navigation, approve one selected member, and verify separate result plus the excluded pending member.
- Recorded post-resolution Decision path with eight actual signed policy checks, human resolver, delivery and audit; absent diff/delegation evidence remains explicit.
- Keyboard Home/Arrow/Enter task-tree navigation and focus into task detail.
- Profile connection, private per-project repository proposal review, issue proposal review and reference resolution, all using the synthetic provider.
- Connected new-project default offers a repository proposal; local-only remains selectable. Missing-folder submission reports a specific error and preserves its draft.
- Advancing the harness-only operator clock by thirty-one minutes preserves the form and connection. A simulated read outage disables decisions, retains the draft, and recovers; explicit folder/Git setup then creates the local project without a model.
- Switching projects clears the former project's selected task/inbox while retaining the shared profile connection.
- An approved synthetic issue-plan artifact shows its originating session and exact inputs. Prepare issue creates a pending indexed proposal, navigates to separate human review, and preserves the exact title/body/labels/input versions without publishing it.

These browser flows prove UI/service integration, not native enforcement or live GitHub creation. Native evidence is listed separately above. Physical/mobile viewport and the complete release combination matrix remain open.

## Automated verification and remaining gates

Run `npm run check` for type checks, all focused unit/integration/security tests, production builds and documentation/dependency validation. The final integrated run passed **221 tests**, type checks, production UI/server builds and documentation/dependency validation (26 Markdown files, 95 local links). Ordinary checks never call a model or create remote resources. Recovery probes and synthetic UI harnesses are opt-in.

Remaining release gates: abrupt crash/host reboot and send/ack uncertainty soak; native structured nonterminal waiting coverage; controlled GitHub writes in a designated owned target; the complete eight-criterion clean-state acceptance matrix; encrypted optional content and durable signing-key/recovery design; Node/SQLite patch review; clean-account packaging/onboarding and owner-selected distribution license. Existing desktop-chat attachment, non-command native approvals and M7 delegated approval authority remain unavailable. No exactly-once native execution or host-administrator-resistant audit claim is made.
