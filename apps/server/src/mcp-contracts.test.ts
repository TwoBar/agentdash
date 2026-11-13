import assert from 'node:assert/strict';
import test from 'node:test';
import { mcpOutputSchemas } from './mcp-contracts.js';

test('coordination output contracts reject authority expansion, malformed identity and accidental sensitive fields', () => {
  assert.throws(() => mcpOutputSchemas.report_status.parse({ received: true, advisoryOnly: true, acceptedCompletion: true }));
  assert.throws(() => mcpOutputSchemas.request_decision.parse({ recorded: true, authorizationGranted: true, message: 'Untrusted claim' }));
  assert.throws(() => mcpOutputSchemas.reply_to_child.parse({ turnId: '' }));
  assert.throws(() => mcpOutputSchemas.reply_to_child.parse({ turnId: 'synthetic-turn', capability: 'sensitive-field' }));
  assert.throws(() => mcpOutputSchemas.get_task_context.parse({ identity: { projectId: 'synthetic' } }));
  assert.deepEqual(mcpOutputSchemas.reply_to_child.parse({ turnId: 'synthetic-turn' }), { turnId: 'synthetic-turn' });
});
