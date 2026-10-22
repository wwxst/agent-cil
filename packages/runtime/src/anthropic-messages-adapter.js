function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function abortIfNeeded(signal) {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error('Messages API stream was aborted.');
  error.name = 'AbortError';
  if (signal.reason !== undefined) error.cause = signal.reason;
  throw error;
}

export class ModelAdapterError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'ModelAdapterError';
  }
}

function mapStopReason(reason) {
  if (reason === 'end_turn' || reason === 'tool_use' || reason === 'max_tokens') return reason;
  if (reason === 'stop_sequence' || reason === 'refusal') return 'end_turn';
  throw new ModelAdapterError('Unsupported Messages API stop reason: ' + String(reason));
}

function dispatchSseEvent(eventName, dataLines) {
  if (dataLines.length === 0) return undefined;
  return { event: eventName || 'message', data: dataLines.join('\n') };
}

/** Parse Server-Sent Events from a byte stream, including split UTF-8 and CRLF. */
export async function* parseSseStream(body, { signal } = {}) {
  if (!body || typeof body[Symbol.asyncIterator] !== 'function') {
    throw new TypeError('SSE body must be an async iterable byte stream.');
  }
  const decoder = new TextDecoder();
  let buffer = '';
  let eventName = 'message';
  let dataLines = [];

  const consumeLine = line => {
    if (line === '') {
      const event = dispatchSseEvent(eventName, dataLines);
      eventName = 'message';
      dataLines = [];
      return event;
    }
    if (line.startsWith(':')) return undefined;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') eventName = value;
    else if (field === 'data') dataLines.push(value);
    return undefined;
  };

  for await (const chunk of body) {
    abortIfNeeded(signal);
    buffer += decoder.decode(chunk, { stream: true });
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      let line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      const event = consumeLine(line);
      if (event) yield event;
    }
  }

  buffer += decoder.decode();
  if (buffer.length > 0) {
    if (buffer.endsWith('\r')) buffer = buffer.slice(0, -1);
    const event = consumeLine(buffer);
    if (event) yield event;
  }
  const finalEvent = dispatchSseEvent(eventName, dataLines);
  if (finalEvent) yield finalEvent;
}

function readErrorMessage(bodyText, status) {
  try {
    const body = JSON.parse(bodyText);
    const message = body?.error?.message;
    const type = body?.error?.type;
    if (typeof message === 'string' && message.length > 0) {
      return 'Messages API returned HTTP ' + status + (type ? ' (' + type + ')' : '') + ': ' + message;
    }
  } catch {
    // Avoid dumping arbitrary proxy response bodies.
  }
  return 'Messages API returned HTTP ' + status + '.';
}

/**
 * Minimal adapter for Anthropic's public Messages API streaming endpoint.
 * API credentials are supplied by the host and are never persisted by this class.
 */
export class AnthropicMessagesAdapter {
  #apiKey;
  #apiKeyProvider;
  #model;
  #maxTokens;
  #system;
  #baseUrl;
  #version;
  #fetch;

  constructor({
    apiKey,
    apiKeyProvider,
    model,
    maxTokens = 1024,
    system,
    baseUrl = 'https://api.anthropic.com',
    apiVersion = '2023-06-01',
    fetchImpl = globalThis.fetch,
  } = {}) {
    if (apiKey !== undefined && (typeof apiKey !== 'string' || apiKey.trim().length === 0)) {
      throw new TypeError('apiKey must be a non-empty string when provided.');
    }
    if (apiKeyProvider !== undefined && typeof apiKeyProvider !== 'function') {
      throw new TypeError('apiKeyProvider must be a function when provided.');
    }
    if (apiKey === undefined && apiKeyProvider === undefined) {
      throw new TypeError('Provide apiKey or apiKeyProvider.');
    }
    if (typeof model !== 'string' || model.trim().length === 0) throw new TypeError('model must be a non-empty string.');
    if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) throw new RangeError('maxTokens must be a positive safe integer.');
    if (system !== undefined && typeof system !== 'string') throw new TypeError('system must be a string when provided.');
    if (typeof baseUrl !== 'string' || baseUrl.trim().length === 0) throw new TypeError('baseUrl must be a non-empty URL.');
    let parsedBaseUrl;
    try {
      parsedBaseUrl = new URL(baseUrl);
    } catch {
      throw new TypeError('baseUrl must be a valid HTTP(S) URL.');
    }
    if (!['http:', 'https:'].includes(parsedBaseUrl.protocol)) throw new TypeError('baseUrl must use HTTP or HTTPS.');
    if (parsedBaseUrl.protocol === 'http:') {
      const hostname = parsedBaseUrl.hostname.toLowerCase().replace(/^\[|\]$/g, '');
      const isLoopback = hostname === 'localhost'
        || hostname.endsWith('.localhost')
        || hostname === '::1'
        || /^127(?:\.\d{1,3}){3}$/.test(hostname);
      if (!isLoopback) {
        throw new TypeError('baseUrl must use HTTPS unless it targets localhost or a loopback address.');
      }
    }
    if (typeof apiVersion !== 'string' || apiVersion.trim().length === 0) throw new TypeError('apiVersion must be a non-empty string.');
    if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a fetch-compatible function.');

    this.#apiKey = apiKey;
    this.#apiKeyProvider = apiKeyProvider;
    this.#model = model;
    this.#maxTokens = maxTokens;
    this.#system = system;
    this.#baseUrl = parsedBaseUrl.toString().replace(/\/+$/, '');
    this.#version = apiVersion;
    this.#fetch = fetchImpl;
  }

  async *stream({ messages, tools = [], signal } = {}) {
    if (!Array.isArray(messages)) throw new TypeError('messages must be an array.');
    if (!Array.isArray(tools)) throw new TypeError('tools must be an array.');
    abortIfNeeded(signal);

    const apiKey = this.#apiKeyProvider ? await this.#apiKeyProvider() : this.#apiKey;
    if (typeof apiKey !== 'string' || apiKey.trim().length === 0) {
      throw new ModelAdapterError('API key provider did not return a non-empty key.');
    }

    const requestMessages = messages.map((message, index) => {
      if (!isRecord(message) || !['user', 'assistant'].includes(message.role)) {
        throw new TypeError('messages[' + index + '] must have role user or assistant.');
      }
      if (typeof message.content !== 'string' && !Array.isArray(message.content)) {
        throw new TypeError('messages[' + index + '].content must be a string or content-block array.');
      }
      return { role: message.role, content: structuredClone(message.content) };
    });

    const requestTools = tools.map((tool, index) => {
      if (!isRecord(tool) || typeof tool.name !== 'string' || typeof tool.description !== 'string'
        || !isRecord(tool.input_schema)) {
        throw new TypeError('tools[' + index + '] must include name, description, and input_schema.');
      }
      return {
        name: tool.name,
        description: tool.description,
        input_schema: structuredClone(tool.input_schema),
      };
    });

    const body = {
      model: this.#model,
      max_tokens: this.#maxTokens,
      messages: requestMessages,
      stream: true,
    };
    if (this.#system !== undefined) body.system = this.#system;
    if (requestTools.length > 0) body.tools = requestTools;

    let response;
    try {
      response = await this.#fetch(this.#baseUrl + '/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'anthropic-version': this.#version,
          'x-api-key': apiKey,
          accept: 'text/event-stream',
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (signal?.aborted) abortIfNeeded(signal);
      throw new ModelAdapterError('Failed to connect to the Messages API.', { cause: error });
    }

    if (!response || typeof response.ok !== 'boolean') {
      throw new ModelAdapterError('Fetch adapter returned an invalid response.');
    }
    if (!response.ok) {
      const responseText = typeof response.text === 'function' ? await response.text() : '';
      throw new ModelAdapterError(readErrorMessage(responseText, response.status));
    }
    if (!response.body || typeof response.body[Symbol.asyncIterator] !== 'function') {
      throw new ModelAdapterError('Messages API response has no async-iterable SSE body.');
    }

    const blocks = new Map();
    let messageStarted = false;
    let messageStopped = false;
    let stopReason;
    let usage = {};

    for await (const sse of parseSseStream(response.body, { signal })) {
      abortIfNeeded(signal);
      let payload;
      try {
        payload = JSON.parse(sse.data);
      } catch (cause) {
        throw new ModelAdapterError('Messages API sent malformed SSE JSON.', { cause });
      }
      if (!isRecord(payload)) throw new ModelAdapterError('Messages API sent a non-object SSE event.');
      const type = typeof payload.type === 'string' ? payload.type : sse.event;

      if (type === 'ping') continue;
      if (type === 'error') {
        const message = typeof payload.error?.message === 'string' ? payload.error.message : 'Unknown streaming error.';
        throw new ModelAdapterError('Messages API stream error: ' + message);
      }
      if (type === 'message_start') {
        messageStarted = true;
        const initialUsage = payload.message?.usage;
        if (isRecord(initialUsage)) {
          usage = { ...usage, ...initialUsage };
          yield { type: 'usage', usage: structuredClone(usage) };
        }
      } else if (type === 'content_block_start') {
        const block = payload.content_block;
        if (!Number.isSafeInteger(payload.index) || payload.index < 0 || !isRecord(block)) {
          throw new ModelAdapterError('Messages API sent a malformed content_block_start.');
        }
        if (block.type === 'server_tool_use') {
          throw new ModelAdapterError('Server-side tool use is not supported by this client-tool adapter.');
        }
        if (blocks.has(payload.index)) throw new ModelAdapterError('Messages API reused an active content block index.');
        const state = { type: block.type };
        if (block.type === 'tool_use') {
          if (typeof block.id !== 'string' || typeof block.name !== 'string') {
            throw new ModelAdapterError('Messages API sent a malformed tool_use block.');
          }
          if (block.input !== undefined && !isRecord(block.input)) {
            throw new ModelAdapterError('Messages API sent non-object initial tool input.');
          }
          state.id = block.id;
          state.name = block.name;
          state.input = block.input === undefined ? {} : structuredClone(block.input);
          state.partialJson = '';
        }
        blocks.set(payload.index, state);
        if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
          yield { type: 'text_delta', text: block.text };
        }
      } else if (type === 'content_block_delta') {
        const state = blocks.get(payload.index);
        const delta = payload.delta;
        if (!state || !isRecord(delta)) throw new ModelAdapterError('Messages API sent a delta for an unknown content block.');
        if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          yield { type: 'text_delta', text: delta.text };
        } else if (delta.type === 'input_json_delta' && state.type === 'tool_use'
          && typeof delta.partial_json === 'string') {
          state.partialJson += delta.partial_json;
        }
      } else if (type === 'content_block_stop') {
        const state = blocks.get(payload.index);
        if (!state) throw new ModelAdapterError('Messages API stopped an unknown content block.');
        if (state.type === 'tool_use') {
          let input = state.input;
          if (state.partialJson.length > 0) {
            try {
              input = JSON.parse(state.partialJson);
            } catch (cause) {
              throw new ModelAdapterError('Messages API sent invalid partial tool input JSON.', { cause });
            }
          }
          if (!isRecord(input)) throw new ModelAdapterError('Tool input must decode to a JSON object.');
          yield { type: 'tool_use', id: state.id, name: state.name, input };
        }
        blocks.delete(payload.index);
      } else if (type === 'message_delta') {
        if (typeof payload.delta?.stop_reason === 'string') stopReason = payload.delta.stop_reason;
        if (isRecord(payload.usage)) {
          usage = { ...usage, ...payload.usage };
          yield { type: 'usage', usage: structuredClone(usage) };
        }
      } else if (type === 'message_stop') {
        if (!messageStarted) throw new ModelAdapterError('Messages API stopped before message_start.');
        if (blocks.size > 0) throw new ModelAdapterError('Messages API stopped with unfinished content blocks.');
        if (typeof stopReason !== 'string') throw new ModelAdapterError('Messages API stopped without a stop reason.');
        messageStopped = true;
        yield { type: 'message_end', stopReason: mapStopReason(stopReason) };
        return;
      }
    }

    if (!messageStopped) throw new ModelAdapterError('Messages API stream ended before message_stop.');
  }
}
