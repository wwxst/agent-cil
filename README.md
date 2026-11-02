# Agent CIL

> 自有 Agent CLI 项目。以旧版 CLI 2.1.88 成熟源码为实现基础，以新版 CLI 2.1.304 为升级目标。

本仓库包含可执行的 CLI、Runtime、Protocol、测试、构建脚本和旧版源码参照，不是纯文档仓库。

## 项目范围

- 只开发 Agent CLI 及其命令行终端交互体验。
- 不开发 Web 前端或 Desktop 应用。
- 命令行终端 TUI 属于 CLI 本身；必须接入真实 AgentLoop、权限审批、工具执行、会话和取消链路，不能只是独立展示层。
- 优先直接复用旧版 2.1.88 的成熟源码，按新版 2.1.304 的真实差异逐项升级。

## 版本基线

| 样本 | 用途 |
| --- | --- |
| CLI 2.1.88 | 成熟实现与调用链基线 |
| CLI 2.1.304 | 功能和行为升级目标 |

## 开发原则

1. 保留原有方法名、类名和核心调用链；先修复依赖，再移植和接入真实运行链。
2. 每项升级都对照旧版、新版和当前实现，核实正常执行、权限、中断、异常恢复、工具状态、结果保留和资源清理。
3. 不以代码量、文档或单元测试数量代替真实可用性；关键功能必须经过真实 CLI 验证。
4. P0/P1 优先，完成后更新测试和 PR；不自动合并未经验证的改动。

## 代码结构

- `packages/cli`：CLI 启动、交互、配置、会话和终端入口。
- `packages/runtime`：AgentLoop、模型流、工具注册、权限、Bash、文件操作和会话运行时。
- `packages/protocol`：JSONL、控制请求、子进程传输和 Query 生命周期。
- `legacy/2.1.88`：旧版源码、恢复源码及来源/许可记录。
- `docs/`：V2 目标架构、设计契约和质量资料；这些设计文档不等于当前 CLI 已完成相应实现。

## 安装与运行

要求 Node.js 22 或更高版本。

```bash
npm install
npm test
npm link
```

配置模型凭证后启动：

```bash
export ANTHROPIC_API_KEY="..."
agent-cil --model claude-sonnet-4-5
```

单次调用：

```bash
agent-cil --print "Summarize this repository"
cat question.txt | agent-cil --print
```

## 当前状态

- 核心 CLI 代码从最后一个已确认全绿的核心提交恢复；该提交的 Runtime、Windows Live Harness、CLI 2.1.88 Smoke 三组 CI 均通过。
- 2.1.304 的完整行为对齐仍在进行，不宣称全部兼容或已达到生产稳定状态。
- Ink TUI 已接入真实 AgentLoop；Linux PTY 已验证 Markdown、12 轮历史滚动和输入，Windows ConPTY 已验证权限、历史滚动及中英实时切换。仍未完成真实外部模型的长时间 TUI 工程任务验收，不宣称生产稳定。
- 当前验证细节见[验证状态](docs/质量/验证状态.md)。

## 参考文档

- [项目概览](docs/项目概览.md)
- [实施路线图](docs/实施路线图.md)
- [质量验收标准](docs/质量/验收标准.md)
- [验证状态](docs/质量/验证状态.md)
- [来源与许可说明](docs/许可证与来源说明.md)


## 真实模型 TUI 验收（手动）

PR #63 增加了可选的真实 Provider 交互验收脚本。它会在临时工作区中启动真实 Ink TUI，要求模型通过 Read → Edit → Read 修复一个小文件，再执行第二轮交互读取与计算；结束后删除临时工作区。此脚本不会在 GitHub CI 中使用凭证。

先安装本机 PTY 适配器（不写入 package.json 或 lockfile）：

```bash
npm install --no-save --no-package-lock node-pty@1.1.0
```

Anthropic 示例：

```bash
export ANTHROPIC_API_KEY="..."
export ANTHROPIC_BASE_URL="https://api.anthropic.com"
npm run verify:live-tui
```

DeepSeek 示例：

```bash
export AGENT_CIL_PROVIDER=deepseek
export DEEPSEEK_API_KEY="..."
export DEEPSEEK_BASE_URL="https://api.deepseek.com/anthropic"
npm run verify:live-tui
```

Windows PowerShell 使用 `$env:ANTHROPIC_API_KEY="..."` 等环境变量语法。脚本只向子进程传递当前选择的 Provider 凭证，不打印密钥；请勿把密钥提交到仓库或 CI 日志。
