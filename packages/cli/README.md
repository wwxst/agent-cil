# agent-cil CLI

This package adds the first executable entry point for the independent CLI. It is deliberately a small non-interactive slice, not a claim of full Claude Code CLI compatibility.

## Run

Node.js 22 or newer is required.

~~~bash
npm run cli -- --help
npm run cli -- --version
ANTHROPIC_API_KEY=your-key npm run cli -- --print "Explain the current directory structure."
cat prompt.txt | ANTHROPIC_API_KEY=your-key npm run cli -- --print
ANTHROPIC_API_KEY=your-key npm run cli -- --print --output-format json "Summarize this input."
~~~

The agent-cil executable is also declared in the root package bin field. For local development, npm run cli -- ... avoids a global install.

## Implemented options

- **--print / -p**: run one prompt and exit. The prompt may be positional or read from non-TTY stdin.
- **--model**: model ID; defaults to AGENT_CIL_MODEL and then claude-sonnet-4-6.
- **--max-turns**: cap model rounds for this prompt.
- **--system-prompt**: supply an optional system prompt.
- **--output-format text|json**: text streams to stdout; JSON emits one final object with ok, text, stopReason, and turns on success.
- **--verbose**: write diagnostics to stderr, leaving stdout available for answer output.
- **--help** and **--version** are fast paths and do not require credentials.

The default model adapter reads ANTHROPIC_API_KEY from the host environment. This initial CLI path does not read Desktop OAuth caches or persist credentials.

## Explicit limitations

- Interactive REPL is not implemented.
- Built-in file/shell tools and CLI permission prompts are not wired into the executable yet. The runtime registry and permission primitives remain library code, not automatically enabled CLI capabilities.
- The official SDK contract --input-format stream-json --output-format stream-json is **not implemented by this first slice**. Do not use this entry point as a drop-in replacement for Desktop's SDK-launched CLI yet.
- Resume/continue/fork, MCP, full Claude Code flags, context compaction, hooks, subagents, and provider retry/fallback are not implemented in this executable.
- Tests inject a fake model. They do not call the public API or require a real key.
