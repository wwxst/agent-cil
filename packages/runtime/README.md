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

## 2.1.88 Tool.call and result mapping (PR #20)

Source: recovered `src/Tool.ts` (`call`, `mapToolResultToToolResultBlockParam`), `src/services/tools/toolExecution.ts` (`await tool.call` around line 1207 and single result mapping around line 1292), and `src/utils/toolResultStorage.ts` (oversized mapped-result persistence boundary). `legacy-tools/tool-execution.js` now **invokes** the old call signature and maps `result.data` once **after** PR #9's schema validation, policy, tool-specific permission, `updatedInput` rechecks and any interactive approval. The result supplied to the model is checked for tool-use ID, supported `tool_result` shape, content and `is_error`.

`ToolRegistry` accepts the 2.1.88 `call + mapper` pair, or the existing `execute` API. During migration both may coexist: `AgentLoop` uses `call + mapper` when present, while older direct callers can continue to call `execute`. The CLI's built-in `Read` is the first **actual built-in tool** migrated to this path, reusing the existing verified workspace-safe reader rather than copying its implementation; its previous model-facing text result and direct test entry remain unchanged. The packaged CLI smoke consequently exercises an actual `Tool.call` invocation.

The old `canUseTool` parameter for nested permission requests is **deny-only for now**: a parent tool approval must not silently authorize nested actions. Old `newMessages`, `contextModifier`, MCP metadata and structured output attachments are not yet supported and return an explicit error instead of being ignored. Old `toolResultStorage.ts` persists oversized results to per-session files; that subsystem is not ported, so legacy mapped results above 1 MiB fail closed until storage and result references are available. Original `PreToolUse`/`PostToolUse` hooks and full `query.ts` continue to require their dependency closure. Real-provider credentialed acceptance is still outstanding.

## 2.1.88 queryLoop model/tool core (PR #21)

Recovered source: `reference-2.1.88/restored-src/src/query.ts`, especially `query()` / `queryLoop()` (around lines 219–320), `needsFollowUp` and `toolUseBlocks` (around 530–540 and 832–844), tool-result batching (around 1340–1400), and cross-iteration `State` transitions. The running Node port is `src/legacy-query/query.js`, and `AgentLoop.run()` now delegates model/tool iteration to it, rather than retaining a second independent loop. The CLI retains the existing streaming model-event protocol checks, `StreamingToolExecutor`/`runToolUse`/`Tool.call` pipeline, worktree security checks and PR #9 permission reauthorization.

**Key source-derived semantic fix:** 2.1.88 query explicitly says `stop_reason === 'tool_use'` is unreliable. The presence of *actual tool_use blocks* determines `needsFollowUp`, regardless of the reported stop reason. A model response containing a valid `tool_use` with `end_turn` still executes it, gathers corresponding tool_results and continues. A misleading `tool_use` stop reason with no tool blocks ends normally without inventing tools. Protocol-level `message_end`/tool-input validation still applies. The port carries real `messages`, `turnCount` and continuation reason in state and preserves the existing `maxTurns`, error propagation, cancellation and event lifecycle. This is exercised by real CLI child-process HTTP/SSE integration tests plus direct query and AgentLoop regressions.

**Not ported:** the complete 1,729-line source with its Bun feature gates and 43 imports, compact/reactiveCompact, context-collapse, attachments/queue, SDK thinking signatures, stop/post-sampling hooks, token/task budgets, memory/skill prefetch, fallback retries and per-session storage. Those dependencies are still unfulfilled and must not be called implemented. The current CLI has **not** completed a credentialed real-provider Anthropic acceptance test; local SSE fixtures validate the protocol boundary, not live model behavior.

## CLI 2.1.88 model client and withRetry transport port (PR #22)

The original 2.1.88 core request chain is `query.ts → services/api/claude.ts → services/api/withRetry.ts → services/api/client.ts → Anthropic Messages API`. The recovered source exposes substantially more dependencies than the headless Node CLI supports: SDK Beta streaming helpers, Bun feature gates, OAuth/subscriber/enterprise policies, AWS Bedrock, Vertex, Foundry, proxy negotiation, model fallback, token budgets and analytics. Those components have **not** been wholesale built or silently replaced.

The first **running** source subset is `src/legacy-api/transport.js`: old `withRetry.ts` `BASE_DELAY_MS/getRetryDelay()` (exponential backoff, 25% jitter), pre-response `APIConnectionError` retry behavior mapped to Node `fetch`'s `TypeError`, and old `client.ts` `buildFetch`'s `x-client-request-id` for first-party-only API calls. The existing `AnthropicMessagesAdapter` directly calls these functions; it is not a disconnected reference module. Server `Retry-After` remains bounded by 30 seconds, `x-should-retry:false` stops attempts, API key stays out of the request body, and a successful response that has started SSE **is never replayed**. The first-party ID header is limited to HTTPS `api.anthropic.com`, not attached to local fixtures or custom API endpoints.

Verified behavior: source-algorithm parity tests, an actual CLI Node subprocess against a local HTTP server that closes the first connection before response headers, and a **real pseudo-terminal** CLI coding task performing `Read → Edit → user-approved Bash → Read`. The latter checks actual file edits and command `exit_code=0`, not just mock responses from tools. The `--print` mode still denies Bash without an interactive approval handler. CI runs the two model/CLI acceptance cases again against a **freshly installed `npm pack` tarball**, after the full unit/integration suite and ordinary installation smoke.

No Anthropic API credentials were available. The model replies in these tests are deterministic local SSE fixtures; this establishes real process/tool/transport behavior, **not live provider compatibility**. SDK request construction, Bedrock/Vertex/Foundry, auth refresh, server streaming fallback, persistent retries, and other 2.1.88 API dependencies still require explicit migration, compilation and parity tests before replacement.

## DeepSeek and Anthropic protected-thinking streaming (PR #25)

Original 2.1.88 source: `reference-2.1.88/restored-src/src/services/api/claude.ts` `content_block_start` (around lines 1995–2041), `content_block_delta` cases `thinking_delta`/`signature_delta` (around 2127–2166), and `content_block_stop` (around 2171–2205); `restored-src/src/query.ts` protected-thinking trajectory rules (around lines 152–162). The compressed 2.1.304 `chunk-4b60tdnk.js` preserves these state transitions and additionally ignores known `thinking_delta` events on `redacted_thinking`. Original notice: © Anthropic PBC. All rights reserved.

The **running** `AnthropicMessagesAdapter` now accumulates `thinking_delta`, attaches an opaque `signature_delta` without creating its own signature, and finalizes blocks at `content_block_stop`. It also handles Anthropic `redacted_thinking` as an opaque `data` payload. The **running** `legacy-query/query.js` keeps these blocks in the assistant message content in original order and passes them through the next tool-use request unmodified. It never emits thinking or ciphertext as `textDelta`, so the CLI prints only public `text` blocks. Syntax/type/index mismatches, unknown blocks, malformed redaction and truncated streams still produce protocol errors.

**Provider differences:** DeepSeek's official Anthropic-compatible endpoint (`https://api.deepseek.com/anthropic`) supports `thinking` but says `redacted_thinking` is unsupported. If such a block unexpectedly arrives from that endpoint, fail before executing any model-requested tool; never silently strip it or attempt to send an invalid history. Other endpoints can round-trip redacted blocks without modifying ciphertext. Signed thinking from DeepSeek remains attached to tool-use history exactly as supplied; a missing signature is left missing rather than forged.

Tests include delta/signature assembly, thinking + public text + tool use, exact cross-round replay, both providers' redacted paths, unknown blocks, cancellation without side effects, a real Node CLI subprocess with three HTTP/SSE rounds and actual filesystem Read/Edit, and the same subprocess test against an npm-packed freshly installed executable. **No credentialed DeepSeek API call has been completed by this PR**: all currently reported tests use deterministic local SSE fixtures. A reachable provider and a freshly rotated valid API key are needed to claim genuine live compatibility.


## Safe streaming Read/Glob/Grep dispatch (PR #26)

This change reuses the **running 2.1.88 Query, StreamingToolExecutor, and runToolUse**. Source: wwxst/- pinned restored src/query.ts (the streaming assistant-message loop invokes addTool and fallback invokes discard), src/services/tools/StreamingToolExecutor.ts (queued/running/completed/yielded states, concurrency-safe/exclusive admission, ordered results), and src/services/tools/toolExecution.ts (schema → value validation → permissions → call → tool_result). Copyright notices in the ported files remain intact.

The uploaded CLI 2.1.304 cli-2.1.304/modules/chunk-smbjjyps.js still has addTool, getCompletedResults and getRemainingResults, and adds a responseOpen lifecycle signal and discardAndAbortInFlight. **We are not claiming complete 2.1.304 scheduler parity.** This is a deliberately conservative first slice to unblock the actual CLI.

**Execution contract:** only the CLI built-in Read, Glob and Grep tools explicitly opt in with canRunDuringStream. Their registry definition must also declare isConcurrencySafe. AgentLoop previews global permissions using phase streaming-preflight **only when the permission policy explicitly declares supportsStreamingPreflight=true**, guaranteeing that its decision does not depend on an incomplete assistant message. The built-in CLI workspace policy opts in; arbitrary custom policies stay post-message_end. Preflight starts an early tool only when the decision is allow with no rewritten input; a custom validator or tool-specific permission check disables speculation. The normal legacy runToolUse chain repeats schema, value and permission validations. If permission changes to ask after preflight, an early call is denied rather than showing approval during the model stream.

**Safety and order:** Write, Edit, Bash, unknown tools, ask/deny decisions and input-rewriting decisions wait until fully validated message_end. The first deferred tool forms an ordering barrier for every following tool, even a safe one. Tool results are appended to assistant history only after the complete model message has been verified; the scheduler preserves tool_use/result order. Invalid, truncated or aborted streams call discard(), which aborts in-flight speculative workers. The built-in Read, Glob and Grep now check AbortSignal through file reads and directory walks. A custom third-party tool must still cooperate with AbortSignal; synchronous cancellation cannot be guaranteed.

**Evidence:** CI runs real Node CLI subprocesses driven by local DeepSeek-shaped SSE. One test withholds message_stop until Read has actually started, while a later Edit stays deferred; another introduces a protocol error and verifies Edit never changes the file. The npm-packed fresh-install CLI runs the same tests. Unit tests cover stream cancellation, permission approval/revocation, unsafe ordering barriers and history consistency. These fixture tests do **not** establish credentialed live DeepSeek early-scheduling behavior; that remains a separate acceptance gate.


## Completed tool-turn recovery (PR #27)

The original CLI 2.1.88 restored query.ts uses a streamed result/history path rather than treating an entire Agent run as atomic. In its model error branch, it emits missing-tool results and returns an explicit model_error transition; a completed prior tool response is not retroactively undone. The present headless Query port still runs the same legacy scheduler, but previously returned no successful result at all when a later model request failed.

On the active CLI path, Query now emits a structuredClone of the message history through the existing turnFinished event **only after** the assistant message and every matching tool_result block have completed. The CLI keeps the newest such checkpoint for the active prompt. If a subsequent model request errors or aborts, interactive mode retains only this committed history (including the original request), and refuses to commit the failed response or any partial tool result. A subsequent prompt can continue without asking the model to redo the prior Edit/Write/Bash. Permission checks are not weakened and there is no hidden retry or replay of tool actions.

This is **in-process interactive recovery only**, not durable session persistence. A one-shot --print invocation still exits with an error and does not save session state; external process crashes cannot recover checkpoints. A failure *during* a tool's side effect, or a partial tool batch, remains excluded from checkpointing. Existing streaming tool cancellation and strict model protocol checks remain unchanged.

Tests drive a fake DeepSeek-compatible local HTTP/SSE response through an actual pseudo-TTY CLI: Edit completes, the next model turn returns HTTP 503, the user types continue, and the third model request must contain the original signed thinking, Edit and tool_result exactly once. The installed npm CLI runs this case too. These regression fixtures are not official credentialed DeepSeek calls.
