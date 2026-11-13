#!/usr/bin/env node
// AGCP-002: synthetic, owned app-server sessions. No raw events are written.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const safeMethods = new Set(['thread/started', 'thread/status/changed', 'turn/started', 'turn/completed', 'item/started', 'item/completed', 'item/agentMessage/delta', 'item/commandExecution/outputDelta', 'turn/diff/updated', 'item/fileChange/patchUpdated', 'error', 'serverRequest/resolved']);
const forbidden = ['rawResponse/completed', 'rawResponseItem/completed', 'item/reasoning/textDelta', 'item/reasoning/summaryTextDelta', 'item/reasoning/summaryPartAdded'];

export function terminalObservation(events, threadId, turnId) {
  const terminal = events.findLast(e => e.method === 'turn/completed' && e.params.threadId === threadId && e.params.turn.id === turnId);
  if (!terminal) return null;
  const messages = events.filter(e => e.method === 'item/completed' && e.params.threadId === threadId && e.params.turnId === turnId && e.params.item.type === 'agentMessage').map(e => e.params.item);
  return { threadId, turnId, status: terminal.params.turn.status, messages, advisoryOnly: true };
}

class Client {
  constructor() {
    this.events = []; this.pending = new Map(); this.next = 0; this.buffer = ''; this.requestMethods = [];
    this.proc = spawn(process.env.CODEX_BIN || 'codex', ['app-server', '--listen', 'stdio://', '-c', 'analytics.enabled=false', '-c', 'features.hooks=false', '-c', 'features.apps=false', '-c', 'features.code_mode=false', '-c', 'features.unified_exec=true'], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stderr.on('data', () => {}); // Never persist unredacted diagnostics.
    this.proc.stdout.on('data', chunk => {
      this.buffer += chunk;
      for (let newline; (newline = this.buffer.indexOf('\n')) >= 0;) {
        const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1);
        if (!line.trim()) continue;
        let event; try { event = JSON.parse(line); } catch { this.parseFailed = true; continue; }
        if (event.method && event.id !== undefined) {
          this.requestMethods.push(event.method);
          // This event-coverage spike grants no approvals or permissions.
          this.send({ id: event.id, error: { code: -32000, message: 'Event coverage spike does not authorize server requests' } });
        } else if (event.id !== undefined) {
          const pending = this.pending.get(event.id); if (!pending) continue;
          this.pending.delete(event.id); clearTimeout(pending.timer);
          if (event.error) pending.reject(Object.assign(new Error('App-server request failed'), { rpcError: event.error })); else pending.resolve(event.result);
        } else if (safeMethods.has(event.method)) {
          if (event.params?.item?.type === 'reasoning') continue;
          this.events.push(event);
        }
      }
    });
    this.proc.on('error', () => { this.spawnFailed = true; });
  }
  send(message) { this.proc.stdin.write(JSON.stringify(message) + '\n'); }
  request(method, params = {}, timeout = 30000) {
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Timed out: ${method}`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer }); this.send({ id, method, params });
    });
  }
  async initialize() {
    await this.request('initialize', { clientInfo: { name: 'agentdash_event_spike', version: '0.1.0' }, capabilities: { experimentalApi: false, requestAttestation: false, optOutNotificationMethods: forbidden } });
    this.send({ method: 'initialized' });
  }
  async wait(predicate, timeout = 180000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { const found = this.events.find(predicate); if (found) return found; await new Promise(resolve => setTimeout(resolve, 50)); }
    throw new Error(`Timed out waiting for synthetic event; aggregate=${JSON.stringify(stats(this.events))}`);
  }
  async turn(threadId, text, interrupt = false) {
    const result = await this.request('turn/start', { threadId, input: [{ type: 'text', text, text_elements: [] }] });
    if (interrupt) {
      const first = await this.wait(e => (e.params?.turnId === result.turn.id && e.method === 'item/started' && e.params.item.type === 'commandExecution') || (e.method === 'turn/completed' && e.params.turn.id === result.turn.id));
      if (first.method === 'turn/completed') return first.params.turn;
      await this.request('turn/interrupt', { threadId, turnId: result.turn.id });
    }
    const event = await this.wait(e => e.method === 'turn/completed' && e.params.turn.id === result.turn.id);
    return event.params.turn;
  }
  close() { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Client closed')); } this.pending.clear(); this.proc.kill('SIGTERM'); }
}

function stats(events) {
  const methods = {}, itemTypes = {}, terminalStatuses = {};
  for (const event of events) {
    methods[event.method] = (methods[event.method] || 0) + 1;
    if (event.method === 'item/completed') itemTypes[event.params.item.type] = (itemTypes[event.params.item.type] || 0) + 1;
    if (event.method === 'turn/completed') terminalStatuses[event.params.turn.status] = (terminalStatuses[event.params.turn.status] || 0) + 1;
  }
  return { methods, itemTypes, terminalStatuses };
}

async function page(client, method, threadId, extra = {}) {
  const data = []; let cursor;
  do { const result = await client.request(method, { threadId, limit: 100, ...extra, ...(cursor ? { cursor } : {}) }); data.push(...result.data); cursor = result.nextCursor; } while (cursor);
  return data;
}

async function live() {
  const stage = message => console.error(`Synthetic event spike: ${message}`);
  const scratch = await mkdtemp(path.join(tmpdir(), 'agentdash-events-'));
  execFileSync('git', ['init', '--quiet', scratch]);
  await writeFile(path.join(scratch, 'sample.txt'), 'alpha\n');
  const client = new Client(); let resumed;
  const output = { kind: 'sanitized-live-aggregate', version: execFileSync(process.env.CODEX_BIN || 'codex', ['--version'], { encoding: 'utf8' }).trim(), transport: 'stdio', experimentalApi: false, scratchRemoved: false };
  try {
    await client.initialize();
    stage('initialized');
    const models = await client.request('model/list', {}); output.modelCatalogAvailable = models.data.length > 0;
    const selectedModel = models.data.find(model => model.isDefault);
    assert.ok(selectedModel, 'No default model in supported catalog');
    const started = await client.request('thread/start', { model: selectedModel.model, cwd: scratch, approvalPolicy: 'never', sandbox: 'workspace-write', baseInstructions: 'This is a synthetic protocol experiment. Work only in this temporary directory. Do not use any network, MCP, app, or external services. Follow the user request literally; do not inspect user files or skills. Use shell and apply_patch only if requested.' });
    const threadId = started.thread.id;
    stage('owned thread started');
    output.sessionIdPresent = typeof started.thread.sessionId === 'string';
    output.model = started.model;
    output.historyMode = started.thread.historyMode;
    const question = await client.turn(threadId, 'Do not use tools. End this turn with exactly this question: Which synthetic color should I use, blue or green?');
    const observation = terminalObservation(client.events, threadId, question.id);
    stage(`question turn ${question.status}`);
    output.question = { status: question.status, observedWithoutMcp: observation?.messages.some(m => m.text.includes('Which synthetic color should I use, blue or green?')) || false };
    const work = await client.turn(threadId, 'Synthetic coverage experiment: use the shell tool to run printf SYNTHETIC_OUTPUT followed by a newline, then separately run sh -c "exit 7" once; failure is intentional and must not be retried. Use apply_patch to change sample.txt from alpha to beta. Finish with the message SYNTHETIC_DONE.');
    output.workStatus = work.status;
    stage(`tool and edit turn ${work.status}`);
    const interrupted = await client.turn(threadId, 'Run sleep 30 with the shell tool. This is an interruption test; do not write any files and do not retry if interrupted.', true);
    output.interruptStatus = interrupted.status;
    stage(`interrupt turn ${interrupted.status}`);
    const liveCompleted = client.events.filter(e => e.method === 'item/completed').map(e => ({ turnId: e.params.turnId, item: e.params.item }));
    const turns = await page(client, 'thread/turns/list', threadId, { itemsView: 'full', sortDirection: 'asc' });
    let items = []; try { items = await page(client, 'thread/items/list', threadId, { sortDirection: 'asc' }); output.itemPaginationAvailable = true; } catch (error) { output.itemPaginationAvailable = false; output.itemPaginationErrorCode = error.rpcError?.code || null; }
    const historyItems = items.length ? items.map(entry => entry.item || entry) : turns.flatMap(t => t.items);
    const nonReasoningLive = liveCompleted.filter(e => e.item.type !== 'reasoning');
    output.history = { turns: turns.length, statuses: turns.map(t => t.status), items: historyItems.length, liveCompletedItems: nonReasoningLive.length, missingCompletedIds: nonReasoningLive.filter(e => !historyItems.some(i => i.id === e.item.id)).length, commandExitCodes: historyItems.filter(i => i.type === 'commandExecution').map(i => i.exitCode), fileChangeItems: historyItems.filter(i => i.type === 'fileChange').length };
    output.live = stats(client.events);
    const finalMessages = nonReasoningLive.filter(e => e.item.type === 'agentMessage');
    output.agentDeltasMatchFinal = finalMessages.every(({ item }) => client.events.filter(e => e.method === 'item/agentMessage/delta' && e.params.itemId === item.id).map(e => e.params.delta).join('') === item.text);
    output.toolLifecycleOrdered = nonReasoningLive.filter(e => ['commandExecution', 'fileChange'].includes(e.item.type)).every(({ item, turnId }) => {
      const startIndex = client.events.findIndex(e => e.method === 'item/started' && e.params.item.id === item.id && e.params.turnId === turnId);
      const endIndex = client.events.findIndex(e => e.method === 'item/completed' && e.params.item.id === item.id && e.params.turnId === turnId);
      return startIndex >= 0 && endIndex > startIndex;
    });
    const duplicateCompleted = nonReasoningLive.length - new Set(nonReasoningLive.map(e => `${e.turnId}:${e.item.id}`)).size;
    output.duplicateCompletedItems = duplicateCompleted;
    output.eventTimestampsPresent = client.events.every(e => typeof e.emittedAtMs === 'number');
    output.serverRequestMethods = client.requestMethods;
    client.close();
    resumed = new Client(); await resumed.initialize();
    const resume = await resumed.request('thread/resume', { threadId, excludeTurns: true });
    const resumedTurns = await page(resumed, 'thread/turns/list', threadId, { itemsView: 'full', sortDirection: 'asc' });
    output.restart = { sameThreadId: resume.thread.id === threadId, sameTurnIds: turns.length === resumedTurns.length && turns.every((t, i) => t.id === resumedTurns[i].id), sameItemIds: turns.every((t, i) => t.items.every(item => resumedTurns[i].items.some(candidate => candidate.id === item.id))), historyTurnStatuses: resumedTurns.map(t => t.status) };
    const invalid = await resumed.request('turn/interrupt', { threadId, turnId: 'synthetic-missing-turn' }).then(() => ({ rejected: false }), error => ({ rejected: true, code: error.rpcError?.code || null }));
    output.invalidInterrupt = invalid;
  } finally { client.close(); resumed?.close(); await rm(scratch, { recursive: true, force: true }); output.scratchRemoved = true; }
  console.log(JSON.stringify(output, null, 2));
}

function selfTest() {
  const events = [
    { method: 'item/completed', params: { threadId: 'thread-synthetic', turnId: 'turn-synthetic', item: { id: 'item-synthetic', type: 'agentMessage', text: 'Which color?' } } },
    { method: 'turn/completed', params: { threadId: 'thread-synthetic', turn: { id: 'turn-synthetic', status: 'completed' } } },
  ];
  assert.equal(terminalObservation(events, 'thread-synthetic', 'turn-synthetic').messages[0].text, 'Which color?');
  assert.equal(terminalObservation(events, 'other-thread', 'turn-synthetic'), null);
  assert.equal(terminalObservation(events, 'thread-synthetic', 'other-turn'), null);
  assert.equal(terminalObservation(events.slice(0, 1), 'thread-synthetic', 'turn-synthetic'), null);
  assert.equal(terminalObservation(events, 'thread-synthetic', 'turn-synthetic').advisoryOnly, true);
  console.log('Synthetic terminal-observation checks passed. No model used.');
}

if (process.argv.includes('--live')) live().catch(error => { console.error(JSON.stringify({ failed: true, message: error.message, rpcCode: error.rpcError?.code || null })); process.exitCode = 1; });
else selfTest();
