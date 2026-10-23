# Priority 1 — Live DeepSeek and OpenAI model acceptance

## Status and protocol boundaries

- `--provider deepseek` uses DeepSeek's documented **Anthropic-compatible** Messages API. Default base: `https://api.deepseek.com/anthropic`; model: `deepseek-flash`.
- `--provider openai` uses OpenAI's **Chat Completions** SSE and function tool calls. Default base: `https://api.openai.com/v1`; model default: `gpt-5.1` (override `OPENAI_MODEL` or `--model`). Responses-API-only features are not yet implemented.
- `--provider anthropic` is unchanged. The legacy Query and all filesystem, Bash approval and tool permissions are shared between providers.
- CI uses local deterministic SSE servers to run a genuine Node CLI process and OS tools. Its green status does **not** prove a real credentialed provider connection.

## Credentialed live test on an installed CLI

Run `npm pack --ignore-scripts`, install the tarball in a temporary directory, and pass the installed `agent-cil` executable to the script. Or provide the existing installed executable on your PATH.

### DeepSeek official V4.1 Flash

```bash
export AGENT_CIL_PROVIDER=deepseek
export DEEPSEEK_MODEL=deepseek-flash
read -rs -p 'DeepSeek API key: ' DEEPSEEK_API_KEY; echo
export DEEPSEEK_API_KEY
node scripts/verify-live-provider.mjs /path/to/installed/agent-cil
unset DEEPSEEK_API_KEY
```

### OpenAI official Chat Completions

```bash
export AGENT_CIL_PROVIDER=openai
export OPENAI_MODEL=gpt-5.1
read -rs -p 'OpenAI API key: ' OPENAI_API_KEY; echo
export OPENAI_API_KEY
node scripts/verify-live-provider.mjs /path/to/installed/agent-cil
unset OPENAI_API_KEY
```

The live script uses two **separate** CLI subprocesses and a temporary workspace: first it verifies streamed text output; then it asks the selected model to Read, Edit and Read a buggy `math.js`. It asserts the actual file contents and verifies the tool event trail. It never stores credentials, prints their values, or adds them to GitHub CI. It does not auto-approve Bash in headless mode.

For a **test/fix command loop**, launch the installed CLI interactively on a TTY, without `--print`. Ask it to read source, run your test command with Bash, fix the file and rerun the test. **Review both Bash commands and approve explicitly**; a model-generated shell command must never be auto-approved by the harness. CI's deterministic TTY test covers a failing Bash test, Edit fix and successful retest using this same approval mechanism.

## Acceptance gates

| Gate | DeepSeek | OpenAI |
|---|---|---|
| Correct model format and tool schemas | Local fixture tests | Local fixture tests |
| Freshly installed CLI full coding-task test | Existing Anthropic-compatible fixture | OpenAI Chat fixture |
| Live authenticated streaming | Requires private credentialed run | Requires private credentialed run |
| Live Read → Edit → Read | Requires private credentialed run | Requires private credentialed run |
| Interactive Bash test/fix on live provider | Requires manual approval & run | Requires manual approval & run |

Do not start streaming speculative tool execution or expand MCP/session features until both providers complete live credentialed checks. Rotate API keys previously shared in chats or logs.
