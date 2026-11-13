# Agentdash

A personal, local-first control plane for Codex coding agents. Coordinate registered tasks, review native command approvals, inspect decision evidence, and keep a durable project record from an Operations desk.

**Status: experimental local development build.** Real owned Codex sessions, command approvals and registered child workflows have been exercised. This is not a packaged MVP release; supported native categories, recovery and release limits are recorded below.

## Run locally

Use Node **22.20.0** and npm **10.9.3**. If you use nvm, run `nvm use` first.

```sh
npm ci
npm run dev
```

Open [Agentdash](http://127.0.0.1:4317). Create a project using an existing local directory, then launch its orchestrator explicitly. Merely opening the app does not launch a model or modify a project. Codex must be signed in through its normal supported CLI authentication.

The connector accepts the tested **Codex CLI 0.163.0-alpha.11.1**. Other versions appear unavailable until their protocol behavior is verified; the UI remains usable for local project organization. Initial development host: macOS; Linux CI exercises portable code.

For the compiled application:

```sh
npm run build
npm start
```

Set `AGENTDASH_PORT` to use a different local port. `AGENTDASH_DATA_DIR` may select a private data directory **outside** Git repositories and registered project workspaces. Default macOS data: `~/Library/Application Support/Agentdash`; Linux: `$XDG_DATA_HOME/agentdash` or `~/.local/share/agentdash`.

## What works

- Persistent projects and registered task trees, with separate task acceptance and session lifecycle.
- An owned Codex process per session; chat, interruption, termination and explicit completion acceptance.
- Scoped AGCP tools for task context, artifacts, child requests, child status and replies. Child launches pass depth/budget/input checks and use isolated Git worktrees. Non-Git child launch stays blocked.
- Real native **command** approvals with the reviewed invocation, immutable digest, per-boot signed human decision, one-shot native delivery and fail-closed invalidation.
- Approve/Deny on notification cards; counted group approval with member exclusion, frozen IDs/digests/revisions and individual outcomes.
- An event-anchored Activity / Changes / Context / Decision path inspector; raw reasoning is excluded.
- Automatic advisory turn observations and parent inbox routing without requiring the child to call an MCP reporting tool. Bounded parent review turns never authorize native actions.
- Nine versioned personas, cloning, draft/approved/stale artifacts, and required input/freshness checks.
- SQLite migrations, revision checks, source deduplication and a verifiable hash-linked audit ledger.

## Boundaries

Native command approval authorizes the invocation and working directory; it does not snapshot every script, environment value or resulting effect. Native file-change, network-group, permission and app/tool approval categories remain unavailable. Other native requests are refused, not silently treated as command authorization. Existing Codex desktop chat attachment is unavailable.

Internal AGCP coordination tools have a narrow explicit native tool allow list; their project/task authority is enforced by the service capability token. They cannot approve actions, accept their own completion, modify parentage or access another project. External actions still pass the native command checkpoint.

Run one service per data directory; an exclusive server.lock prevents overlapping boots from rewriting each other’s live state. A clean shutdown removes it. After a crash, confirm the recorded process has stopped before removing a stale lock. For a consistent metadata backup, stop the service cleanly and copy its private data directory to a protected location. Restoring a copy preserves historical records; the next boot invalidates old live sessions and approvals. Codex history and original source repositories have separate backup requirements.

Private signing keys live only in memory for one service boot. Restart invalidates former pending approvals and live sessions; it never replays an old native response. Delivery and execution are distinct; uncertain delivery requires inspection, not an automatic retry. Capabilities expire after 15 minutes; long-session rotation and recovery are release work.

Governance metadata stays outside source repositories. Default retention keeps session text in memory and persists minimal event metadata. Explicit local-content retention stores redacted messages/output in a **plaintext local database**, excludes raw reasoning, does not erase old content when turned off, and resets to minimal on restart. Redaction catches common credential patterns, not every possible secret. Codex independently retains its own local session history.

The loopback service uses an HttpOnly SameSite cookie, exact Host/Origin checks and CSRF tokens. This is a single-user local boundary, not isolation from a malicious program running as the same OS user or a privileged host administrator. Worktrees isolate source edits, not the operating system.

GitHub currently supports repository references; credentialed repository/issue writes, OS-backed persistent keys, encrypted content archives, supported-version expansion, prolonged recovery tests and desktop packaging remain planned. The experimental Node SQLite driver and runtime/embedded SQLite patch currency need release review. No open-source license has been selected; private package metadata is UNLICENSED and distribution is blocked on the owner's choice.

The planned GitHub workflow is a connection in **profile settings**, reused across projects. Each project creates its own repository or links an existing one when connected; local-only setup also works. Profile connection and repository creation are **not implemented yet**. See [ADR 0004](docs/decisions/0004-profile-github-and-project-repositories.md).

## Verify

```sh
npm run check
```

This runs type checks, focused unit/integration/security tests, the UI/server build and documentation/dependency checks. The native probes below consume model usage in isolated synthetic workspaces and require signed-in Codex; ordinary CI uses protocol doubles and never calls a model.

```sh
npm run spike:approvals
npm run spike:events
npx tsx scripts/spikes/native-approval-connector.ts --live
npx tsx scripts/spikes/native-approval-application.ts --live
npx tsx scripts/spikes/native-approval-group.ts --live
```

See the [first-build verification and remaining work](docs/research/first-local-build.md), [native evidence](docs/research/native-approval-feasibility.md) and [event coverage](docs/research/session-event-coverage.md) for exact measured behavior and gaps. An interrupted tool can be absent from recovered native history; locally observed evidence remains in the event ledger.

## Project documents

- [Product requirements](Agent-Governance-Control-Plane-PRD.md) and [technical specification](Agent-Governance-Control-Plane-Technical-Spec.md)
- [Roadmap](docs/ROADMAP.md), [initial backlog](docs/BACKLOG.md), and [readiness review](docs/READINESS.md)
- [Runtime and trust decision](docs/decisions/0002-runtime-and-connector.md), [accepted workspace UX](docs/decisions/0003-operations-desk-and-group-approvals.md), and [MVP scope](docs/decisions/0001-mvp-sequencing.md)
- [Parallel implementation contract](docs/research/implementation-contract.md) and [contributing](CONTRIBUTING.md)

[GitHub issues](https://github.com/TwoBar/agentdash/issues) are canonical for current progress. The checked-in backlog is the initial planning baseline.
