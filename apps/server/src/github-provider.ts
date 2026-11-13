import { spawn } from 'node:child_process';
import { AppError } from './security.js';
import type { ConnectionCapabilities } from '../../../packages/domain/src/index.js';

export interface Repository { id: number; full_name: string; html_url: string; private: boolean; description: string | null; permissions?: { pull?: boolean; push?: boolean; admin?: boolean }; }
export interface Issue { id: number; number: number; html_url: string; body: string | null; title: string; pull_request?: unknown; }
export interface GitHubIdentity { login: string; id: number; owners: Array<{ login: string; id: number }>; capabilities: ConnectionCapabilities; privateRepositoryCreate: boolean; }
export interface ExpectedGitHubAccount { login: string; id: number }
export type BeforeGitHubWrite = () => void | Promise<void>;
export interface GitHubProvider {
  identity(): Promise<GitHubIdentity>;
  repository(name: string): Promise<Repository | null>;
  createRepository(owner: string, name: string, visibility: 'private' | 'public', description: string, login: string, expectedAccount: ExpectedGitHubAccount, beforeWrite?: BeforeGitHubWrite): Promise<Repository>;
  createIssue(repository: string, input: { title: string; body: string; labels: string[] }, expectedAccount: ExpectedGitHubAccount, beforeWrite?: BeforeGitHubWrite): Promise<Issue>;
  findIssue(repository: string, marker: string): Promise<Issue | null>;
  reference(repository: string, kind: 'issues' | 'pulls' | 'commits' | 'contents', target: string, ref?: string): Promise<unknown>;
}
export class GitHubFailure extends AppError {
  constructor(code: string, message: string, readonly ambiguous = false, status = 409) { super(code, message, status, { retryable: !ambiguous }); }
}
/** Read operations use gh; writes transiently hold one named keyring token for account-pinned HTTPS. */
export class GitHubCliProvider implements GitHubProvider {
  constructor(private readonly executable = 'gh', private readonly fetchImpl: typeof fetch = globalThis.fetch) {}
  private async run(args: string[], input?: unknown): Promise<string> {
    const env: NodeJS.ProcessEnv = { GH_PROMPT_DISABLED: '1', GH_HOST: 'github.com', NO_COLOR: '1' };
    for (const key of ['HOME', 'PATH', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'GH_CONFIG_DIR', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) if (process.env[key]) env[key] = process.env[key];
    return await new Promise<string>((resolve, reject) => {
      const child = spawn(this.executable, args, { env, stdio: ['pipe', 'pipe', 'pipe'] }); let output = ''; let tooLarge = false;
      const timer = setTimeout(() => child.kill('SIGTERM'), 20_000); timer.unref();
      child.stdout.on('data', bytes => { if (output.length + bytes.length > 1_000_000) { tooLarge = true; child.kill('SIGTERM'); } else output += bytes.toString(); });
      child.stderr.resume(); // Never return raw CLI diagnostics, credentials or URLs to the operator/model.
      child.stdin.on('error', () => { clearTimeout(timer); child.kill('SIGTERM'); reject(new GitHubFailure('github_delivery_uncertain', 'The GitHub CLI input channel closed. Reconcile before attempting another write.', true)); });
      child.on('error', () => { clearTimeout(timer); reject(new GitHubFailure('github_cli_unavailable', 'Install GitHub CLI and sign in using its OS keyring before connecting the profile.', false)); });
      child.on('close', code => { clearTimeout(timer); if (code === 0 && !tooLarge) resolve(output); else {
        const status = output.match(/^HTTP\/[\d.]+\s+(\d+)/m)?.[1]; const definitive = status && ['400','401','403','404','409','422'].includes(status);
        reject(new GitHubFailure(status === '404' ? 'github_not_found' : status === '401' || status === '403' ? 'github_access_denied' : 'github_request_failed', definitive ? 'GitHub rejected this request. Check the connected account, target access and proposal.' : 'GitHub did not return a confirmed result. Inspect or reconcile this proposal before any new write.', !definitive));
      } });
      if (input !== undefined) child.stdin.end(JSON.stringify(input)); else child.stdin.end();
    });
  }
  private async request(method: string, endpoint: string, body?: unknown): Promise<{ value: any; headers: string }> {
    const output = await this.run(['api', '--hostname', 'github.com', '--method', method, '--include', '-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2026-03-10', endpoint, ...(body === undefined ? [] : ['--input', '-'])], body);
    const match = output.match(/^([\s\S]*?)\r?\n\r?\n([\s\S]*)$/);
    if (!match) throw new GitHubFailure('github_response_invalid', 'GitHub returned an unreadable response.', method !== 'GET');
    try { return { value: JSON.parse(match[2]), headers: match[1] }; } catch { throw new GitHubFailure('github_response_invalid', 'GitHub returned an unreadable response.', method !== 'GET'); }
  }
  async identity(): Promise<GitHubIdentity> {
    let accounts: any;
    try { accounts = JSON.parse(await this.run(['auth', 'status', '--active', '--hostname', 'github.com', '--json', 'hosts'])); } catch { throw new GitHubFailure('github_auth_unavailable', 'Sign in with GitHub CLI using its OS keyring, then connect your profile.'); }
    const accountsForHost = accounts?.hosts?.['github.com'];
    const account = Array.isArray(accountsForHost) ? accountsForHost.find((a: any) => a && a.active && a.state === 'success') : undefined;
    if (!account || typeof account.login !== 'string' || account.tokenSource !== 'keyring') throw new GitHubFailure('github_secure_storage_required', 'This integration requires GitHub CLI authentication stored in the OS keyring. Environment tokens and plaintext credential storage are not accepted.');
    const { value: user, headers } = await this.request('GET', 'user');
    if (!user || typeof user.login !== 'string' || !Number.isSafeInteger(user.id) || user.id < 1 || user.login.toLowerCase() !== account.login.toLowerCase()) throw new GitHubFailure('github_identity_unverified', 'The active GitHub identity could not be verified.');
    const scopes = (headers.match(/^x-oauth-scopes:\s*(.*)$/im)?.[1] ?? (typeof account.scopes === 'string' ? account.scopes : '')).split(/[,\s]+/);
    const repositoryWrite = scopes.includes('repo') || scopes.includes('public_repo');
    let organizations: Array<{ login: string; id: number }> = [];
    try { const { value } = await this.request('GET', 'user/orgs?per_page=100'); organizations = Array.isArray(value) ? value.filter(o => o && typeof o.login === 'string' && Number.isSafeInteger(o.id) && o.id > 0).map(o => ({ login: o.login, id: o.id })) : []; } catch { /* Personal owner remains available; never infer inaccessible organizations. */ }
    return { login: user.login, id: user.id, owners: [{ login: user.login, id: user.id }, ...organizations], capabilities: { read: true, repositoryCreate: repositoryWrite, issueCreate: repositoryWrite, administration: false, release: false }, privateRepositoryCreate: scopes.includes('repo') };
  }
  async repository(name: string): Promise<Repository | null> { try { return (await this.request('GET', 'repos/' + name)).value; } catch (error) { if (error instanceof GitHubFailure && error.code === 'github_not_found') return null; throw error; } }
  private async pinnedRequest(method: 'GET' | 'POST', endpoint: string, token: string, input?: unknown): Promise<unknown> {
    const ambiguous = method === 'POST';
    let response: Response;
    try {
      response = await this.fetchImpl('https://api.github.com/' + endpoint, {
        method, redirect: 'error', signal: AbortSignal.timeout(20_000),
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10', 'User-Agent': 'Agentdash/0.1', ...(input === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(input === undefined ? {} : { body: JSON.stringify(input) }),
      });
    } catch { throw new GitHubFailure('github_delivery_uncertain', ambiguous ? 'GitHub did not confirm the write. Reconcile before attempting another write.' : 'GitHub account verification could not be completed; no write was sent.', ambiguous); }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      const definitive = [400, 401, 403, 404, 409, 422].includes(response.status);
      throw new GitHubFailure('github_request_failed', 'GitHub rejected the account verification or write request. Review the account and proposal.', ambiguous && !definitive);
    }
    try {
      const reader = response.body?.getReader(); if (!reader) throw new Error('Missing response body');
      const chunks: Uint8Array[] = []; let total = 0;
      try {
        while (true) { const { done, value } = await reader.read(); if (done) break; total += value.byteLength; if (total > 1_000_000) { await reader.cancel(); throw new Error('Response limit'); } chunks.push(value); }
      } finally { reader.releaseLock(); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch { throw new GitHubFailure('github_response_invalid', ambiguous ? 'GitHub returned an unreadable write result. Reconcile before another write.' : 'GitHub account verification returned unreadable data; no write was sent.', ambiguous); }
  }
  private async accountPinnedWrite(endpoint: string, input: unknown, expectedAccount: ExpectedGitHubAccount, beforeWrite?: BeforeGitHubWrite): Promise<any> {
    if (!expectedAccount || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(expectedAccount.login) || !Number.isSafeInteger(expectedAccount.id) || expectedAccount.id < 1) throw new GitHubFailure('github_identity_unverified', 'The original GitHub account binding is missing; no write was sent.');
    let accounts: any;
    try { accounts = JSON.parse(await this.run(['auth', 'status', '--hostname', 'github.com', '--json', 'hosts'])); } catch { throw new GitHubFailure('github_auth_unavailable', 'The original GitHub account could not be verified; no write was sent.'); }
    const list = accounts?.hosts?.['github.com'];
    const account = Array.isArray(list) ? list.find(value => typeof value?.login === 'string' && value.login.toLowerCase() === expectedAccount.login.toLowerCase()) : undefined;
    if (account?.state !== 'success' || account.tokenSource !== 'keyring') throw new GitHubFailure('github_secure_storage_required', 'The original GitHub account must use the OS keyring; no write was sent.');
    let token: string;
    try { token = (await this.run(['auth', 'token', '--hostname', 'github.com', '--user', expectedAccount.login])).trim(); } catch { throw new GitHubFailure('github_auth_unavailable', 'The named keyring credential could not be retrieved; no write was sent.'); }
    if (!/^[A-Za-z0-9_.-]{20,2000}$/.test(token)) throw new GitHubFailure('github_auth_unavailable', 'The named keyring credential is unavailable; no write was sent.');
    // The same captured token verifies identity and authenticates the POST; gh's global active account cannot rebind it.
    try {
      const user: any = await this.pinnedRequest('GET', 'user', token);
      if (user?.id !== expectedAccount.id || typeof user.login !== 'string' || user.login.toLowerCase() !== expectedAccount.login.toLowerCase()) throw new GitHubFailure('github_identity_unverified', 'The named credential does not match the original account; no write was sent.');
      try { await beforeWrite?.(); } catch { throw new GitHubFailure('github_context_changed', 'The exact project, account or planning context changed before delivery; no write was sent. Review a new proposal.'); }
      return await this.pinnedRequest('POST', endpoint, token, input);
    } finally { token = ''; }
  }
  async createRepository(owner: string, name: string, visibility: 'private' | 'public', description: string, _login: string, expectedAccount: ExpectedGitHubAccount, beforeWrite?: BeforeGitHubWrite): Promise<Repository> {
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(owner)) throw new GitHubFailure('github_target_mismatch', 'The repository owner is invalid; no write was sent.');
    return this.accountPinnedWrite(owner.toLowerCase() === expectedAccount?.login?.toLowerCase() ? 'user/repos' : `orgs/${encodeURIComponent(owner)}/repos`, { name, private: visibility === 'private', description, auto_init: false }, expectedAccount, beforeWrite);
  }
  async createIssue(repository: string, input: { title: string; body: string; labels: string[] }, expectedAccount: ExpectedGitHubAccount, beforeWrite?: BeforeGitHubWrite): Promise<Issue> {
    const parts = repository.split('/');
    if (parts.length !== 2 || parts.some(part => !/^[A-Za-z0-9_.-]{1,100}$/.test(part) || ['.', '..'].includes(part))) throw new GitHubFailure('github_target_mismatch', 'The repository target is invalid; no write was sent.');
    return this.accountPinnedWrite(`repos/${parts.map(encodeURIComponent).join('/')}/issues`, input, expectedAccount, beforeWrite);
  }
  async findIssue(repository: string, marker: string): Promise<Issue | null> {
    for (let page = 1; page <= 3; page++) { const { value } = await this.request('GET', `repos/${repository}/issues?state=all&sort=created&direction=desc&per_page=100&page=${page}`); if (!Array.isArray(value)) break; const issue = value.find(i => !i.pull_request && typeof i.body === 'string' && i.body.includes(marker)); if (issue) return issue; if (value.length < 100) break; } return null;
  }
  async reference(repository: string, kind: 'issues' | 'pulls' | 'commits' | 'contents', target: string, ref?: string): Promise<unknown> {
    const query = ref === undefined ? '' : '?ref=' + encodeURIComponent(ref);
    return (await this.request('GET', `repos/${repository}/${kind}/${(kind === 'contents' ? target.split('/').map(encodeURIComponent).join('/') : encodeURIComponent(target))}${query}`)).value;
  }
}
