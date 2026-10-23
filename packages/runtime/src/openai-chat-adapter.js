/**
 * Headless OpenAI Chat Completions adapter for the existing agent-cil Query.
 *
 * Reuses the 2.1.88-derived pre-stream retry/backoff and current SSE parser.
 * Converts Chat Completions function-call deltas to the exact normalized
 * text_delta/tool_use/message_end contract used by legacy-query/query.js.
 * It does not replace any permission, tool, or Agent execution logic.
 */
import { setTimeout as delay } from 'node:timers/promises';
import { parseSseStream } from './anthropic-messages-adapter.js';
import {
  getBoundedRetryDelay,
  isRetryablePreStreamConnectionError,
  shouldRetryHttpResponse,
} from './legacy-api/transport.js';

export class OpenAIChatError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'OpenAIChatError';
  }
}

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function abortIfNeeded(signal) {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error('OpenAI request cancelled.');
  error.name = 'AbortError';
  throw error;
}

function formatContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) throw new TypeError('Unsupported message content.');
  if (content.every(x => x?.type === 'text' && typeof x.text === 'string')) {
    return content.map(x => x.text).join('\n');
  }
  throw new TypeError('Unsupported non-text message blocks for OpenAI Chat Completions.');
}

/** Translate existing Anthropic-shaped history without dropping tool results. */
export function mapChatMessages(messages, system) {
  const output = [];
  if (system !== undefined) output.push({ role: 'system', content: system });
  for (const message of messages) {
    if (!isRecord(message)) throw new TypeError('Invalid model history message.');
    if (message.role === 'assistant') {
      const content = typeof message.content === 'string'
        ? [{ type: 'text', text: message.content }] : message.content;
      if (!Array.isArray(content)) throw new TypeError('Invalid assistant content.');
      const toolCalls = [];
      const text = [];
      for (const block of content) {
        if (block?.type === 'text' && typeof block.text === 'string') {
          text.push(block.text);
        } else if (block?.type === 'tool_use' && typeof block.id === 'string'
          && typeof block.name === 'string' && isRecord(block.input)) {
          toolCalls.push({
            id: block.id, type: 'function',
            function: { name: block.name, arguments: JSON.stringify(block.input) },
          });
        } else {
          throw new TypeError('Unsupported assistant block in Chat Completions history.');
        }
      }
      output.push({
        role: 'assistant', content: text.join('\n') || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
    } else if (message.role === 'user') {
      if (typeof message.content === 'string') {
        output.push({ role: 'user', content: message.content });
        continue;
      }
      if (!Array.isArray(message.content)) throw new TypeError('Invalid user content.');
      let text = [];
      const flushText = () => {
        if (text.length) {
          output.push({ role: 'user', content: text.join('\n') });
          text = [];
        }
      };
      for (const block of message.content) {
        if (block?.type === 'text' && typeof block.text === 'string') {
          text.push(block.text);
        } else if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
          flushText();
          output.push({
            role: 'tool', tool_call_id: block.tool_use_id,
            content: formatContent(block.content),
          });
        } else {
          throw new TypeError('Unsupported user content block for Chat Completions.');
        }
      }
      flushText();
    } else {
      throw new TypeError('Only user and assistant history messages are supported.');
    }
  }
  return output;
}

export class OpenAIChatAdapter {
  #apiKey;
  #model;
  #baseUrl;
  #system;
  #maxTokens;
  #maxRetries;
  #fetch;

  constructor({
    apiKey, model, baseUrl = 'https://api.openai.com/v1',
    system, maxTokens = 4096, maxRetries = 2, fetchImpl = globalThis.fetch,
  } = {}) {
    if (typeof apiKey !== 'string' || apiKey.trim().length === 0) {
      throw new TypeError('OpenAI API key must be a non-empty string.');
    }
    if (typeof model !== 'string' || !model.trim()) throw new TypeError('Model must be non-empty.');
    if (system !== undefined && typeof system !== 'string') throw new TypeError('system must be text.');
    if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) throw new RangeError('Invalid maxTokens.');
    if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 5) throw new RangeError('Invalid maxRetries.');
    if (typeof fetchImpl !== 'function') throw new TypeError('Invalid fetch implementation.');
    let url;
    try { url = new URL(baseUrl); } catch { throw new TypeError('Invalid OpenAI base URL.'); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new TypeError('OpenAI base URL must be HTTP(S) without embedded credentials.');
    }
    if (url.protocol === 'http:' &&
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
      throw new TypeError('OpenAI base URL must use HTTPS outside localhost.');
    }
    this.#apiKey = apiKey;
    this.#model = model;
    this.#baseUrl = url.toString().replace(/\/+$/, '');
    this.#system = system;
    this.#maxTokens = maxTokens;
    this.#maxRetries = maxRetries;
    this.#fetch = fetchImpl;
  }

  async *stream({ messages, tools = [], signal } = {}) {
    if (!Array.isArray(messages) || !Array.isArray(tools)) {
      throw new TypeError('messages and tools must be arrays.');
    }
    abortIfNeeded(signal);
    const mappedTools = tools.map(tool => {
      if (!isRecord(tool) || typeof tool.name !== 'string' ||
        typeof tool.description !== 'string' || !isRecord(tool.input_schema)) {
        throw new TypeError('Invalid tool definition.');
      }
      return { type: 'function', function: {
        name: tool.name, description: tool.description,
        parameters: structuredClone(tool.input_schema),
      } };
    });
    const body = {
      model: this.#model,
      messages: mapChatMessages(messages, this.#system),
      stream: true, max_completion_tokens: this.#maxTokens,
      ...(mappedTools.length ? { tools: mappedTools } : {}),
    };
    let response;
    for (let attempt = 0; ; attempt++) {
      abortIfNeeded(signal);
      try {
        response = await this.#fetch(this.#baseUrl + '/chat/completions', {
          method: 'POST', redirect: 'error', signal,
          headers: {
            'authorization': 'Bearer ' + this.#apiKey,
            'content-type': 'application/json',
            accept: 'text/event-stream',
          },
          body: JSON.stringify(body),
        });
      } catch (error) {
        abortIfNeeded(signal);
        if (attempt < this.#maxRetries && isRetryablePreStreamConnectionError(error)) {
          await delay(getBoundedRetryDelay(attempt + 1), undefined, { signal });
          continue;
        }
        throw new OpenAIChatError('OpenAI Chat connection failed before response.', { cause: error });
      }
      if (!response || typeof response.ok !== 'boolean') {
        throw new OpenAIChatError('Invalid HTTP response.');
      }
      if (response.ok || attempt >= this.#maxRetries || !shouldRetryHttpResponse(response)) break;
      const wait = getBoundedRetryDelay(attempt + 1, response.headers?.get?.('retry-after'));
      if (wait === null) break;
      await response.body?.cancel?.();
      await delay(wait, undefined, { signal });
    }
    if (!response.ok) {
      let detail = '';
      try {
        const json = await response.json();
        if (typeof json?.error?.message === 'string') detail = json.error.message.slice(0, 600);
      } catch { /* Do not echo arbitrary upstream HTML or auth headers. */ }
      throw new OpenAIChatError('Chat Completions HTTP ' + response.status +
        (detail ? ': ' + detail : '.'));
    }
    if (!response.body || typeof response.body[Symbol.asyncIterator] !== 'function') {
      throw new OpenAIChatError('OpenAI streaming response body is unavailable.');
    }
    const calls = new Map();
    let finished = false;
    let finalStopReason;
    let gotDone = false;
    for await (const frame of parseSseStream(response.body, { signal })) {
      abortIfNeeded(signal);
      if (frame.data === '[DONE]') {
        gotDone = true;
        break;
      }
      let chunk;
      try { chunk = JSON.parse(frame.data); } catch (cause) {
        throw new OpenAIChatError('Invalid OpenAI SSE JSON.', { cause });
      }
      if (!isRecord(chunk)) throw new OpenAIChatError('Invalid OpenAI SSE chunk.');
      if (isRecord(chunk.usage)) {
        yield { type: 'usage', usage: structuredClone(chunk.usage) };
      }
      if (!Array.isArray(chunk.choices)) {
        throw new OpenAIChatError('OpenAI chunk is missing choices.');
      }
      if (!chunk.choices.length) continue;
      if (chunk.choices.length !== 1 || chunk.choices[0]?.index !== 0) {
        throw new OpenAIChatError('Multiple Chat Completions choices are unsupported.');
      }
      const choice = chunk.choices[0];
      const delta = choice.delta;
      if (finished && (delta?.content || delta?.tool_calls?.length)) {
        throw new OpenAIChatError('Model returned content after finish_reason.');
      }
      if (isRecord(delta)) {
        if (typeof delta.content === 'string' && delta.content.length > 0) {
          yield { type: 'text_delta', text: delta.content };
        }
        if (delta.refusal) throw new OpenAIChatError('Model refused the requested completion.');
        if (delta.tool_calls !== undefined) {
          if (!Array.isArray(delta.tool_calls)) throw new OpenAIChatError('Malformed tool_calls delta.');
          for (const part of delta.tool_calls) {
            if (!Number.isSafeInteger(part?.index) || part.index < 0 || part.index > 256) {
              throw new OpenAIChatError('Invalid tool-call index.');
            }
            const acc = calls.get(part.index) ?? { id: '', name: '', arguments: '' };
            if (typeof part.id === 'string') {
              if (acc.id && acc.id !== part.id) throw new OpenAIChatError('Conflicting tool-call ID.');
              acc.id = part.id;
            }
            if (part.function?.name !== undefined) {
              if (acc.name && acc.name !== part.function.name) throw new OpenAIChatError('Conflicting tool name.');
              acc.name = part.function.name;
            }
            if (part.function?.arguments !== undefined) {
              if (typeof part.function.arguments !== 'string') {
                throw new OpenAIChatError('Tool-call arguments must be string chunks.');
              }
              acc.arguments += part.function.arguments;
              if (acc.arguments.length > 1024 * 1024) {
                throw new OpenAIChatError('Tool-call input exceeds 1 MiB.');
              }
            }
            calls.set(part.index, acc);
          }
        }
      }
      if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
        if (finished) throw new OpenAIChatError('Duplicate finish_reason.');
        const reason = choice.finish_reason;
        if (!['stop', 'tool_calls', 'length'].includes(reason)) {
          throw new OpenAIChatError('Unsupported finish_reason: ' + reason);
        }
        const seenIds = new Set();
        for (const idx of [...calls.keys()].sort((a, b) => a - b)) {
          const call = calls.get(idx);
          if (!call.id || !call.name || seenIds.has(call.id)) {
            throw new OpenAIChatError('Malformed or duplicate tool call identity.');
          }
          seenIds.add(call.id);
          let input;
          try { input = JSON.parse(call.arguments); } catch (cause) {
            throw new OpenAIChatError('Invalid function call JSON.', { cause });
          }
          if (!isRecord(input)) throw new OpenAIChatError('Tool input must be a JSON object.');
          yield { type: 'tool_use', id: call.id, name: call.name, input };
        }
        finished = true;
        // Chat Completions may emit a final choices:[] usage-only chunk
        // before [DONE]. Query rejects events after message_end, so delay
        // the terminal event until every usage delta has been delivered.
        finalStopReason = reason === 'length' ? 'max_tokens'
          : (calls.size ? 'tool_use' : 'end_turn');
      }
    }
    if (!gotDone || !finished) {
      throw new OpenAIChatError('OpenAI stream ended without final finish_reason and [DONE].');
    }
    yield { type: 'message_end', stopReason: finalStopReason };
  }
}
