#!/usr/bin/env node
// SYNTHETIC protocol double for adapter tests. It never invokes a model or shell action.
import readline from 'node:readline';
import { basename } from 'node:path';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
if (process.env.AWS_SECRET_ACCESS_KEY || process.env.AGCP_UNRELATED_HOST_SECRET || process.env.NODE_OPTIONS) process.exit(44);
if (process.argv.includes('--version')) {
  console.log(`codex-cli ${process.argv[1].includes('unsupported') ? '0.0.0' : '0.163.0-alpha.11.1'}`);
  process.exit(0);
}
const scenario = basename(process.argv[1]).replace(/^codex-/, '');
let pending = false;
const historyFile = process.env.AGCP_FIXTURE_HISTORY_FILE;
let history = historyFile && existsSync(historyFile) ? JSON.parse(readFileSync(historyFile, 'utf8')) : [];
let turn = history.length;
const saveHistory = () => { if (historyFile) writeFileSync(historyFile, JSON.stringify(history)); };
let configured = false;
let explicit = [];
const threadId = 'synthetic-native-thread';
const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
const event = (method, params) => send({ method, params });
const result = (id, value) => send({ id, result: value });
const params = () => ({ threadId, turnId: `synthetic-turn-${turn}`, itemId: 'synthetic-item', kind: 'command',
  environmentId: 'local', command: 'touch synthetic-sentinel', cwd: process.cwd(),
  availableDecisions: scenario === 'decline-option' ? ['accept', 'decline', 'cancel'] : ['accept', 'cancel'],
});
const finish = nativeResponse => {
  pending = false;
  const current = history.find(value => value.id === `synthetic-turn-${turn}`);
  if (current) { current.status = 'completed'; current.items = [{ id: 'synthetic-command-item', type: 'commandExecution', status: nativeResponse.decision === 'accept' ? 'completed' : 'declined', aggregatedOutput: 'synthetic-result' }, { id: 'synthetic-message', type: 'agentMessage', text: JSON.stringify(nativeResponse) }, { id: 'synthetic-reasoning', type: 'reasoning', text: 'RAW_REASONING_MARKER' }]; saveHistory(); }
  event('serverRequest/resolved', { threadId, requestId: 0 });
  const completed = { threadId, turnId: `synthetic-turn-${turn}`, item: { id: 'synthetic-command-item', type: 'commandExecution', status: nativeResponse.decision === 'accept' ? 'completed' : 'declined', aggregatedOutput: 'synthetic-result' } };
  event('item/completed', completed);
  event('item/completed', completed); // Delivery replay must preserve the same source event identity.
  event('item/completed', { threadId, turnId: `synthetic-turn-${turn}`, item: { id: 'synthetic-message', type: 'agentMessage', text: JSON.stringify(nativeResponse) } });
  event('turn/completed', { threadId, turn: { id: `synthetic-turn-${turn}`, status: 'completed' } });
};
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (!message.method) {
    if (message.id === 0 && pending) finish(message.result ?? message.error);
    return;
  }
  const p = message.params ?? {};
  if (message.method === 'initialize') result(message.id, {});
  if (message.method === 'config/read') result(message.id, { config: {
    mcp_servers: { inherited: { url: 'http://example.invalid/mcp', bearer_token: 'synthetic-config-secret' } },
    plugins: { 'synthetic-plugin@example': { enabled: true } },
  } });
  if (message.method === 'model/list') result(message.id, { data: [{ model: 'synthetic-model', isDefault: true }] });
  if (message.method === 'thread/start' || message.method === 'thread/resume') {
    const flags = process.argv;
    configured = p.config?.mcp_servers?.inherited?.enabled === false &&
      p.config?.plugins?.['synthetic-plugin@example']?.enabled === false &&
      flags.includes('features.multi_agent=false') && flags.includes('features.multi_agent_v2=false') &&
      flags.includes('features.hooks=false') && flags.includes('features.apps=false') &&
      p.model === 'synthetic-model' && p.approvalPolicy === 'on-request' && p.approvalsReviewer === 'user';
    if (scenario === 'env-boundary') configured = configured && process.env.AGCP_SESSION_CAP === 'synthetic-private-capability-token' && !!process.env.HOME && !!process.env.PATH;
    if (!configured) { send({ id: message.id, error: { code: -32602, message: 'Synthetic unsafe config' } }); return; }
    explicit = Object.keys(p.config.mcp_servers).filter(key => key !== 'inherited');
    if (message.method === 'thread/resume') { for (const old of history) if (old.status === 'inProgress') old.status = 'interrupted'; saveHistory(); }
    result(message.id, { thread: { id: threadId }, approvalPolicy: p.approvalPolicy, approvalsReviewer: p.approvalsReviewer, sandbox: { type: 'readOnly' } });
  }
  if (message.method === 'mcpServerStatus/list') result(message.id, { data: [
    { name: 'inherited', runtimeStatus: scenario === 'unexpected-mcp' ? 'connected' : 'disabled' },
    ...explicit.map(name => ({ name, runtimeStatus: 'connected' })),
  ], nextCursor: null });
  if (message.method === 'thread/turns/list') {
    const data = scenario === 'history-paginated' ? (p.cursor ? history.slice(1) : history.slice(0, 1)) : history;
    result(message.id, { data, nextCursor: scenario === 'history-paginated' && !p.cursor && history.length > 1 ? 'page-two' : null });
  }
  if (message.method === 'turn/start') {
    turn++;
    history.push({ id: `synthetic-turn-${turn}`, status: 'inProgress', itemsView: 'full', items: [] }); saveHistory();
    result(message.id, { turn: { id: `synthetic-turn-${turn}`, status: 'inProgress' } });
    event('turn/started', { threadId, turn: { id: `synthetic-turn-${turn}` } });
    event('item/reasoning/summaryTextDelta', { threadId, delta: 'RAW_REASONING_MARKER' });
    event('item/completed', { threadId, item: { id: 'secret-reasoning', type: 'reasoning', text: 'RAW_REASONING_MARKER' } });
    event('item/completed', { threadId, item: { id: 'visible-message', type: 'agentMessage', text: `Visible ${process.env.AGCP_SESSION_CAP ?? ''} Bearer synthetic-bearer-token sk-syntheticVeryLongApiKey123456 ${'x'.repeat(9000)}` } });
    if (scenario === 'malformed') { process.stdout.write('not-json\n'); return; }
    event('item/started', { threadId, turnId: `synthetic-turn-${turn}`, item: { id: 'synthetic-command-item', type: 'commandExecution', command: 'touch synthetic-sentinel' } });
    const approvalParams = params();
    let method = 'item/commandExecution/requestApproval';
    if (scenario === 'network') approvalParams.networkApprovalContext = { host: 'example.invalid', protocol: 'https' };
    if (scenario === 'permissions') method = 'item/permissions/requestApproval';
    if (scenario === 'file') method = 'item/fileChange/requestApproval';
    if (scenario === 'mcp') method = 'mcpServer/elicitation/request';
    if (scenario === 'input') method = 'item/tool/requestUserInput';
    if (scenario === 'unknown') method = 'synthetic/unsupported';
    if (scenario === 'missing-command') delete approvalParams.command;
    if (scenario === 'relative-cwd') approvalParams.cwd = 'relative';
    if (scenario === 'wrong-turn') approvalParams.turnId = 'some-other-turn';
    if (scenario === 'wrong-thread') approvalParams.threadId = 'some-other-thread';
    if (scenario === 'stdin') approvalParams.kind = 'writeStdin';
    pending = true;
    send({ id: 0, method, params: approvalParams });
    if (scenario === 'disconnect') setTimeout(() => process.exit(0), 60);
    if (scenario === 'native-cleared') setTimeout(() => { pending = false; event('serverRequest/resolved', { threadId, requestId: 0 }); }, 60);
    if (scenario === 'turn-ended') setTimeout(() => { pending = false; event('turn/completed', { threadId, turn: { id: `synthetic-turn-${turn}`, status: 'interrupted' } }); }, 60);
  }
  if (message.method === 'turn/interrupt') {
    result(message.id, {});
    if (pending) finish({ interrupted: true });
  }
});
