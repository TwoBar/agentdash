# AGCP-002: Codex session event coverage

Research date: 2026-11-13. Issue: [AGCP-002](https://github.com/TwoBar/agentdash/issues/2). Tested CLI: `0.163.0-alpha.11.1`; Node: `22.20.0`. This report concerns AGCP-owned sessions. It is not desktop attachment or release-readiness evidence.

## Method and data boundary

The reproducer is [session-events.mjs](../../scripts/spikes/session-events.mjs). It uses documented newline-delimited JSON-RPC over an owned `codex app-server --listen stdio://` child process, negotiates `experimentalApi: false`, creates a temporary Git workspace, and uses synthetic questions, a harmless command, an intentional command failure, a file edit, and an interrupted sleep. It grants no native approvals. The installed CLI's `generate-ts` output was inspected in a temporary directory; generated bindings are not application dependencies.

Raw events remain in process memory and are never printed or written. Reasoning/raw-response notifications are opted out and reasoning items are excluded from the live collector. Output contains counts, booleans, statuses, and protocol version only. The fixture contains sanitized aggregates, not transcripts, identifiers, local paths, credentials, or model reasoning. Codex itself persists these synthetic owned sessions in its normal local history; deleting the temporary workspace does not delete that supported history.

Run the offline observation checks:

```sh
node scripts/spikes/session-events.mjs
```

Run the signed-in live experiment explicitly; this consumes model usage and requires an already configured Codex CLI:

```sh
node scripts/spikes/session-events.mjs --live
```

No API key is read or copied. The child uses the CLI's existing supported authentication/configuration. A different CLI or account can produce different results. Re-run against any proposed supported-version change.

The successful run explicitly selected `model/list`'s `isDefault` entry, `gpt-6.1-sol`. An earlier implicit `thread/start` default selected `gpt-5-codex` and failed; model-list availability does not guarantee that an omitted model resolves to a usable model. Hooks, apps and Code Mode were disabled for this isolated experiment, with unified shell execution enabled. These are process-only overrides; user configuration was not modified.

## Measured capability matrix

Evidence: [successful owned-session aggregate](fixtures/events/successful-owned-session-aggregate.json) and [failed-model aggregate](fixtures/events/failed-model-aggregate.json). Proven means observed in this experiment, not a universal protocol guarantee.

| Capability | Result | Observed evidence and limit |
|---|---|---|
| User and final agent messages | Proven | 3 user messages and 2 completed agent messages; final question observed without MCP |
| Agent message deltas | Proven | 17 deltas; concatenated per-item deltas exactly matched final message text |
| Tool lifecycle and command results | Proven | Completed commands had ordered start/completion and exit codes 0 and 7 |
| Command output streaming | Not observed | No `item/commandExecution/outputDelta`; only final aggregated command output is available for this run |
| File-change item and turn diff | Proven | 1 completed file-change item, 3 `turn/diff/updated` events; this is execution/inspection evidence, not exact-diff approval evidence |
| Terminal child-style question | Proven at connector boundary | Final question plus completed turn observed automatically; no MCP tool invocation or special report; actual parent registration/routing remains application work |
| Terminal success and interruption | Proven | Completed, completed, interrupted across 3 turns; interrupt RPC returned before terminal notification |
| Failed model turns | Proven | Separate implicit-model run emitted 3 errors, 3 failed terminal turns; failed statuses survived restart |
| Retries and recoverable upstream errors | Untested | No controlled retryable upstream failure induced |
| Paginated history methods | Proven for one page | Both turns and items APIs returned stored data; 8 completed live items were found with matching IDs |
| Fresh-process resume | Proven after terminal turns | Same thread, turn and item IDs and statuses after process restart; no active turn or approval was resumed by this spike |
| Duplicate live delivery | None observed | 0 duplicate completed item identities in this run; no exactly-once guarantee inferred |
| Timestamp envelope | Proven | All retained live events contained `emittedAtMs`; timestamps are not event IDs |
| Invalid interrupt | Proven rejection | Wrong turn ID rejected with JSON-RPC code `-32600` |
| Native approvals/disconnect enforcement | Separate spike | This reproducer grants no approvals; see AGCP-001 evidence |
| Native desktop attachment/co-approval | Unavailable in MVP | No supported ownership/conflict guarantee established or simultaneous desktop test performed |
| Remote terminal/shared-server clients | Documented, untested | Not accepted as an alternate approval owner |

**Observed transcript gap:** the interrupted sleep produced an item start without a completion. History contained the 8 completed items, while the live stream had 9 starts. The unfinished command was not recovered as a persisted item. Preserve the live start in AGCP's ledger and display incomplete/interrupted evidence. History hydration alone cannot reconstruct every live event. Streamed token boundaries, turn-diff update history, transient errors/status changes, and pending-approval request ownership also must not be inferred from persisted final item snapshots.

## Supported interface and native coexistence

Official OpenAI documentation presents app-server as a client integration surface with streamed conversation items, history, approvals, and interruption. It also documents a remote terminal client, `codex --remote`, and Unix-socket transports. TCP WebSocket transport is explicitly labeled experimental and unsupported. These descriptions establish candidate integration surfaces, not AGCP's approval-ownership guarantees. [Official app-server documentation](https://learn.chatgpt.com/docs/app-server).

The tested CLI's public help exposes `app-server proxy --sock` and daemon management. Its generated `ThreadResumeParams` says that resuming a running thread rejoins it. Neither finding proves that a desktop chat can simultaneously attach to an independently owned stdio process while preserving a single approval authority. No private desktop database, credential store, rollout file, or transcript was read. No desktop listener was attached to and no running user chat was resumed or altered.

**MVP boundary:** AGCP owns the app-server process and renders its own chat/inspector. Simultaneous native desktop participation is unavailable in the initial product capability set because no supported end-to-end ownership/conflict contract has been established. This is a product availability decision, not a claim that all protocol-level multi-client use is impossible. Remote TUI coexistence is documented but untested here. Before enabling it, test approval recipient selection, competing replies, permission/configuration changes, concurrent `turn/start` steering, disconnect, request cleanup, and stale-client resolution. An observer must never become another approval authority implicitly.

## Ordering, identifiers, and recovery contract

The exact-version generated schema exposes `thread.id`, `thread.sessionId`, `turn.id`, and `item.id`. Do not derive a thread's session-tree identity from its thread ID. Notification envelopes have optional `emittedAtMs`, not a unique monotonic event sequence. Item deltas identify their thread, turn, and item. Persist an application receive sequence for transport order; do not order events solely by wall clock.

The schema exposes `thread/turns/list` with `itemsView: full`, `thread/items/list`, and opaque pagination/backwards cursors. History is a materialized item/turn view, not a replay log of every streaming notification or approval response. A connector must merge recovered items by the full binding and native IDs rather than append history as new activity. Never redispatch decisions during hydration.

There is no demonstrated exactly-once notification guarantee. Reconciliation should tolerate repeated snapshots and history overlap. Deltas cannot be safely deduplicated by text or timestamp: repeated text can be valid. If transport continuity is lost, mark the session uncertain, stop delivery of decisions, recover authoritative item/turn state, and show any evidence gaps explicitly. Recovered content is context, not renewed authorization.

Command result fields in the generated `ThreadItem` include command, cwd, process ID when available, status, aggregated output, exit code, and duration. File-change items contain changes and status. These fields describe observable execution; seeing a diff does not establish pre-execution exact-diff authorization. AGCP-001 separately determines approval payload sufficiency and native pause behavior.

## Inspector and parent-routing implications

A final agent message plus its matching `turn/completed` is enough to create an advisory terminal observation without any child MCP report. This spike does not register an actual parent or implement an inbox. The production connector must persist the terminal observation before scheduling parent routing and make that scheduling idempotent by the bound session and turn.

An agent's natural-language question or completion claim is content. It cannot approve anything, grant authority, accept a task, or mutate task completion. A failed command is also distinct from a failed model turn; render both status layers. An interruption can have an incomplete final message and unfinished tool evidence. The inspector must show the interruption and any missing results instead of inferring success.

## Remaining release gates

- Verify retry notifications and controlled upstream failures; do not induce account or external-service failures. Model-level failed turns were observed with the implicit configured model; the underlying provider error text was not retained.
- Exercise history pagination over multiple pages, compaction, content retention/truncation, and prolonged sessions.
- Verify disconnect during active commands and pending approvals in AGCP-001 and the connector recovery suite.
- Exercise duplicate/overlap reconciliation in application tests, including cross-project/session rejection.
- Re-test every capability on the exact Codex binary selected for product support. This alpha is research evidence, not a general compatibility claim.
