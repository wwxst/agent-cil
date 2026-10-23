# Agent CIL

自有 Agent CLI 项目。旧版 CLI 2.1.88 是实现参照，新版 CLI 2.1.304 是功能与行为升级目标。优先复用旧仓库中已有的 package 发布代码和 restored-src 恢复源码，按模块迁入、修复依赖、补齐新版差异并验证；不从零重建通用 Runtime。

**当前只开发 CLI，不开发前端或 Desktop UI。** Desktop 与 SDK Wrapper 仅用于确认 CLI 的调用边界和协议契约。

## 版本基线

| 样本 | 版本 / 范围 |
| --- | --- |
| 新版目标 CLI | 2.1.304 |
| 新版 Desktop SDK Wrapper（仅作边界参考） | 0.3.304 |
| 旧版实现参照 | CLI 2.1.88 |

## 核心调用链

```text
CLI entry / args / config
  → user input
  → model streaming request
  → assistant text + tool_use
  → permission decision / approval
  → tool execution
  → tool_result appended to history
  → next model turn or final response
```

官方 CLI 与 Desktop SDK Wrapper 是不同组件。当前先实现独立 CLI 的可用闭环；不把 Desktop IPC、图形界面或平台宿主集成当成交付前置条件。

## 当前实现

- [x] JSONL 编解码、控制请求关联、子进程 transport 和 Query 生命周期原型
- [x] 自有 AgentLoop、ToolRegistry、参数校验、权限决策与 Messages SSE adapter
- [x] 第一版可执行 CLI：参数/模型配置、流式与多轮对话、Read/Write/Edit/Glob/Grep/Bash 基础工具（见 [PR #13](https://github.com/wwxst/agent-cil/pull/13)）
- [ ] 对齐官方 CLI SDK stream-json 输入输出及真实宿主控制协议
- [ ] 完成权限 updatedInput、取消和错误传播的新版行为核对（见 [PR #9](https://github.com/wwxst/agent-cil/pull/9)）
- [ ] 完善 Session 恢复与 MCP；只有核心功能需要时才提前推进

## 代码入口

- [CLI 使用与当前限制](packages/cli/README.md)
- [协议层](packages/protocol/README.md)：JSONL、控制请求关联、子进程通信和 Query 生命周期。
- [Runtime](packages/runtime/README.md)：AgentLoop、模型流适配、工具注册、校验、权限和 Session 原型。
- [旧版核心源码迁入 PR #12](https://github.com/wwxst/agent-cil/pull/12)：保留旧版入口、Query、工具调度与权限处理的原始路径，作为后续逐模块升级依据。
- [旧版/新版 Agent Loop 对照](docs/reverse-engineering/agent-loop-comparison.md)
- [工具执行对照](docs/reverse-engineering/tool-execution-comparison.md)
- [版本与证据基线](docs/reverse-engineering/baseline.md)
- [协议契约](docs/reverse-engineering/protocol-contracts.md)

## 安装与运行

要求 Node.js 22 或更高版本。

```bash
npm link
export ANTHROPIC_API_KEY="..."
agent-cil --model claude-sonnet-4-5
```

单次调用：

```bash
agent-cil --print "Summarize this repository"
cat question.txt | agent-cil --print
```

第一版通过 `ANTHROPIC_API_KEY`、`ANTHROPIC_MODEL` 和 `ANTHROPIC_BASE_URL` 配置模型；远程 API 地址必须使用 HTTPS，本机 loopback 开发地址允许 HTTP；写文件、编辑文件和执行命令需要交互式批准，非交互模式默认拒绝这些操作。文件工具会检查路径越界及真实路径解析结果，直接指向符号链接的目标会被拒绝，搜索工具不会遍历符号链接条目。它还不支持官方 CLI 的 OAuth、完整配置系统、SDK stream-json、MCP、Session resume 或全部高级工具。

## 开发与验证

```bash
npm test
```

测试包含协议帧、流式 SSE、Agent Loop 多轮工具回填、权限与 schema、Session 原型，以及 CLI 参数、版本快路径、文件操作、搜索、符号链接越界保护和基于本地 SSE 服务的 CLI 端到端工具回填/非交互权限拒绝验证。

模拟模型与模拟工具只能证明对应的确定性行为。真实模型请求仍需配置有效凭证；没有执行真实请求时，不宣称完成端到端兼容验证。

## 旧版源码的使用方式

旧仓库中的 package 与 restored-src 是本项目的重要研究和实现资产。按实际模块需要复用、迁入和修改，优先继承成熟实现；不必无差别复制整个恢复树，也不应只看函数名就判断理解了调用链。每个迁入模块都要追踪上下游、依赖、状态和错误/取消路径，再通过测试确认行为。

所有开发改动通过独立分支和 PR 提交到 [agent-cil](https://github.com/wwxst/agent-cil)。本项目不开发前端或 Desktop UI。

## 参考仓库

- [旧版 CLI 2.1.88 源码](https://github.com/wwxst/-)
- [新版逆向资料与 CLI 2.1.304 证据](https://github.com/wwxst/agent-cil)
- [既有 Agent Desktop 项目（仅作边界参考）](https://github.com/wwxst/agent-desktop)
