# agent-cil CLI

This is the first executable CLI slice built on the existing self-owned AgentLoop, AnthropicMessagesAdapter, and ToolRegistry. It implements a small, testable core instead of claiming to reproduce all official CLI modes.

## Run from a checkout

Node.js 22 or newer is required.

    npm link
    export ANTHROPIC_API_KEY="..."
    agent-cil --model claude-sonnet-4-5

One-shot / script mode:

    agent-cil --print "Summarize the current repository"
    cat question.txt | agent-cil --print

Configuration is environment-based for this first slice. Remote API endpoints must use HTTPS; plain HTTP is accepted only for localhost/loopback development endpoints:

- ANTHROPIC_API_KEY is required.
- ANTHROPIC_MODEL selects the default model.
- ANTHROPIC_BASE_URL selects an API-compatible Messages endpoint.
- --model, --base-url, --max-tokens, --system, and --cwd override defaults.

Read-only tools (Read, Glob, Grep) are allowed automatically. File writes/edits and shell commands (Write, Edit, Bash) require interactive approval. In non-interactive print mode, actions requiring approval are denied by default. The shared Runtime validates any permission-updated tool input against the registered schema and rechecks authorization whenever the effective input changes; a denial cannot be overridden by a later replacement. File tools reject lexical paths that escape the chosen workspace and resolve existing path components to detect symlink escapes; direct symlink targets are rejected, and search tools do not traverse symlink entries. Read/Write/Edit now operate through verified file handles, use `O_NOFOLLOW` where available, and compare the opened file identity with the workspace path before reading or modifying it. This narrows final-component symlink races but is not a substitute for an OS sandbox against a hostile process concurrently renaming parent directories.

Bash captures combined stdout/stderr up to 1 MiB. On POSIX systems, cancellation, timeout, or output-limit overflow terminates the command's process group and escalates from `SIGTERM` to `SIGKILL` if needed. On Windows, cancellation currently signals the direct child process only; descendant cleanup is platform-dependent.

## Current limitations

This is not yet compatible with the official CLI OAuth/configuration, SDK stream-json protocol, Session resume, MCP, Hooks, full tool set, or advanced concurrent streaming tool scheduler. It is a first usable API-key CLI path, not a claim of complete 2.1.304 compatibility.
