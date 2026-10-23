# Credentialed DeepSeek V4.1 acceptance — 2026-10-23

Base: latest `origin/main` at `52712a77` (full SHA available in Git history).
Environment: Windows / PowerShell / ConPTY, Node.js v24.20.0.
Model: `deepseek-flash`, official DeepSeek V4.1 Flash alias per
https://api-docs.deepseek.com/zh-cn/updates/ (2026-10-17 update).
Endpoint: `https://api.deepseek.com/anthropic`.
Credentials were inherited through `DEEPSEEK_API_KEY`; no key, request headers,
reasoning text or signature values are saved in these artifacts.

## Live results

- Existing harness, unmodified: `AGENT_CIL_PROVIDER=deepseek node scripts/verify-live-provider.mjs ./packages/cli/src/index.js`:
  PASS streaming and actual Read → Edit → Read file verification, both before and after the compaction fix.
- Extended harness: `node scripts/verify-deepseek-extended.mjs`: PASS.
  Uses the existing production adapter, AgentLoop, builtin CLI tools and permission
  policy. No fixture server or fabricated provider responses. Four user turns read
  four ~72 KB diagnostic files; a fifth user turn performs Read → Edit → Read → Bash.
  Actual math.cjs content is checked, the Node assertion returns successfully, and
  an append-only execution marker contains exactly one line. One Edit and one Bash
  executed. The final response retains `ORCHID-741` from earlier notes.
- 17 real HTTP requests, all HTTP 200; peak request body 77,512 bytes. 13 thinking
  blocks, four with nonempty reasoning, all with 36-character signatures.
  Outgoing retained thinking blocks/signatures match prior received blocks exactly.
- Four automatic compactions (estimated tokens): 47,824 → 24,315;
  48,274 → 24,404; 48,387 → 24,482; 24,838 → 944.
  Controlled threshold 6,000 exercises the real summarization path without sending
  a near-million-token conversation. The default 850,000 threshold at production
  scale is **not verified**.
- Peak provider-reported input plus cache-read input: 16,800 tokens.
  Raw usage event snapshots are retained in the accompanying JSON; start and final
  usage snapshots must not be summed, and compaction sampling usage is not emitted
  through the query usage listener. These are not billing totals.
- Windows interactive CLI: startup succeeded, Bash requested approval, `y` allowed
  `node -e "console.log(741)"`, exit code 0 and stdout 741. In a separate real
  headless call, `--allow-edits` still denied Bash and returned denial to the model.
- Real Windows ConPTY Ctrl+C during a live response initially failed to cancel.
  After the readline fix it printed `Interrupted by user` / `Interrupted`, returned
  to `you>`, answered `RESUMED` on the next user turn, and `/exit` exited 0.

## Problems found and fixes

1. Proactive compaction could repeat immediately while protected recent rounds
   dominated context, then abort a healthy task with “Summary did not sufficiently
   reduce context size.” Skip proactive sampling when the retained suffix alone
   exceeds the 80% reduction bound. Forced HTTP-overflow recovery remains unchanged.
   The new regression verifies intact history, no summary request, no failure count,
   and a forced attempt still taking the recovery path.
2. readline consumes raw TTY Ctrl+C and emits its own SIGINT, whereas the CLI only
   listened on process. Forward the interface event to the existing abort handler
   and remove the listener during cleanup. Live Windows interruption and subsequent
   conversation were verified as above.
3. Four Windows tests failed because this account lacks file-symlink privilege.
   Probe capability and skip only those tests on Windows EPERM. Other errors still
   fail; hosts with symlink permission still run the assertions.

## Full suite and limits

`npm test` after all runtime/CLI fixes: **262 total, 249 passed, 13 skipped,
0 failed, 0 cancelled**. Nine pre-existing platform skips plus four capability
skips on this Windows account. Symlink race protection is not verified locally.
`git diff --check`: PASS.

**Not verified live:** genuine provider context-overflow HTTP 400 and subsequent
safe recovery; transport retries; no duplicate Edit/Bash during such retries.
The successful live run had no HTTP rejection or transport retry. Existing
deterministic recovery, signature preservation and replay tests passed as part
of the suite; they are separate evidence and are not called real API acceptance.
No claim is made that overflow recovery was exercised against DeepSeek.

Structural live evidence: [deepseek-live-2026-10-23.json](deepseek-live-2026-10-23.json).
The unsuccessful initial extended run had one successful compact followed by the
reduction-bound error; it motivated fix 1. The checked-in JSON is the successful
rerun with that fix. No Runtime was rewritten.


## Post-acceptance source review (subsequent PR #31 commits)

The credentialed results above were collected at `5aad518c3a7d22234c35c0e47809275a072b5f79`. **They have not been rerun against the later review commits** and should not be used as proof of the revised source behavior.

The review directly compared the restored CLI 2.1.88 `autoCompactIfNeeded`, `query.ts`, `compact.ts`, `useCancelRequest.ts`, `useExitOnCtrlCD.ts` and `useDoublePress.ts` with the runnable Node CLI. It corrected two gaps: proactive compaction failures must be logged and ignored (subject to a 3-failure circuit breaker), while a forced provider-overflow recovery still reports failure; and Ctrl+C must cancel active work but require two presses within 800ms to exit the idle interactive CLI. A new Linux pseudo-TTY CLI test covers interrupted SSE, continued conversation and idle exit; CI also tests the installed npm package on Linux and startup/Read/Edit on Windows.

The uploaded 2.1.304 ZIP was not source-inspected in this review due to its size exceeding available artifact extraction access. As a result **exact new-version behavior equivalence is not yet demonstrated**. The PR remains open.

For credentialed re-acceptance of the revised branch (local-only secret, no credentials committed):

```powershell
$env:DEEPSEEK_API_KEY = '<secret from secure local environment>'
node scripts/verify-deepseek-extended.mjs
```

The script outputs structural metadata only. Inspect and redact it before saving any additional evidence. Required checks: real automatic summary failures do not abort a healthy run; active Ctrl+C interrupts once and leaves the interactive CLI usable; idle Ctrl+C only exits on double press; signed tool turns, file edits and Bash execution remain correct. Real HTTP 400/retry/no-duplicate-Edit/Bash and default 850k threshold remain explicitly unverified unless independently exercised.
