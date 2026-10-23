# CLI 入口与启动分流：2.1.88 / 2.1.304 / agent-cil

## 范围与证据等级

本记录来自上传的 2.1.304 静态提取模块，以及公开仓库 `wwxst/-` 中固定的 2.1.88 恢复源码。本文件的入口对比来自静态源码；之后 PR #11 已在 CI 隔离验证旧版 2.1.88 发布产物的版本快路径，但未读取凭证或发起真实模型请求。

- **已证实（静态）**：源码位置与控制流可以直接定位。
- **已证实（自有代码）**：可直接从 agent-cil 当前代码确认。
- **尚未动态验证**：需要在隔离、无凭证环境中实际运行才能确认。
- **未发现**：只表示所检查的文件中没有看到，不证明整个程序都不存在该行为。

## 1. 旧版 CLI 2.1.88

主入口：`wwxst/-/restored-src/src/entrypoints/cli.tsx`。

| 位置 | 输入/动作 | 控制流结果 | 证据 |
| --- | --- | --- | --- |
| 第 33 行起 `main()` | 读取 `process.argv.slice(2)` | 进入轻量入口函数 | 已证实 |
| 第 36–41 行 | 参数仅为 `--version`、`-v` 或 `-V` | 打印版本后直接返回，不动态加载其他模块 | 已证实 |
| 第 44 行以后 | 非版本路径 | 动态导入 `startupProfiler`，随后继续处理常规启动 | 已证实 |
| 后续入口分支 | 特殊子命令（例如 MCP/native host） | 动态导入相应功能模块并返回 | 已证实 |
| 文件末尾第 302 行 | 模块执行 | 调用 `void main()` | 已证实 |

入口文件在 fast path 之前也有顶层环境变量修改；因此“version fast path 不动态导入其他模块”不等于“整个进程在执行入口前完全没有副作用”。

旧版发布包元数据位于 `wwxst/-/package/package.json`，标记 `@anthropic-ai/claude-code@2.1.88`、`bin: cli.js`、Node.js `>=18`。但 `restored-src` 没有独立 package/build 配置，不能将其认定为可从恢复源码重建的工程；随后已在 PR #11 中隔离运行发布包的版本快路径。

## 2. 新版 CLI 2.1.304

入口：上传资料包中的 `cli-2.1.304/modules/cli`。以下 offset 是该提取文件的 0 基字符位置，不是源文件行号。

| 位置 | 输入/动作 | 控制流结果 | 证据 |
| --- | --- | --- | --- |
| `le()`，约 offset 953 | 调用 `process.cwd()` | 目录不可用时构造明确错误 | 已证实 |
| 顶层启动代码，约 offset 1,000 | 设置 `NoDefaultCurrentDirectoryInExePath`、`COREPACK_ENABLE_AUTO_PIN`；在 remote 环境调整 `NODE_OPTIONS` | 环境预处理先于启动函数 | 已证实 |
| `pe()`，约 offset 1,585 | 检查 debug 类参数 | 为后续模式分流提供判断 | 已证实 |
| `Ge()`，约 offset 1,926 | 从参数中分离 permission mode、model、effort、agent、bypass 相关 dispatch defaults | 剩余参数交给主参数解析 | 已证实 |
| `Ve()`，约 offset 2,602 | 处理 relay-token/session-tunnel guard、启动预检与参数校验 | 进入版本或常规启动分支 | 已证实 |
| 版本分支，约 offset 3,000 | 单独的 version 参数，或 version 加 `--verbose` | 输出 `2.1.304 (Claude Code)`；verbose 分支还输出构建 commit | 已证实 |
| `Zht(e)`，约 offset 14,225 | 常规参数解析 | 组合受限配置与 dispatch defaults，选择后续运行模式 | 已证实 |
| 主模块加载，约 offset 25,145 | 动态导入 `chunk-9b0nx8jt.js` 并调用 `main(s)` | 进入主 CLI 功能模块 | 已证实 |

新版与旧版在入口的明确差异：

1. 新版版本分支允许附带 `--verbose`；旧版入口只在参数恰好是单个版本 flag 时走该分支。
2. 新版在版本输出前可见 relay-token guard、启动预检与参数验证；旧版 `main()` 的版本分支位于 profiler 动态导入之前，但该文件顶层环境处理已经执行。
3. 新版入口有显式 cwd 可用性检查，并在常规路径分离 dispatch defaults；旧版入口文件未见同样的入口级 cwd 检查或这套参数预分离。不能据此断言旧版其他模块没有相关校验。
4. 两版都保留轻量入口和按需动态导入的启动策略；这属于结构延续，不代表所有启动行为相同。

## 3. 当前 agent-cil 的对应实现（2026-10-23）

当前 `main` 已包含可执行 npm bin `agent-cil`，入口位于 `packages/cli/src/index.js`（PR #13）。它支持 `--version`、`--help`、`--model`、`--base-url`、`--max-tokens`、`--cwd`、`--print`、TTY 多轮会话，以及 Read、Write、Edit、Glob、Grep、Bash 工具；缺少凭证时版本/帮助仍可通过轻量快路径执行。

实际调用链为 `CLI → AnthropicMessagesAdapter (Messages SSE) → AgentLoop → StreamingToolExecutor → runToolUse → 执行前校验 → 权限决策与工具调用 → tool_result`。权限更新输入后二次校验由 #9 提供；已合并的 #14–#18 将旧版成熟逻辑的可运行子集接入上述链路，并以回归测试约束调用顺序、并发、取消和授权行为。

`packages/protocol/` 的 Query JSONL 与子进程传输仍属原型；直连 Messages SSE **不是**官方 CLI 的 SDK `stream-json` 契约，尚未宣称对应兼容性。也未宣称 2.1.304 全量功能已经移植。

## 4. 验证边界与下一步

- **已验证**：#11 的旧版固定 bundle 版本快路径；当前 CLI 的 npm pack 安装、版本/帮助、Node 测试、语法，以及本地 SSE 服务的多轮工具调用和权限拒绝场景。
- **未验证**：真实托管模型的凭证请求；旧版完整常规启动与源码重建；官方 SDK stream-json 完整交互协议。
- **开发策略**：继续对照旧版 `query.ts`、`toolExecution.ts` 及新版 2.1.304 的真实链路，优先移植已获授权、可编译、可验证的成熟实现。Session/MCP 依核心 CLI 需要推进，不开发前端或 Desktop UI。
- **版权边界**：复用源码需先核实权利与再分发条件，保留必要声明；#12 的原始源码切片尚未通过这项合并审查。
