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


## CLI 2.1.88 `runToolUse()` streaming dispatch (PR #16)

The active `AgentLoop` now feeds the ported `StreamingToolExecutor` through `src/legacy-tools/tool-execution.js`, a Node.js port of the **actual old `runToolUse()` / `streamedCheckPermissionsAndCallTool()` dispatch and callback-to-Stream bridge**. `src/legacy-tools/stream.js` is the old single-reader asynchronous queue ported from `utils/stream.ts`. Unknown tools, pre-call cancellation, progress delivery, and errors are converted to model-visible messages in that code. The active execution path is `AgentLoop → StreamingToolExecutor → runToolUse → streamedCheckPermissionsAndCallTool → existing verified permission executor → tool_result`.

**Migration boundary:** This does not yet port the complete original 1,745-line `toolExecution.ts` or its `checkPermissionsAndCallTool()` implementation. The latter requires SDK/Zod schemas, Pre/PostToolUse hooks, permission handler state, telemetry, MCP and Bun feature gates. The bridge delegates that body to the existing PR #9 `AgentLoop.#executeTool()` for schema, `updatedInput` revalidation, approval, and execution until those dependencies are runnable and compared. Tests cover the old Stream contract and dispatch/error/progress behavior, plus existing CLI multi-tool and npm-install smoke paths. No real Anthropic API key was available for live verification.

## Legacy 2.1.88 whole-tool permission rule evaluation (PR #17)

The Node ESM port at `src/legacy-permissions/permission-rules.js` uses the original `src/utils/permissions/permissionRuleParser.ts` rule string parser and whole-tool rule matching from `src/utils/permissions/permissions.ts`. It consumes the actual in-memory `PermissionUpdate.ts` context already ported in PR #14. This code is **called by the CLI's live permission policy** for Read/Write/Edit/Glob/Grep/Bash after workspace/symlink safety checks, and its explicit decisions obey `deny > ask > allow`; the final action still passes through PR #9's schema checks, updatedInput reauthorization and approval.

The following are deliberately **not** claimed: content-specific Bash command rules such as `Bash(npm publish:*)`, MCP server/tool permission aliases or wildcards, `tool.checkPermissions` callbacks, sandbox-specific allow decisions, React/Ink/Hook integrations, and persisted permissions settings. Content-qualified rules are parsed as in 2.1.88 but **never** treated as broad whole-tool allows. This preserves fail-closed behavior until the old tool-specific permission dependency is restored. The old full `checkPermissionsAndCallTool()` implementation from `toolExecution.ts` remains a later gated port, not an already completed module.

The parity tests in `test/legacy-permission-rules.test.js` exercise fixtures corresponding to the old parser/matcher cases; `packages/cli/test/cli.test.js` verifies decisions through the active CLI policy and a model-to-tool `AgentLoop` run. These are deterministic code/runtime tests, not a real-model API acceptance.

## 2.1.88 `checkPermissionsAndCallTool()` validation prefix (PR #18)

The active `runToolUse → streamedCheckPermissionsAndCallTool → checkPermissionsAndCallTool` path now performs the first two *actual* phases found at lines 615–730 of the recovered 2.1.88 `src/services/tools/toolExecution.ts` **before requesting permission**:

1. Parse/validate the tool input schema (original: `tool.inputSchema.safeParse`; Node CLI adapter: the same JSON Schema already published to the Messages API, validated by `validateJsonSchema`).
2. Invoke each tool's `validateInput` for value-level checks, including the original `{ result: false, message, errorCode }` rejection contract.

Schema/value failures produce a model-visible error `tool_result` and prevent policy calls, approval and tool execution. The former initial validation block has been removed from `AgentLoop.#executeTool()`, so successful tools are **not validated twice**. The PR #9 `updatedInput` recheck loop remains in `AgentLoop`; it still validates each rewritten input (using the **same** tool-value validator), rechecks permission, and denies or re-asks when needed. This is a running port of a concrete old execution sequence and has live AgentLoop behavior tests, not just a copied reference.

**Not yet ported:** the original PreToolUse and PostToolUse hook processors, `resolveHookPermissionDecision`, the tool-specific permission method/interactive state, `tool.call()`/rich result mapping, analytics/MCP, and session-specific side effects. Actual permission, OS file safeguards, and execution continue in the tested PR #9 path. Zod and Bun runtime dependencies have not been introduced into the Node 22 CLI. This PR does **not** establish real Anthropic API compatibility without an actual credentialed run.

## Legacy 2.1.88 tool-specific permissions (PR #19)

`src/legacy-permissions/tool-specific-permission.js` restores the `tool.checkPermissions(input, context)` **decision stage** from the 2.1.88 `utils/permissions/permissions.ts` chain, using `allow`, `deny`, `ask` and `passthrough` contracts (including `message` and `updatedInput`). `ToolRegistry` now preserves optional `checkPermissions` callbacks. This code is invoked by **the active AgentLoop** after the configured application permission policy and before approval or calling tools. It is not a disconnected test fixture.

A global deny is terminal and never invokes `tool.checkPermissions`. A tool deny/ask may tighten access but a tool allow cannot supersede global ask. A permission-policy input rewrite takes precedence for its recheck; a tool-specific rewrite goes through the existing PR #9 schema/value revalidation and complete policy/tool-permission recheck before approval or execution. Tool-specific exceptions or malformed decisions fail closed. Input is cloned before passing it to the tool's callback to avoid in-place mutation of model parameters. Workspace path/symlink checks and current built-in permissions remain authoritative.

This is a **dependency-limited port**, not full `checkPermissionsAndCallTool`: 2.1.88's sandbox/classifier special cases, Hook approvals, MCP, rich `tool.call()` result mapping and persisted permissions remain unported. The CLI's six built-in tools currently use their existing workspace permission policy and do not yet implement old tool-specific Bash subcommand classification. Tests exercise custom registered tools through the actual multi-turn AgentLoop. The CI npm tarball acceptance uses a local model fixture, not a credentialed Anthropic request.
