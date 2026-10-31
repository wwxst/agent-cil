# Agent CIL

自主开发的命令行 Coding Agent，使用旧版 CLI 2.1.88 的成熟源码作为基础，逐项对照 CLI 2.1.304 升级。**只开发 CLI 和终端交互，不开发 Web / Desktop UI。**

> **实现状态：** 已有可执行 CLI、AgentLoop、文件工具、Bash、权限与会话组件；当前分支正恢复原版 Ink 终端交互。完整的 2.1.304 行为对齐及真实 Provider 多平台验收尚未结束，不应宣称生产稳定。

## 运行环境

Node.js 22 或更高版本。首先安装依赖：

```bash
npm install
npm link
```

根据所选 Provider 设置 API 密钥，例如 `ANTHROPIC_API_KEY`、`DEEPSEEK_API_KEY` 或 `OPENAI_API_KEY`（密钥只放在环境变量，勿作为 CLI 参数提交）。

```bash
agent-cil
agent-cil --print "Read the repository and summarize its architecture"
agent-cil --help
```

直接使用源码入口：`npm start` 或 `node packages/cli/src/index.js`。

## 终端交互

- 默认使用从原版 2.1.88 移植的 **Ink 终端界面**，支持流式输出、会话历史输入、工具消息、交互式权限审批、Ctrl+C 中断。
- 支持简体中文和英语：`/language zh-CN`、`/language en`，也支持 `--language`。
- `/model` 查询或切换当前模型；会话模型变更按原有 Journal 路径持久化。
- `/exit` 或 `/quit` 退出。
- 若终端不兼容 Ink，可以显式将环境变量 `AGENT_CIL_TUI=readline` 设为 `readline`，保留原本经过测试的 readline 交互。这不是另一套 Agent 内核；两种终端共用 AgentLoop、权限策略、模型配置和会话日志。

## 核心结构

| 目录 | 用途 |
| --- | --- |
| `packages/cli/` | 启动参数、真实命令行入口、交互式 Ink TUI 与 CLI 验证 |
| `packages/runtime/` | 原版调用链移植：模型流、多轮工具、权限与审批、取消和恢复 |
| `packages/protocol/` | 协议、JSONL 与子进程控制 |
| `legacy/2.1.88/` | 旧版源码基线与来源/许可记录 |
| `scripts/` | 源码生成、一致性检查与真实安装验证 |
| `docs/` | 中文项目说明、V2 目标设计与质量验收文档 |

## 测试与准入

```bash
npm test
```

核心修改还需验证真实安装后的 CLI、Linux PTY、Windows ConPTY、读写与 Bash 副作用、权限拒绝、审批后复验、中断清理、会话恢复与输出持久化。GitHub PR 的 CI 结果必须对应**当前提交**；历史绿色 CI 不能代表新修改已通过。

**不要自动合并开发 PR。** 旧版 2.1.88 与新版 2.1.304 的真实行为差异仍需逐项核对，不用设计报告或测试数量替代真实任务验收。

## 项目文档

[项目概览](docs/项目概览.md) · [实施路线图](docs/实施路线图.md) · [验收标准](docs/质量/验收标准.md) · [验证状态](docs/质量/验证状态.md) · [许可证与来源说明](docs/许可证与来源说明.md)

根目录许可证不改变 `legacy/` 内的原始来源及版权声明。
