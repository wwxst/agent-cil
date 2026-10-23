import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BASE_DELAY_MS,
  CLIENT_REQUEST_ID_HEADER,
  MAX_PRE_STREAM_BACKOFF_MS,
  getRetryDelay,
  getBoundedRetryDelay,
  isFirstPartyAnthropicUrl,
  isRetryablePreStreamConnectionError,
  shouldRetryHttpResponse,
  withClientRequestId,
} from '../src/legacy-api/transport.js';

test('ported 2.1.88 getRetryDelay uses 500ms exponential backoff and up to 25% jitter', () => {
  assert.equal(BASE_DELAY_MS, 500);
  assert.equal(getRetryDelay(1, null, 32000, () => 0), 500);
  assert.equal(getRetryDelay(1, null, 32000, () => 1), 625);
  assert.equal(getRetryDelay(2, null, 32000, () => 0.5), 1125);
  assert.equal(getRetryDelay(7, null, 32000, () => 0), 32000);
  assert.equal(getRetryDelay(7, null, 32000, () => 1), 40000);
  assert.equal(getRetryDelay(3, '2', 32000, () => 1), 2000);
});

test('ported bounded retry respects fractional Retry-After, HTTP dates and a 30s limit', () => {
  assert.equal(getBoundedRetryDelay(1, '0.025'), 25);
  assert.equal(getBoundedRetryDelay(1, '31'), null);
  assert.equal(getBoundedRetryDelay(1, 'invalid', { random: () => 0 }), 500);
  assert.equal(getBoundedRetryDelay(2, null, { random: () => 1 }), 1250);
  assert.equal(getBoundedRetryDelay(20, null, { random: () => 1 }), MAX_PRE_STREAM_BACKOFF_MS);
  const now = Date.parse('2026-01-01T00:00:00Z');
  assert.equal(getBoundedRetryDelay(2, new Date(now + 8000).toUTCString(), { now }), 8000);
  assert.equal(getBoundedRetryDelay(2, new Date(now + 60000).toUTCString(), { now }), null);
});

test('ported first-party request ID only injects for verified official HTTPS endpoint', () => {
  assert.equal(CLIENT_REQUEST_ID_HEADER, 'x-client-request-id');
  assert.equal(isFirstPartyAnthropicUrl('https://api.anthropic.com'), true);
  assert.equal(isFirstPartyAnthropicUrl('https://api.anthropic.com:443'), true);
  assert.equal(isFirstPartyAnthropicUrl('http://api.anthropic.com'), false);
  assert.equal(isFirstPartyAnthropicUrl('https://api.anthropic.com.evil.test'), false);
  assert.equal(isFirstPartyAnthropicUrl('http://127.0.0.1:3000'), false);

  const headers = withClientRequestId({ 'x-api-key': 'private-key' }, {
    baseUrl: 'https://api.anthropic.com', createId: () => 'known-request-id',
  });
  assert.equal(headers.get(CLIENT_REQUEST_ID_HEADER), 'known-request-id');
  assert.equal(headers.get('x-api-key'), 'private-key');
  assert.equal(withClientRequestId({ [CLIENT_REQUEST_ID_HEADER]: 'already-set' }, {
    baseUrl: 'https://api.anthropic.com', createId: () => { throw new Error('not needed'); },
  }).get(CLIENT_REQUEST_ID_HEADER), 'already-set');
  const localHeaders = withClientRequestId({ 'x-api-key': 'test' }, {
    baseUrl: 'http://localhost:3333', createId: () => { throw new Error('not needed'); },
  });
  assert.equal(localHeaders['x-api-key'], 'test');
  assert.equal(Object.hasOwn(localHeaders, CLIENT_REQUEST_ID_HEADER), false);
});

test('ported retry classification includes transport failures and refuses explicit deny', () => {
  assert.equal(isRetryablePreStreamConnectionError(new TypeError('fetch failed')), true);
  assert.equal(isRetryablePreStreamConnectionError(new Error('unexpected')), false);
  const res = (status, header) => ({
    status, headers: { get: key => key === 'x-should-retry' ? header : null },
  });
  for (const status of [408, 409, 429, 500, 502, 503, 504, 529]) {
    assert.equal(shouldRetryHttpResponse(res(status)), true);
  }
  for (const status of [400, 401, 403, 422]) {
    assert.equal(shouldRetryHttpResponse(res(status)), false);
  }
  assert.equal(shouldRetryHttpResponse(res(503, 'false')), false);
  assert.equal(shouldRetryHttpResponse(res(503, 'true')), true);
});
