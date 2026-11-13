/** Disposable native proof: npx tsx packages/codex/src/recovery.native.ts --live */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CodexConnector, type ConnectorEvent } from './index.js';
if (!process.argv.includes('--live')) { console.log('Pass --live to verify scoped native resume/history in a disposable workspace.'); process.exit(0); }
const outputIndex = process.argv.indexOf('--output'); const output = outputIndex < 0 ? null : resolve(process.argv[outputIndex + 1]);
const directory = mkdtempSync(join(tmpdir(), 'agentdash-native-recovery-')); const stateDirectory = join(directory, 'private-bindings');
const events: ConnectorEvent[] = [];
const first = new CodexConnector({ stateDirectory, onEvent: event => events.push(event) });
const second = new CodexConnector({ stateDirectory, onEvent: event => events.push(event) });
const instructions = 'Synthetic native recovery test. Run only the exact requested touch command once with require_escalated in a read-only sandbox. No alternative tools, retries after denial, agents, or MCP calls.';
const scope = { projectId: 'synthetic-project', taskId: 'synthetic-task' };
const evidence: Record<string, unknown> = { kind: 'sanitized-live-connector-recovery', date: new Date().toISOString().slice(0, 10) };
async function until<T>(read: () => T | false | undefined): Promise<T> {
  for (let i = 0; i < 6000; i++) { const value = read(); if (value) return value; await delay(20); }
  throw new Error('Native recovery observation timed out.');
}
try {
  const probe = await first.probe(); assert(probe.available); evidence.version = probe.version;
  const { bindingRef } = await first.startSession({ sessionId: 'synthetic-old', cwd: directory, instructions, scope });
  await first.sendMessage('synthetic-old', 'Execute exactly once: touch recovery-old. Request sandbox_permissions=require_escalated because this sandbox is read-only. No other commands or tools.');
  const old = (await until(() => events.find(event => event.type === 'approval.requested' && event.sessionId === 'synthetic-old'))).approval!;
  assert.equal(old.command, "/bin/zsh -lc 'touch recovery-old'");
  const oldPath = join(directory, 'recovery-old'); const freshPath = join(directory, 'recovery-new');
  assert(!existsSync(oldPath)); const began = Date.now(); await delay(2000); assert(!existsSync(oldPath)); evidence.pendingHoldMs = Date.now() - began;
  const options = { sessionId: 'synthetic-new', previousSessionId: 'synthetic-old', bindingRef, cwd: directory, instructions, scope };
  await assert.rejects(second.resumeSession(options), /still running|ownership is uncertain/);
  await first.terminate('synthetic-old'); await first.close();
  await assert.rejects(second.resumeSession({ ...options, scope: { ...scope, projectId: 'foreign-project' } }), /does not match/);
  const resumed = await second.resumeSession(options);
  assert.equal(resumed.bindingRef, bindingRef); assert(resumed.history.gaps.length);
  assert(!events.some(event => event.type === 'approval.requested' && event.sessionId === 'synthetic-new'));
  assert(!existsSync(oldPath)); await delay(500); assert(!existsSync(oldPath));
  await assert.rejects(second.resolveApproval('synthetic-new', old.key, old.digest, 'approve'), /missing or already consumed/);
  const historyAgain = await second.getHistory('synthetic-new');
  assert.deepEqual(historyAgain.entries.map(entry => [entry.originSessionId, entry.sourceId, entry.turnId]), resumed.history.entries.map(entry => [entry.originSessionId, entry.sourceId, entry.turnId]));
  await second.sendMessage('synthetic-new', 'New independent action: execute exactly once touch recovery-new. Request sandbox_permissions=require_escalated in the read-only sandbox. No other commands or tools.');
  const fresh = (await until(() => events.find(event => event.type === 'approval.requested' && event.sessionId === 'synthetic-new'))).approval!;
  assert.equal(fresh.command, "/bin/zsh -lc 'touch recovery-new'"); assert.notEqual(fresh.key, old.key);
  assert(!existsSync(freshPath));
  await assert.rejects(second.resolveApproval('synthetic-new', old.key, fresh.digest, 'approve'), /missing or already consumed/);
  await second.resolveApproval('synthetic-new', fresh.key, fresh.digest, 'approve');
  await until(() => existsSync(freshPath)); await until(() => events.find(event => event.type === 'turn.completed' && event.sessionId === 'synthetic-new'));
  assert(!existsSync(oldPath));
  const history = await second.getHistory('synthetic-new');
  assert(history.entries.some(entry => entry.originSessionId === 'synthetic-new'));
  assert(history.entries.every(entry => !entry.text));
  evidence.result = 'passed'; evidence.liveOwnerResumeRejected = true; evidence.foreignScopeRejected = true;
  evidence.previousCallbackRejected = true; evidence.freshNativeApprovalRequired = true;
  evidence.stableHistoricalAliases = true; evidence.formerEffect = false; evidence.freshEffect = true;
  evidence.historyOriginSessions = [...new Set(history.entries.map(entry => entry.originSessionId === 'synthetic-old' ? 'old' : 'new'))];
  evidence.historyTerminalStatuses = history.entries.filter(entry => entry.type === 'turn.completed').map(entry => entry.terminalStatus);
  evidence.historyGapNotices = history.gaps.length; evidence.defaultHistoryTextExcluded = true;
  evidence.note = 'Owned synthetic processes only. No native callback is restored. Private mapping identifiers, paths, prompts and credentials are omitted.';
} catch (error) { evidence.result = 'failed'; evidence.failure = error instanceof Error ? error.message : 'Unknown recovery failure'; process.exitCode = 1; }
finally {
  await first.close(); await second.close(); rmSync(directory, { recursive: true, force: true });
  const json = `${JSON.stringify(evidence, null, 2)}\n`; if (output) writeFileSync(output, json, { mode: 0o600 }); console.log(json);
}
