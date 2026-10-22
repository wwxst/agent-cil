import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ToolRegistry, ToolRegistryError } from '../src/tool-registry.js';
import { validateJsonSchema } from '../src/validation.js';
import { defaultDenyPermission } from '../src/permissions.js';

test('validates nested object, array, enum, and numeric constraints', () => {
  const schema = {
    type: 'object',
    properties: {
      mode: { type: 'string', enum: ['safe', 'fast'] },
      count: { type: 'integer', minimum: 1, maximum: 5 },
      tags: { type: 'array', minItems: 1, items: { type: 'string', minLength: 2 } },
    },
    required: ['mode', 'count', 'tags'],
    additionalProperties: false,
  };
  assert.deepEqual(validateJsonSchema({ mode: 'safe', count: 3, tags: ['ok'] }, schema), []);
  const errors = validateJsonSchema({ mode: 'unsafe', count: 9, tags: ['x'], extra: true }, schema);
  assert.equal(errors.length, 4);
});

test('registers a tool, describes only public metadata, and supports unregister', async () => {
  const registry = new ToolRegistry();
  const unregister = registry.register({
    name: 'lookup',
    description: 'Look up a key.',
    inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
    execute: async ({ key }) => key,
  });
  assert.equal(registry.has('lookup'), true);
  assert.deepEqual(registry.describe(), [{
    name: 'lookup',
    description: 'Look up a key.',
    input_schema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
  }]);
  assert.deepEqual(await registry.validateInput('lookup', { key: 'alpha' }), []);
  assert.equal(await registry.get('lookup').execute({ key: 'alpha' }), 'alpha');
  unregister();
  assert.equal(registry.has('lookup'), false);
});

test('rejects duplicate or malformed registrations', () => {
  const registry = new ToolRegistry();
  const definition = { name: 'echo', description: 'Echo.', execute: async () => 'ok' };
  registry.register(definition);
  assert.throws(() => registry.register(definition), ToolRegistryError);
  assert.throws(() => registry.register({ ...definition, name: 'not a valid name' }), ToolRegistryError);
  assert.throws(() => registry.register({ ...definition, execute: null }), ToolRegistryError);
});

test('fails closed for unknown tools and non-object inputs', async () => {
  const registry = new ToolRegistry();
  assert.deepEqual(await registry.validateInput('missing', {}), ['Tool is not registered: missing']);
  registry.register({ name: 'echo', description: 'Echo.', execute: async () => 'ok' });
  assert.deepEqual(await registry.validateInput('echo', ['not', 'an', 'object']), ['Tool input must be a JSON object.']);
});

test('custom validator failures are surfaced as validation errors', async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: 'custom',
    description: 'Custom validator.',
    validateInput: async () => { throw new Error('validator unavailable'); },
    execute: async () => 'should not run',
  });
  assert.deepEqual(await registry.validateInput('custom', {}), ['Custom input validator failed: validator unavailable']);
});

test('default permission policy always denies unless an application supplies another policy', () => {
  assert.deepEqual(defaultDenyPermission({ name: 'delete_file' }), {
    behavior: 'deny',
    reason: 'No permission policy is configured for tool delete_file.',
  });
  assert.deepEqual(defaultDenyPermission(), {
    behavior: 'deny',
    reason: 'No permission policy is configured.',
  });
});
