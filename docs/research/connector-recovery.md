# Owned-session recovery and worktree retry

Date: 2026-11-13. Scope: AGCP-009, AGCP-010 and AGCP-012. This report distinguishes native connector evidence from application integration evidence. The application remains experimental.

## Supported boundary

The adapter uses the documented app-server `thread/resume`, `thread/turns/list` and, when needed, `thread/items/list` methods. It supports exactly Codex CLI `0.163.0-alpha.11.1`, checked before starting each owned process. Existing desktop chats and arbitrary native thread IDs cannot be attached through this API. See the [official app-server documentation](https://learn.chatgpt.com/docs/app-server).

Recovery requires an adapter-private binding created by an earlier scoped application start. Its private directory contains native identifiers, opaque application aliases, the original project/task, canonical workspace, protocol version and process generation. Files use mode 0600 in an owned mode 0700 directory, reject symlinks and malformed or corrupted records, and are atomically replaced with directory synchronization. The checksum detects corruption; it does not protect against a privileged local attacker. Bindings contain no prompts, message text, capabilities, approval callbacks or credentials. Native identifiers never enter the public domain/history API.

A resume must match the original project, task, previous application session, canonical workspace and tested version. The former process must be confirmed stopped. A still-live PID or uncertain ownership is refused, and the adapter never kills a PID recovered from disk. A new process claims a new generation; late former-process callbacks cannot overwrite its binding. Legacy sessions without verified scoped metadata must start fresh.

The resumed application session has a fresh identity, context, scoped MCP capability and native callback map. Former approvals remain invalid. A history item cannot recreate a callback, dispatch a decision, change live task state, trigger parent routing or accept a task. A command delivered before disconnection may already have executed; recovery cannot roll it back or establish exactly-once execution.

## Historical evidence

History is normalized separately from live connector callbacks and is never emitted through `onEvent`. Stable opaque turn/item/phase aliases and originating application-session ownership support deduplication across replay. Reasoning and user instructions are excluded. Metadata is returned by default; explicitly requested local text is bounded and redacted. The application must retain the origin session when merging history and must not feed historical terminal snapshots through live state transitions.

Retrieval is bounded to 200 turns and 2,000 items, with bounded cursor pagination and repeated-cursor rejection. Materialized history does not reproduce every streamed event, so a gap notice always states that limitation. Interrupted/failed unfinished evidence and truncation add explicit gaps. `complete` therefore remains false. An unfinished command missing from persisted native history is not evidence of approval or execution. History cannot authorize work.

`isSessionAlive` checks only a currently initialized, adapter-owned process and transport. A private binding or recorded PID does not establish liveness. It supplies a local ownership signal for bounded service capability maintenance, not new agent authority.

## Worktree retry

An isolated task worktree can be reused after failed or terminated provisioning when its task marker, source repository, canonical path, Git common directory, registered worktree metadata and reciprocal Git directory pointer all agree. Tracked changes, untracked files and the current commit are preserved; retry performs no reset, clean or deletion. A legacy worktree can be adopted only when the caller also supplies its persisted task/workspace binding and all Git ownership checks pass.

Unknown directories, foreign repositories, mismatched markers, missing previously owned worktrees and symlinks fail closed without modifying the candidate. Per-task serialization prevents concurrent ownership races. Folder validation expands `~` and reports distinct actionable errors for missing folders, inaccessible folders and file paths.

## Verification

The reproducible native connector test uses disposable temporary directories and emits only sanitized outcomes:

```sh
npx tsx packages/codex/src/recovery.native.ts --live --output /tmp/agentdash-native-recovery.json
```

The signed-in native run on 2026-11-13 passed. A pending synthetic command was held for 2,003 ms without its sentinel. Resume while its owner was live and a foreign-project resume were rejected. After termination, a fresh connector resumed the owned thread into a new application session. The former callback could not be used, the old sentinel remained absent, and no former approval was reissued. A new turn required a new native decision; accepting it created only the fresh sentinel. Repeated history retained stable aliases, old/new session provenance, interrupted/completed terminal snapshots, two gap notices and no default text.

The checked-in [native connector outcomes](fixtures/recovery/native-connector.json) retain only verified flags, counts and CLI version. They contain no native/application identities, paths, text, prompts, credentials or protocol bodies.

Focused synthetic tests cover exact-action decisions, cross-session callback isolation, replay, disconnect, environment filtering, scoped recovery, private metadata exclusion, stable history, pagination, dirty-worktree preservation and ownership refusal. These subprocess doubles test adapter behavior; they do not replace the native proof. The native result above demonstrates graceful termination/resume, not a full application crash/reboot or every uncertain-delivery case.

## Actual application recovery and continuation

The full application reproducer starts the real HTTP operator boundary, scoped HTTP MCP server, SQLite audit store, governance signer and native connector in disposable workspaces:

```sh
npx tsx scripts/spikes/recovery-application.ts --live --output /tmp/agentdash-recovery-application.json
```

The 2026-11-13 native run passed. Through authenticated HTTP it created a project, started a task, observed an actual pending command without its sentinel, terminated the session and explicitly resumed it into a fresh Session. The old approval became disconnected and a frozen attempt to approve it was rejected. Two history loads returned stable evidence with two gap notices and added no duplicate activity. Historical ingestion created no decision, pending approval or accepted task state. A new message required a new native command approval bound to the new Session; its independently signed decision was valid and delivered. Only the fresh sentinel appeared. The task remained in review.

A second disposable project proved automatic parent/child continuation. An idle native parent received the registered Research child's question through the service's automatic observation route. The parent actually called `get_child_status`, then `reply_to_child` with that observation ID through its scoped MCP connection. The observation became replied and the child completed a distinct subsequent turn. The child remained in review, unaccepted, with zero native approvals granted. The authenticated operator fallback included in the reproducer was not used. This proves one bounded parent review and continuation, not every provider failure, timeout or repeated-review case.

The checked-in [application and continuation outcomes](fixtures/recovery/application-continuation.json) record those verified flags and counts without source content or identities.

A second targeted run also closed the application and store, created a new Runtime boot and HTTP listener against the same disposable data directory, reauthenticated the operator and resumed the stopped owned thread. History remained stable and nonauthoritative after that service restart; the former approval was refused and only a fresh signed native decision produced its new sentinel. Reproduce that bounded scenario with:

```sh
npx tsx scripts/spikes/recovery-application.ts --live --restart --recovery-only --output /tmp/agentdash-recovery-application-restart.json
```

The audit chain remained valid and all persisted event text was null in minimal retention mode in both runs. All app-server processes and temporary repositories were closed and removed. The reproducer prints only synthetic outcome flags, counts and version; it does not retain request bodies, native IDs, source paths, prompts or credentials. Graceful service restart is covered; abrupt service crash or host reboot remains a separate scenario. In those cases a live or uncertain former process is refused rather than adopted.

The checked-in [service restart outcomes](fixtures/recovery/application-restart.json) contain only verified flags, counts and CLI version. Final local cleanup inspection found zero matching synthetic temporary directories and zero native process working directories in these recovery workspaces; all inspected Codex process working directories were readable. This is scoped cleanup evidence for these runs, not a claim that unrelated desktop or service sessions were stopped.

## Final privacy review and limits

Recovery records contain native identities and canonical paths only in private local adapter storage. The three checked-in outcome files contain booleans, counts and the pinned version exclusively. No callbacks, signatures, source content, raw reasoning, authorization headers, prompts, session tokens or local database files are included. Explicit local content retention remains subject to bounded redaction; it is not a guarantee that every possible secret embedded in arbitrary text can be detected.

The remaining limits are abrupt service crash/host reboot evidence, already delivered effects that cannot be undone, incomplete bounded materialized history, and legacy or uncertain native ownership that requires a fresh session or operator recovery. Reused worktrees intentionally retain dirty edits and Git registrations; safe retry does not delete those retained resources. Adapter compatibility remains restricted to the exact tested CLI. The accepted [ADR 0005](../decisions/0005-owned-session-recovery.md) records this scope.
