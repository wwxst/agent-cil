# agent-cil CLI

This is the first executable CLI slice built on the existing self-owned AgentLoop, AnthropicMessagesAdapter, and ToolRegistry. It implements a small, testable core instead of claiming to reproduce all official CLI modes.

## Run from a checkout

Node.js 22 or newer is required.

    npm link
    export ANTHROPIC_API_KEY="..."
    agent-cil --model claude-sonnet-4-5

When launched on an interactive terminal without `--print`, the CLI stays open
for multiple turns. A positional prompt (for example,
`agent-cil "Inspect this project"`) runs as the first turn and then leaves
the `you>` prompt available. Type `/exit` or `/quit` to finish.
Subsequent turns reuse the prior model conversation history.

One-shot / script mode:

    agent-cil --print "Summarize the current repository"
    cat question.txt | agent-cil --print

Configuration is environment-based for this first slice. Remote API endpoints must use HTTPS; plain HTTP is accepted only for localhost/loopback development endpoints:

- ANTHROPIC_API_KEY is required.
- ANTHROPIC_MODEL selects the default model.
- ANTHROPIC_BASE_URL selects an API-compatible Messages endpoint.
- --model, --base-url, --max-tokens, --max-turns, --max-retries, --system, and --cwd override defaults.

Read-only tools (Read, Glob, Grep) are allowed automatically. File writes/edits and shell commands (Write, Edit, Bash) require interactive approval. In non-interactive print mode, actions requiring approval are denied by default. The shared Runtime validates any permission-updated tool input against the registered schema and rechecks authorization whenever the effective input changes; a denial cannot be overridden by a later replacement. File tools reject lexical paths that escape the chosen workspace and resolve existing path components to detect symlink escapes; direct symlink targets are rejected, and search tools do not traverse symlink entries. Read/Write/Edit now operate through verified file handles, use `O_NOFOLLOW` where available, and compare the opened file identity with the workspace path before reading or modifying it. This narrows final-component symlink races but is not a substitute for an OS sandbox against a hostile process concurrently renaming parent directories.

In non-interactive print mode, SIGINT cancels an in-flight model request and the CLI exits with status 130. The cancellation contract is covered by a local streaming HTTP integration test; this does not establish parity with the official CLI's full signal-handling behavior.

Bash captures combined stdout/stderr up to 1 MiB. On POSIX systems, cancellation, timeout, or output-limit overflow terminates the command's process group and escalates from `SIGTERM` to `SIGKILL` if needed. On Windows, cancellation currently signals the direct child process only; descendant cleanup is platform-dependent.

The default agent limit is 8 model rounds per prompt; use `--max-turns <n>` (1–100) to change it. If the model stops at `max_tokens` or the agent runs out of model rounds while tools are still pending, the CLI reports an incomplete response and exits with status 1 in non-interactive mode. Partial text may already have been printed to stdout; scripts must check the exit status before treating it as a finished task. Interactive mode keeps the conversation history so you can increase the limits on restart or ask the model to continue in the same session.


Transient pre-stream HTTP failures (408, 409, 429, selected 5xx statuses including 529) are retried up to **2** times by default, with bounded exponential backoff or a short server-provided `Retry-After` value. Use `--max-retries 0` to disable retries or choose 1–5 for a different bound. The adapter respects `x-should-retry: false` and will not automatically retry a server cooldown longer than 30 seconds. Authentication errors and errors after the HTTP SSE stream begins are **not** replayed; once streaming starts, a replay could duplicate partial model output or tool actions. The handling is adapted from the old 2.1.88 retry subsystem, not a complete port of its provider-specific fallback and token refresh logic.

## Current limitations

This is not yet compatible with the official CLI OAuth/configuration, SDK stream-json protocol, Session resume, MCP, Hooks, full tool set, or advanced concurrent streaming tool scheduler. It is a first usable API-key CLI path, not a claim of complete 2.1.304 compatibility.
