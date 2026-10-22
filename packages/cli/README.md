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

Configuration is environment-based for this first slice:

- ANTHROPIC_API_KEY is required.
- ANTHROPIC_MODEL selects the default model.
- ANTHROPIC_BASE_URL selects an API-compatible Messages endpoint.
- --model, --base-url, --max-tokens, --system, and --cwd override defaults.

Read-only tools (Read, Glob, Grep) are allowed automatically. File writes/edits and shell commands (Write, Edit, Bash) require interactive approval. In non-interactive print mode, actions requiring approval are denied by default. File tools reject lexical paths that escape the chosen workspace and resolve existing path components to detect symlink escapes; direct symlink targets are rejected, and search tools do not traverse symlink entries.

## Current limitations

This is not yet compatible with the official CLI OAuth/configuration, SDK stream-json protocol, Session resume, MCP, Hooks, full tool set, or advanced concurrent streaming tool scheduler. It is a first usable API-key CLI path, not a claim of complete 2.1.304 compatibility.
