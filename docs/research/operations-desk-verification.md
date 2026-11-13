# Operations desk verification and acceptance gaps

Date: 2026-11-13. Scope: the local development build and issues [AGCP-008](https://github.com/TwoBar/agentdash/issues/8), [AGCP-016](https://github.com/TwoBar/agentdash/issues/16), [AGCP-017](https://github.com/TwoBar/agentdash/issues/17), and [AGCP-018](https://github.com/TwoBar/agentdash/issues/18). This is a record of observed flows and remaining acceptance work, not a claim that all four issues are complete.

## Actual browser verification

The in-app browser exercised the real HTTP service on an isolated loopback port. The service used a temporary data directory outside the source checkout and a synthetic Git workspace. There were no seeded execution sessions. Project/task/artifact/persona records were created through the UI. The signed-in installed Codex binary ran only owned synthetic sessions; no source-project code was changed by these sessions.

Observed flows:

- Empty workspace: no invented agents or activity; the create-project action opened a labeled form and focused its first field.
- Project creation: created a project and root task, then selected the registered orchestrator. The inspector showed its objective, persona, state, and session launch action.
- Native approval: launching the root produced a real command approval in the notification feed. A synthetic output file remained absent while the action was pending. Inline Approve/Deny/Inspect and the group action were present.
- Member exclusion: excluding the single displayed member changed the group action to disabled **Approve selected 0**. Including it restored **Approve all 1**. Clicking that real group action produced a separate successful member outcome; only then did the synthetic file appear with its expected content.
- Session inspection: Inspect opened the correct pending action, command, directory, expiry, state, and highlighted source event. Resolution updated that same selected approval to approved and disabled its resolution controls.
- Artifacts: created a draft with synthetic content, inspected its content and captured source commit, and approved it as project context.
- Personas: cloned the architect as version 2 with synthetic instructions; version 1 remained available and unchanged.
- Child sessions: registered a specialist under the root with the selected version-2 persona and launched it in an isolated Git worktree. Its terminal question appeared automatically in the inbox without a reporting MCP call. The child remained in review rather than being automatically accepted. A bounded parent review was scheduled.
- Reload and project separation: page reload retained the two projects, task tree, artifact, and persona version. Switching to the second project removed the first project's tasks, artifacts, questions, and activity. A stale local decision-result card on project creation was found and fixed by applying the full project-switch reset.
- Settings: the retention control disclosed plaintext local content storage, common credential redaction, exclusion of raw reasoning, non-erasure of earlier content, and reset to minimal after service restart. Escape closed the dialog and restored focus to its trigger.
- Desktop layout: independent feed/inspector scrolling preserved the header, sidebar, and footer. Browser developer logs showed no warnings or errors during these flows.

After stopping and restarting the actual service with the same synthetic data directory, authenticated HTTP state returned two projects, the original project's two tasks, one artifact, ten persona versions, valid audit integrity, minimal retention, and both old sessions disconnected. This confirms service-restart data recovery; the restarted view was not re-verified in a browser because the browser integration became unavailable during the later audit.

## Audit corrections

The later acceptance audit added exact directory/target information directly to approval cards. It also added an independent approval-review dock that preserves the selected action and its controls when changing inspector tabs or selecting context artifacts/personas. The dock can return to the original approval and can be explicitly unpinned; changing projects clears it. The selected source event remains highlighted.

Changes now explicitly labels missing diff evidence as unavailable and says that missing evidence does not establish that no files changed. Related artifact source commits are distinguished from unavailable diff base/head evidence. Context includes the persona version and explicitly labels unavailable exact sandbox evidence. Decision Path displays the recorded policy snapshot identifier and available resolution reason while labeling the missing detailed resolver/evaluation records.

Inspector tabs gained roving keyboard focus with Left/Right/Home/End navigation and a focusable content panel. These audit corrections passed TypeScript checking and production compilation. They have **not** yet had a successful post-change browser interaction run: the in-app browser was unavailable, and the Chrome integration failed during session naming/navigation. This tooling failure is not application evidence.

## Acceptance disposition

| Issue | Evidence available | Remaining acceptance work |
|---|---|---|
| AGCP-008 | Real project/root/child creation, details, empty state, native unavailable/disconnected state handling, reload and service-restart persistence; HTTP/runtime tests cover invalid scope/child and restart behavior | Complete the specifically requested keyboard-only project selection/tree/detail flow and observed loading/error recovery flow. Modal focus/Escape was tested; full task-tree keyboard interaction was not. Implementation is a closure candidate once these focused checks pass. |
| AGCP-016 | Real approval source-event inspection and same-view resolution; explicit evidence gaps, persona version, independent review dock and keyboard tab support implemented | Keep open. Verify the new dock across tabs, artifact/navigation changes and long output. Detailed recorded policy checks and resolver ancestry are not exposed by the state API. Exact sandbox and diff base/head evidence remain unavailable. Wrong-session/deep-link and long-output browser cases were not demonstrated. |
| AGCP-017 | Native child question observed without MCP, parent routing, persisted source binding, duplicate question-event and ambiguous-empty-content tests, claims remain unaccepted | Keep open. The audited classifier lacks a `decision_proposal` branch and treats every nonempty unmatched message as progress. Observation records do not separately persist terminal status, so failed/interrupted truth cannot reliably be recovered from the observation after content replacement/restart. Structured waiting requests, classifier uncertainty/failure, all label fixtures, root/orphan semantics, and failed/interrupted observation replay need complete evidence. |
| AGCP-018 | Parent review scheduled, bounded count/deadline code, human reply and completion endpoints, scope/acceptance tests; no model output grants approval | Keep open. The earlier live parent review encountered refused unsupported native requests, and child question → valid reply → child continuation was not demonstrated end to end. The audit found the old-observation-to-replacement-session reply risk; the service owner is addressing exact originating-session/boot validation. Verify foreign parent, busy/unavailable parent, actual timeout, loop bounds, and reply provenance/continuation after that fix. |

The table records the audit state. Later service changes and additional tests may resolve individual gaps; they do not retroactively make an unperformed browser or live flow proven.

## Limits

The native UI group flow used one member. Multi-member exclusion, new arrivals during dispatch, and mixed outcomes were not manually exercised in the browser. Server/native multi-member tests are separate evidence and should be cited separately. Mobile responsive styles and an agent picker exist, but no mobile viewport interaction/accessibility run was performed. No delegated approvals, desktop-session attachment, production packaging, or governed GitHub writes were validated by this browser exercise.

Only sanitized aggregate evidence is retained in this report. No transcripts, prompts from user work, secrets, capability values, signing material, or local databases were added to the repository. The synthetic QA service was stopped after the checks.
