# Live DeepSeek / Anthropic-compatible acceptance

This is a **manual credentialed test**, not an automatic GitHub Actions run. Do not check an API key into the repository, issue tracker, source test, PR text or logs.

## Endpoint and model

- Official DeepSeek Anthropic-compatible base URL: `https://api.deepseek.com/anthropic`.
- Official documented V4.1 Flash alias: `deepseek-flash`.
- The user-specified `deepseek4.1flsh` is preserved exactly by the CLI but is **not** an ID in the official model list. It may belong to a third-party gateway. Ask the provider for the correct base URL or exact model ID rather than silently substituting one.

## Test an installed agent-cil

From the checked-out repository root, install the package separately or pass the already installed `agent-cil` executable. The script defaults to the `agent-cil` binary on PATH and checks the exact model ID given in `ANTHROPIC_MODEL`.

```bash
# Use your provider's Anthropic-compatible base URL.
export ANTHROPIC_BASE_URL='https://api.deepseek.com/anthropic'
export ANTHROPIC_MODEL='deepseek4.1flsh'

# Enter the key without printing it in the terminal or saving it to shell history.
read -rs -p 'API key: ' ANTHROPIC_API_KEY; echo
export ANTHROPIC_API_KEY

node scripts/verify-live-provider.mjs /path/to/installed/agent-cil
unset ANTHROPIC_API_KEY
```

The script uses a temporary workspace. It first verifies live streaming, then asks the selected model to `Read` a buggy `math.js`, apply an `Edit` and `Read` it again. It verifies **actual file contents** and confirms both reads and one edit in tool events. Headless Bash remains denied. It has a 120-second timeout per request, output limits, and key redaction.

If using the **official** DeepSeek API rather than a custom model alias, set `ANTHROPIC_MODEL=deepseek-flash`. If the key belongs to another API gateway, **replace the base URL with that gateway's documented Anthropic-compatible URL**; do not send credentials to an unrelated endpoint.

## Evidence levels

1. `packages/runtime/test/deepseek-model-config.test.js` verifies that the adapter sends the user-specified alias, Anthropic-compatible URL path and protocol headers using a **local deterministic fake fetch**, without credentials.
2. Existing GitHub CI builds and installs the real npm package and verifies streaming, tools, permissions and developer tasks against **local fixture servers**.
3. Only a successful run of `scripts/verify-live-provider.mjs` against a credentialed, reachable provider counts as a **live model acceptance test**. It has not been run automatically in CI.

Never print, upload, or persist the key when reporting success or failure. Replace keys that have been shared in chat or logs.
