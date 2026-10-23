# @agent-cil/runtime

An independent, adapter-driven Agent Loop for Node.js 22+. It is deliberately separate from the protocol transport and does not require network access or model credentials in tests.

## Model adapter

Implement `model.stream()` as an async iterable of `text_delta`, `tool_use`, `message_end`, and optional `usage` events. The adapter owns the provider-specific streaming protocol; the loop owns tool dispatch, message history, permissions, and round limits.

~~~js
import { AgentLoop, ToolRegistry } from '@agent-cil/runtime';

const tools = new ToolRegistry();
tools.register({
  name: 'echo',
  description: 'Return a value.',
  inputSchema: {
    type: 'object',
    properties: { value: { type: 'string' } },
    required: ['value'],
    additionalProperties: false,
  },
  execute: async ({ value }) => value,
});

const loop = new AgentLoop({
  model: providerAdapter,
  tools,
  permissionPolicy: async ({ name, input }) => {
    // Use a real application policy; this example allows only a known operation.
    if (name === 'echo' && typeof input.value === 'string') {
      return { behavior: 'allow', reason: 'Explicit application policy.' };
    }
    return { behavior: 'deny', reason: 'Not authorized.' };
  },
  maxTurns: 8,
});

const result = await loop.run({ input: 'Echo hello.' });
~~~

The model adapter contract is intentionally provider-neutral:

- `text_delta`: `{ type: 'text_delta', text: string }`
- `tool_use`: `{ type: 'tool_use', id: string, name: string, input: object }`
- `message_end`: `{ type: 'message_end', stopReason: 'end_turn' | 'tool_use' | 'max_tokens' }`
- `usage` (optional): `{ type: 'usage', usage: object }`

A message containing tool calls must end with `tool_use`; a `tool_use` stop reason without tool calls is rejected. Each run tracks tool-use IDs and rejects duplicates. The result contains the complete message history, number of model turns, stop reason, and final assistant message.

## Tool registry and permissions

Tool definitions require a stable name, description, JSON input schema, and execute function. The built-in validator supports a deliberate subset of JSON Schema: `type`, `enum`, `properties`, `required`, `additionalProperties`, `items`, string length, array length, and numeric minimum/maximum. Use a full JSON Schema validator if the application needs broader semantics.

The default permission policy is **deny**. Tools execute only when the configured policy returns `{ behavior: 'allow' }`, or when it returns `ask` and an approval handler explicitly approves the request. Missing approval handlers, invalid decisions, policy exceptions, unknown tools, and invalid inputs fail closed. Tool failures are returned to the model as error `tool_result` blocks so the model can recover.

A permission policy receives `phase: 'initial'` for the first decision and `phase: 'recheck'` when a policy or approval handler changes the proposed input. Each changed input must pass the registered JSON Schema and is re-authorized before execution; a denial is terminal. If the final input still requires approval, the approval handler receives that exact input. Policies should evaluate the supplied input on every call and avoid non-idempotent rewrites. When a custom `validateInput` function is registered, it supplements rather than replaces JSON Schema validation.

## Events and cancellation

The loop emits `runStarted`, `turnStarted`, `textDelta`, `assistantMessage`, `toolCallStarted`, `toolCallFinished`, `permissionRequired`, `turnFinished`, `finished`, and diagnostic error events. Pass an `AbortSignal` to cancel between model events and tool boundaries; provider and tool adapters should also honor that signal while doing I/O.

This is the minimum independent runtime slice. Persistent sessions, provider-specific model adapters, parallel tool execution, MCP, streaming recovery, and desktop/VM/SSH host integration are not included yet.

## Sessions and persistence

`AgentSessionManager` stores user-turn history and a separate turn journal. The default `InMemorySessionStore` is useful for tests and warm sessions. `FileSessionStore` persists one JSON file per session and uses atomic file replacement, restrictive file creation modes, and revision checks.

~~~js
import { AgentLoop, AgentSessionManager, FileSessionStore } from '@agent-cil/runtime';

const sessions = new AgentSessionManager({
  loop: providerNeutralLoop,
  store: new FileSessionStore({ directory: '/private/app-data/sessions' }),
});
const session = await sessions.create({ metadata: { label: 'example' } });
const first = await sessions.run(session.id, 'Start a task.');
const second = await sessions.run(session.id, 'Continue the same task.');
~~~

A fresh manager can load the same session from the same file directory and continue with the persisted message history. Successful user turns commit their full message history; failed or cancelled turns remain in the journal and do not append an incomplete conversation to the committed history. `recoverInterruptedTurns(id)` marks stale `running` journal entries as `interrupted`; call it only after confirming that the prior runtime is no longer running.

Important limits:

- FileSessionStore is designed for a **single writer process** per session directory. Revision checks protect against stale writes within that store instance, not arbitrary cross-process races.
- Session JSON is plaintext and can contain prompts, tool results, and other sensitive data. Choose a private directory and add host-level encryption or redaction where required.
- Tool side effects may happen before a turn fails. The manager does not automatically replay failed/interrupted turns and cannot guarantee exactly-once tool execution.
- Parallel turns through one AgentSessionManager are rejected. Use a separate loop/manager for independently scheduled sessions.
- Expiry policies, encryption keys, distributed locking, session migration, and automatic crash recovery are host responsibilities.

## Anthropic Messages API adapter

`AnthropicMessagesAdapter` implements the runtime's Model contract using the public Messages API and SSE streaming, without adding an SDK dependency.

~~~js
import { AgentLoop, AnthropicMessagesAdapter, ToolRegistry } from '@agent-cil/runtime';

const model = new AnthropicMessagesAdapter({
  apiKeyProvider: async () => secretStore.getAnthropicApiKey(),
  model: 'claude-sonnet-4-6',
  maxTokens: 2048,
  system: 'Follow the application policy.',
});
const loop = new AgentLoop({
  model,
  tools: new ToolRegistry(),
  permissionPolicy: applicationPermissionPolicy,
});
~~~

The host supplies the credential through `apiKey` or `apiKeyProvider`; the adapter does not read environment variables, write credentials to disk, or log them. It maps text deltas, client-side tool JSON deltas, usage, and supported stop reasons into the AgentLoop event contract. Server-side tools and unsupported stop reasons are rejected rather than silently ignored.

The adapter uses the Messages API stream event contract documented in the [Anthropic streaming guide](https://docs.anthropic.com/en/api/messages-streaming). This implementation is a small compatibility slice, not a complete replacement for Anthropic's SDK: retries, timeout policy, extended-thinking round trips, citations, images/documents, server-side tools, prompt caching options, and every provider-specific error type remain out of scope.


## Legacy 2.1.88 streaming executor port (PR #15)

`src/legacy-tools/streaming-tool-executor.js` is a Node.js-adapted port of the old `services/tools/StreamingToolExecutor.ts` scheduling core. The active `AgentLoop` now uses its `queued → executing → completed → yielded` queue for tool-use turns **after** the complete Messages SSE turn has been validated. Explicitly registered concurrency-safe tools may run together; Write/Edit/Bash remain exclusive barriers. Worker results feed the existing model `tool_result` history. Progress/discard/sibling-error paths are covered by scheduler-specific tests.

The port intentionally uses an adapter that calls the existing PR #9 `AgentLoop.#executeTool` permission execution path, preserving `updatedInput` revalidation and approval. This **does not** mean old `toolExecution.ts` / `runToolUse` (Bun/Hook/MCP/telemetry) has already been ported. The original scheduling and result lifecycle is reused; missing platform dependencies are bridged rather than recreated. Further replacement of the execution adapter requires independent old/new behavior and real-model checks. On this CLI path tools start only after the model message closes, not speculatively during SSE streaming.
