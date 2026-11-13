#!/usr/bin/env node
/** Native model-backed feasibility probe. No application/server mocks.
 * Run: node scripts/spikes/native-approval.mjs --live [--output /tmp/summary.json]
 * Requires signed-in Codex CLI. Reads no credentials and stores no wire transcripts.
 */
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const argv = process.argv.slice(2);
if (!argv.includes('--live')) {
  console.log('Native approval probe: pass --live to run signed-in model-backed Codex calls. Optional: --output /tmp/summary.json');
  process.exit(0);
}
const outputIndex = argv.indexOf('--output');
if (outputIndex >= 0 && !argv[outputIndex + 1]) throw new Error('--output needs a path');
const output = outputIndex < 0 ? null : resolve(argv[outputIndex + 1]);
const HOLD_MS = 2000;
const TIMEOUT_MS = 90000;
const scratch = mkdtempSync(join(tmpdir(), 'agentdash-native-approval-'));
const clients = [];
const evidence = {
  kind: 'sanitized-live-observations',
  date: new Date().toISOString().slice(0, 10),
  cliVersion: execFileSync('codex', ['--version'], { encoding: 'utf8' }).trim(),
  transport: 'stdio JSON-RPC, v2 methods',
  scratchRetained: false,
  observations: {},
};
function assert(value, message) { if (!value) throw new Error(message); }
async function until(predicate, label, timeout = TIMEOUT_MS) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start >= timeout) throw new Error(`Timed out: ${label}`);
    await delay(30);
  }
  return predicate();
}
class NativeClient {
  constructor() {
    this.pendingCalls = new Map();
    this.requests = [];
    this.items = [];
    this.turns = [];
    this.events = [];
    this.sequence = 1;
    this.closed = false;
    // Leave CLI authentication in its supported store. No auth/config file reads.
    // Hooks/apps are disabled for this isolated synthetic test; no external tool calls are requested.
    this.proc = spawn('codex', ['app-server',
      '-c', 'features.apps=false', '-c', 'features.hooks=false',
      '-c', 'features.code_mode=false', '-c', 'features.shell_tool=true',
      '-c', 'features.unified_exec=true', '-c', 'analytics.enabled=false',
    ], { cwd: scratch, stdio: ['pipe', 'pipe', 'pipe'] });
    clients.push(this);
    this.proc.stderr.resume(); // Raw process logs may contain private machine paths: never persist.
    this.proc.stdin.on('error', () => {});
    this.proc.on('exit', (code, signal) => {
      this.closed = true;
      this.exit = { code, signal };
      for (const { reject } of this.pendingCalls.values()) reject(new Error('Native process exited'));
      this.pendingCalls.clear();
    });
    this.proc.on('error', () => { this.closed = true; });
    createInterface({ input: this.proc.stdout }).on('line', line => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (Object.hasOwn(msg, 'id') && !msg.method) {
        const call = this.pendingCalls.get(msg.id);
        if (!call) return;
        this.pendingCalls.delete(msg.id);
        if (msg.error) call.reject(new Error(`Native RPC error ${msg.error.code}`));
        else call.resolve(msg.result);
        return;
      }
      if (!msg.method) return;
      this.events.push(msg.method); // Method names only, never raw conversation data.
      if (Object.hasOwn(msg, 'id')) this.requests.push(msg);
      if (msg.method === 'item/completed' && msg.params.item.type === 'commandExecution') {
        this.items.push({ threadId: msg.params.threadId, itemId: msg.params.item.id, status: msg.params.item.status });
      }
      if (msg.method === 'turn/completed') {
        this.turns.push({ threadId: msg.params.threadId, turnId: msg.params.turn.id, status: msg.params.turn.status });
      }
    });
  }
  send(message) {
    assert(!this.closed, 'Native process unavailable');
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }
  call(method, params) {
    const id = this.sequence++;
    return new Promise((resolveCall, reject) => {
      const timer = setTimeout(() => {
        this.pendingCalls.delete(id);
        reject(new Error(`Native RPC timeout: ${method}`));
      }, TIMEOUT_MS);
      this.pendingCalls.set(id, {
        resolve: value => { clearTimeout(timer); resolveCall(value); },
        reject: error => { clearTimeout(timer); reject(error); },
      });
      this.send({ id, method, params });
    });
  }
  async initialize() {
    const result = await this.call('initialize', {
      clientInfo: { name: 'agentdash_native_approval_spike', version: '0.0.1' },
      capabilities: { experimentalApi: false },
    });
    this.send({ method: 'initialized', params: {} });
    this.userAgent = result.userAgent;
    const models = await this.call('model/list', {});
    this.model = models.data.find(model => model.isDefault)?.model;
    assert(this.model, 'No server-default model available');
    return this;
  }
  async thread(sentinel, persistent = false) {
    const result = await this.call('thread/start', {
      model: this.model, cwd: scratch, ephemeral: !persistent,
      sandbox: 'read-only', approvalPolicy: 'on-request', approvalsReviewer: 'user',
      baseInstructions: 'You run isolated synthetic native approval tests. Execute only the exact requested command once. If denied, stop and report denial. Do not try alternative tools or commands.',
      developerInstructions: 'Use the shell execution tool for the requested touch command. Request require_escalated sandbox permissions because the sandbox is read-only. Do not use request_permissions or apply_patch. Never retry a denied command.',
    });
    assert(result.approvalPolicy === 'on-request', 'Approval policy override did not apply');
    assert(result.approvalsReviewer === 'user', 'Approval reviewer is not user');
    assert(result.sandbox.type === 'readOnly', 'Sandbox is not read-only');
    const state = { threadId: result.thread.id, sentinel, path: join(scratch, sentinel) };
    assert(!existsSync(state.path), 'Sentinel exists before test');
    const turn = await this.call('turn/start', {
      threadId: state.threadId, effort: 'low',
      input: [{ type: 'text', text: `Synthetic approval test. Execute exactly this shell command once: touch ${sentinel}. Request sandbox_permissions=require_escalated because the sandbox is read-only. Do not execute any other command, do not use an alternate tool, and do not retry if declined.` }],
    });
    state.turnId = turn.turn.id;
    return state;
  }
  async approval(state) {
    const request = await until(() => this.requests.find(req => req.params?.threadId === state.threadId && req.params?.turnId === state.turnId), 'native approval');
    assert(request.method === 'item/commandExecution/requestApproval', 'Unexpected request category: fail closed');
    const p = request.params;
    assert(p.threadId === state.threadId && p.turnId === state.turnId, 'Native session binding mismatch');
    assert(p.kind === 'command' && !p.networkApprovalContext, 'Not a one-command approval');
    assert(p.cwd === scratch && p.environmentId === 'local', 'Native workspace/environment mismatch');
    // These are known synthetic commands; reject every alternative rather than approving model output freely.
    assert(p.command === `/bin/zsh -lc 'touch ${state.sentinel}'` ||
      p.command === `/bin/bash -lc 'touch ${state.sentinel}'` ||
      p.command === `touch ${state.sentinel}`, 'Unexpected native command: fail closed');
    state.request = request;
    return request;
  }
  decide(state, decision) {
    assert(state.request && !state.resolved, 'Missing/already resolved request');
    assert(state.request.params.threadId === state.threadId && state.request.params.turnId === state.turnId, 'Local binding mismatch');
    assert(decision === 'accept' || decision === 'decline' || decision === 'cancel', 'Only one-action decisions allowed');
    this.send({ id: state.request.id, result: { decision } });
    state.resolved = true;
  }
  async completed(state) {
    return until(() => this.turns.find(turn => turn.threadId === state.threadId && turn.turnId === state.turnId), 'turn completion');
  }
  async stop(signal = 'SIGTERM') {
    if (!this.closed) this.proc.kill(signal);
    await until(() => this.closed, 'native process exit', 10000);
  }
}
async function hold(states, duration = HOLD_MS) {
  assert(states.every(state => !existsSync(state.path)), 'Side effect present before response');
  const began = Date.now();
  await delay(duration);
  assert(states.every(state => !existsSync(state.path)), 'Side effect occurred while response withheld');
  return Date.now() - began;
}
function summaryRequest(state) {
  const p = state.request.params;
  return {
    method: state.request.method, requestIdType: typeof state.request.id,
    kind: p.kind, nativeCorrelationFields: ['request.id', 'threadId', 'turnId', 'itemId', ...(p.approvalId ? ['approvalId'] : [])],
    hasStartedAtMs: Number.isFinite(p.startedAtMs), environmentId: p.environmentId,
    command: p.command, cwd: '<scratch>',
    availableDecisionKinds: p.availableDecisions?.map(value => typeof value === 'string' ? value : Object.keys(value)[0]) ?? null,
    hasProposedPolicyAmendment: !!p.proposedExecpolicyAmendment,
  };
}
try {
  const client = await new NativeClient().initialize();
  evidence.model = client.model;
  evidence.configuration = { approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'read-only', experimentalApi: false };
  console.log('Native probe: starting concurrent accept/deny threads.');
  const [accept, deny] = await Promise.all([client.thread('sentinel-accept'), client.thread('sentinel-deny')]);
  await Promise.all([client.approval(accept), client.approval(deny)]);
  assert(accept.request.id !== deny.request.id, 'Concurrent native callbacks share JSON-RPC ID');
  assert(accept.threadId !== deny.threadId && accept.request.params.itemId !== deny.request.params.itemId, 'Concurrent native identities collided');
  const holdMs = await hold([accept, deny]);
  // Unknown correlation ID must not authorize either pending command.
  client.send({ id: 900000, result: { decision: 'accept' } });
  await hold([accept, deny], 300);
  client.decide(accept, 'accept');
  await until(() => existsSync(accept.path), 'accepted sentinel');
  assert(!existsSync(deny.path), 'Accept for A released pending B');
  // Replay response for A while B remains pending; B must stay held.
  client.send({ id: accept.request.id, result: { decision: 'accept' } });
  await hold([deny], 300);
  client.decide(deny, 'decline');
  const [acceptedTurn, deniedTurn] = await Promise.all([client.completed(accept), client.completed(deny)]);
  assert(existsSync(accept.path) && !existsSync(deny.path), 'Accept/deny sentinel outcome mismatch');
  evidence.observations.concurrentAcceptDeny = {
    request: summaryRequest(accept), simultaneousPendingRequests: 2, holdMs,
    before: { accept: false, deny: false }, pending: { accept: false, deny: false },
    afterAcceptBeforeDeny: { accept: true, deny: false }, after: { accept: true, deny: false },
    unknownResponseIdReleasedNeither: true, replayOfAcceptDidNotReleaseOther: true,
    distinctRequestThreadAndItemIds: true, acceptedTurnStatus: acceptedTurn.status, deniedTurnStatus: deniedTurn.status,
    commandItemStatuses: client.items.map(item => ({ branch: item.threadId === accept.threadId ? 'accept' : 'deny', status: item.status })),
  };
  console.log('Native probe: concurrent hold/accept/deny and correlation checks passed.');

  const expiry = { threadId: accept.threadId, sentinel: 'sentinel-expiry', path: join(scratch, 'sentinel-expiry') };
  const followupTurn = await client.call('turn/start', {
    threadId: expiry.threadId, effort: 'low',
    input: [{ type: 'text', text: 'New synthetic approval test in the same session. Execute exactly this command once: touch sentinel-expiry. Request sandbox_permissions=require_escalated because the sandbox is read-only. Do not run alternatives or retry after denial.' }],
  });
  expiry.turnId = followupTurn.turn.id;
  await client.approval(expiry);
  const expiryHoldMs = await hold([expiry]);
  client.decide(expiry, 'cancel');
  const expiryTurn = await client.completed(expiry);
  assert(!existsSync(expiry.path), 'Expired/cancelled request executed');
  evidence.observations.expiry = {
    nativeAutomaticExpiryProven: false, boundedPendingMs: expiryHoldMs,
    sameSessionFreshApprovalAfterAccept: true,
    clientExpiryAction: 'cancel', sentinelAfter: false, turnStatus: expiryTurn.status,
    note: 'Local bounded expiry simulation; no native TTL is asserted.',
  };
  await client.stop();

  console.log('Native probe: testing stdio client disconnect.');
  const disconnected = await new NativeClient().initialize();
  const pendingDisconnect = await disconnected.thread('sentinel-disconnect');
  await disconnected.approval(pendingDisconnect);
  const disconnectHold = await hold([pendingDisconnect]);
  disconnected.proc.stdin.end();
  await until(() => disconnected.closed, 'stdio EOF shutdown', 15000);
  await delay(500);
  assert(!existsSync(pendingDisconnect.path), 'Pending command executed after stdin EOF');
  evidence.observations.stdioDisconnect = { pendingMs: disconnectHold, stdinEof: true, serverExited: true, exit: disconnected.exit, sentinelAfter: false };

  console.log('Native probe: testing process loss and persistent thread restart.');
  const first = await new NativeClient().initialize();
  const pendingRestart = await first.thread('sentinel-restart', true);
  await first.approval(pendingRestart);
  const restartHold = await hold([pendingRestart]);
  await first.stop('SIGKILL');
  await delay(500);
  assert(!existsSync(pendingRestart.path), 'Pending command executed on process kill');
  const second = await new NativeClient().initialize();
  const resumed = await second.call('thread/resume', {
    threadId: pendingRestart.threadId, cwd: scratch, sandbox: 'read-only',
    approvalPolicy: 'on-request', approvalsReviewer: 'user', excludeTurns: false,
  });
  assert(resumed.thread.id === pendingRestart.threadId, 'Resumed a different thread');
  await delay(HOLD_MS);
  assert(!existsSync(pendingRestart.path), 'Restart resumed side effect without fresh decision');
  const reissued = second.requests.filter(req => req.method === 'item/commandExecution/requestApproval');
  // Deliberately do not send a stale decision: IDs are scoped to process/transport generation.
  // A new process may reuse the same numeric ID for a different request.
  evidence.observations.processRestart = {
    pendingMs: restartHold, killedSignal: 'SIGKILL', sentinelAfterKillAndResume: false,
    sameThreadResumed: true, nativeApprovalReissuedCount: reissued.length,
    hydratedTurnStatuses: (resumed.thread.turns ?? []).map(turn => turn.status),
    observationAfterResumeMs: HOLD_MS,
    staleDecisionDispatched: false,
    note: 'Old callbacks are invalid after connector generation loss; never route a stale numeric request ID into a restarted process.',
  };
  await second.stop();
  evidence.nativeMethodNamesObserved = [...new Set(clients.flatMap(client => client.events))].sort();
  evidence.result = 'passed';
  console.log('Native probe: all bounded native observations passed.');
} catch (error) {
  evidence.result = 'failed';
  // Error strings originate exclusively from this harness or numeric RPC codes; no server message text is retained.
  evidence.failure = error.message;
  process.exitCode = 1;
} finally {
  await Promise.allSettled(clients.filter(client => !client.closed).map(client => client.stop()));
  rmSync(scratch, { recursive: true, force: true });
  const json = `${JSON.stringify(evidence, null, 2)}\n`;
  if (output) writeFileSync(output, json, { mode: 0o600 });
  console.log(json);
}
