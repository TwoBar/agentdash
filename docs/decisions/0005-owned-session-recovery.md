# ADR 0005: Scoped owned-session recovery

Date: 2026-11-13. Status: accepted. Scope: AGCP-009, AGCP-010, AGCP-012.

## Context

An application restart or terminated process invalidates native callback ownership. Retrying child provisioning must also preserve existing worktree edits. Native app-server history and thread resume are available in the tested CLI, but historical evidence cannot reconstruct authority.

## Decision

Keep native identities in adapter-private, scoped, validated metadata outside source control. Resume only a previously owned thread whose project, task, previous application session, canonical workspace and exact supported version match, after the former owned process is confirmed stopped. Refuse live or uncertain ownership without killing a recorded PID. Legacy sessions without a verified binding start fresh.

Resume creates a new application Session and process generation with fresh context and MCP capability. Do not restore native approval callbacks, decisions or former permissions. All new actions require current exact-action approval. History is normalized through a separate nonmutating ingestion path with stable aliases, original session attribution, bounded pagination and explicit gaps; exclude raw reasoning and default to metadata retention. Historical terminal events cannot accept tasks or trigger parent actions.

Reuse only a verified task worktree. Validate persisted ownership and Git registration/reciprocal metadata before reuse, preserve all edits, and refuse unknown paths or symlinks. Do not silently replace, reset or clean a failed task's workspace.

## Evidence and consequences

[Recovery research and native reproducers](../research/connector-recovery.md) demonstrate held old approval, stopped-owner resume, foreign-scope/live-owner refusal, invalid old callback, fresh required approval and stable historical provenance on Codex CLI 0.163.0-alpha.11.1. The full HTTP application run additionally passed fresh-session recovery, nonauthoritative history deduplication and a new signed native decision. A targeted graceful service restart repeated those checks after a new Runtime boot and operator authentication. A separate actual parent MCP review replied to its registered child's observation and continued that child into a new turn without accepting its task or granting native actions. Abrupt service crash or host reboot recovery is not yet proven by these runs.

Recovery does not undo already delivered commands, guarantee complete streamed history, attach desktop chats, or provide exactly-once execution. Private metadata contains identifiers and must remain local with service data. A future protocol change requires new compatibility evidence.
