import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { GitHubCliProvider, GitHubFailure } from './github-provider.js';
import { freshEntity, type Artifact, type Project, type Task } from '../../../packages/domain/src/index.js';
import { Store } from '../../../packages/store/src/index.js';
import { GitHubService } from './github.js';

interface Configuration { tokenSource?: string; scopes?: string; user?: unknown; exitEarly?: boolean; malformedPost?: boolean; rejectPost?: boolean; accounts?: unknown; pinnedUser?: unknown; postStatus?: number; fetchThrows?: boolean; oversizedPost?: boolean; malformedToken?: boolean; repository?: unknown }
const expectedAccount = { login: 'synthetic', id: 100 };
const syntheticToken = 'gho_synthetic_keyring_credential_for_tests';
function fixture(config: Configuration = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'agentdash-gh-provider-')); const executable = join(directory, 'synthetic-gh.mjs'); const trace = join(directory, 'trace.jsonl');
  const source = `#!${process.execPath}\nimport fs from 'node:fs';
const config=${JSON.stringify(config)}; const trace=${JSON.stringify(trace)}; const args=process.argv.slice(2);
const envKeys=['GH_TOKEN','GITHUB_TOKEN','GH_ENTERPRISE_TOKEN','GITHUB_ENTERPRISE_TOKEN','GIT_ASKPASS','SSH_ASKPASS'];
const env=Object.fromEntries(envKeys.map(key=>[key,Object.hasOwn(process.env,key)]));
if(config.exitEarly){fs.appendFileSync(trace,JSON.stringify({args,env})+'\\n');process.exit(1);}
const input=fs.readFileSync(0,'utf8');fs.appendFileSync(trace,JSON.stringify({args,env,input:input?JSON.parse(input):null})+'\\n');
if(args[0]==='auth'&&args[1]==='token'){process.stdout.write(config.malformedToken?'invalid token output':${JSON.stringify(syntheticToken)});process.exit(0);}
if(args[0]==='auth'){process.stdout.write(JSON.stringify({hosts:{'github.com':Object.hasOwn(config,'accounts')?config.accounts:[{active:true,state:'success',login:'synthetic',tokenSource:config.tokenSource??'keyring',scopes:config.scopes??'repo'}]}}));process.exit(0);}
const endpoint=args.includes('--input')?args[args.indexOf('--input')-1]:args.at(-1);const method=args[args.indexOf('--method')+1];
if(method==='POST'&&config.rejectPost){process.stdout.write('HTTP/2.0 403 Forbidden\\r\\nContent-Type: application/json\\r\\n\\r\\n{"message":"synthetic rejected"}');process.exit(1);}
if(method==='GET'&&endpoint==='repos/synthetic/missing'){process.stdout.write('HTTP/2.0 404 Not Found\\r\\nContent-Type: application/json\\r\\n\\r\\n{"message":"synthetic missing"}');process.exit(1);}
const value=endpoint==='user'?(Object.hasOwn(config,'user')?config.user:{login:'synthetic',id:100}):endpoint.startsWith('user/orgs')?[{login:'synthetic-org',id:200},null]:endpoint==='repos/synthetic/project'&&config.repository?config.repository:{name:'synthetic.txt',sha:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'};
process.stdout.write('HTTP/2.0 200 OK\\r\\nX-OAuth-Scopes: '+(config.scopes??'repo')+'\\r\\nContent-Type: application/json\\r\\n\\r\\n'+(method==='POST'&&config.malformedPost?'invalid-json':JSON.stringify(value)));
`;
  writeFileSync(executable, source); chmodSync(executable, 0o700);
  const fetchCalls: Array<{ url: string; method: string; headers: Headers; redirect?: RequestRedirect; signal?: AbortSignal | null; body?: BodyInit | null }> = [];
  let pinnedUserHook: (() => void) | undefined;
  const fakeFetch: typeof fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), method: init?.method ?? 'GET', headers: new Headers(init?.headers), redirect: init?.redirect, signal: init?.signal, body: init?.body });
    if (config.fetchThrows) throw new DOMException('Synthetic network timeout', 'TimeoutError');
    if (init?.method === 'GET') { pinnedUserHook?.(); return new Response(JSON.stringify(Object.hasOwn(config, 'pinnedUser') ? config.pinnedUser : { login: 'synthetic', id: 100 })); }
    const status = config.postStatus ?? (config.rejectPost ? 403 : 201);
    return new Response(config.malformedPost ? 'invalid-json' : config.oversizedPost ? 'x'.repeat(1_000_001) : JSON.stringify({ synthetic: true }), { status });
  };
  const provider = new GitHubCliProvider(executable, fakeFetch);
  return { provider, executable, fakeFetch, fetchCalls, onPinnedUser(hook?: () => void) { pinnedUserHook = hook; }, calls(): Array<{ args: string[]; env: Record<string, boolean>; input: unknown }> { try { return readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch { return []; } }, close() { rmSync(directory, { recursive: true, force: true }); } };
}

test('verified keyring identity returns scoped metadata and private creation needs repo scope', async () => {
  const f = fixture();
  try { const identity = await f.provider.identity(); assert.equal(identity.login, 'synthetic'); assert.equal(identity.privateRepositoryCreate, true); assert.deepEqual(identity.owners, [{ login: 'synthetic', id: 100 }, { login: 'synthetic-org', id: 200 }]); assert.equal('token' in identity, false); }
  finally { f.close(); }
  const publicOnly = fixture({ scopes: 'public_repo' });
  try { const identity = await publicOnly.provider.identity(); assert.equal(identity.capabilities.repositoryCreate, true); assert.equal(identity.privateRepositoryCreate, false); }
  finally { publicOnly.close(); }
});

test('environment and plaintext account sources are rejected before profile API reads', async () => {
  for (const tokenSource of ['GH_TOKEN','GITHUB_TOKEN','oauth_token','plaintext']) {
    const f = fixture({ tokenSource });
    try { await assert.rejects(f.provider.identity(), error => error instanceof GitHubFailure && error.code === 'github_secure_storage_required'); assert.equal(f.calls().length, 1); }
    finally { f.close(); }
  }
});

test('GitHub CLI child receives no environment-token or askpass fallback credentials', async () => {
  const keys = ['GH_TOKEN','GITHUB_TOKEN','GH_ENTERPRISE_TOKEN','GITHUB_ENTERPRISE_TOKEN','GIT_ASKPASS','SSH_ASKPASS'];
  const former = keys.map(key => process.env[key]); const f = fixture();
  try {
    for (const key of keys) process.env[key] = 'synthetic-not-forwarded';
    await f.provider.identity();
    for (const call of f.calls()) for (const key of keys) assert.equal(call.env[key], false);
    assert.equal(JSON.stringify(f.calls()).includes('synthetic-not-forwarded'), false);
  } finally { keys.forEach((key,index) => { if (former[index] === undefined) delete process.env[key]; else process.env[key] = former[index]; }); f.close(); }
});

test('contents path segments and branch ref are encoded independently exactly once', async () => {
  const f = fixture();
  try {
    await f.provider.reference('synthetic/project', 'contents', 'docs/a b.txt', 'feature/synthetic');
    const args = f.calls()[0].args; assert.equal(args.at(-1), 'repos/synthetic/project/contents/docs/a%20b.txt?ref=feature%2Fsynthetic');
    assert.equal(args.at(-1)?.includes('%3Fref'), false);
  } finally { f.close(); }
});

test('null or mismatched account API data fails closed without exposing raw diagnostics', async () => {
  for (const user of [null, { login: 'other-account', id: 100 }, { login: 'synthetic', id: -1 }]) {
    const f = fixture({ user });
    try { await assert.rejects(f.provider.identity(), error => error instanceof GitHubFailure && error.code === 'github_identity_unverified'); }
    finally { f.close(); }
  }
});

test('definitive missing/rejected responses differ from malformed or closed-channel uncertain writes', async () => {
  const missing = fixture();
  try { assert.equal(await missing.provider.repository('synthetic/missing'), null); }
  finally { missing.close(); }
  const rejected = fixture({ rejectPost: true });
  try { await assert.rejects(rejected.provider.createIssue('synthetic/project', { title: 'Synthetic', body: 'Synthetic', labels: [] }, expectedAccount), error => error instanceof GitHubFailure && !error.ambiguous); }
  finally { rejected.close(); }
  const malformed = fixture({ malformedPost: true });
  try { await assert.rejects(malformed.provider.createIssue('synthetic/project', { title: 'Synthetic', body: 'Synthetic', labels: [] }, expectedAccount), error => error instanceof GitHubFailure && error.ambiguous); }
  finally { malformed.close(); }
  const closed = fixture({ exitEarly: true });
  try { await assert.rejects(closed.provider.createIssue('synthetic/project', { title: 'Synthetic', body: 'Synthetic', labels: [] }, expectedAccount), error => error instanceof GitHubFailure && !error.ambiguous); assert.equal(closed.fetchCalls.length, 0); }
  finally { closed.close(); }
});

test('writes fetch the named keyring account and pin the same verified credential despite a different active CLI account', async () => {
  const f = fixture({ accounts: [{ login: 'other', active: true, state: 'success', tokenSource: 'keyring' }, { login: 'synthetic', active: false, state: 'success', tokenSource: 'keyring' }] });
  try {
    await f.provider.createIssue('synthetic/project', { title: 'Synthetic', body: 'Exact reviewed body', labels: [] }, expectedAccount);
    assert.deepEqual(f.calls().map(call => call.args), [['auth','status','--hostname','github.com','--json','hosts'], ['auth','token','--hostname','github.com','--user','synthetic']]);
    assert.equal(f.fetchCalls.length, 2); assert.equal(f.fetchCalls[0].url, 'https://api.github.com/user'); assert.equal(f.fetchCalls[1].url, 'https://api.github.com/repos/synthetic/project/issues');
    for (const call of f.fetchCalls) { assert.equal(call.headers.get('Authorization'), `Bearer ${syntheticToken}`); assert.equal(call.redirect, 'error'); assert.ok(call.signal instanceof AbortSignal); }
    for (const call of f.calls()) { assert.equal(call.args.includes(syntheticToken), false); assert.ok(Object.values(call.env).every(present => !present)); }
    assert.equal(JSON.stringify(f.calls()).includes(syntheticToken), false);
  } finally { f.close(); }
});

test('named account must be keyring-backed before token lookup, and token identity mismatch never sends POST', async () => {
  for (const config of [{ tokenSource: 'plaintext' }, { tokenSource: 'GH_TOKEN' }, { accounts: [] }, { accounts: [{ login: 100 }] }]) {
    const f = fixture(config);
    try { await assert.rejects(f.provider.createIssue('synthetic/project', { title: 'Synthetic', body: 'Synthetic', labels: [] }, expectedAccount)); assert.equal(f.calls().length, 1); assert.equal(f.fetchCalls.length, 0); }
    finally { f.close(); }
  }
  for (const pinnedUser of [{ login: 'synthetic', id: 101 }, { login: 'other', id: 100 }, null]) {
    const f = fixture({ pinnedUser });
    try { await assert.rejects(f.provider.createIssue('synthetic/project', { title: 'Synthetic', body: 'Synthetic', labels: [] }, expectedAccount), error => error instanceof GitHubFailure && !error.ambiguous); assert.equal(f.fetchCalls.length, 1); assert.equal(f.fetchCalls[0].method, 'GET'); }
    finally { f.close(); }
  }
});

test('final local context refusal occurs after pinned identity verification and before any POST', async () => {
  const f = fixture(); let revoked = false; let checked = false;
  try {
    f.onPinnedUser(() => { revoked = true; });
    await assert.rejects(f.provider.createIssue('synthetic/project', { title: 'Synthetic', body: 'Synthetic', labels: [] }, expectedAccount, () => { checked = true; if (revoked) throw new Error('Synthetic revoked input'); }), error => error instanceof GitHubFailure && error.code === 'github_context_changed' && !error.ambiguous);
    assert.equal(checked, true); assert.deepEqual(f.fetchCalls.map(call => call.method), ['GET']);
  } finally { f.close(); }
});

test('pinned transport rejects redirects, oversized/malformed success and server uncertainty without retrying', async () => {
  for (const config of [{ postStatus: 302 }, { postStatus: 500 }, { oversizedPost: true }, { malformedPost: true }]) {
    const f = fixture(config);
    try { await assert.rejects(f.provider.createRepository('synthetic', 'planned', 'private', 'Synthetic', 'forged-unused-login', expectedAccount), error => error instanceof GitHubFailure && error.ambiguous); assert.deepEqual(f.fetchCalls.map(call => call.method), ['GET','POST']); assert.equal(f.fetchCalls[1].url, 'https://api.github.com/user/repos'); }
    finally { f.close(); }
  }
  const failedIdentity = fixture({ fetchThrows: true });
  try { await assert.rejects(failedIdentity.provider.createIssue('synthetic/project', { title: 'Synthetic', body: 'Synthetic', labels: [] }, expectedAccount), error => error instanceof GitHubFailure && !error.ambiguous); assert.deepEqual(failedIdentity.fetchCalls.map(call => call.method), ['GET']); }
  finally { failedIdentity.close(); }
  const malformedToken = fixture({ malformedToken: true });
  try { await assert.rejects(malformedToken.provider.createIssue('synthetic/project', { title: 'Synthetic', body: 'Synthetic', labels: [] }, expectedAccount)); assert.equal(malformedToken.fetchCalls.length, 0); }
  finally { malformedToken.close(); }
});

test('write targets cannot redirect static GitHub API requests through caller-controlled path components', async () => {
  const f = fixture();
  try {
    for (const target of ['https://attacker.invalid/x','../user','synthetic/../user','synthetic/project?redirect=x','synthetic/%2e%2e']) await assert.rejects(f.provider.createIssue(target, { title: 'Synthetic', body: 'Synthetic', labels: [] }, expectedAccount));
    assert.equal(f.calls().length, 0); assert.equal(f.fetchCalls.length, 0);
  } finally { f.close(); }
});

test('service revalidates revoked issue inputs after pinned GET and records a definitive consumed no-write outcome', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agentdash-pinned-context-')); const store = new Store(':memory:');
  const repository = { id: 500, full_name: 'synthetic/project', html_url: 'https://github.com/synthetic/project', private: true, description: 'Synthetic', permissions: { push: true } };
  const f = fixture({ repository });
  try {
    execFileSync('git', ['init', '-q', directory]); execFileSync('git', ['-C', directory, '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'commit', '--allow-empty', '-qm', 'Synthetic baseline']);
    const commit = execFileSync('git', ['-C', directory, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); const root = freshEntity('tsk');
    const project = store.create<Project>('projects', { ...freshEntity('prj'), name: 'Synthetic', workspace: directory, rootTaskId: root.id, githubRepo: null });
    store.create<Task>('tasks', { ...root, projectId: project.id, parentTaskId: null, name: 'Synthetic', objective: 'Synthetic', personaId: 'synthetic', state: 'ready', sessionId: null, workspace: directory });
    const sources = ['current_roadmap', 'codebase_map'].map(logicalKey => store.create<Artifact>('artifacts', { ...freshEntity('art'), projectId: project.id, taskId: root.id, logicalKey, version: 1, status: 'approved', summary: 'Synthetic', content: null, externalRef: null, sourceCommit: commit, expiresAt: null }));
    const service = new GitHubService(store, 'synthetic-boot', f.provider); await service.connect(); await service.link(project.id, repository.full_name);
    const proposal = await service.propose(project.id, { kind: 'issue.create', repository: repository.full_name, title: 'Synthetic', body: 'Synthetic', labels: [] });
    f.onPinnedUser(() => { const source = sources[0]; store.update<Artifact>('artifacts', source.id, source.revision, { status: 'stale' }); });
    const result = await service.resolve(project.id, proposal.id, { decision: 'approve', expectedRevision: proposal.revision, actionDigest: proposal.actionDigest });
    assert.equal(result.state, 'failed'); assert.equal(result.externalUrl, null); assert.equal(service.verifyProposal(result), true); assert.deepEqual(f.fetchCalls.map(call => call.method), ['GET']);
    await assert.rejects(service.resolve(project.id, proposal.id, { decision: 'approve', expectedRevision: result.revision, actionDigest: result.actionDigest }), /already resolved/);
    assert.equal(f.fetchCalls.length, 1); assert.equal(store.verifyAudit().valid, true);
  } finally { store.close(); f.close(); rmSync(directory, { recursive: true, force: true }); }
});
