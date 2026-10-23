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
