# Native Codex approval feasibility — AGCP-001

Date: 2026-11-13. Result: **go for a version-pinned, AGCP-owned command-approval prototype**. This is a native integration spike, not an implemented application or a production support guarantee. Existing desktop chats, WebSocket reconnect, non-command approvals, and long-lived availability are outside the proven boundary.

## Interface and exact version

Tested `codex-cli 0.163.0-alpha.11.1`, the installed macOS CLI, using the documented app-server stdio transport and v2 thread/turn methods. Authentication used the existing signed-in CLI through the supported process; the probe never reads credential files or asks for an API key. The model was the server's `model/list` default, `gpt-6.1-sol`, rather than the older implicit thread model default.

The [official OpenAI app-server documentation](https://learn.chatgpt.com/docs/app-server) describes embedding Codex with JSON-RPC, native approvals, and streamed item events. The CLI labels app-server experimental. The tested build and generated schema are the compatibility boundary, not a promise that subsequent builds behave identically.

Generated outside the repository:

```sh
codex app-server generate-ts --out /tmp/agentdash-approval-schema-ts
codex app-server generate-json-schema --out /tmp/agentdash-approval-schema-json
```

Stable-output JSON bundle: 318 files; SHA-256 `26d29150781fc9fb69e43c8e0fbe2d4834f4032a34d28383332177e80a884314`. The digest concatenates each sorted bundle-relative schema filename, NUL, its raw bytes, NUL. Generated files stay outside Git. Relevant generated types are `ThreadStartParams`, `TurnStartParams`, `CommandExecutionRequestApprovalParams`, `CommandExecutionRequestApprovalResponse`, `CommandExecutionApprovalDecision`, `FileChangeRequestApprovalParams`, and `PermissionsRequestApprovalResponse`.

Initialize with `clientInfo` and `capabilities.experimentalApi: false`, acknowledge `initialized`, then start a thread with `approvalPolicy: on-request`, `approvalsReviewer: user`, and `sandbox: read-only`. Check the returned effective configuration. Synthetic turns request a harmless `touch sentinel-*` command with native escalation. The harness rejects any unexpected tool category, command, cwd, or thread/turn identity. It never accepts policy amendments or session grants.

## Native evidence

Run the checked-in probe with signed-in Codex:

```sh
node scripts/spikes/native-approval.mjs --live --output /tmp/agentdash-native-approval-summary.json
```

This makes model-backed calls. No package installation is needed. The probe creates and deletes an OS temporary scratch workspace, keeps wire content only in memory, discards stderr, and emits a sanitized summary. The persistent synthetic restart case uses supported Codex thread persistence outside this repository; ephemeral threads are used for the other cases. Normal host MCP server startup can still occur from inherited CLI configuration; the probe requests no MCP actions. It disables hooks and apps for these synthetic sessions.

The [recorded observation summary](fixtures/approval/native-observations.json) contains only known synthetic command text, method names, counts, statuses, and relative outcomes. Native thread, turn, item, callback, and real filesystem identifiers are omitted. The [protocol example](fixtures/approval/command-request-response.synthetic.json) uses invented identifiers and is an illustration, not independent enforcement evidence.

| Case | Live observation |
|---|---|
| Hold | Two concurrent native requests remained pending for at least 2,000 ms. Both sentinel files were absent before and throughout the bounded hold. |
| Accept | Responding `accept` to request A created only A's sentinel; request B stayed pending without its side effect. Command A completed. |
| Deny | Responding `decline` to B left B's sentinel absent. Its command item finished `declined`; the agent turn completed without a retry. |
| Native correlation/replay | Two threads had distinct native request, thread, and item IDs. An unknown response ID released neither; replay of A's response while B remained pending did not release B. |
| One-action scope / expiry | A later command in A's same session produced a fresh approval; the previous `accept` did not become session permission. After a bounded hold, client `cancel` produced an interrupted turn without a sentinel. This establishes an implementable client timeout path; native automatic TTL was not proven. |
| Client disconnect | Closing app-server stdin during pending approval caused server exit code 0. After shutdown the sentinel remained absent. |
| Process loss/restart | SIGKILL while pending left the sentinel absent. A new server resumed the same persistent thread with the former turn `interrupted`, no reissued approval callbacks, and no effect over a further 2,000 ms. |

These are bounded observations on one host. They do not establish indefinite holding, cross-machine behavior, races after a valid dispatch, or termination of an already executing approved command.

## Binding and decision limits

The native request is `item/commandExecution/requestApproval`. This build supplies `kind`, `threadId`, `turnId`, `itemId`, `startedAtMs`, `environmentId`, exact `command`, `cwd`, a friendly parsed `commandActions` array, and possibly policy-amendment suggestions. JSON-RPC callback IDs can be numeric, including **0**; truthiness checks lose valid requests. Generated schema also has optional `approvalId`, which distinguishes multiple callbacks sharing an item (for example stdin/bridge callbacks). A product binding must include connector process/transport generation and the exact callback, not only the item.

The exact command string and cwd were present for the tested shell commands. `commandActions` is best-effort display information. A command string is not an immutable snapshot of scripts, environment, executable contents, or external resources; the application must describe the authorized invocation accurately and must not advertise exact-diff or complete-effect authorization from these fields.

The response contains only the callback's JSON-RPC `id` and `{ decision }`. Codex does not receive or validate AGCP action digests, project IDs, human authority, signatures, or expiry. Those are mandatory application bridge checks before dispatch. The live native correlation checks above are not proof of cross-project application access control or signature verification.

The generated schema permits `accept`, `decline`, and `cancel`, plus session/policy widening choices. The live request advertised `accept`, an execpolicy amendment, and `cancel`; `decline` nevertheless worked in this build. A product client should honor the native advertised options and use `cancel` for a human denial when `decline` is unavailable. Never substitute `acceptForSession`, an execpolicy amendment, or a network policy amendment for a one-action decision.

Pending callbacks are process-local. After disconnect/process loss, invalidate all AGCP pending dispatch capabilities for that connector generation. Resuming a thread is not recovery of its former approval callback. Require a new native pending request and new review. Never send an old numeric response ID to a replacement process, which may reuse that number.

## Coverage inventory

| Category | Status | Limit / product behavior |
|---|---|---|
| Local shell command escalation | **Proven**, bounded live hold/accept/deny | Enable only requests with complete command/cwd and verified original session/callback binding. |
| Stdin / bridged subcommand callbacks | Schema present, **untested** | Reject until exact scope and callback handling have their own evidence. |
| File changes | Schema/documented surface, **untested** | Approval params do not contain an exact diff; correlate immutable proposed item changes before any future enablement. Fail closed initially. |
| Managed network | Documented surface, **untested** | Destination approvals can unblock grouped queued requests. They are not one-command decisions; leave unavailable for the exact-action command slice. |
| `request_permissions` | Schema/documented surface, **untested** | Turn/session permission grants broaden access. Do not map an approval card to a permission grant. |
| MCP elicitation | Schema/documented surface, **untested** | Form/URL input is not automatically exact-action authorization. |
| App/MCP side-effect tool approvals | Documented surface, **untested** | Different input/approval flow; no payload-completeness proof. Disabled initially. |
| Existing desktop chat coexistence | **Unproven** here | Owned app-server sessions only; AGCP-002 owns the investigation. |
| Native automatic approval expiry | **Not established** | Implement bridge deadline + cancel/termination; reject late responses. |

## Conclusion and follow-through

The central native command checkpoint is feasible with an owned app-server and the tested CLI build. Proceed with connector-neutral domain contracts, a pinned adapter, explicit unsupported categories, application-owned authority validation, and fail-closed disconnect/restart handling. This closes the command feasibility question; it does not implement AGCP governance, prove production hardening, or authorize integration with arbitrary existing desktop chats. Negative application tests for project isolation, missing authority, expiry, replay, and dispatch uncertainty remain required by AGCP-013/015.


## Implemented adapter follow-up

The initial adapter now lives in `packages/codex/src/index.ts`. Its version probe accepts exactly the tested CLI. It owns one process per session, opaque callback/turn aliases, command digest and one-shot checks, process-generation invalidation, and safe refusal of unsupported request categories. It distinguishes item start/completion identities while retaining stable identity on delivery replay. Reasoning events/items are excluded; forwarded activity text is bounded and configured session credentials are redacted. Content persistence remains the service's retention decision.

The adapter disables native `multi_agent` and `multi_agent_v2`, hooks and apps using the installed supported feature toggles. Before thread creation it enumerates inherited server/plugin names through supported `config/read`, disables them with nested per-thread config, and enables only the service-supplied AGCP MCP definition. Empty MCP tables merge with inherited config and do **not** isolate tools. Native MCP inventory is checked before the session is exposed as started. No config values or raw process logs are logged. Built-in child spawning is disabled; this does not claim to control arbitrary same-user programs or the full effects of a human-approved shell invocation.

The reproducible actual-adapter smoke is:

```sh
npx tsx scripts/spikes/native-approval-connector.ts --live --output /tmp/agentdash-native-connector-summary.json
```

The [sanitized adapter observation](fixtures/approval/connector-observations.json) records two real owned processes, a 2,003 ms hold, rejected cross-session/digest/replay attempts, accepted sentinel creation, and cancellation without the denied sentinel. The denial turn finished `interrupted`, as expected for advertised `cancel`. Adapter unit tests use an explicitly synthetic protocol subprocess and are separate from this live evidence.

The approval inbox covers actions that Codex actually pauses for. Commands already allowed by its read-only sandbox can execute without a native approval request. This adapter does not synthesize enforcement for every command or tool.

## Full application follow-up

The real application smoke starts `Runtime` and `createApplication` on an isolated loopback port with disposable SQLite and committed scratch Git workspaces:

```sh
npx tsx scripts/spikes/native-approval-application.ts --live --output /tmp/agentdash-native-application-summary.json
```

The [sanitized application observation](fixtures/approval/application-observations.json) proves operator cookie/CSRF setup, two authenticated native MCP `get_task_context` calls bound to the correct task/session, native approvals held 2,002 ms without effects, signed approve/deny decisions with `sent` delivery, rejected member replay, accepted sentinel creation and denied sentinel absence. The accepted task ended in human review; denial left the other task blocked. The SQLite audit verified 94 events, and all persisted activity text stayed null in minimal retention. Wire content, capability tokens, keys/signatures, native IDs, local paths, and prompts are absent from the fixture.

The first integration attempt exposed missing MCP read-only annotations: transport initialization and tools/list succeeded, but native `mcpServer/elicitation/request` intercepted `get_task_context`. The adapter correctly refused this unsupported category. Declaring truthful read-only/idempotent/non-destructive/closed-world annotations on the three read tools enabled actual context calls without weakening command approval or pre-approving unknown MCP side effects. The smoke separates context verification and shell execution into two turns for clearer evidence. It wraps only the disposable server's MCP stream in memory to verify actual successful tool responses; model completion claims are not evidence of tool execution.

A subsequent bounded end-to-end run adds an actual registered research child:

```sh
npx tsx scripts/spikes/native-approval-application.ts --live --spawn --output /tmp/agentdash-native-application-spawn-summary.json
```

The [registered-child observation](fixtures/approval/application-spawn-observations.json) repeats native approve/deny with a 2,003 ms hold under the current scoped AGCP tool policy, then proves one successful `request_subagent` MCP call, a registered child session with its own working `get_task_context`, an isolated committed Git worktree, and automatic `awaiting_input` observation routed to the original parent. The child was not marked accepted and did not receive native action authority. The audit verified 140 events with no persisted activity text.

The AGCP server explicitly exposes its eight bounded coordination tools and applies a per-tool `approve` mode only to those tools, with `prompt` as the default for anything else. These handlers enforce authenticated session scope, parent/depth/budget/artifact constraints and local graph/provenance access. There is no MCP action-approval or external-write tool. This configuration is application authorization for its own scoped coordination interface, not translation of one native command decision into a session-wide or third-party grant. Native command escalation remains human `on-request`; inherited servers, plugins and apps remain disabled. [The official MCP configuration reference](https://learn.chatgpt.com/docs/extend/mcp) describes the per-server/tool approval controls used here.

## Native two-member group and process environment

A focused group-only application probe avoids rerunning other model scenarios:

```sh
npx tsx scripts/spikes/native-approval-group.ts --live --output /tmp/agentdash-native-group-summary.json
```

The [two-member group observation](fixtures/approval/group-observations.json) proves two pending native command approvals in one project, from separate registered Research child sessions in isolated Git worktrees. Their shared parent did not start a model. Both sentinels remained absent through a 2,002 ms hold. One authenticated HTTP gesture containing the two frozen IDs/digests/revisions produced two independent signed, verified decisions and native dispatches. Both effects appeared, both decisions recorded `sent`, both approvals recorded `approved`, and both tasks entered human review. The audit verified 76 events. This is one human gesture over two separately validated actions, not an atomic native execution transaction.

The connector now filters the inherited environment for both its CLI version probe and native process. Only `HOME`, `PATH`, `USER`, `LOGNAME`, `SHELL`, `TMPDIR`, `TEMP`, `TMP`, `LANG`, `LC_*`, `TERM`, `CODEX_HOME`, `SSL_CERT_FILE`, and `SSL_CERT_DIR` are inherited; the service explicitly supplies the scoped session capability separately. Unrelated cloud tokens and `NODE_OPTIONS` are not silently delegated to Codex. A focused protocol-subprocess test verifies host secret exclusion and explicit capability forwarding. The native group run above passed with this filter using existing signed-in CLI authentication through the approved runtime environment.

## Root context and provenance stub

The focused root artifact probe runs without shell actions or child sessions:

```sh
npx tsx scripts/spikes/native-approval-artifact.ts --live --output /tmp/agentdash-native-artifact-summary.json
```

The [root artifact observation](fixtures/approval/artifact-observations.json) records actual native `get_task_context` and `register_artifact` MCP calls, once each. The resulting draft artifact is version 1, scoped to the authenticated root task/project, with provenance matching the committed scratch workspace HEAD. The root ended in review, granted itself no approval, and authorized no native action. The audit verified 34 events. The fixture contains synthetic aggregate outcomes only. Explicit MCP output-schema validation is assessed separately from this live tool-execution proof.

## Acceptance audit at the initial PR boundary

| Issue | Evidence / remaining boundary |
|---|---|
| AGCP-009 | Owned start/message/interrupt/termination, version failure, disconnect and native smoke exist. Keep open: application resume/rebind is not implemented; a research-only native resume does not satisfy application resume. |
| AGCP-011 | Compiled context digest/persona/artifact references and capability scope have application tests; native root context retrieval and provenance stub now have live evidence. Close only after the MCP output-schema validation work and its negative case pass; input schemas and live execution alone do not establish that criterion. |
| AGCP-012 | Actual registered child/MCP/worktree/question flow, simultaneous isolated children, launch budget and failure/token cleanup have evidence. Keep open for complete denied depth/authority/tool-scope verification and worktree compensation/retry ownership. Existing task worktree paths are retained and need reconciliation before a failed/terminated child can be relaunched. |
| AGCP-013 | Supported command slice has exact action/callback/session checks, canonicalization, signed-envelope verification, negative binding/expiry/policy cases, concurrent winner/replay tests and real native delivery evidence. Broader native categories remain unavailable by design. |
| AGCP-014 | Native single approve/deny and two-member frozen HTTP group are proven; backend tests cover mixed validity/new arrivals and per-member outcomes. Browser evidence includes direct single-member approval and exclusion/count behavior. Multi-member browser exclusion/new-arrival/mixed-result combinations require their own recorded UI verification; backend evidence must not be described as that browser proof. |

This is an evidence audit, not a change to issue scope or an automatic assertion that all MVP/release gates are complete.
