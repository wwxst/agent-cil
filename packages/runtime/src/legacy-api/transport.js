/**
 * Minimal Node 22 ports from Claude CLI 2.1.88:
 * restored-src/src/services/api/withRetry.ts (BASE_DELAY_MS/getRetryDelay,
 * APIConnectionError retry decision), and
 * restored-src/src/services/api/client.ts (CLIENT_REQUEST_ID_HEADER/buildFetch).
 *
 * Original notice: © Anthropic PBC. All rights reserved.
 *
 * Only the directly usable first-party HTTP transport logic is transplanted.
 * 2.1.88 OAuth refresh, subscriber-specific backoff, Bedrock/Vertex/Foundry,
 * SDK ClientOptions, Bun feature gates, analytics and persistent retries
 * require their original dependencies and are NOT included here.
 */
import { randomUUID } from 'node:crypto';

export const BASE_DELAY_MS = 500;
export const CLIENT_REQUEST_ID_HEADER = 'x-client-request-id';
export const MAX_PRE_STREAM_BACKOFF_MS = 30_000;

/**
 * Port of the old withRetry.ts getRetryDelay(attempt, retryAfter, maxDelay).
 * Retains the original 0-25% jitter. The caller handles bounded waits.
 */
export function getRetryDelay(attempt, retryAfterHeader, maxDelayMs = 32_000, random = Math.random) {
  if (retryAfterHeader) {
    const seconds = parseInt(retryAfterHeader, 10);
    if (!Number.isNaN(seconds)) return seconds * 1000;
  }
  const baseDelay = Math.min(BASE_DELAY_MS * Math.pow(2, attempt - 1), maxDelayMs);
  const jitter = random() * 0.25 * baseDelay;
  return baseDelay + jitter;
}

/**
 * HTTP pre-stream retry window: preserve existing CLI support for fractional
 * seconds and HTTP-date Retry-After, while retaining the old jitter policy
 * for requests without a server-specified backoff.
 *
 * null means the server requested a longer delay than this CLI permits.
 */
export function getBoundedRetryDelay(attempt, retryAfter, {
  now = Date.now(), random = Math.random,
} = {}) {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const requestedMs = Number.isFinite(seconds) && seconds >= 0
      ? seconds * 1000 : Date.parse(retryAfter) - now;
    if (Number.isFinite(requestedMs) && requestedMs >= 0) {
      return requestedMs > MAX_PRE_STREAM_BACKOFF_MS ? null : Math.ceil(requestedMs);
    }
  }
  return Math.min(Math.ceil(getRetryDelay(attempt, null, MAX_PRE_STREAM_BACKOFF_MS, random)),
    MAX_PRE_STREAM_BACKOFF_MS);
}

/**
 * 2.1.88 shouldRetry() treats SDK APIConnectionError as retryable.
 * Undici/fetch represents pre-response network errors as TypeError, not
 * APIConnectionError. Only a TypeError from the *fetch invocation* is
 * considered here; explicit abort and protocol/SSE errors must not retry.
 */
export function isRetryablePreStreamConnectionError(error) {
  return error instanceof TypeError;
}

export function shouldRetryHttpResponse(response) {
  const status = response?.status;
  if (response?.headers?.get?.('x-should-retry') === 'false') return false;
  if (response?.headers?.get?.('x-should-retry') === 'true') {
    // The old withRetry can honor this hint for eligible clients, but never
    // retry ordinary 4xx requests in this unauthenticated provider-neutral CLI.
    return status === 408 || status === 409 || status === 429 || status >= 500;
  }
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

/** Port of the first-party-only condition in old client.ts buildFetch(). */
export function isFirstPartyAnthropicUrl(baseUrl) {
  try {
    const url = new URL(baseUrl);
    return url.protocol === 'https:' && url.hostname.toLowerCase() === 'api.anthropic.com'
      && (url.port === '' || url.port === '443');
  } catch {
    return false;
  }
}

/**
 * Original buildFetch retains a provided x-client-request-id; otherwise
 * generates one for direct first-party traffic. Never add the header for
 * local SSE fixtures or alternate proxy/API endpoints.
 */
export function withClientRequestId(headers, { baseUrl, createId = randomUUID } = {}) {
  if (!isFirstPartyAnthropicUrl(baseUrl)) return headers;
  const result = new Headers(headers);
  if (!result.has(CLIENT_REQUEST_ID_HEADER)) {
    result.set(CLIENT_REQUEST_ID_HEADER, createId());
  }
  return result;
}
