import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import test from 'node:test';
import { AppError, Capabilities, OperatorSessions, equalSecret, redact } from './security.js';

const origin = 'http://127.0.0.1:4317';
function request(headers: Record<string, string | string[] | undefined> = {}): IncomingMessage { return { headers } as IncomingMessage; }
function established(sessions: OperatorSessions) {
  const headers = new Map<string, string>();
  const response = { setHeader(name: string, value: string) { headers.set(name, value); } } as unknown as ServerResponse;
  sessions.establish(response);
  const cookieHeader = headers.get('Set-Cookie')!;
  const cookie = cookieHeader.split(';')[0];
  const csrf = sessions.authenticate(request({ cookie }), origin, false).csrfToken;
  return { cookieHeader, cookie, csrf };
}
function appError(code: string) { return (error: unknown) => error instanceof AppError && error.code === code; }

test('operator session is opaque, HttpOnly, SameSite strict and independently CSRF-bound', () => {
  const sessions = new OperatorSessions();
  const first = established(sessions); const second = established(sessions);
  assert.match(first.cookieHeader, /agcp_operator=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\/api/);
  assert.notEqual(first.cookie, second.cookie); assert.notEqual(first.csrf, second.csrf);
  sessions.authenticate(request({ cookie: first.cookie, origin, 'content-type': 'application/json; charset=utf-8', 'x-agcp-csrf': first.csrf }), origin, true);
  assert.throws(() => sessions.authenticate(request({ cookie: first.cookie, origin, 'content-type': 'application/json', 'x-agcp-csrf': second.csrf }), origin, true), appError('csrf_rejected'));
});

test('missing, forged and capability-bearer credentials cannot authenticate the operator', () => {
  const sessions = new OperatorSessions(); const capability = new Capabilities('boot').issue({ projectId: 'p', taskId: 't', sessionId: 's' });
  for (const headers of [{}, { cookie: 'agcp_operator=forged' }, { authorization: `Bearer ${capability}` }, { cookie: `agcp_operator=${capability}` }]) assert.throws(() => sessions.authenticate(request(headers), origin, false), appError('unauthenticated'));
});

test('mutations reject missing/null/foreign/other-port origins before accepting CSRF', () => {
  const sessions = new OperatorSessions(); const operator = established(sessions);
  for (const supplied of [undefined, 'null', 'https://attacker.example', 'http://127.0.0.1:9999', 'http://localhost:4317', [origin, 'https://attacker.example']]) {
    assert.throws(() => sessions.authenticate(request({ cookie: operator.cookie, origin: supplied, 'content-type': 'application/json', 'x-agcp-csrf': operator.csrf }), origin, true), appError('origin_rejected'));
  }
  assert.throws(() => sessions.authenticate(request({ cookie: operator.cookie, origin: 'https://attacker.example' }), origin, false), appError('origin_rejected'));
});

test('mutation JSON and CSRF are mandatory and a failed mutation cannot bypass them', () => {
  const sessions = new OperatorSessions(); const operator = established(sessions);
  const valid = { cookie: operator.cookie, origin, 'content-type': 'application/json', 'x-agcp-csrf': operator.csrf };
  for (const contentType of [undefined, 'text/plain', 'application/x-www-form-urlencoded']) assert.throws(() => sessions.authenticate(request({ ...valid, 'content-type': contentType }), origin, true), appError('json_required'));
  for (const csrf of [undefined, '', 'forged', ['forged', operator.csrf]]) assert.throws(() => sessions.authenticate(request({ ...valid, 'x-agcp-csrf': csrf }), origin, true), appError('csrf_rejected'));
  assert.equal(equalSecret('a', 'longer'), false);
});

test('operator idle expiry uses a boundary check and successful access extends only its session', () => {
  let now = 1_000; const sessions = new OperatorSessions(() => now);
  const first = established(sessions); const second = established(sessions);
  now += 20 * 60_000;
  sessions.authenticate(request({ cookie: first.cookie }), origin, false);
  now += 10 * 60_000;
  assert.throws(() => sessions.authenticate(request({ cookie: second.cookie }), origin, false), appError('unauthenticated'));
  sessions.authenticate(request({ cookie: first.cookie }), origin, false);
  now += 30 * 60_000;
  assert.throws(() => sessions.authenticate(request({ cookie: first.cookie }), origin, false), appError('unauthenticated'));
});

test('capability scope comes from issuing registry and cannot substitute another token or boot', () => {
  const capabilities = new Capabilities('boot-one');
  const first = capabilities.issue({ projectId: 'project-one', taskId: 'task-one', sessionId: 'session-one' });
  const second = capabilities.issue({ projectId: 'project-two', taskId: 'task-two', sessionId: 'session-two' });
  assert.notEqual(first, second);
  const principal = capabilities.authenticate(`Bearer ${first}`);
  assert.equal(principal.projectId, 'project-one'); assert.equal(principal.taskId, 'task-one'); assert.equal(principal.bootId, 'boot-one');
  const restarted = new Capabilities('boot-two');
  assert.throws(() => restarted.authenticate(`Bearer ${first}`), appError('invalid_capability'));
  for (const invalid of [undefined, first, `Basic ${first}`, `Bearer ${first}x`, `Bearer ${first.toUpperCase()}`, 'Bearer forged']) assert.throws(() => capabilities.authenticate(invalid), appError('invalid_capability'));
});

test('capability expiry is fixed and revocation covers all tokens of only the original session', () => {
  let now = 1_000; const capabilities = new Capabilities('boot', () => now);
  const first = capabilities.issue({ projectId: 'p', taskId: 't', sessionId: 's' });
  const rotated = capabilities.issue({ projectId: 'p', taskId: 't', sessionId: 's' });
  const other = capabilities.issue({ projectId: 'p', taskId: 'other', sessionId: 'other' });
  capabilities.revokeSession('s');
  for (const token of [first, rotated]) assert.throws(() => capabilities.authenticate(`Bearer ${token}`), appError('invalid_capability'));
  now += 14 * 60_000; capabilities.authenticate(`Bearer ${other}`);
  now += 60_000; assert.throws(() => capabilities.authenticate(`Bearer ${other}`), appError('invalid_capability'));
});

test('capability authentication returns a scope snapshot rather than mutable registry authority', () => {
  const capabilities = new Capabilities('boot'); const token = capabilities.issue({ projectId: 'original-project', taskId: 't', sessionId: 's' });
  const returned = capabilities.authenticate(`Bearer ${token}`);
  returned.projectId = 'forged-project';
  assert.equal(capabilities.authenticate(`Bearer ${token}`).projectId, 'original-project');
});

test('ordinary text redaction removes common credential forms and bounds retained output', () => {
  const input = 'authorization: Bearer abc123\napi_key=synthetic-value password=unsafe\nsk-abcdefghijklmnopqrst ghp_abcdefghijklmnopqrst';
  const output = redact(input);
  for (const secret of ['abc123', 'synthetic-value', 'unsafe', 'sk-abcdefghijklmnopqrst', 'ghp_abcdefghijklmnopqrst']) assert.equal(output.includes(secret), false);
  assert.ok(redact('x'.repeat(40_000)).length <= 30_000);
});
