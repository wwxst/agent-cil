# @agent-cil/protocol

Dependency-free protocol primitives for the independent Agent CIL runtime. Requires Node.js 22 or newer.

## JSONL framing

Use JsonlParser to turn a byte stream into JSON object frames and encodeJsonlFrame to serialize one object per line. Malformed frames emit frameError and are skipped; oversized frames are fatal. Never write human-readable logs to protocol stdout.

## Process transport

ProcessTransport owns one child process and exposes stdout frames, stderr chunks, a bounded stderr tail, and an exit result. It supports explicit stdin writes and controlled shutdown. Raw stderr can contain sensitive data, so it is not logged automatically and should be redacted before persistence. The env option passes the supplied environment object to the child; it does not merge it with the parent environment.

## Query session

QueryProtocolSession provides an initialize write barrier, request/response correlation, and host-side control callback dispatch. The initialize frame being written and its control_response arriving are distinct facts. sendInput waits for the write barrier; callers that require initialization success should also await the initialize response.

Register only host callback handlers that the application can safely fulfill. A handler can return NO_CONTROL_RESPONSE when another execution host truly owns the response. This package does not implement permission policy, tool execution, authentication, or a full SDK Query lifecycle.

## Run lifecycle

QueryRunLifecycle distinguishes the CLI result frame from completion of host-side interactions. It observes result and session_state_changed frames, waits for idle when bidirectional callbacks are configured, pauses the end ceiling during requires_action, and can use a bounded ceiling when the session never becomes idle.

~~~js
import { QueryRunLifecycle } from '@agent-cil/protocol';

const lifecycle = new QueryRunLifecycle({
  session: querySession,
  hasBidirectionalNeeds: true,
  runEndCeilingMs: 30_000,
});
lifecycle.beginRun();
const ended = lifecycle.waitForRunEnd();
// Send input using querySession; incoming frames are observed automatically.
const endResult = await ended;
~~~

## Control response correlation

ControlRequestRegistry correlates responses by response.request_id, supports out-of-order responses, and provides abort, timeout, and close cleanup. createControlCancelFrame builds a separate cancellation frame for a single pending control request.

The package implements generic transport primitives only. Version-specific schema validation, session persistence, permission UI, MCP bridge, authentication, and retries remain higher-layer responsibilities.
