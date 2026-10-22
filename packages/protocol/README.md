# @agent-cil/protocol

A dependency-free protocol foundation for the independent Agent CIL runtime. Requires Node.js 22 or newer.

## JSONL framing

~~~js
import { JsonlParser, encodeJsonlFrame } from '@agent-cil/protocol';

const parser = new JsonlParser({ maxFrameBytes: 8 * 1024 * 1024 });
parser.on('data', frame => handleFrame(frame));
parser.on('frameError', error => diagnostics.warn(error.message));
process.stdin.pipe(parser);
process.stdout.write(encodeJsonlFrame({ type: 'user', message: { role: 'user', content: 'Hello' } }));
~~~

The **frameError** event is recoverable and malformed frames are skipped. An oversized frame is fatal and errors the stream. Do not write human-readable logs to a protocol stdout stream.

## Process transport

~~~js
import { ProcessTransport } from '@agent-cil/protocol';

const transport = new ProcessTransport({
  command: '/path/to/agent-cli',
  args: ['--output-format', 'stream-json', '--input-format', 'stream-json'],
  cwd: '/workspace',
  env: process.env,
});
transport.on('frame', frame => handleFrame(frame));
transport.on('frameError', error => diagnostics.warn(error.message));
transport.on('transportError', error => diagnostics.error(error.message));
await transport.start();
await transport.writeFrame({ type: 'user', message: { role: 'user', content: 'Hello' } });
// End the input stream or close the child when the owner is done.
await transport.close();
~~~

The transport owns one child process and exposes stdout frames, stderr chunks, a bounded stderr tail, and an exit result. Closing ends stdin, then sends SIGTERM after the grace period and SIGKILL if the child still does not exit. Raw stderr may contain sensitive data; it is not logged automatically, and callers must redact before persisting it. Supplying **env** passes that environment object to the child; construct it deliberately rather than assuming inherited variables are merged.

## Control response correlation

~~~js
import { ControlRequestRegistry, createControlCancelFrame } from '@agent-cil/protocol';

const pending = new ControlRequestRegistry();
const response = pending.waitFor('request-42', { signal, timeoutMs: 30_000 });
writeFrame({ type: 'control_request', request_id: 'request-42', request: { subtype: 'initialize' } });
// In the transport's frame handler:
if (frame.type === 'control_response') pending.accept(frame);
// On cancellation, write the separate control-cancel frame when appropriate:
writeFrame(createControlCancelFrame('request-42'));
~~~

The registry correlates by **response.request_id**; it does not infer response order. **waitFor()** resolves with the control-response envelope (**frame.response**), rejects peer **subtype: "error"** responses, and supports abort, timeout and close. The bounded early-response cache exists for races where a response arrives before a waiter is registered; it is not a message queue for arbitrary protocol events.

This package implements generic transport primitives only. Version-specific schema validation, SDK Query initialization, session lifecycle, permission UI, MCP server execution, authentication and retries remain in higher layers.
