# ADR 0006: Explicit GitHub CLI profile connection and exact proposals

Date: 2026-11-13. Status: accepted for the experimental local build. Scope: AGCP-021/022/023.

## Context

ADR 0004 requires one profile connection and separate project repository bindings. The single-user local application needs an explicit credential provider without copying credentials into governance data or granting agents direct remote-write authority.

## Decision

Use a narrow GitHub.com provider backed by the existing GitHub CLI. Connecting the profile is an explicit operator action. Verify that the active account uses the OS keyring and matches the authenticated API identity; refuse environment tokens and plaintext fallback. Pass no inherited token or askpass environment to the CLI and store only identity/capability/provider references. For a write, retrieve the specifically connected keyring account token transiently into provider memory, verify `/user` with that same token, and use that same token for the exact HTTPS request. Never put it on disk, in environment/arguments, logs, agent context or the database. Refuse redirects. This pins the request actor even if another process switches the CLI active account; it does not claim guaranteed zeroization of JavaScript strings. Disconnect revokes application proposals and bindings for future writes without logging the operator out of GitHub CLI.

Expose verified read, repository-create and issue-create capabilities independently; administration, release, merge and PR writes remain unavailable. Unknown token scopes cannot imply write access. Organization membership is not proof of repository-create permission: GitHub still checks the actual request. OAuth or a GitHub App remains an alternative for a packaged application; the current provider does not implement those flows or claim repository-limited credentials.

Keep repositories on projects. Prepare immutable, expiring repository/issue proposals with exact account, target, visibility or title/body/labels, input references and a visible reconciliation marker. Human resolution binds the proposal revision/digest, current connection/project and context. Persist a signed decision and consume the dispatch intent before one remote attempt. Changed inputs, identity, target or permissions fail closed. A timeout, malformed response or interrupted dispatch becomes uncertain, never an automatic retry. Reconciliation searches for the exact marker and reviewed content; bounded search without a match remains uncertain.

Issue-planning output is a draft `issue_proposals` artifact containing a strict JSON list of title/body/optional labels. The service records the exact roadmap and codebase-map versions successfully resolved by the originating scoped session, rather than accepting agent-supplied provenance. Approving the artifact does not publish it. Preparing one indexed item creates another immutable proposal; publication still requires a human decision and current source-input validation. Manual human issue preparation remains supported with validated current inputs.

## Evidence and limits

Provider subprocess tests exercise environment filtering, keyring/account rejection, HTTP failure classification and path/ref encoding. Service tests cover cross-project/account/digest/revision/expiry, context revocation, denied writes, concurrent decisions, restart and uncertain-result reconciliation. The synthetic browser exercise created separate local projects and reviewed repository/issue proposals without remote effects. A real authenticated GET-only smoke resolved the owned project repository and engineering references; controlled live creation remains an M6 acceptance gate. See [the increment report](../research/recovery-profile-increment.md).

The provider relies on the operator's GitHub CLI and OS-user boundary. It does not protect credentials from a malicious program running as the same OS user. Per-boot application signing keys remain separate from GitHub's OS-keyring credential. No broad token is narrowed merely by labeling a UI capability unavailable; the service exposes only its implemented operations.

Primary references: [account-specific GitHub CLI token retrieval](https://cli.github.com/manual/gh_auth_token), [GitHub CLI credential storage](https://cli.github.com/manual/gh_auth_login), [GitHub CLI API interface](https://cli.github.com/manual/gh_api), and [repository REST operations and permissions](https://docs.github.com/en/rest/repos/repos).
