/** Native adapter smoke: npx tsx scripts/spikes/native-approval-connector.ts --live */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CodexConnector, type ConnectorEvent } from '../../packages/codex/src/index.js';
if (!process.argv.includes('--live')) { console.log('Pass --live to exercise the real adapter with signed-in model-backed Codex.'); process.exit(0); }
const outputIndex = process.argv.indexOf('--output');
const output = outputIndex < 0 ? null : resolve(process.argv[outputIndex + 1]);
const scratch = mkdtempSync(join(tmpdir(), 'agentdash-native-connector-'));
const events: ConnectorEvent[] = [];
const connector = new CodexConnector({ onEvent: event => events.push(event) });
const evidence: Record<string, unknown> = { kind: 'sanitized-live-adapter-observations', date: new Date().toISOString().slice(0, 10) };
async function until<T>(read: () => T | false | undefined): Promise<T> {
  for (let i = 0; i < 6000; i++) { const value = read(); if (value) return value; await delay(20); }
  throw new Error('Native adapter smoke timed out.');
}
try {
  evidence.probe = await connector.probe();
  assert((evidence.probe as { available: boolean }).available);
  for (const sessionId of ['accept', 'deny']) await connector.startSession({
    sessionId, cwd: scratch,
    instructions: 'Isolated synthetic native approval test. Run exactly the requested shell command once with require_escalated permissions in the read-only sandbox. Do not use apply_patch, request_permissions, alternatives, or retry after denial.',
  });
  await Promise.all(['accept', 'deny'].map(sessionId => connector.sendMessage(sessionId, `Execute exactly this shell command once: touch connector-${sessionId}. Request sandbox_permissions=require_escalated for the read-only sandbox. Do not run any other command or use any alternative tool. Stop if denied.`)));
  const [aEvent, dEvent] = await Promise.all(['accept', 'deny'].map(sessionId => until(() => events.find(event => event.type === 'approval.requested' && event.sessionId === sessionId))));
  const a = aEvent.approval!; const d = dEvent.approval!;
  assert.equal(a.command, "/bin/zsh -lc 'touch connector-accept'");
  assert.equal(d.command, "/bin/zsh -lc 'touch connector-deny'");
  const aPath = join(scratch, 'connector-accept'); const dPath = join(scratch, 'connector-deny');
  assert(!existsSync(aPath) && !existsSync(dPath));
  const began = Date.now(); await delay(2000);
  assert(!existsSync(aPath) && !existsSync(dPath));
  await assert.rejects(connector.resolveApproval('accept', d.key, d.digest, 'approve'));
  await assert.rejects(connector.resolveApproval('accept', a.key, 'sha256:wrong', 'approve'));
  assert(!existsSync(aPath) && !existsSync(dPath));
  const holdMs = Date.now() - began;
  await connector.resolveApproval('accept', a.key, a.digest, 'approve');
  await until(() => existsSync(aPath)); assert(!existsSync(dPath));
  await assert.rejects(connector.resolveApproval('accept', a.key, a.digest, 'approve'));
  await connector.resolveApproval('deny', d.key, d.digest, 'deny');
  await Promise.all(['accept', 'deny'].map(sessionId => until(() => events.find(event => event.type === 'turn.completed' && event.sessionId === sessionId))));
  assert(existsSync(aPath) && !existsSync(dPath));
  evidence.result = 'passed';
  evidence.holdMs = holdMs;
  evidence.pendingEffects = { accept: false, deny: false };
  evidence.finalEffects = { accept: true, deny: false };
  evidence.crossSessionRejected = true; evidence.digestMismatchRejected = true; evidence.replayRejected = true;
  evidence.nativeTurnStatuses = events.filter(event => event.type === 'turn.completed').map(event => ({ branch: event.sessionId, status: event.terminalStatus }));
  evidence.nativeEventTypes = [...new Set(events.map(event => event.type))];
  evidence.scope = 'Real CodexConnector with isolated owned processes, explicit default model selection, inherited MCP/plugins disabled, hooks/apps/native child spawning disabled. No raw session or native identifiers retained.';
} catch (error) {
  evidence.result = 'failed'; evidence.failure = error instanceof Error ? error.message : 'Unknown smoke failure.'; process.exitCode = 1;
} finally {
  await connector.close(); rmSync(scratch, { recursive: true, force: true });
  const json = `${JSON.stringify(evidence, null, 2)}\n`;
  if (output) writeFileSync(output, json, { mode: 0o600 });
  console.log(json);
}
