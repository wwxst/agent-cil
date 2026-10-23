# Live DeepSeek / Anthropic-compatible acceptance

This is a **manual credentialed test**, not an automatic GitHub Actions run. Do not check an API key into the repository, issue tracker, source test, PR text or logs.

## Endpoint and model

- Official DeepSeek Anthropic-compatible base URL: `https://api.deepseek.com/anthropic`.
- Official API model ID: `deepseek-flash` (serves DeepSeek-V4.1-Flash-1017 as of October 17, 2026).
- The earlier spelling `deepseek4.1flsh` was a typo. Use `deepseek-flash` with the official API; unsupported non-Claude model IDs return HTTP 400.

## Test an installed agent-cil

From the checked-out repository root, install the package separately or pass the already installed `agent-cil` executable. The script defaults to the `agent-cil` binary on PATH and checks the exact model ID given in `ANTHROPIC_MODEL`.

```bash
# Use your provider's Anthropic-compatible base URL.
export ANTHROPIC_BASE_URL='https://api.deepseek.com/anthropic'
export ANTHROPIC_MODEL='deepseek-flash'

# Enter the key without printing it in the terminal or saving it to shell history.
read -rs -p 'API key: ' ANTHROPIC_API_KEY; echo
export ANTHROPIC_API_KEY

node scripts/verify-live-provider.mjs /path/to/installed/agent-cil
unset ANTHROPIC_API_KEY
```

The script uses a temporary workspace. It first verifies live streaming, then asks the selected model to `Read` a buggy `math.js`, apply an `Edit` and `Read` it again. It verifies **actual file contents** and confirms both reads and one edit in tool events. Headless Bash remains denied. It has a 120-second timeout per request, output limits, and key redaction.

This procedure targets the **official** DeepSeek endpoint and model. Do not transmit credentials to an unrelated API gateway. Official documentation: https://api-docs.deepseek.com/zh-cn/ (API configuration) and https://api-docs.deepseek.com/zh-cn/updates/ (October 17 V4.1 Flash update).

## Evidence levels

1. `packages/runtime/test/deepseek-model-config.test.js` verifies that the adapter sends the user-specified alias, Anthropic-compatible URL path and protocol headers using a **local deterministic fake fetch**, without credentials.
2. Existing GitHub CI builds and installs the real npm package and verifies streaming, tools, permissions and developer tasks against **local fixture servers**.
3. Only a successful run of `scripts/verify-live-provider.mjs` against a credentialed, reachable provider counts as a **live model acceptance test**. It has not been run automatically in CI.

Never print, upload, or persist the key when reporting success or failure. Replace keys that have been shared in chat or logs.

## Recorded live acceptance: PR #25 (2026-10-23)

- Branch: `fix/deepseek-thinking-stream`.
- Tested commit: `562bfb674e4791b51955c454e758c5c907855061`.
- Environment: Windows, Node.js `v24.13.1`.
- Endpoint: `https://api.deepseek.com/anthropic`.
- Model: `deepseek-flash`.
- The API key was supplied only through the validation child process environment and is omitted from this record.

Running `node scripts/verify-live-provider.mjs ./packages/cli/src/index.js`
unchanged on Windows failed with `spawn EFTYPE` before any model request.
For this run, a temporary copy of the validation script changed only
`spawn(executable, args, ...)` to
`spawn(process.execPath, [executable, ...args], ...)`, passing the absolute CLI
entrypoint path. All prompts, model parameters and acceptance assertions were
unchanged. The temporary copy was removed after the run; the checked-in
validation script was not changed.

The live validation exited with status **0** and reported:

```text
PASS: credentialed streaming response from selected model.
PASS: live Read -> Edit -> Read coding task, workspace content verified.
```

The second check verified that the temporary `math.js` contained the expected
addition implementation and that tool events included at least two `Read`
calls and an `Edit` call. The test workspace was removed by the script.

At the same tested commit, `npm test` exited with status **0**:
206 tests total, 199 passed, 7 skipped and 0 failed. The Windows command above
still requires a Node-based child-process launcher; this record captures the
successful provider validation with that execution-only adaptation.

## Permanent Windows launcher fix (PR #25 follow-up)

`scripts/verify-live-provider.mjs` now launches explicit `.js`, `.cjs` and `.mjs` CLI entrypoint paths via `process.execPath` (Node.js), rather than asking Windows to spawn the script directly. This fixes the prior `spawn EFTYPE` with the unmodified verification script. Other executable commands retain direct invocation; `shell:true` is deliberately not used, so the free-form prompt never passes through a shell.

The original **live-provider acceptance** above remains attributed to the tested commit `562bfb6` and its temporary Windows-only launch adjustment. The permanent fix has a separate credential-free, cross-platform regression `packages/cli/test/live-provider-launch.test.js`: it starts the actual validation harness pointing at the Node CLI entrypoint, drives a local SSE model through `Read → Edit → Read`, checks tool history, final file contents via the harness, and exits successfully. CI runs that regression on both Ubuntu and a `windows-latest` GitHub runner. These fixture tests do **not** constitute a second credentialed DeepSeek acceptance.
