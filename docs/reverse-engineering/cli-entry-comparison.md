# CLI 入口与启动分流：2.1.88 / 2.1.304 / agent-cil

## 范围与证据等级

本记录来自上传的 2.1.304 静态提取模块，以及公开仓库 `wwxst/-` 中固定的 2.1.88 恢复源码。没有执行第三方 CLI，也没有读取凭证或发起模型请求。

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

旧版发布包元数据位于 `wwxst/-/package/package.json`，标记 `@anthropic-ai/claude-code@2.1.88`、`bin: cli.js`、Node.js `>=18`。但 `restored-src` 没有独立 package/build 配置，不能将其认定为可从恢复源码重建的工程；本轮没有实际运行发布包。

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

## 3. 当前 agent-cil 的对应实现

当前 `main` 的 `package.json` 只有 `test`、`check` 脚本，没有 `bin` 字段；仓库也没有 `packages/cli`。现有实现是库模块：

- `packages/protocol/src/process-transport.js`：自有子进程 transport。
- `packages/protocol/src/query-session.js`：初始化屏障、输入门控和双向 control request 分发。
- `packages/protocol/src/query-lifecycle.js`：result / idle / requires_action 等生命周期观察。
- `packages/runtime/src/agent-loop.js`：adapter-driven Agent Loop。
- `packages/runtime/src/anthropic-messages-adapter.js`：直接模型 API 的 SSE adapter，不是 Claude Code CLI 的 SDK JSONL 协议。

因此当前 `main` 不能作为完整可执行 CLI 直接启动，也不能把 `AnthropicMessagesAdapter` 当作官方 `--input-format stream-json --output-format stream-json` 协议的替代品。此前的 PR #8 曾添加一个一次性 `--print` 入口，但它没有实现新版 SDK JSONL 契约，现已关闭且未合并；它不构成已交付 CLI 能力。

## 4. 结论与下一步

| 领域 | 当前结论 | 下一步 |
| --- | --- | --- |
| 旧版源码基线 | 恢复源码不能独立构建；发布 bundle 存在，但本轮未运行；代码授权未证明可宽松复用 | 在隔离环境对官方发布包做无凭证 fast-path smoke test；只记录行为，不复制代码 |
| 新旧 CLI 入口 | 轻量入口/动态导入结构延续；新版新增或扩展 preflight、cwd 检查、dispatch-defaults 分离 | 继续核实参数语义和启动失败的 stdout/stderr/退出码 |
| 当前自有 CLI | main 没有可执行 bin，也没有 SDK JSONL 输入输出主路径 | 等入口与协议行为对照充分后，再做一个有明确验收契约的 CLI 入口 PR |
| 当前代码优先级 | 权限更新输入差异已从新旧源码确认；PR #9 提出 schema 复验修正，尚未合并 | 先完成权限与工具执行语义；Session/MCP 暂停扩张 |

当前没有证据支持将恢复出来的 Claude Code 源码直接复制到自有产品。可复用的是经核实的行为契约与测试结论；代码复用需要另行确认授权。
