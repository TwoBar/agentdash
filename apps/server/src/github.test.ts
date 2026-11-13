import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createPublicKey, verify } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { canonicalize, freshEntity, type Artifact, type GitHubProposal, type Project, type Task } from '../../../packages/domain/src/index.js';
import { Store } from '../../../packages/store/src/index.js';
import { GitHubService } from './github.js';
import { GitHubFailure, type GitHubIdentity, type GitHubProvider, type Issue, type Repository } from './github-provider.js';

class FakeProvider implements GitHubProvider {
  account: GitHubIdentity = { login: 'synthetic', id: 100, owners: [{ login: 'synthetic', id: 100 }], capabilities: { read: true, repositoryCreate: true, issueCreate: true, administration: false, release: false }, privateRepositoryCreate: true };
  repositories = new Map<string, Repository>();
  issues: Issue[] = [];
  writes: Array<{ kind: string; target: string; body: unknown }> = [];
  references: Array<{ repository: string; kind: string; target: string; ref?: string }> = [];
  identityError?: Error;
  repositoryHook?: () => void | Promise<void>;
  createRepositoryHook?: (repository: Repository) => void | Promise<void>;
  createIssueHook?: (issue: Issue) => void | Promise<void>;
  async identity() { if (this.identityError) throw this.identityError; return structuredClone(this.account); }
  async repository(name: string) { await this.repositoryHook?.(); return this.repositories.get(name.toLowerCase()) ?? null; }
  async createRepository(owner: string, name: string, visibility: 'private' | 'public', description: string, _login: string) {
    const repository: Repository = { id: 1000 + this.writes.length, full_name: `${owner}/${name}`, html_url: `https://github.com/${owner}/${name}`, private: visibility === 'private', description, permissions: { push: true, pull: true } };
    this.writes.push({ kind: 'repository.create', target: repository.full_name, body: { visibility, description } }); this.repositories.set(repository.full_name.toLowerCase(), repository);
    await this.createRepositoryHook?.(repository); return repository;
  }
  async createIssue(repository: string, input: { title: string; body: string; labels: string[] }) {
    const issue: Issue = { id: 2000 + this.issues.length, number: this.issues.length + 1, html_url: `https://github.com/${repository}/issues/${this.issues.length + 1}`, body: input.body, title: input.title };
    this.writes.push({ kind: 'issue.create', target: repository, body: structuredClone(input) }); this.issues.push(issue); await this.createIssueHook?.(issue); return issue;
  }
  async findIssue(_repository: string, marker: string) { return this.issues.find(issue => issue.body?.includes(marker)) ?? null; }
  async reference(repository: string, kind: 'issues' | 'pulls' | 'commits' | 'contents', target: string, ref?: string) { this.references.push({ repository, kind, target, ...(ref ? { ref } : {}) }); return { name: target.split('/').at(-1), path: target, type: 'file', sha: (kind === 'contents' ? 'b' : 'a').repeat(40) }; }
}
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'agentdash-github-')); const workspace = join(directory, 'workspace'); mkdirSync(workspace);
  execFileSync('git', ['init', '--quiet', workspace]); execFileSync('git', ['-C', workspace, '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'commit', '--allow-empty', '--quiet', '-m', 'Synthetic baseline']);
  const store = new Store(join(directory, 'state.sqlite')); const provider = new FakeProvider(); const clock = { now: Date.now(), monotonic: 1_000 };
  const service = new GitHubService(store, 'synthetic-boot', provider, () => clock.now, () => clock.monotonic);
  function project(name = 'Synthetic project') {
    const root = freshEntity('tsk'); const project = store.create<Project>('projects', { ...freshEntity('prj'), name, workspace, rootTaskId: root.id, githubRepo: null });
    store.create<Task>('tasks', { ...root, projectId: project.id, parentTaskId: null, name: 'Synthetic root', objective: 'Synthetic', personaId: 'synthetic-persona', state: 'ready', sessionId: null, workspace }); return project;
  }
  async function issueProject() {
    const p = project(); const repository: Repository = { id: 500, full_name: 'synthetic/project', html_url: 'https://github.com/synthetic/project', private: true, description: 'Synthetic existing repository', permissions: { push: true } }; provider.repositories.set(repository.full_name, repository);
    const linked = await service.link(p.id, repository.full_name);
    const commit = execFileSync('git', ['-C', workspace, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const artifacts = ['current_roadmap','codebase_map'].map(logicalKey => store.create<Artifact>('artifacts', { ...freshEntity('art'), projectId: p.id, taskId: p.rootTaskId, logicalKey, version: 1, status: 'approved', summary: 'Synthetic approved input', content: null, externalRef: null, sourceCommit: commit, expiresAt: null }));
    return { project: linked, artifacts, repository };
  }
  function input(proposal: GitHubProposal, decision: 'approve' | 'deny' = 'approve') { return { decision, expectedRevision: proposal.revision, actionDigest: proposal.actionDigest }; }
  return { store, provider, service, clock, project, issueProject, input, close() { store.close(); rmSync(directory, { recursive: true, force: true }); } };
}
const repositoryInput = { kind: 'repository.create' as const, owner: 'synthetic', name: 'new-project', visibility: 'private' as const };
const issueInput = { kind: 'issue.create' as const, repository: 'synthetic/project', title: 'Synthetic reviewed issue', body: 'Synthetic issue body', labels: ['synthetic'] };
function verificationBytes(proposal: GitHubProposal) {
  return canonicalize({ id: proposal.id, projectId: proposal.projectId, taskId: proposal.taskId, connectionId: proposal.connectionId, kind: proposal.kind, payload: proposal.payload, actionDigest: proposal.actionDigest, bootId: proposal.bootId, reviewedProjectRevision: proposal.reviewedProjectRevision ?? null, expiresAt: proposal.expiresAt, resolver: proposal.resolver, decision: proposal.decision, decidedAt: proposal.decidedAt, keyId: proposal.keyId, reconciliationMarker: proposal.reconciliationMarker, artifactInputs: proposal.artifactInputs ?? [] });
}

test('profile connect stores only keyring-provider metadata and disconnect invalidates pending proposals', async () => {
  const f = fixture();
  try {
    assert.equal(f.service.profile().connected, false); const profile = await f.service.connect(); assert.equal(profile.connected, true); assert.equal(profile.credentialProvider, 'gh-cli');
    const project = f.project(); const pending = await f.service.propose(project.id, repositoryInput);
    const record = f.store.get('connections', profile.connectionId!)!; assert.equal('token' in record, false); assert.equal('credential' in record, false);
    f.service.disconnect(); assert.equal(f.service.profile().connected, false); assert.equal(f.store.get<GitHubProposal>('githubProposals', pending.id)?.state, 'failed'); assert.equal(f.provider.writes.length, 0);
  } finally { f.close(); }
});

test('wrong account/project/digest/revision and expiry are rejected before remote writes', async () => {
  const f = fixture();
  try {
    await f.service.connect(); const project = f.project(); const foreign = f.project('Foreign'); const proposal = await f.service.propose(project.id, repositoryInput);
    await assert.rejects(f.service.resolve(foreign.id, proposal.id, f.input(proposal)), /selected project/);
    await assert.rejects(f.service.resolve(project.id, proposal.id, { ...f.input(proposal), actionDigest: `sha256:${'0'.repeat(64)}` }), /changed/);
    await assert.rejects(f.service.resolve(project.id, proposal.id, { ...f.input(proposal), expectedRevision: 999 }), /changed/);
    f.provider.account.id = 999; await assert.rejects(f.service.resolve(project.id, proposal.id, f.input(proposal)), /account changed/); f.provider.account.id = 100;
    f.clock.now += 10 * 60_000; await assert.rejects(f.service.resolve(project.id, proposal.id, f.input(proposal)), /expired/);
    assert.equal(f.provider.writes.length, 0); assert.equal(f.store.get<GitHubProposal>('githubProposals', proposal.id)?.state, 'pending');
  } finally { f.close(); }
});

test('an exact operator denial remains available offline and causes no remote write', async () => {
  const f = fixture();
  try {
    await f.service.connect(); const project = f.project(); const proposal = await f.service.propose(project.id, repositoryInput);
    f.provider.identityError = new Error('Synthetic network offline'); f.clock.now += 20 * 60_000;
    const result = await f.service.resolve(project.id, proposal.id, f.input(proposal, 'deny'));
    assert.equal(result.state, 'denied'); assert.equal(result.decision, 'deny'); assert.equal(f.provider.writes.length, 0);
  } finally { f.close(); }
});

test('wall-clock rollback cannot extend a pending write proposal beyond its per-boot monotonic deadline', async () => {
  const f = fixture();
  try {
    await f.service.connect(); const project = f.project(); const proposal = await f.service.propose(project.id, repositoryInput);
    f.clock.now -= 60_000; f.clock.monotonic += 10 * 60_000;
    await assert.rejects(f.service.resolve(project.id, proposal.id, f.input(proposal)), /expired/); assert.equal(f.provider.writes.length, 0);
    const denied = await f.service.resolve(project.id, proposal.id, f.input(proposal, 'deny')); assert.equal(denied.state, 'denied'); assert.equal(f.provider.writes.length, 0);
  } finally { f.close(); }
});

test('repository approval creates exactly reviewed visibility and sets verified project binding with a durable signature', async () => {
  const f = fixture();
  try {
    await f.service.connect(); const project = f.project(); const proposal = await f.service.propose(project.id, repositoryInput);
    const result = await f.service.resolve(project.id, proposal.id, f.input(proposal));
    assert.equal(result.state, 'succeeded'); assert.equal(f.provider.writes.length, 1); assert.deepEqual(f.provider.writes[0].body, { visibility: 'private', description: proposal.payload.description });
    const linked = f.store.get<Project>('projects', project.id)!; assert.equal(linked.githubRepo, 'synthetic/new-project'); assert.equal(linked.githubConnectionId, proposal.connectionId); assert.equal(linked.githubRepositoryId, 1000);
    const key = createPublicKey({ key: Buffer.from(result.verificationKey!, 'base64'), type: 'spki', format: 'der' });
    assert.equal(verify(null, Buffer.from(verificationBytes(result)), key, Buffer.from(result.signature!, 'base64')), true);
    assert.equal(verify(null, Buffer.from(verificationBytes({ ...result, reviewedProjectRevision: 999 })), key, Buffer.from(result.signature!, 'base64')), false);
    assert.equal(verify(null, Buffer.from(verificationBytes({ ...result, payload: { ...result.payload, visibility: 'public' } })), key, Buffer.from(result.signature!, 'base64')), false);
    await assert.rejects(f.service.resolve(project.id, proposal.id, f.input(proposal)), /already resolved/); assert.equal(f.provider.writes.length, 1); assert.equal(f.store.verifyAudit().valid, true);
  } finally { f.close(); }
});

test('public-only credentials cannot propose or dispatch private repository creation', async () => {
  const f = fixture();
  try {
    await f.service.connect(); const project = f.project(); f.provider.account.privateRepositoryCreate = false;
    await assert.rejects(f.service.propose(project.id, repositoryInput), /private repositories/);
    f.provider.account.privateRepositoryCreate = true; const proposal = await f.service.propose(project.id, repositoryInput);
    f.provider.account.privateRepositoryCreate = false; await assert.rejects(f.service.resolve(project.id, proposal.id, f.input(proposal)), /Private repository/); assert.equal(f.provider.writes.length, 0);
  } finally { f.close(); }
});

test('active account change during remote validation is caught again before the dispatch intent', async () => {
  const f = fixture();
  try {
    await f.service.connect(); const project = f.project(); const proposal = await f.service.propose(project.id, repositoryInput);
    f.provider.repositoryHook = () => { f.provider.repositoryHook = undefined; f.provider.account.id = 999; };
    await assert.rejects(f.service.resolve(project.id, proposal.id, f.input(proposal)), /account changed/);
    assert.equal(f.provider.writes.length, 0); assert.equal(f.store.get<GitHubProposal>('githubProposals', proposal.id)?.signature, undefined);
  } finally { f.close(); }
});

test('issue creation requires exact project repository, approved pinned inputs and current write permission', async () => {
  const f = fixture();
  try {
    await f.service.connect(); const { project, artifacts, repository } = await f.issueProject();
    await assert.rejects(f.service.propose(project.id, { ...issueInput, repository: 'synthetic/foreign' }), /Link this project/);
    f.store.update<Artifact>('artifacts', artifacts[0].id, 1, { status: 'draft' }); await assert.rejects(f.service.propose(project.id, issueInput), /current_roadmap/);
    const current = f.store.get<Artifact>('artifacts', artifacts[0].id)!; f.store.update<Artifact>('artifacts', current.id, current.revision, { status: 'approved' });
    const proposal = await f.service.propose(project.id, issueInput); repository.permissions!.push = false;
    await assert.rejects(f.service.resolve(project.id, proposal.id, f.input(proposal)), /write access/); assert.equal(f.provider.writes.length, 0);
    repository.permissions!.push = true; const result = await f.service.resolve(project.id, proposal.id, f.input(proposal)); assert.equal(result.state, 'succeeded'); assert.equal(f.provider.writes.length, 1);
    const sent = f.provider.writes[0].body as { body: string }; assert.equal(sent.body, proposal.payload.body);
  } finally { f.close(); }
});

test('artifact revocation during repository verification is rechecked before signing or dispatch', async () => {
  const f = fixture();
  try {
    await f.service.connect(); const { project, artifacts } = await f.issueProject(); const proposal = await f.service.propose(project.id, issueInput);
    f.provider.repositoryHook = () => { f.provider.repositoryHook = undefined; const current = f.store.get<Artifact>('artifacts', artifacts[0].id)!; f.store.update<Artifact>('artifacts', current.id, current.revision, { status: 'stale' }); };
    await assert.rejects(f.service.resolve(project.id, proposal.id, f.input(proposal)), /current_roadmap|context/);
    assert.equal(f.provider.writes.length, 0); assert.equal(f.store.get<GitHubProposal>('githubProposals', proposal.id)?.signature, undefined);
  } finally { f.close(); }
});

test('an uncertain issue write is only reconciled by exact result and never resent', async () => {
  const f = fixture();
  try {
    await f.service.connect(); const { project } = await f.issueProject(); const proposal = await f.service.propose(project.id, issueInput);
    f.provider.createIssueHook = () => { throw new GitHubFailure('synthetic_lost_response', 'Synthetic response lost after write', true); };
    const result = await f.service.resolve(project.id, proposal.id, f.input(proposal)); assert.equal(result.state, 'uncertain');
    await assert.rejects(f.service.propose(project.id, issueInput), /uncertain result/);
    await assert.rejects(f.service.resolve(project.id, proposal.id, f.input(proposal)), /already resolved/);
    const restarted = new GitHubService(f.store, 'new-boot', f.provider, () => f.clock.now);
    assert.equal(restarted.verifyProposal(result), true);
    const reconciled = await restarted.reconcile(project.id, proposal.id); assert.equal(reconciled.state, 'succeeded'); assert.equal(f.provider.writes.length, 1);
  } finally { f.close(); }
});

test('malformed or mismatched remote issue response remains uncertain rather than claiming exact success', async () => {
  const f = fixture();
  try {
    await f.service.connect(); const { project } = await f.issueProject(); const proposal = await f.service.propose(project.id, issueInput);
    f.provider.createIssueHook = issue => { issue.title = 'Unexpected different title'; };
    const result = await f.service.resolve(project.id, proposal.id, f.input(proposal)); assert.equal(result.state, 'uncertain'); assert.equal(f.provider.writes.length, 1);
    assert.equal((await f.service.reconcile(project.id, proposal.id)).state, 'uncertain'); assert.equal(f.provider.writes.length, 1);
  } finally { f.close(); }
});

test('in-flight repository creation never overwrites a newer human project binding', async () => {
  const f = fixture();
  try {
    await f.service.connect(); const project = f.project(); const proposal = await f.service.propose(project.id, repositoryInput);
    f.provider.createRepositoryHook = () => { const current = f.store.get<Project>('projects', project.id)!; f.store.update<Project>('projects', current.id, current.revision, { githubRepo: 'synthetic/newer-human-choice', githubConnectionId: proposal.connectionId, githubRepositoryId: 9999 }, 'human'); };
    const result = await f.service.resolve(project.id, proposal.id, f.input(proposal)); assert.equal(result.state, 'uncertain'); assert.equal(result.externalUrl, 'https://github.com/synthetic/new-project');
    assert.equal(f.store.get<Project>('projects', project.id)?.githubRepo, 'synthetic/newer-human-choice');
    assert.equal((await f.service.reconcile(project.id, proposal.id)).state, 'uncertain'); assert.equal(f.provider.writes.length, 1);
  } finally { f.close(); }
});

test('concurrent decisions consume one proposal snapshot and create at most one remote side effect', async () => {
  const f = fixture();
  try {
    await f.service.connect(); const project = f.project(); const proposal = await f.service.propose(project.id, repositoryInput);
    const results = await Promise.allSettled([f.service.resolve(project.id, proposal.id, f.input(proposal)), f.service.resolve(project.id, proposal.id, f.input(proposal))]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1); assert.equal(results.filter(result => result.status === 'rejected').length, 1); assert.equal(f.provider.writes.length, 1);
  } finally { f.close(); }
});

test('restart expires former pending proposals and marks interrupted dispatch uncertain without resending', async () => {
  const f = fixture();
  try {
    await f.service.connect(); const project = f.project(); const pending = await f.service.propose(project.id, repositoryInput); const dispatching = await f.service.propose(project.id, { ...repositoryInput, name: 'interrupted-project' });
    f.store.update<GitHubProposal>('githubProposals', dispatching.id, 1, { state: 'dispatching' });
    const restarted = new GitHubService(f.store, 'new-boot', f.provider, () => f.clock.now);
    assert.equal(f.store.get<GitHubProposal>('githubProposals', pending.id)?.state, 'expired'); assert.equal(f.store.get<GitHubProposal>('githubProposals', dispatching.id)?.state, 'uncertain');
    await assert.rejects(restarted.resolve(project.id, pending.id, f.input(pending)), /already resolved/); assert.equal(f.provider.writes.length, 0);
  } finally { f.close(); }
});

test('GitHub file reference keeps path and ref separate and rejects foreign project targets', async () => {
  const f = fixture();
  try {
    await f.service.connect(); const { project } = await f.issueProject();
    const file = await f.service.reference(project.id, 'https://github.com/synthetic/project/blob/main/docs/synthetic.txt');
    assert.equal(file.sourceCommit, 'a'.repeat(40), 'Provenance must identify a commit, not the file blob object');
    assert.deepEqual(f.provider.references[0], { repository: 'synthetic/project', kind: 'commits', target: 'main' });
    await f.service.reference(project.id, 'https://github.com/synthetic/project/blob/feature%2Fsafe/docs/a%20b.txt');
    assert.deepEqual(f.provider.references[1], { repository: 'synthetic/project', kind: 'contents', target: 'docs/synthetic.txt', ref: 'a'.repeat(40) });
    assert.deepEqual(f.provider.references[2], { repository: 'synthetic/project', kind: 'commits', target: 'feature/safe' });
    assert.deepEqual(f.provider.references[3], { repository: 'synthetic/project', kind: 'contents', target: 'docs/a b.txt', ref: 'a'.repeat(40) });
    await assert.rejects(f.service.reference(project.id, 'https://github.com/synthetic/project/blob/main/..%2Fissues'), /URL|reference/);
    await assert.rejects(f.service.reference(project.id, 'https://github.com/synthetic/foreign/issues/1'), /linked GitHub repository/); assert.equal(f.provider.references.length, 4);
  } finally { f.close(); }
});
