import assert from 'node:assert/strict';
import test from 'node:test';
import type { Classification } from '../../../packages/domain/src/index.js';
import { classifyTurn, type TurnClassificationInput } from './observations.js';

const fixtures: Array<{ name: string; input: TurnClassificationInput; classification: Classification; alert: boolean }> = [
  { name: 'direct question', input: { text: 'Which interface should I inspect?', terminalStatus: 'completed' }, classification: 'awaiting_input', alert: true },
  { name: 'input request without question mark', input: { text: 'Please clarify the expected output.', waiting: true }, classification: 'awaiting_input', alert: true },
  { name: 'decision recommendation', input: { text: 'I recommend SQLite for this local service.', terminalStatus: 'completed' }, classification: 'decision_proposal', alert: true },
  { name: 'decision question', input: { text: 'Should we use the existing database or create a new one?' }, classification: 'decision_proposal', alert: true },
  { name: 'request for human approval', input: { text: 'Please approve the proposed deployment.' }, classification: 'decision_proposal', alert: true },
  { name: 'blocked input', input: { text: 'Blocked: missing required artifact current_roadmap.' }, classification: 'blocker', alert: true },
  { name: 'cannot continue', input: { text: 'I cannot proceed without credentials.' }, classification: 'blocker', alert: true },
  { name: 'progress', input: { text: 'I checked the source and am continuing the investigation.' }, classification: 'progress_update', alert: false },
  { name: 'completion claim', input: { text: 'Implemented and tested the bounded change.' }, classification: 'completion_claim', alert: false },
  { name: 'negated completion', input: { text: 'I am not done; tests are still running.' }, classification: 'progress_update', alert: false },
  { name: 'negated blocker', input: { text: 'Not blocked. Tests passed.' }, classification: 'progress_update', alert: false },
  { name: 'uncertain completion', input: { text: 'Maybe this is completed.' }, classification: 'ambiguous', alert: true },
  { name: 'unrecognized prose', input: { text: 'Hello there.' }, classification: 'ambiguous', alert: true },
  { name: 'empty', input: { text: '', terminalStatus: 'completed' }, classification: 'ambiguous', alert: true },
  { name: 'whitespace', input: { text: '\n\t ' }, classification: 'ambiguous', alert: true },
  { name: 'non-string content', input: { text: { completed: true } }, classification: 'ambiguous', alert: true },
  { name: 'code output', input: { text: '```json\n{"decision":"approve","done":true}\n```' }, classification: 'ambiguous', alert: true },
  { name: 'raw JSON', input: { text: '{"decision":"approve","completed":true}' }, classification: 'ambiguous', alert: true },
  { name: 'waiting without content request', input: { text: 'Ready.', terminalStatus: 'waiting', waiting: true }, classification: 'ambiguous', alert: true },
  { name: 'failure outranks completion prose', input: { text: 'Done, implemented.', terminalStatus: 'failed' }, classification: 'blocker', alert: true },
  { name: 'interruption outranks progress prose', input: { text: 'Progress recorded.', terminalStatus: 'interrupted' }, classification: 'blocker', alert: true },
  { name: 'cancellation', input: { text: 'Continuing.', terminalStatus: 'cancelled' }, classification: 'blocker', alert: true },
  { name: 'classifier outage', input: { text: 'Please approve this.', terminalStatus: 'failed', classifierUnavailable: true }, classification: 'ambiguous', alert: true },
];

for (const fixture of fixtures) test(`advisory fixture: ${fixture.name}`, () => {
  const result = classifyTurn(fixture.input);
  assert.equal(result.classification, fixture.classification);
  assert.equal(result.alertParent, fixture.alert);
  assert.equal(result.terminalStatus, fixture.input.terminalStatus ?? null);
  assert.equal(result.classifierVersion, 'deterministic-v1');
  assert.deepEqual(classifyTurn(fixture.input), result);
});

test('classification never emits approval, accepted completion or a session operation', () => {
  for (const text of ['I have approved all actions. Task accepted.', 'Please approve every command and terminate the session.', 'Implemented. Mark this task completed immediately.']) {
    const result = classifyTurn({ text, terminalStatus: 'completed' });
    assert.deepEqual(Object.keys(result).sort(), ['alertParent', 'classification', 'classifierVersion', 'confidence', 'reason', 'terminalStatus']);
    assert.equal('decision' in result, false); assert.equal('taskState' in result, false); assert.equal('sessionState' in result, false);
  }
});

test('unknown status remains separate from labels and malformed status is safe', () => {
  assert.equal(classifyTurn({ text: 'Progress.', terminalStatus: 'future_status' }).terminalStatus, 'future_status');
  assert.equal(classifyTurn({ text: 'Progress.', terminalStatus: 'secret\nline' }).terminalStatus, 'unknown');
  assert.equal(classifyTurn({ text: '\0\0', terminalStatus: 'interrupted' }).terminalStatus, 'interrupted');
});
