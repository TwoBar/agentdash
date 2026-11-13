import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CodexConnector, type StartSessionOptions } from '../../../packages/codex/src/index.js';
import { freshEntity, type Artifact, type GitHubProposal, type Session, type Task } from '../../../packages/domain/src/index.js';
import { createApplication } from './app.js';
import type { GitHubProvider, Issue, Repository } from './github-provider.js';
import { artifactInput, parseIssuePlan } from './issue-planning.js';
import { Runtime } from './runtime.js';

const plannedIssues = [{ title: 'Synthetic planned issue', body: 'Implement the reviewed bounded change.', labels: ['synthetic'] }, { title: 'Second synthetic issue', body: 'Verify the reviewed bounded change.' }];
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'agentdash-issue-planning-')); const workspace = join(directory, 'workspace'); const assets = join(directory, 'assets'); mkdirSync(workspace); mkdirSync(assets);
  writeFileSync(join(assets, 'index.html'), '<!doctype html><title>Synthetic planning</title>');
  execFileSync('git', ['init', '-q', workspace]); execFileSync('git', ['-C', workspace, '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'commit', '--allow-empty', '-qm', 'Synthetic baseline']);
  const head = (cwd = workspace) => execFileSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const repository: Repository = { id: 500, full_name: 'synthetic/planning', html_url: 'https://github.com/synthetic/planning', private: true, description: 'Synthetic', permissions: { push: true } };
  const writes: Array<{ repository: string; title: string; body: string; labels: string[] }> = []; const issues: Issue[] = [];
  let repositoryHook: (() => void) | undefined;
  const provider: GitHubProvider = {
    identity: async () => ({ login: 'synthetic', id: 100, owners: [{ login: 'synthetic', id: 100 }], capabilities: { read: true, repositoryCreate: true, issueCreate: true, administration: false, release: false }, privateRepositoryCreate: true }),
    repository: async name => { repositoryHook?.(); return name === repository.full_name ? repository : null; },
    createRepository: async () => { throw new Error('Repository writes are not used in this fixture'); },
    createIssue: async (target, input) => { writes.push({ repository: target, ...structuredClone(input) }); const result = { id: 1000 + writes.length, number: writes.length, html_url: `https://github.com/${target}/issues/${writes.length}`, title: input.title, body: input.body }; issues.push(result); return result; },
    findIssue: async (_target, marker) => issues.find(issue => issue.body?.includes(marker)) ?? null,
    reference: async () => ({}),
  };
  const starts: StartSessionOptions[] = []; let runtime!: Runtime; let sequence = 0;
  const connector = {
    probe: async () => ({ available: true, version: 'synthetic', reason: null }),
    startSession: async (input: StartSessionOptions) => { starts.push(input); return { bindingRef: `synthetic-${input.sessionId}` }; },
    sendMessage: async (sessionId: string) => { const turnId = `turn-${++sequence}`; runtime.onConnectorEvent({ sessionId, type: 'turn.started', sourceId: turnId, turnId, summary: 'Synthetic turn' }); return { turnId }; },
    terminate: async () => {}, interrupt: async () => {}, close: async () => {}, resolveApproval: async () => { throw new Error('No native approval delivery expected'); },
  };
  runtime = new Runtime({ dataDirectory: join(directory, 'state'), connector: connector as unknown as CodexConnector, githubProvider: provider, bootId: 'synthetic-planning-boot', maxParentReviews: 0 });
  const app = await createApplication({ runtime, port: 0, development: false, staticDirectory: assets });
  const nav = await fetch(app.origin); await nav.text(); const cookie = nav.headers.get('set-cookie')!.split(';')[0];
  const { csrfToken } = await (await fetch(app.origin + '/api/session', { headers: { cookie } })).json() as { csrfToken: string };
  const headers = { cookie, Origin: app.origin, 'Content-Type': 'application/json', 'X-AGCP-CSRF': csrfToken };
  const post = (path: string, body: unknown) => fetch(app.origin + path, { method: 'POST', headers, body: JSON.stringify(body) });
  const project = await runtime.createProject({ name: 'Synthetic issue planning', workspace, objective: 'Synthetic bounded planning' });
  await runtime.github.connect(); await runtime.github.link(project.id, repository.full_name);
  const planner = runtime.createTask(project.id, { parentTaskId: project.rootTaskId, name: 'Issue planner', objective: 'Resolve both inputs and publish bounded issues', personaId: 'persona_research_v1' });
  const session = await runtime.startTask(project.id, planner.id); const token = starts[0].environment!.AGCP_SESSION_CAPABILITY;
  const inputs = ['current_roadmap', 'codebase_map'].map(logicalKey => runtime.store.create<Artifact>('artifacts', { ...freshEntity('art'), projectId: project.id, taskId: project.rootTaskId, logicalKey, version: 1, status: 'approved', summary: 'Synthetic approved source', content: logicalKey === 'current_roadmap' ? 'Synthetic roadmap' : 'Synthetic map', externalRef: null, sourceCommit: head(), expiresAt: null, readableByTaskIds: [planner.id] }));
  async function call(name: string, args: unknown, capability = token) {
    const response = await fetch(app.origin + '/mcp', { method: 'POST', headers: { Authorization: `Bearer ${capability}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++sequence, method: 'tools/call', params: { name, arguments: args } }) });
    const body = await response.json() as any; return { status: response.status, result: body.result, body };
  }
  async function readBoth(capability = token) { for (const logicalKey of ['current_roadmap', 'codebase_map']) { const response = await call('resolve_artifact', { logicalKey }, capability); assert.equal(response.result?.isError, undefined, JSON.stringify(response.body)); } }
  async function publish() { await readBoth(); const response = await call('register_artifact', { logicalKey: 'issue_proposals', summary: 'Synthetic issue list', content: JSON.stringify(plannedIssues) }); assert.equal(response.result.isError, undefined); return response.result.structuredContent as Artifact; }
  async function approve(artifact: Artifact) { const response = await post(`/api/projects/${project.id}/artifacts/${artifact.id}/approve`, {}); assert.equal(response.status, 200); return await response.json() as Artifact; }
  async function prepare(artifact: Artifact, index = 0) { return post(`/api/projects/${project.id}/github/proposals/from-artifact`, { artifactId: artifact.id, index }); }
  return { app, runtime, project, planner, session, token, inputs, writes, head, workspace, call, readBoth, publish, approve, prepare, post, setRepositoryHook(hook?: () => void) { repositoryHook = hook; }, async close() { await app.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('issue list schema rejects executable/authority metadata, malformed JSON and invalid items', () => {
  for (const input of [null, '{', '{}', '[]', '[{"title":"", "body":"x"}]', JSON.stringify([{ ...plannedIssues[0], approved: true }]), JSON.stringify([{ ...plannedIssues[0], repository: 'foreign/repository' }]), JSON.stringify([{ ...plannedIssues[0], labels: [''] }])]) assert.throws(() => parseIssuePlan(input), /JSON list/);
  assert.deepEqual(parseIssuePlan(JSON.stringify(plannedIssues)), [plannedIssues[0], { ...plannedIssues[1], labels: [] }]);
});

test('real MCP resolves both logical keys then publishes draft exact provenance; only human approval prepares and dispatches selected issue', async () => {
  const f = await fixture();
  try {
    const draft = await f.publish(); assert.equal(draft.status, 'draft'); assert.equal(draft.taskId, f.planner.id); assert.equal(draft.sourceSessionId, f.session.id); assert.deepEqual(draft.inputArtifacts, f.inputs.map(artifactInput)); assert.equal(draft.sourceCommit, f.head());
    assert.equal((await f.prepare(draft)).status, 409); assert.equal(f.writes.length, 0); const approved = await f.approve(draft);
    const response = await f.prepare(approved, 1); assert.equal(response.status, 201); const proposal = await response.json() as GitHubProposal;
    assert.equal(proposal.taskId, f.planner.id); assert.equal(proposal.planningArtifactId, approved.id); assert.equal(proposal.planningIssueIndex, 1); assert.deepEqual(proposal.artifactInputs, approved.inputArtifacts); assert.equal(proposal.payload.title, plannedIssues[1].title); assert.equal(proposal.payload.body, plannedIssues[1].body + `\n\n<!-- ${proposal.reconciliationMarker} -->`); assert.deepEqual(proposal.payload.labels, []); assert.equal(f.writes.length, 0);
    const decision = { decision: 'approve', expectedRevision: proposal.revision, actionDigest: proposal.actionDigest };
    const resolved = await f.post(`/api/projects/${f.project.id}/github/proposals/${proposal.id}/resolve`, decision); assert.equal(resolved.status, 200); const result = await resolved.json() as GitHubProposal;
    assert.equal(result.state, 'succeeded'); assert.equal(f.writes.length, 1); assert.equal(f.writes[0].title, plannedIssues[1].title); assert.equal(f.writes[0].body, proposal.payload.body); assert.equal(f.runtime.github.verifyProposal(result), true);
    assert.equal(f.runtime.github.verifyProposal({ ...result, planningIssueIndex: 0 }), false); assert.equal((await f.prepare(approved, 1)).status, 409); assert.equal((await f.post(`/api/projects/${f.project.id}/github/proposals/${proposal.id}/resolve`, decision)).status, 409); assert.equal(f.writes.length, 1);
    assert.equal(f.runtime.must<Task>('tasks', f.planner.id).state, 'running'); assert.equal(f.runtime.store.list('decisions').length, 0); assert.equal(f.runtime.store.verifyAudit().valid, true);
  } finally { await f.close(); }
});

test('caller claims, partial reads, other sessions and a fresh replacement cannot supply planning read authority', async () => {
  const f = await fixture();
  try {
    const input = { logicalKey: 'issue_proposals', summary: 'Synthetic', content: JSON.stringify(plannedIssues), inputArtifacts: f.inputs.map(artifactInput), sourceSessionId: f.session.id };
    assert.equal((await f.call('register_artifact', input)).result.isError, true); await f.call('resolve_artifact', { logicalKey: 'current_roadmap' }); assert.equal((await f.call('register_artifact', input)).result.isError, true);
    await f.readBoth(); const ownTask = f.runtime.must<Task>('tasks', f.planner.id);
    f.runtime.onConnectorEvent({ sessionId: f.session.id, type: 'session.disconnected', sourceId: 'synthetic-lost', summary: 'Synthetic process lost' });
    const replacement = await f.runtime.startTask(f.project.id, f.planner.id); const replacementToken = f.runtime.capabilities.issue({ projectId: f.project.id, taskId: f.planner.id, sessionId: replacement.id });
    assert.equal((await f.call('register_artifact', input, replacementToken)).result.isError, true);
    await f.readBoth(replacementToken); const draft = await f.call('register_artifact', input, replacementToken); assert.equal(draft.result.isError, undefined); assert.equal(draft.result.structuredContent.sourceSessionId, replacement.id); assert.notEqual(draft.result.structuredContent.sourceSessionId, ownTask.sessionId);
    const events = f.runtime.store.list('events'); assert.equal(JSON.stringify(events).includes('Synthetic roadmap'), false);
  } finally { await f.close(); }
});

test('current inputs must be reread after supersession and missing, unreadable or stale logical inputs fail closed', async () => {
  const f = await fixture();
  try {
    await f.readBoth(); const current = f.inputs[0];
    const newer = f.runtime.store.create<Artifact>('artifacts', { ...current, ...freshEntity('art'), version: 2 });
    const draftInput = { logicalKey: 'issue_proposals', summary: 'Synthetic', content: JSON.stringify(plannedIssues) };
    assert.equal((await f.call('register_artifact', draftInput)).result.isError, true); await f.readBoth(); assert.equal((await f.call('register_artifact', draftInput)).result.isError, undefined);
    f.runtime.store.create<Artifact>('artifacts', { ...newer, ...freshEntity('art'), version: 3, readableByTaskIds: [] }); assert.equal((await f.call('resolve_artifact', { logicalKey: 'current_roadmap' })).result.isError, true);
    const staleMap = f.runtime.store.update<Artifact>('artifacts', f.inputs[1].id, f.inputs[1].revision, { status: 'stale' }); assert.equal((await f.call('resolve_artifact', { logicalKey: staleMap.logicalKey })).result.isError, true); assert.equal((await f.call('resolve_artifact', { logicalKey: 'missing_source' })).result.isError, true); assert.equal(f.writes.length, 0);
  } finally { await f.close(); }
});

test('foreign plans, malformed selectors and caller content overrides cannot prepare an external issue', async () => {
  const f = await fixture();
  try {
    const approved = await f.approve(await f.publish()); const foreign = await f.runtime.createProject({ name: 'Foreign synthetic', workspace: f.workspace, objective: 'Synthetic' });
    assert.equal((await f.post(`/api/projects/${foreign.id}/github/proposals/from-artifact`, { artifactId: approved.id, index: 0 })).status, 404);
    for (const body of [{ artifactId: approved.id, index: -1 }, { artifactId: approved.id, index: 0.5 }, { artifactId: approved.id, index: 0, title: 'Forged title' }]) assert.equal((await f.post(`/api/projects/${f.project.id}/github/proposals/from-artifact`, body)).status, 400);
    assert.equal((await f.prepare(approved, 99)).status, 409); assert.equal(f.writes.length, 0);
  } finally { await f.close(); }
});

test('source changes in the planning child worktree invalidate old read receipts and approved plans', async () => {
  const f = await fixture();
  try {
    const approved = await f.approve(await f.publish()); const worktree = f.runtime.must<Task>('tasks', f.planner.id).workspace!;
    execFileSync('git', ['-C', worktree, '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'commit', '--allow-empty', '-qm', 'Synthetic source changed']);
    assert.notEqual(f.head(worktree), f.head()); assert.equal((await f.prepare(approved)).status, 409);
    assert.equal((await f.call('register_artifact', { logicalKey: 'issue_proposals', summary: 'Synthetic', content: JSON.stringify(plannedIssues) })).result.isError, true); assert.equal(f.writes.length, 0);
  } finally { await f.close(); }
});

test('revoking source inputs or the planning artifact during remote predispatch validation blocks without signing or writes', async () => {
  for (const revokePlan of [false, true]) {
    const f = await fixture();
    try {
      const approved = await f.approve(await f.publish()); const prepared = await f.prepare(approved); assert.equal(prepared.status, 201); const proposal = await prepared.json() as GitHubProposal;
      f.setRepositoryHook(() => { f.setRepositoryHook(); const target = revokePlan ? approved : f.inputs[0]; const current = f.runtime.must<Artifact>('artifacts', target.id); f.runtime.store.update<Artifact>('artifacts', current.id, current.revision, { status: 'stale' }); });
      await assert.rejects(f.runtime.github.resolve(f.project.id, proposal.id, { decision: 'approve', expectedRevision: proposal.revision, actionDigest: proposal.actionDigest }), /current_roadmap|planning artifact/);
      const current = f.runtime.must<GitHubProposal>('githubProposals', proposal.id); assert.equal(current.state, 'pending'); assert.equal(current.signature, undefined); assert.equal(f.writes.length, 0);
    } finally { await f.close(); }
  }
});

test('concurrent preparation consumes one planning item and provenance bindings cannot be rewritten or cross projects', async () => {
  const f = await fixture();
  try {
    const approved = await f.approve(await f.publish()); const responses = await Promise.all([f.prepare(approved), f.prepare(approved)]); assert.deepEqual(responses.map(response => response.status).sort(), [201,409]);
    assert.throws(() => f.runtime.store.update<Artifact>('artifacts', approved.id, approved.revision, { inputArtifacts: [] }), /Immutable/); assert.throws(() => f.runtime.store.update<Artifact>('artifacts', approved.id, approved.revision, { sourceSessionId: 'forged' }), /Immutable/);
    const foreign = await f.runtime.createProject({ name: 'Foreign metadata', workspace: f.workspace, objective: 'Synthetic' });
    assert.throws(() => f.runtime.store.create<Artifact>('artifacts', { ...approved, ...freshEntity('art'), projectId: foreign.id, taskId: foreign.rootTaskId, version: 1 }), /input binding|session binding/);
    const proposal = f.runtime.store.list<GitHubProposal>('githubProposals')[0]; assert.throws(() => f.runtime.store.update<GitHubProposal>('githubProposals', proposal.id, proposal.revision, { planningIssueIndex: 1 }), /Immutable/); assert.equal(f.writes.length, 0);
  } finally { await f.close(); }
});
