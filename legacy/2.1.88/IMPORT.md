# CLI 2.1.88 source baseline

Imported from `wwxst/-` at pinned commit `57d4d4d05121f84601af119091455832d37de5df`.

This is the first core-source slice, copied verbatim while preserving original relative paths. It is not the complete 4,471-file restored tree and is not yet a standalone build.

## Imported core paths

- `restored-src/src/entrypoints/cli.tsx` — CLI startup and command dispatch.
- `restored-src/src/query.ts` — query/turn loop, model stream consumption, message history, tool executor integration, and continuation/compaction branches.
- `restored-src/src/Tool.ts` — tool definitions, lookup, context and permission types.
- `restored-src/src/services/tools/StreamingToolExecutor.ts` — streaming tool queue, concurrency-safety gating, ordered result delivery, and cancellation/error behavior.
- `restored-src/src/services/tools/toolExecution.ts` — permission checks, input normalization, tool invocation, and result generation.
- `restored-src/src/hooks/useCanUseTool.tsx` — allow/deny/ask decision handling and interactive approval flow.
- `restored-src/src/utils/permissions/PermissionMode.ts` and `PermissionResult.ts` — permission contracts.
- `package/` — original package metadata and package README/license notice.

## Build boundary

The restored files retain imports such as `bun:bundle`, source aliases, SDK types, UI/Ink components, hooks, and other modules that are not all included in this slice. Therefore this commit does not claim the source slice builds on its own.

The next migration step is to use these real implementations to port one complete core path at a time, resolving its dependency closure and testing observable behavior before changing the executable runtime. Existing `packages/runtime` code remains active until a migrated path is runnable and validated.
