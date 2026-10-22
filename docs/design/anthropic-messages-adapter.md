# Anthropic Messages Adapter — stream contract

## Scope

`AnthropicMessagesAdapter` adapts the public Messages API streaming endpoint to the provider-neutral Model event contract consumed by AgentLoop. It uses host-supplied fetch and credential providers, has no SDK dependency, and does not automatically read environment variables or persist secrets.

## Request mapping

- POST to `/v1/messages` with `stream: true`, model, max_tokens, optional system prompt, messages, and client-side tools.
- Pass `x-api-key`, `anthropic-version`, and SSE accept/content-type headers.
- Forward AbortSignal to fetch and check it between stream events.
- Remove runtime-only message fields such as stop_reason from the wire messages; only role and content are sent.
- Tool schemas are passed as input_schema. Tool execution and allow/deny/ask policy remain in AgentLoop.

## SSE mapping

- `message_start`: emit initial usage when available.
- `content_block_delta.text_delta`: emit runtime text_delta.
- `content_block_delta.input_json_delta`: buffer partial JSON by content block index.
- `content_block_stop` for tool_use: parse the complete JSON object and emit runtime tool_use.
- `message_delta`: capture stop_reason and emit usage deltas.
- `message_stop`: emit runtime message_end after validating that a stop reason was received.
- `error`: raise ModelAdapterError; malformed SSE JSON and invalid tool input also fail explicitly.

The SSE parser handles chunked UTF-8, CRLF, multiple data lines, and a final event without a terminating blank line.

## Stop reasons and limits

The runtime currently supports end_turn, tool_use, and max_tokens. The adapter maps stop_sequence and refusal to end_turn; unsupported reasons such as pause_turn are rejected. Server-side tool use is rejected because this adapter only knows about client-side tool calls. Extended-thinking blocks are not represented in the current AgentLoop message contract and are not round-tripped.

## Credential and error handling

Credentials come from the constructor or an async key provider and are not included in the request body or persisted by this class. HTTP errors expose status and a structured API error message when available; arbitrary non-JSON proxy response bodies are not dumped into errors. Hosts should still avoid logging raw request headers and should configure secret storage, rate limits, timeouts, and retry policy.

## Verification

Tests use an injected fake fetch and deterministic SSE byte stream. They cover split UTF-8/CRLF, text deltas, tool input JSON, usage, stop reasons, API errors, server-tool rejection, malformed JSON, constructor validation, and pre-request cancellation. They do not make network calls or prove live-account compatibility.

Reference: [Anthropic Messages API streaming](https://docs.anthropic.com/en/api/messages-streaming).
