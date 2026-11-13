import { createPublicKey, generateKeyPairSync, randomUUID, sign, verify } from 'node:crypto';
import { canonicalize, digest, freshEntity, type Artifact, type GitHubProposal, type ProfileConnection, type Project, type Task } from '../../../packages/domain/src/index.js';
import { Store } from '../../../packages/store/src/index.js';
import { AppError, requireCondition } from './security.js';
import { GitHubCliProvider, GitHubFailure, type GitHubIdentity, type GitHubProvider, type Repository } from './github-provider.js';
import { proposalInput, repositoryName, type GitHubProfile, type ProposalInput } from './github-contracts.js';
import { sourceCommit } from './workspaces.js';
import { issueInputs, validateIssuePlan } from './issue-planning.js';

const noCapabilities = { read: false, repositoryCreate: false, issueCreate: false, administration: false, release: false };
export class GitHubService {
  private keys = generateKeyPairSync('ed25519');
  private keyId = randomUUID();
  private deadlines = new Map<string, number>();
  constructor(readonly store: Store, readonly bootId: string, readonly provider: GitHubProvider = new GitHubCliProvider(), readonly now: () => number = Date.now, readonly monotonic: () => number = () => performance.now()) {
    for (const proposal of store.list<GitHubProposal>('githubProposals')) {
      if (proposal.state === 'pending') this.update(proposal, { state: 'expired', reason: 'Service restarted; create a new exact proposal.' });
      else if (proposal.state === 'dispatching') this.update(proposal, { state: 'uncertain', reason: 'Service restarted during dispatch. Reconcile before any new write.' });
    }
  }
  profile(): GitHubProfile {
    const connection = this.store.list<ProfileConnection>('connections').filter(c => c.state === 'connected').at(-1);
    return connection ? { connected: true, connectionId: connection.id, identity: { login: connection.login, id: connection.accountId }, capabilities: connection.capabilities, status: 'connected', owners: connection.owners, credentialProvider: 'gh-cli', reason: 'Credentials stay in your OS keyring; writes use them transiently and store no token.' } : { connected: false, connectionId: null, identity: null, capabilities: { ...noCapabilities }, status: 'disconnected', owners: [], credentialProvider: 'gh-cli', reason: 'Connect an existing OS-keyring-backed GitHub CLI account in profile settings. Local projects work without GitHub.' };
  }
  async connect(): Promise<GitHubProfile> {
    const account = await this.provider.identity();
    this.disconnect();
    this.store.create<ProfileConnection>('connections', { ...freshEntity('ghc'), provider: 'gh-cli', credentialProvider: 'gh-cli', login: account.login, accountId: account.id, owners: account.owners, capabilities: account.capabilities, state: 'connected' }, 'human');
    return this.profile();
  }
  disconnect(): GitHubProfile {
    for (const connection of this.store.list<ProfileConnection>('connections').filter(c => c.state === 'connected')) this.store.update<ProfileConnection>('connections', connection.id, connection.revision, { state: 'disconnected' }, 'human');
    for (const proposal of this.store.list<GitHubProposal>('githubProposals').filter(p => p.state === 'pending')) this.update(proposal, { state: 'failed', reason: 'Profile connection was disconnected; a new proposal and review are required.' });
    return this.profile();
  }
  private project(id: string): Project { const project = this.store.get<Project>('projects', id); requireCondition(project, 'not_found', 'This project is unavailable.', 404); return project; }
  private async connected(connectionId?: string): Promise<{ connection: ProfileConnection; identity: GitHubIdentity }> {
    const profile = this.profile(); const connection = profile.connectionId ? this.store.get<ProfileConnection>('connections', profile.connectionId) : undefined;
    requireCondition(connection && (!connectionId || connection.id === connectionId), 'github_disconnected', 'Connect the intended GitHub account in profile settings. Former proposals cannot use a new connection.', 409);
    const identity = await this.provider.identity();
    requireCondition(identity.id === connection.accountId && identity.login.toLowerCase() === connection.login.toLowerCase(), 'github_account_changed', 'The active GitHub CLI account changed. Reconnect in profile settings and review a new proposal.', 409);
    requireCondition(this.store.get<ProfileConnection>('connections', connection.id)?.state === 'connected', 'github_disconnected', 'The profile connection was disconnected.', 409);
    return { connection, identity };
  }
  private verifyRepository(repository: Repository, name: string): void { requireCondition(repository && Number.isSafeInteger(repository.id) && repository.id > 0 && typeof repository.full_name === 'string' && repository.full_name.toLowerCase() === name.toLowerCase() && repository.html_url === `https://github.com/${repository.full_name}`, 'github_target_mismatch', 'GitHub returned a different repository identity. No project binding was changed.', 409); }
  async link(projectId: string, name: string): Promise<Project> {
    repositoryName.parse(name); const project = this.project(projectId); const { connection } = await this.connected();
    const repository = await this.provider.repository(name); requireCondition(repository, 'github_repository_unavailable', 'This repository is missing or unreadable by the connected account.', 404); this.verifyRepository(repository, name);
    requireCondition(this.store.get<ProfileConnection>('connections', connection.id)?.state === 'connected', 'github_disconnected', 'Profile disconnected before linking.', 409);
    const current = this.project(projectId);
    return this.store.update<Project>('projects', current.id, current.revision, { githubRepo: repository.full_name, githubConnectionId: connection.id, githubRepositoryId: repository.id }, 'human');
  }
  list(projectId: string): GitHubProposal[] { this.project(projectId); return this.store.list<GitHubProposal>('githubProposals', projectId); }
  private async inputs(project: Project, taskId = project.rootTaskId): Promise<Artifact[]> {
    const task = this.store.get<Task>('tasks', taskId);
    requireCondition(task?.projectId === project.id, 'issue_plan_unavailable', 'The original planning task is unavailable.', 409);
    return issueInputs(this.store, project.id, taskId, await sourceCommit(task.workspace || project.workspace), this.now());
  }
  async propose(projectId: string, raw: ProposalInput): Promise<GitHubProposal> {
    return this.prepare(projectId, raw);
  }
  private async planning(projectId: string, artifactId: string) {
    const artifact = this.store.get<Artifact>('artifacts', artifactId); const project = this.project(projectId);
    requireCondition(artifact?.projectId === projectId, 'issue_plan_unavailable', 'This issue planning artifact is unavailable in the selected project.', 404);
    const task = this.store.get<Task>('tasks', artifact.taskId);
    requireCondition(task?.projectId === projectId, 'issue_plan_unavailable', 'The original planning task is unavailable.', 409);
    return validateIssuePlan(this.store, projectId, artifactId, await sourceCommit(task.workspace || project.workspace), this.now());
  }
  async proposeFromArtifact(projectId: string, artifactId: string, index: number): Promise<GitHubProposal> {
    requireCondition(Number.isSafeInteger(index) && index >= 0, 'issue_plan_index', 'Select a valid issue from the planning artifact.', 409);
    const plan = await this.planning(projectId, artifactId); const selected = plan.issues[index];
    requireCondition(selected, 'issue_plan_index', 'The selected issue is absent from the planning artifact.', 409);
    const repository = this.project(projectId).githubRepo;
    requireCondition(repository, 'github_target_unavailable', 'Link this project to a repository before preparing issue publication.', 409);
    return this.prepare(projectId, { kind: 'issue.create', repository, ...selected }, { artifactId, index });
  }
  private assertNotPublished(projectId: string, planning: { artifactId: string; index: number }): void {
    requireCondition(!this.list(projectId).some(proposal => proposal.planningArtifactId === planning.artifactId && proposal.planningIssueIndex === planning.index && ['pending', 'dispatching', 'uncertain', 'succeeded'].includes(proposal.state)), 'issue_plan_already_prepared', 'This planned issue already has a pending or delivered proposal. Review or reconcile that proposal instead of publishing it twice.', 409);
  }
  private async prepare(projectId: string, raw: ProposalInput, planning?: { artifactId: string; index: number }): Promise<GitHubProposal> {
    const input = proposalInput.parse(raw); const project = this.project(projectId); const { connection, identity } = await this.connected();
    if (planning) this.assertNotPublished(projectId, planning);
    const plan = planning ? await this.planning(projectId, planning.artifactId) : undefined;
    const taskId = plan?.artifact.taskId ?? project.rootTaskId;
    const id = freshEntity('ghp'); const marker = `[agentdash:${id.id}]`; let payload: Record<string, unknown>; let artifacts: Artifact[] = [];
    if (input.kind === 'repository.create') {
      requireCondition(identity.capabilities.repositoryCreate && identity.owners.some(o => o.login.toLowerCase() === input.owner.toLowerCase()), 'github_capability_unavailable', 'The connected account cannot create repositories for this owner.', 403);
      requireCondition(input.visibility !== 'private' || identity.privateRepositoryCreate, 'github_private_unavailable', 'The connected account cannot create private repositories. Reconnect with the required private-repository permission.', 403);
      requireCondition(!await this.provider.repository(`${input.owner}/${input.name}`), 'github_repository_exists', 'This repository already exists. Link it instead of creating it.', 409);
      payload = { owner: input.owner, name: input.name, visibility: input.visibility, description: `Agentdash project repository ${marker}` };
    } else {
      requireCondition(identity.capabilities.issueCreate && project.githubRepo?.toLowerCase() === input.repository.toLowerCase() && project.githubConnectionId === connection.id && project.githubRepositoryId, 'github_target_unavailable', 'Link this project to the selected repository using the current profile connection first.', 409);
      artifacts = await this.inputs(project, taskId);
      const repository = await this.provider.repository(input.repository); requireCondition(repository && repository.id === project.githubRepositoryId && repository.permissions?.push === true, 'github_write_unavailable', 'The connected account lacks verified write access to this project repository.', 403);
      payload = { repository: input.repository, title: input.title, body: input.body + `\n\n<!-- ${marker} -->`, labels: input.labels };
    }
    const actionDigest = digest({ kind: input.kind, payload, connectionId: connection.id, projectId });
    const conflict = this.list(projectId).find(p => ['dispatching', 'uncertain'].includes(p.state) && p.kind === input.kind && (input.kind === 'repository.create' ? p.payload.owner === input.owner && p.payload.name === input.name : p.payload.repository === input.repository && p.payload.title === input.title));
    requireCondition(!conflict, 'github_reconciliation_required', 'A previous matching write has an uncertain result. Reconcile it before creating another proposal.', 409);
    requireCondition(this.store.get<ProfileConnection>('connections', connection.id)?.state === 'connected', 'github_disconnected', 'Profile disconnected before proposal creation.', 409);
    if (planning) {
      const current = await this.planning(projectId, planning.artifactId); const selected = current.issues[planning.index];
      requireCondition(input.kind === 'issue.create' && selected && canonicalize(selected) === canonicalize({ title: input.title, body: input.body, labels: input.labels }) && canonicalize(current.inputs.map(a => a.id)) === canonicalize(artifacts.map(a => a.id)), 'context_changed', 'The selected planned issue or its inputs changed before preparation.', 409);
      this.assertNotPublished(projectId, planning);
    }
    const proposal = this.store.create<GitHubProposal>('githubProposals', { ...id, projectId, taskId, connectionId: connection.id, kind: input.kind, payload, actionDigest, state: 'pending', bootId: this.bootId, reviewedProjectRevision: project.revision, expiresAt: new Date(this.now() + 10 * 60_000).toISOString(), reason: null, externalUrl: null, reconciliationMarker: marker, artifactInputs: artifacts.map(a => ({ id: a.id, logicalKey: a.logicalKey, version: a.version, sourceCommit: a.sourceCommit })), ...(planning ? { planningArtifactId: planning.artifactId, planningIssueIndex: planning.index } : {}) }, 'human');
    this.deadlines.set(proposal.id, this.monotonic() + 10 * 60_000);
    return proposal;
  }
  private unexpired(proposal: GitHubProposal): boolean { const deadline = this.deadlines.get(proposal.id); return Date.parse(proposal.expiresAt) > this.now() && deadline !== undefined && this.monotonic() < deadline; }
  private update(proposal: GitHubProposal, changes: Partial<GitHubProposal>): GitHubProposal { return this.store.update<GitHubProposal>('githubProposals', proposal.id, proposal.revision, changes, 'human'); }
  private bound(proposal: GitHubProposal): string { return canonicalize({ id: proposal.id, projectId: proposal.projectId, taskId: proposal.taskId, connectionId: proposal.connectionId, kind: proposal.kind, payload: proposal.payload, actionDigest: proposal.actionDigest, bootId: proposal.bootId, reviewedProjectRevision: proposal.reviewedProjectRevision ?? null, expiresAt: proposal.expiresAt, resolver: proposal.resolver, decision: proposal.decision, decidedAt: proposal.decidedAt, keyId: proposal.keyId, reconciliationMarker: proposal.reconciliationMarker, artifactInputs: proposal.artifactInputs ?? [], ...(proposal.planningArtifactId !== undefined ? { planningArtifactId: proposal.planningArtifactId, planningIssueIndex: proposal.planningIssueIndex } : {}) }); }
  verifyProposal(proposal: GitHubProposal): boolean {
    try {
      if (!proposal.signature || !proposal.verificationKey || !proposal.keyId || proposal.resolver !== 'human' || !['approve','deny'].includes(proposal.decision ?? '') || !proposal.decidedAt || !Number.isFinite(Date.parse(proposal.decidedAt))) return false;
      if (proposal.decision === 'approve' && Date.parse(proposal.decidedAt) >= Date.parse(proposal.expiresAt)) return false;
      if (proposal.actionDigest !== digest({ kind: proposal.kind, payload: proposal.payload, connectionId: proposal.connectionId, projectId: proposal.projectId })) return false;
      return verify(null, Buffer.from(this.bound(proposal)), createPublicKey({ key: Buffer.from(proposal.verificationKey, 'base64'), type: 'spki', format: 'der' }), Buffer.from(proposal.signature, 'base64'));
    } catch { return false; }
  }
  private matchesIssue(issue: unknown, proposal: GitHubProposal): issue is import('./github-provider.js').Issue {
    if (!issue || typeof issue !== 'object') return false;
    const value = issue as import('./github-provider.js').Issue;
    return Number.isSafeInteger(value.id) && value.id > 0 && Number.isSafeInteger(value.number) && value.number > 0 && value.html_url === `https://github.com/${proposal.payload.repository}/issues/${value.number}` && value.body === proposal.payload.body && value.title === proposal.payload.title && !value.pull_request;
  }
  async resolve(projectId: string, id: string, input: { decision: 'approve' | 'deny'; expectedRevision: number; actionDigest: string }): Promise<GitHubProposal> {
    let proposal = this.store.get<GitHubProposal>('githubProposals', id);
    requireCondition(proposal && proposal.projectId === projectId, 'not_found', 'This proposal is unavailable in the selected project.', 404);
    requireCondition(proposal.state === 'pending' && proposal.revision === input.expectedRevision && proposal.actionDigest === input.actionDigest && proposal.actionDigest === digest({ kind: proposal.kind, payload: proposal.payload, connectionId: proposal.connectionId, projectId }), 'github_proposal_changed', 'This proposal changed or was already resolved. Refresh and review its current contents.', 409);
    requireCondition(proposal.bootId === this.bootId && (input.decision === 'deny' || this.unexpired(proposal)) && this.store.verifyAudit().valid, 'github_proposal_expired', 'This proposal expired or governance verification is unavailable. Create a fresh proposal.', 409);
    let identity: GitHubIdentity | undefined;
    if (input.decision === 'approve') {
      const connected = await this.connected(proposal.connectionId); identity = connected.identity;
      await this.validateWrite(proposal, identity);
      // Remote validation can take time. Recheck account/permissions and local inputs before CAS.
      identity = (await this.connected(proposal.connectionId)).identity;
      this.validateIdentityForWrite(proposal, identity);
      if (proposal.kind === 'issue.create') await this.validateInputs(proposal);
    }
    const current = this.store.get<GitHubProposal>('githubProposals', id)!;
    requireCondition(current.state === 'pending' && current.revision === input.expectedRevision && (input.decision === 'deny' || (this.store.get<ProfileConnection>('connections', current.connectionId)?.state === 'connected' && this.unexpired(current) && this.project(projectId).revision === current.reviewedProjectRevision)), 'github_proposal_changed', 'The proposal or account changed during validation. Review a fresh snapshot.', 409);
    const signed: GitHubProposal = { ...current, decision: input.decision, decidedAt: new Date(this.now()).toISOString(), keyId: this.keyId, resolver: 'human', verificationKey: this.keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64') };
    signed.signature = sign(null, Buffer.from(this.bound(signed)), this.keys.privateKey).toString('base64');
    requireCondition(verify(null, Buffer.from(this.bound(signed)), this.keys.publicKey, Buffer.from(signed.signature, 'base64')), 'github_signature_invalid', 'The exact decision could not be verified.', 409);
    proposal = this.update(current, { decision: signed.decision, decidedAt: signed.decidedAt, keyId: signed.keyId, resolver: signed.resolver, signature: signed.signature, verificationKey: signed.verificationKey, state: input.decision === 'deny' ? 'denied' : 'dispatching', reason: input.decision === 'deny' ? 'Denied by the operator; no write was sent.' : null });
    requireCondition(this.verifyProposal(proposal), 'github_signature_invalid', 'The recorded exact decision could not be verified.', 409);
    if (input.decision === 'deny') return proposal;
    try {
      const account = this.store.get<ProfileConnection>('connections', proposal.connectionId)!;
      const expectedAccount = { login: account.login, id: account.accountId };
      const beforeWrite = async () => {
        if (proposal.kind === 'issue.create') await this.validateInputs(proposal);
        const current = this.store.get<GitHubProposal>('githubProposals', proposal.id);
        requireCondition(current?.state === 'dispatching' && current.revision === proposal.revision && this.verifyProposal(current) && this.store.verifyAudit().valid && this.unexpired(current) && current.bootId === this.bootId && this.project(projectId).revision === proposal.reviewedProjectRevision && this.store.get<ProfileConnection>('connections', proposal.connectionId)?.state === 'connected', 'github_context_changed', 'The exact proposal, project, account or context changed before external delivery.', 409);
      };
      if (proposal.kind === 'repository.create') {
        const p = proposal.payload; const repository = await this.provider.createRepository(String(p.owner), String(p.name), p.visibility as 'private' | 'public', String(p.description), expectedAccount.login, expectedAccount, beforeWrite);
        return this.finishRepository(proposal, repository);
      }
      const p = proposal.payload; const issue = await this.provider.createIssue(String(p.repository), { title: String(p.title), body: String(p.body), labels: p.labels as string[] }, expectedAccount, beforeWrite);
      requireCondition(this.matchesIssue(issue, proposal), 'github_result_unverified', 'The issue result could not be matched to the exact proposal.', 409);
      return this.update(proposal, { state: 'succeeded', externalUrl: issue.html_url, reason: 'GitHub confirmed the reviewed issue creation.' });
    } catch (error) {
      const ambiguous = !(error instanceof GitHubFailure) || error.ambiguous;
      return this.update(proposal, { state: ambiguous ? 'uncertain' : 'failed', reason: ambiguous ? 'Delivery or external identity is uncertain. Reconcile; this write will not be resent automatically.' : (error as GitHubFailure).message });
    }
  }
  private async validateWrite(proposal: GitHubProposal, identity: GitHubIdentity): Promise<void> {
    const project = this.project(proposal.projectId);
    this.validateIdentityForWrite(proposal, identity);
    if (proposal.kind === 'repository.create') {
      requireCondition(!await this.provider.repository(`${proposal.payload.owner}/${proposal.payload.name}`), 'github_repository_exists', 'This repository now exists. Link it after verifying its identity.', 409);
    } else {
      requireCondition(identity.capabilities.issueCreate && project.githubRepo === proposal.payload.repository && project.githubConnectionId === proposal.connectionId, 'github_binding_changed', 'The project repository or connection changed; review a new proposal.', 409);
      const repository = await this.provider.repository(String(proposal.payload.repository)); requireCondition(repository && repository.id === project.githubRepositoryId && repository.permissions?.push === true, 'github_write_unavailable', 'Repository write access is no longer verified.', 403);
      await this.validateInputs(proposal);
    }
  }
  private validateIdentityForWrite(proposal: GitHubProposal, identity: GitHubIdentity): void {
    if (proposal.kind === 'repository.create') {
      requireCondition(identity.capabilities.repositoryCreate && identity.owners.some(owner => owner.login.toLowerCase() === String(proposal.payload.owner).toLowerCase()), 'github_capability_unavailable', 'Repository creation is not authorized for this account/owner.', 403);
      requireCondition(proposal.payload.visibility !== 'private' || identity.privateRepositoryCreate, 'github_private_unavailable', 'Private repository creation permission is unavailable.', 403);
    } else requireCondition(identity.capabilities.issueCreate, 'github_write_unavailable', 'Issue creation permission is unavailable.', 403);
  }
  private async validateInputs(proposal: GitHubProposal): Promise<void> {
    const plan = proposal.planningArtifactId ? await this.planning(proposal.projectId, proposal.planningArtifactId) : undefined;
    if (plan) {
      const selected = plan.issues[proposal.planningIssueIndex!];
      requireCondition(plan.artifact.taskId === proposal.taskId && selected && selected.title === proposal.payload.title && selected.body + `\n\n<!-- ${proposal.reconciliationMarker} -->` === proposal.payload.body && canonicalize(selected.labels) === canonicalize(proposal.payload.labels), 'context_changed', 'The proposal no longer matches its approved planning artifact.', 409);
    }
    const artifacts = plan?.inputs ?? await this.inputs(this.project(proposal.projectId), proposal.taskId);
    requireCondition((proposal.artifactInputs?.length ?? 0) === 2 && proposal.artifactInputs!.every(input => artifacts.some(artifact => artifact.id === input.id && artifact.version === input.version && artifact.sourceCommit === input.sourceCommit)), 'context_changed', 'Issue-planning inputs changed. Generate a new proposal from current approved context.', 409);
  }
  private finishRepository(proposal: GitHubProposal, repository: Repository): GitHubProposal {
    const name = `${proposal.payload.owner}/${proposal.payload.name}`; this.verifyRepository(repository, name);
    requireCondition(repository.private === (proposal.payload.visibility === 'private') && repository.description?.includes(proposal.reconciliationMarker!), 'github_result_unverified', 'Repository creation result does not match the reviewed proposal.', 409);
    return this.store.transaction(() => {
      const project = this.project(proposal.projectId);
      const alreadyBound = project.githubRepo?.toLowerCase() === repository.full_name.toLowerCase() && project.githubRepositoryId === repository.id && project.githubConnectionId === proposal.connectionId;
      if (project.revision !== proposal.reviewedProjectRevision && !alreadyBound) return this.update(proposal, { state: 'uncertain', externalUrl: repository.html_url, reason: 'The repository exists, but the reviewed project binding changed. No newer project binding was overwritten.' });
      if (!alreadyBound) this.store.update<Project>('projects', project.id, project.revision, { githubRepo: repository.full_name, githubRepositoryId: repository.id, githubConnectionId: proposal.connectionId }, 'human');
      return this.update(proposal, { state: 'succeeded', externalUrl: repository.html_url, reason: 'GitHub confirmed the reviewed repository creation and project binding.' });
    });
  }
  async reconcile(projectId: string, id: string): Promise<GitHubProposal> {
    const proposal = this.store.get<GitHubProposal>('githubProposals', id); requireCondition(proposal && proposal.projectId === projectId, 'not_found', 'This proposal is unavailable.', 404);
    requireCondition(proposal.state === 'uncertain', 'github_not_uncertain', 'Only an uncertain delivery needs reconciliation.', 409);
    requireCondition(this.store.verifyAudit().valid && proposal.decision === 'approve' && this.verifyProposal(proposal), 'github_signature_invalid', 'The historical authorization could not be verified; no result will be rebound.', 409);
    await this.connected(proposal.connectionId);
    if (proposal.kind === 'repository.create') { const repository = await this.provider.repository(`${proposal.payload.owner}/${proposal.payload.name}`); if (repository?.description?.includes(proposal.reconciliationMarker!)) return this.finishRepository(proposal, repository); }
    else { const issue = await this.provider.findIssue(String(proposal.payload.repository), proposal.reconciliationMarker!); if (this.matchesIssue(issue, proposal)) return this.update(proposal, { state: 'succeeded', externalUrl: issue.html_url, reason: 'Existing external issue matched by proposal marker and exact reviewed content. No write was resent.' }); }
    return proposal;
  }
  async reference(projectId: string, reference: string): Promise<Record<string, unknown>> {
    const project = this.project(projectId); await this.connected(project.githubConnectionId ?? undefined);
    let url: URL; try { url = new URL(reference); } catch { throw new AppError('github_reference_invalid', 'Use a GitHub issue, pull request, commit or file URL.'); }
    let parts: string[];
    try { parts = url.pathname.split('/').filter(Boolean).map(part => decodeURIComponent(part)); }
    catch { throw new AppError('github_reference_invalid', 'The GitHub reference path has invalid encoding.'); }
    const repository = parts.slice(0, 2).join('/'); repositoryName.parse(repository);
    requireCondition(url.protocol === 'https:' && url.hostname === 'github.com' && !url.port && !url.username && !url.password && !url.search && repository.toLowerCase() === project.githubRepo?.toLowerCase(), 'github_reference_scope', 'References must belong to this project’s linked GitHub repository.', 403);
    const map = { issues: 'issues', pull: 'pulls', commit: 'commits', blob: 'contents' } as const; const kind = parts[2] as keyof typeof map;
    requireCondition(kind in map && parts.length >= 4 && !parts.some(p => p.split('/').some(segment => segment === '..' || segment === '.')), 'github_reference_invalid', 'Use an issue, pull request, commit or file URL.');
    let target = parts.slice(3).join('/'); let value: any; let sourceCommit: string | null = null;
    if (kind === 'blob') {
      const ref = parts[3]; const path = parts.slice(4).join('/'); requireCondition(path, 'github_reference_invalid', 'A file reference needs a path.');
      const commit: any = await this.provider.reference(repository, 'commits', ref);
      requireCondition(typeof commit?.sha === 'string' && /^[a-f0-9]{40,64}$/i.test(commit.sha), 'github_provenance_unavailable', 'The file source commit could not be verified.', 409);
      sourceCommit = commit.sha;
      value = await this.provider.reference(repository, 'contents', path, sourceCommit!);
      requireCondition(value && value.type === 'file' && value.path === path && typeof value.sha === 'string' && /^[a-f0-9]{40,64}$/i.test(value.sha), 'github_reference_invalid', 'GitHub did not return the requested file identity at the verified source commit.', 409);
    }
    else { requireCondition(kind === 'commit' ? /^[a-fA-F0-9]{7,64}$/.test(target) : /^\d+$/.test(target), 'github_reference_invalid', 'The GitHub reference target is invalid.'); value = await this.provider.reference(repository, map[kind], target); }
    return { kind, repository, url: reference, title: value.title ?? value.commit?.message?.slice(0, 200) ?? value.name, summary: 'Resolved against the currently connected profile and project repository.', sourceCommit: kind === 'blob' ? sourceCommit : kind === 'commit' ? value.sha : kind === 'pull' ? value.head?.sha ?? null : null, resolvedAt: new Date(this.now()).toISOString() };
  }
}
