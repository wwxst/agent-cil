# CLI 2.1.88 TUI source import

This directory is a byte-for-byte source transplant from the pinned 2.1.88 reference commit recorded in [TUI-SOURCE-MANIFEST.json](./TUI-SOURCE-MANIFEST.json).

The import includes the original custom Ink renderer, terminal event/input/layout modules, REPL, prompt and text-input components, message rendering, permission prompts, and their primary state/utility entry points. Original file names and relative directory layout are retained.

This is a source-preservation step, not a claim that the imported tree is already executable inside agent-cil. The original source still contains Bun bootstrap/runtime imports and project-wide aliases. The next integration step must close those dependencies and connect the original REPL to agent-cil's AgentLoop, streaming events, permissions, session journal, and cancellation lifecycle without replacing the source UI with a simplified renderer.

The import manifest records each target Git blob SHA so CI can verify that the source snapshot has not been silently rewritten.


## Runtime compatibility boundary

The original Ink renderer has a small set of application-wide imports outside its renderer. Four additional utility modules (`envUtils.ts`, `semver.ts`, `fullscreen.ts`, and `stringUtils.ts`) are imported byte-for-byte from the same pinned 2.1.88 source commit and added to the integrity manifest. `stringUtils.ts` supplies the original full-width CJK digit normalization used by the 2.1.304 CustomSelect numeric shortcut. The adjacent `compatibilityFiles` are agent-cil adapters for bootstrap timing, debug/error sinks, environment access, clipboard child-process invocation, and the original early-input hook. They do not replace AgentLoop, permissions, sessions, or cancellation. The original source files remain unchanged.


The byte-for-byte upstream debug.ts and log.ts utility sources are retained under legacy/2.1.88/source-original/restored-src/src/utils/. The original import paths under restored-src/src/utils/ contain agent-cil runtime adapters so the original Ink/App source can run without importing Claude Code's unrelated bootstrap, telemetry, and diagnostics subsystems. Both the original snapshots and the adapters are hash-verified by the manifest.
