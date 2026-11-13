import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { Artifact, Project } from "../../../packages/domain/src/index.js";
import { displayIssuePlan } from "./issue-plan.js";
import { LocalApi, asFailure, type ApiFailure } from "./api.js";

export type GitHubProfile = {
  connected: boolean;
  connectionId: string | null;
  identity: { id: string | number; login: string; avatarUrl?: string } | null;
  capabilities: {
    read: boolean;
    repositoryCreate: boolean;
    issueCreate: boolean;
    administration: boolean;
    release: boolean;
  };
  status: string;
  reason?: string;
  credentialProvider: "gh-cli" | string;
  owners: Array<{ id: string | number; login: string }>;
};
export type GitHubProposal = {
  id: string;
  revision: number;
  kind: "repository.create" | "issue.create";
  payload: Record<string, unknown>;
  actionDigest: string;
  connectionId: string;
  state: string;
  reason?: string;
  externalUrl?: string;
  expiresAt: string;
  artifactInputs?: Array<{
    id: string;
    logicalKey: string;
    version: number;
    sourceCommit: string | null;
  }>;
};
type ReferenceResult = {
  kind: string;
  repository: string;
  url: string;
  title?: string;
  summary?: string;
  sourceCommit?: string;
  resolvedAt: string;
  content?: string;
};
export type InitialRepository = {
  owner: string;
  name: string;
  visibility: "private" | "public";
  repository: string;
};

export function useGitHubProfile(api: LocalApi, enabled = true) {
  const [profile, setProfile] = useState<GitHubProfile | null>(null);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [loading, setLoading] = useState(false);
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setProfile(await api.get<GitHubProfile>("/profile/github"));
      setFailure(null);
    } catch (error) {
      setFailure(asFailure(error, "Load GitHub profile"));
    } finally {
      setLoading(false);
    }
  }, [api]);
  useEffect(() => {
    if (enabled) void refresh();
  }, [enabled, refresh]);
  return { profile, failure, loading, refresh };
}

type Actions = {
  api: LocalApi;
  busy: boolean;
  run: (work: () => Promise<void>) => Promise<void>;
  notify: (message: string) => void;
};

export function GitHubSettings({ api, busy, run, notify }: Actions) {
  const { profile, loading, failure, refresh } = useGitHubProfile(api);
  return (
    <section className="github-settings" aria-labelledby="github-profile-title">
      <div className="section-heading">
        <h3 id="github-profile-title">GitHub profile</h3>
        <span
          className={`badge ${profile?.connected && !failure ? "green" : ""}`}
        >
          {loading
            ? "Checking connection"
            : failure
              ? "Connection status unavailable"
              : profile?.connected
                ? `Connected as ${profile.identity?.login || "verified account"}`
                : "Not connected"}
        </span>
      </div>
      <p>
        Connect once for this profile. Each project keeps its own repository.
        Local projects and native approvals work without GitHub.
      </p>
      {failure ? (
        <div className="inline-error" role="alert">
          <strong>{failure.operation}</strong>
          <p>{failure.message}</p>
          <button className="text-button" onClick={() => void refresh()}>
            Check connection again
          </button>
        </div>
      ) : null}
      {profile?.reason && <p className="form-note">{profile.reason}</p>}
      <p className="credential-note">
        This connection uses GitHub CLI's existing external credential store.
        Agentdash does not collect a token here or perform an OAuth sign-in.
        Connecting checks that account only when you choose Connect.
      </p>
      {profile?.connected ? (
        <>
          <dl className="facts">
            <dt>Account</dt>
            <dd>{profile.identity?.login || "Identity unavailable"}</dd>
            <dt>Credential provider</dt>
            <dd>GitHub CLI credential store</dd>
            <dt>Read references</dt>
            <dd>{profile.capabilities.read ? "Available" : "Unavailable"}</dd>
            <dt>Create repositories</dt>
            <dd>
              {profile.capabilities.repositoryCreate
                ? "Available with an exact human-approved proposal"
                : "Unavailable"}
            </dd>
            <dt>Create issues</dt>
            <dd>
              {profile.capabilities.issueCreate
                ? "Available with current context and an exact human-approved proposal"
                : "Unavailable"}
            </dd>
            <dt>Administration</dt>
            <dd>
              {profile.capabilities.administration
                ? "Authorized by provider; no action exposed here"
                : "Unavailable"}
            </dd>
            <dt>Releases</dt>
            <dd>
              {profile.capabilities.release
                ? "Authorized by provider; no action exposed here"
                : "Unavailable"}
            </dd>
          </dl>
          <button
            className="button deny"
            disabled={busy || loading}
            onClick={() =>
              void run(async () => {
                await api.post(
                  "/profile/github/disconnect",
                  {},
                  "Disconnect GitHub profile",
                );
                await refresh();
                notify(
                  "GitHub disconnected from this profile. Your GitHub CLI login was not changed.",
                );
              })
            }
          >
            Disconnect profile
          </button>
          <small className="muted">
            Disconnect removes Agentdash's connection reference. It does not
            sign you out of GitHub CLI.
          </small>
        </>
      ) : (
        <button
          className="button"
          disabled={busy || loading}
          onClick={() =>
            void run(async () => {
              await api.post(
                "/profile/github/connect",
                { provider: "gh-cli" },
                "Connect GitHub profile",
              );
              await refresh();
              notify(
                "GitHub account checked. Review the connected identity and available capabilities.",
              );
            })
          }
        >
          Connect using GitHub CLI
        </button>
      )}
    </section>
  );
}

export function GitHubProject({
  api,
  busy,
  run,
  notify,
  project,
  refreshWorkspace,
  openSettings,
  initialRepository,
}: Actions & {
  project: Project;
  refreshWorkspace: () => Promise<void>;
  openSettings: () => void;
  initialRepository?: InitialRepository;
}) {
  const {
    profile,
    loading,
    failure,
    refresh: refreshProfile,
  } = useGitHubProfile(api);
  const [proposals, setProposals] = useState<GitHubProposal[]>([]);
  const [listFailure, setListFailure] = useState<ApiFailure | null>(null);
  const [kind, setKind] = useState<"repository.create" | "issue.create">(
    "repository.create",
  );
  const [repository, setRepository] = useState(
    initialRepository?.repository || project.githubRepo || "",
  );
  const [owner, setOwner] = useState(initialRepository?.owner || "");
  const [name, setName] = useState(initialRepository?.name || "");
  const [visibility, setVisibility] = useState<"private" | "public">(
    initialRepository?.visibility || "private",
  );
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [labels, setLabels] = useState("");
  const [reference, setReference] = useState("");
  const [referenceResult, setReferenceResult] =
    useState<ReferenceResult | null>(null);
  const path = `/projects/${encodeURIComponent(project.id)}/github`;
  const refresh = useCallback(async () => {
    try {
      const result = await api.get<
        GitHubProposal[] | { proposals: GitHubProposal[] }
      >(`${path}/proposals`);
      setProposals(Array.isArray(result) ? result : result.proposals);
      setListFailure(null);
    } catch (error) {
      setListFailure(asFailure(error, "Load GitHub proposals"));
    }
  }, [api, path]);
  useEffect(() => {
    if (!busy) void refresh();
  }, [refresh, busy]);
  useEffect(() => {
    if (project.githubRepo) setRepository(project.githubRepo);
  }, [project.id, project.githubRepo]);
  useEffect(() => {
    if (!owner && profile?.identity) setOwner(profile.identity.login);
  }, [profile, owner]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const proposal =
      kind === "repository.create"
        ? { kind, owner, name, visibility }
        : {
            kind,
            repository,
            title,
            body,
            labels: labels
              .split(",")
              .map((value) => value.trim())
              .filter(Boolean),
          };
    await run(async () => {
      await api.post(`${path}/proposals`, proposal, "Prepare GitHub proposal");
      await refresh();
      notify(
        "Proposal prepared. Review the exact target and content below; no GitHub write has been approved yet.",
      );
    });
  }
  async function decide(
    proposal: GitHubProposal,
    decision: "approve" | "deny",
  ) {
    const snapshot = {
      decision,
      expectedRevision: proposal.revision,
      actionDigest: proposal.actionDigest,
    };
    await run(async () => {
      await api.post(
        `${path}/proposals/${encodeURIComponent(proposal.id)}/resolve`,
        snapshot,
        decision === "approve"
          ? "Approve GitHub proposal"
          : "Deny GitHub proposal",
      );
      await refresh();
      await refreshWorkspace();
      notify(
        "Proposal decision recorded. Check its individual outcome and linked result.",
      );
    });
  }
  return (
    <section className="github-project">
      <div className="github-project-heading">
        <div className="eyebrow">Engineering connection</div>
        <h2>One project, its own repository.</h2>
        <p>
          {project.githubRepo
            ? `Project reference: ${project.githubRepo}`
            : "Keep this project local, link a permitted repository, or prepare a repository creation proposal."}
        </p>
        <button className="text-button" onClick={openSettings}>
          Open profile connection settings
        </button>
      </div>
      {failure && (
        <div className="inline-error" role="alert">
          {failure.message}
          <button className="text-button" onClick={() => void refreshProfile()}>
            Check profile again
          </button>
        </div>
      )}
      {!loading && profile && !profile.connected && (
        <div className="capability-limits">
          <h3>GitHub is disconnected</h3>
          <p>
            Your local project stays available. Connect GitHub in profile
            settings to validate a repository link or prepare a remote write.
          </p>
        </div>
      )}
      {profile?.connected && (
        <>
          <div className="connection-summary">
            <span className={`badge ${failure ? "" : "green"}`}>
              {failure
                ? "Connection status unavailable"
                : profile.identity?.login}
            </span>
            <span>
              Shared profile connection · repository scoped to this project
            </span>
            <button
              className="text-button"
              onClick={() => void refreshProfile()}
            >
              Refresh connection
            </button>
          </div>
          <form
            className="repository-link-form"
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                await api.post(
                  `${path}/link`,
                  { repository },
                  "Link project repository",
                );
                await refreshWorkspace();
                notify(
                  "Repository access verified and linked to this project.",
                );
              });
            }}
          >
            <label htmlFor="project-repository">
              Link an existing repository
            </label>
            <div>
              <input
                id="project-repository"
                value={repository}
                onChange={(event) => setRepository(event.target.value)}
                placeholder="owner/repository"
                required
                pattern="[^/\s]+/[^/\s]+"
              />
              <button
                className="button"
                disabled={
                  busy || Boolean(failure) || !profile.capabilities.read
                }
              >
                Verify & link
              </button>
            </div>
          </form>
          <form
            className="github-proposal-form"
            onSubmit={(event) => void submit(event)}
          >
            <h3>Prepare a governed GitHub action</h3>
            <p>
              Preparation does not perform the remote write. Approve or deny the
              exact proposal after review.
            </p>
            <label>
              Action
              <select
                value={kind}
                onChange={(event) => setKind(event.target.value as typeof kind)}
              >
                <option value="repository.create">
                  Create this project's repository
                </option>
                <option value="issue.create">Create an issue</option>
              </select>
            </label>
            {kind === "repository.create" ? (
              <>
                <label>
                  Repository owner
                  <select
                    required
                    value={owner}
                    onChange={(event) => setOwner(event.target.value)}
                  >
                    <option value="" disabled>
                      Choose an authorized owner
                    </option>
                    {profile.owners.map((item) => (
                      <option key={item.id} value={item.login}>
                        {item.login}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Repository name
                  <input
                    required
                    value={name}
                    maxLength={100}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="project-name"
                  />
                </label>
                <label>
                  Visibility
                  <select
                    value={visibility}
                    onChange={(event) =>
                      setVisibility(event.target.value as typeof visibility)
                    }
                  >
                    <option value="private">Private</option>
                    <option value="public">Public</option>
                  </select>
                </label>
              </>
            ) : (
              <>
                <label>
                  Repository
                  <input
                    required
                    value={repository}
                    onChange={(event) => setRepository(event.target.value)}
                    placeholder="owner/repository"
                  />
                </label>
                <label>
                  Issue title
                  <input
                    required
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                    maxLength={256}
                  />
                </label>
                <label>
                  Issue body
                  <textarea
                    required
                    rows={6}
                    value={body}
                    onChange={(event) => setBody(event.target.value)}
                  />
                </label>
                <label>
                  Labels{" "}
                  <span className="optional">optional, comma separated</span>
                  <input
                    value={labels}
                    onChange={(event) => setLabels(event.target.value)}
                  />
                </label>
              </>
            )}
            <button
              className="button"
              disabled={
                busy ||
                Boolean(failure) ||
                (kind === "repository.create"
                  ? !profile.capabilities.repositoryCreate
                  : !profile.capabilities.issueCreate)
              }
            >
              Prepare proposal for review
            </button>
          </form>
        </>
      )}
      {profile?.connected && (
        <form
          className="repository-link-form"
          onSubmit={(event) => {
            event.preventDefault();
            setReferenceResult(null);
            void run(async () => {
              const result = await api.post<ReferenceResult>(
                `${path}/references/resolve`,
                { reference },
                "Resolve GitHub reference",
              );
              setReferenceResult(result);
              notify("Engineering reference resolved with source provenance.");
            });
          }}
        >
          <h3>Resolve a permitted engineering reference</h3>
          <label htmlFor="github-reference">
            Issue, pull request, commit, or file URL
          </label>
          <div>
            <input
              id="github-reference"
              required
              type="url"
              value={reference}
              onChange={(event) => setReference(event.target.value)}
              placeholder="https://github.com/owner/repository/issues/123"
            />
            <button
              className="button"
              disabled={busy || Boolean(failure) || !profile.capabilities.read}
            >
              Resolve reference
            </button>
          </div>
          <small className="muted">
            Read-only metadata is checked against this project's permitted
            repository. Credentials are never included in the reference.
          </small>
          {referenceResult && (
            <div className="reference-result">
              <h3>{referenceResult.title || referenceResult.kind}</h3>
              <p>{referenceResult.summary}</p>
              <dl className="facts">
                <dt>Repository</dt>
                <dd>{referenceResult.repository}</dd>
                <dt>Resolved</dt>
                <dd>{new Date(referenceResult.resolvedAt).toLocaleString()}</dd>
                <dt>Source commit</dt>
                <dd>
                  {referenceResult.sourceCommit ||
                    "Not available for this reference"}
                </dd>
              </dl>
              {/^https:\/\/github\.com\//.test(referenceResult.url) && (
                <a href={referenceResult.url} target="_blank" rel="noreferrer">
                  Open verified source ↗
                </a>
              )}
              {referenceResult.content && (
                <pre className="content-text" tabIndex={0}>
                  {referenceResult.content}
                </pre>
              )}
            </div>
          )}
        </form>
      )}
      <section
        className="github-proposals"
        aria-label="GitHub action proposals"
      >
        <div className="section-heading">
          <h3>Proposal history</h3>
          <button className="text-button" onClick={() => void refresh()}>
            Refresh proposals
          </button>
        </div>
        {listFailure && (
          <div className="inline-error" role="alert">
            {listFailure.message}
          </div>
        )}
        {!proposals.length && !listFailure && (
          <p className="muted">
            No GitHub proposals have been prepared for this project.
          </p>
        )}
        {proposals.map((proposal) => (
          <article key={proposal.id} className="github-proposal-card">
            <div className="section-heading">
              <h3>
                {proposal.kind === "repository.create"
                  ? "Create repository"
                  : "Create issue"}
              </h3>
              <span
                className={`badge ${proposal.state === "pending" ? "amber" : proposal.state === "succeeded" ? "green" : ""}`}
              >
                {proposal.state.replaceAll("_", " ")}
              </span>
            </div>
            <dl className="proposal-payload">
              {Object.entries(proposal.payload).map(([key, value]) => (
                <div key={key}>
                  <dt>{key}</dt>
                  <dd>
                    {typeof value === "string" ? value : JSON.stringify(value)}
                  </dd>
                </div>
              ))}
            </dl>
            <p className="proposal-account">
              {profile?.connected &&
              !failure &&
              profile.connectionId === proposal.connectionId
                ? `Bound to the current verified profile connection (${profile.identity?.login || "identity unavailable"}).`
                : `Historical connection reference: ${proposal.connectionId}. This is not the current verified connection; approval is unavailable.`}
            </p>
            {proposal.kind === "issue.create" && (
              <section
                className="proposal-inputs"
                aria-label="Exact issue-planning inputs"
              >
                <h4>Planning inputs bound to this proposal</h4>
                {proposal.artifactInputs?.length ? (
                  proposal.artifactInputs.map((input) => (
                    <div className="pinned-input" key={input.id}>
                      <strong>
                        {input.logicalKey} · v{input.version}
                      </strong>
                      <code>{input.id}</code>
                      <span>
                        Source commit:{" "}
                        <code>{input.sourceCommit || "Unavailable"}</code>
                      </span>
                    </div>
                  ))
                ) : (
                  <p className="evidence-gap">
                    Exact planning-input versions are unavailable in this
                    record.
                  </p>
                )}
              </section>
            )}
            {proposal.state === "uncertain" && (
              <div className="evidence-gap">
                Remote completion is uncertain. Reconcile the existing result
                before considering another proposal. No write is resent by this
                check.
                <button
                  className="button compact"
                  disabled={
                    busy ||
                    !profile?.connected ||
                    Boolean(failure) ||
                    profile.connectionId !== proposal.connectionId
                  }
                  onClick={() =>
                    void run(async () => {
                      await api.post(
                        `${path}/proposals/${encodeURIComponent(proposal.id)}/reconcile`,
                        {},
                        "Reconcile GitHub result",
                      );
                      await refresh();
                      await refreshWorkspace();
                      notify(
                        "Reconciliation completed. Inspect the proposal's recorded outcome before taking another action.",
                      );
                    })
                  }
                >
                  Reconcile existing result
                </button>
              </div>
            )}
            <details>
              <summary>Exact proposal binding</summary>
              <code>{proposal.actionDigest}</code>
              <p>Expires {new Date(proposal.expiresAt).toLocaleString()}</p>
            </details>
            {proposal.reason && (
              <p className="proposal-reason">{proposal.reason}</p>
            )}
            {proposal.externalUrl &&
              /^https:\/\/github\.com\//.test(proposal.externalUrl) && (
                <a
                  className="text-link"
                  href={proposal.externalUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open confirmed GitHub result ↗
                </a>
              )}
            <div className="card-actions">
              <button
                className="button primary compact"
                disabled={
                  busy ||
                  proposal.state !== "pending" ||
                  !profile?.connected ||
                  Boolean(failure) ||
                  profile.connectionId !== proposal.connectionId ||
                  !(Date.parse(proposal.expiresAt) > Date.now())
                }
                onClick={() => void decide(proposal, "approve")}
              >
                Approve exact proposal
              </button>
              <button
                className="button compact deny"
                disabled={busy || proposal.state !== "pending"}
                onClick={() => void decide(proposal, "deny")}
              >
                Deny proposal
              </button>
            </div>
          </article>
        ))}
      </section>
    </section>
  );
}

export function ArtifactIssuePlan({
  artifact,
  project,
  api,
  busy,
  run,
  notify,
  openProposals,
}: Actions & {
  artifact: Artifact;
  project: Project;
  openProposals: () => void;
}) {
  const issues = displayIssuePlan(artifact.content);
  return (
    <section
      className="artifact-issue-plan"
      aria-label="Prepare planned GitHub issues"
    >
      <h3>Planned GitHub issues</h3>
      <p className="form-note">
        Preparation creates a pending proposal only. Review and approve its
        exact repository, title, body, labels and input versions separately
        before any GitHub write.
      </p>
      {artifact.status !== "approved" && (
        <p className="evidence-gap">
          Approve this context artifact before preparing its issues.
        </p>
      )}
      {!project.githubRepo && (
        <p className="evidence-gap">
          Connect GitHub in profile settings and verify this project's
          repository first.{" "}
          <button className="text-button" onClick={openProposals}>
            Open project GitHub setup
          </button>
        </p>
      )}
      {!issues ? (
        <p className="evidence-gap">
          Issue content is unavailable or is not a valid JSON issue list. No
          issue can be selected from this record.
        </p>
      ) : (
        issues.map((issue, index) => (
          <article className="planned-issue" key={index}>
            <h4>
              {index + 1}. {issue.title}
            </h4>
            <pre className="content-text" tabIndex={0}>
              {issue.body || "Empty issue body"}
            </pre>
            <p className="form-note">
              Labels: {issue.labels?.join(", ") || "None"}
            </p>
            <button
              className="button compact"
              disabled={
                busy || artifact.status !== "approved" || !project.githubRepo
              }
              onClick={() =>
                void run(async () => {
                  const proposal = await api.post<GitHubProposal>(
                    `/projects/${encodeURIComponent(project.id)}/github/proposals/from-artifact`,
                    { artifactId: artifact.id, index },
                    "Prepare issue from approved planning artifact",
                  );
                  notify(
                    `Issue proposal prepared (${proposal.id}). Review the exact proposal before approving publication.`,
                  );
                  openProposals();
                })
              }
            >
              Prepare issue {index + 1} for review
            </button>
          </article>
        ))
      )}
    </section>
  );
}
