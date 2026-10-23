# CLI 2.1.88 核心源码移植门槛（2026-10-23）

本文件记录实际源码核查和可执行验收结果，不把 `legacy/` 里的代码展示或拷贝视为运行时移植完成。开发目标为 **自有 Agent CLI**；旧版 **2.1.88** 是实现基线，新版 **2.1.304** 是行为对照目标。不涉及 Desktop UI。

## 0. 当前 CLI 的安装验收

PR #13 在原有多轮 CLI/本地 SSE/文件操作集成测试上增加：

1. 用 `npm pack --ignore-scripts` 构建真实 npm 安装包，在独立目录安装；
2. 检查安装后的 `node_modules/.bin/agent-cil` 能运行 `--version` 和 `--help`；
3. 通过安装后的命令发出流式模型请求（本地 HTTP/SSE fixture），执行 `Read`，将对应 `tool_result` 回传第二次模型调用，成功输出并退出 0。

验收直接发现 npm 符号链接启动时入口判断失效。已改为使用真实路径识别可执行入口，并增加 symlink 回归测试。CI #39891647938 为 **121/121 通过**，打包安装验收也通过。

**未通过的验收门槛：** 由于执行环境没有 `ANTHROPIC_API_KEY`，尚未向真实 Anthropic 服务完成流式响应、工具多轮和错误传播的验收。不能将本地 SSE fixture 称为真实模型验收。完成前不宣布 CLI 2.1.304 兼容。

## 1. 源码来源与实际调用链

依据两个已存在的源码资产：

- PR #12 的 `legacy/2.1.88/restored-src` 是从旧仓库移入的**局部原始路径快照**，包含 8 个主要 TS/TSX 源码文件以及原始 package 元信息等；它尚不具备独立构建能力。
- 用户上传的 `claude-agent-reverse-kit-desktop-3.1623.1-cli-2.1.304.zip` 中的 `reference-2.1.88/restored-src/src/` 含更多依赖源码，可用于恢复实际依赖闭包。不得只依赖 PR #12 的局部快照猜测导入关系。

旧版调用链（已由原文件代码定位）：

```text
src/query.ts:query() / queryLoop()
  -> buildQueryConfig + 模型流消息处理 / 流恢复 / compact / stop hooks
  -> StreamingToolExecutor.addTool() [配置允许流式执行时]
  -> StreamingToolExecutor.getCompletedResults()/getRemainingResults()
  -> runToolUse() in services/tools/toolExecution.ts
  -> streamedCheckPermissionsAndCallTool()
  -> canUseTool() from hooks/useCanUseTool.tsx
  -> PermissionContext / coordinator, interactive, swarm handlers
  -> 工具调用 -> Message / tool_result -> query() 下轮
```

当前运行链：
`packages/cli/src/index.js -> AnthropicMessagesAdapter.stream -> AgentLoop.run -> ToolRegistry / permissionPolicy / approvalHandler -> tool_result`。它**没有加载**旧版的 `query.ts`、`StreamingToolExecutor.ts` 或 `toolExecution.ts`。

## 2. 逐模块判断

### A. `src/query.ts`（1729 行，43 个静态直接导入）

**结论：现在不能直接替换 `AgentLoop.run()`；但它仍是长期优先的目标实现，不应被当作只读参考。**

已确认依赖：`src/services/api/withRetry`、消息/附件与模型类型、compact/自动压缩、token 预算、Hook、session/消息队列、`StreamingToolExecutor`、`runTools`、配置和 transition state，以及 `bun:bundle` 的 feature gate。公开接口是 `async function* query(...)`，接收 `QueryParams`（包括 systemPrompt、userContext、systemContext、canUseTool、toolUseContext、querySource、deps 等），并非当前 `model.stream({messages, tools, signal})` 事件契约。它依赖运行前的配置与状态管理。

**最小前置条件：** 先实现/移植消息与工具调用边界，以及 `QueryDeps` 中实际需要的模型请求和配置依赖；隔离 Bun feature gates；在 Node 22 中可编译、可运行；以同一个 fixture 比较多轮消息顺序、停止条件、工具拒绝/错误回填和取消。之后才能切换 CLI 入口。暂不覆盖现有 `AgentLoop`。

### B. `services/tools/StreamingToolExecutor.ts`（530 行，8 个静态直接导入）

**结论：具备实际移植价值，适合作为第一个完整工具调度替换候选；目前还不能无修改地直接载入。**

成熟行为：`queued/executing/completed/yielded` 状态流转；只并发运行 `isConcurrencySafe` 的工具；非并发工具独占执行；按工具接收顺序回传结果；即时 progress；流 fallback 的 `discard()`；Bash 失败时对子工具的协同中断和 synthetic tool_result；用户中断行为控制。主要边界是 `ToolUseContext`、`Tool.ts` 的工具元信息、`createUserMessage`、`createChildAbortController`，以及 `runToolUse()`。

**编译阻断：** 最关键的 `runToolUse` 来自约 1745 行的 `toolExecution.ts`，它再依赖权限、Hook、MCP、工具注册、Bun feature gate 和 UI 相关逻辑。`Tool.ts` 本身还依赖 Zod、MCP types 与多种 AppState。孤立在 Node 22 TypeScript 环境下对原始 executor 运行 `tsc --noEmit --noResolve --module NodeNext --moduleResolution NodeNext --target ES2022`，返回退出码 2，报 SDK 类型、`src/` 路径别名、TSX 配置、`Tool.ts`、`toolExecution.ts` 等 8 个直接导入错误；这**不是**完整仓库编译失败统计，只确认当前孤立模块不能直接编译。

**移植门槛：** 在不重写调度算法的前提下，先接通 `runToolUse`/权限适配边界及消息类型；保持原 `StreamingToolExecutor` 的队列/并发/取消主体；先在隔离的真实 Node 可运行目标里做新旧对照，再让 `AgentLoop` 使用它。并发行为可能改变现有执行顺序，必须测试 Write/Edit/Bash 的互斥、多个 Read 的并发、结果顺序、拒绝、取消、fallback 和 Bash 子进程收尾。

### C. 权限执行模块（`toolExecution.ts`、`useCanUseTool.tsx`、`PermissionContext.ts`）

**结论：应优先恢复权限判定与执行语义，但不能直接把 React/Ink Hook 当作 headless CLI 运行时代码加载。**

核心路径为 `runToolUse -> streamedCheckPermissionsAndCallTool -> canUseTool -> PermissionContext -> checkPermissionsAndCallTool / 实际工具调用`。已有行为包括 `allow/deny/ask`、`updatedInput`、审批队列、策略持久化、取消和结果回填。`useCanUseTool.tsx` 约 203 行、直接导入 26 个模块；`PermissionContext.ts` 约 388 行、直接导入 18 个模块；`toolExecution.ts` 约 1745 行、直接导入 43 个模块。依赖 `react/compiler-runtime`、`bun:bundle`、权限 UI 组件、AppState、工具 schemas、MCP、Hook 和 telemetry。仅把这些文件复制到 `packages/runtime` 不会得到可运行权限链。

**最小前置条件：** 保留老代码的权限决策/结果契约，先将 UI 审批交互替换为已有 CLI approval handler；为 `ToolUseContext`、权限规则、schema 校验、持久化回调和 abort 信号明确适配接口；在独立运行路径中验证之后，才替换当前 `AgentLoop.#executeTool`。不能退化 PR #9 已实现的 `updatedInput` schema 二次校验、再授权、终态 deny 和 fail-closed 行为，也不能绕过 PR #13 工作区内文件安全边界。

## 3. 下一阶段唯一的集成顺序

1. **真实模型验收先于替换：** 在具有有效凭证的隔离工作区运行安装后的 CLI，验收模型流、Read→Edit→Read 的真实调用、默认审批拒绝、429/503 错误和 Ctrl+C；记录命令、退出码、文件副作用和模型标识（不记录凭证）。如无凭证，明确标注“未验收”，不要假装通过。
2. **权限执行边界先编译并运行：** 恢复旧 `PermissionDecision` 和 `runToolUse` 所需的最小完整依赖路径；先用适配层连接现有 CLI，而不是重写一个相似的权限引擎。
3. **接通原 `StreamingToolExecutor` 主体：** 测试其并发、排队、结果排序、取消和权限拦截；确认稳定后替代自建顺序执行器。
4. **最后迁入 `query.ts`：** 在已有工具/权限链上恢复 query 配置、模型与消息适配、stop/compact/恢复，再切换 CLI 入口。

每个模块都要单独具备 **编译通过 → 独立运行通过 → 与现有行为对照测试通过 → 集成真实 CLI 通过 → GitHub PR/CI 通过** 的证据，才允许删除/替换对应自建实现。失败时保留旧实现并继续修依赖，不通过大规模重写绕过原代码。

## 4. 状态边界

- `query.ts`：依赖及调用链已审查；**未移植/未编译通过**。
- `StreamingToolExecutor.ts`：队列和执行链已审查，做了孤立编译尝试；**未接入运行链**。
- 权限执行模块：权限入口、审批上下游已审查；**未接入运行链**。
- 已安装 CLI：本地 SSE 模拟环境安装验收通过；**真实 Anthropic API 未验收**。

源码原件及原始声明保留在原有资产中；实际移植时仍需核对所适用的发布代码许可和必要版权声明。
