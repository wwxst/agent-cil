# Agent CIL

独立重建 Agent CLI。当前只开发命令行入口、Agent 执行链、工具/权限和必要的宿主协议；不开发前端 UI、Desktop 窗口或聊天界面。目标是将已确认的行为契约转化为可测试、可维护的自有实现，而不是搬运第三方发行包。

## 当前基线

| 样本 | 版本 / 范围 |
| --- | --- |
| Claude Desktop | 3.1623.1 |
| 内嵌 SDK wrapper | 0.3.304 |
| CLI build pin | 2.1.304 (win32-x64) |
| 旧版参考 | CLI 2.1.88 |

新版静态调用链：

~~~text
Desktop IPC / session manager
  → SDK Query / JSONL process transport
  → CLI agent loop
  → streaming model request
  → tool_use → permission / tool dispatch
  → tool_result → next round
~~~

CLI 负责 Agent 主循环、模型请求和工具调度；Desktop/SDK 负责进程与会话生命周期、双向控制回调、权限宿主桥接以及运行 target。Host、VM、SSH/WSL 是不同执行路径，不能假定它们共享相同启动方式。

## 仓库状态

- [x] 建立样本版本、架构、协议与阶段计划文档
- [x] 初步对照旧版与新版 Agent Loop、工具执行和模型请求路径
- [x] 实现 JSONL 编解码器与控制请求关联器
- [x] 实现子进程 transport 与 fake child 生命周期测试
- [x] 为协议基础添加确定性自动化测试
- [x] 实现 CLI Query 初始化屏障和双向控制回调分发
- [x] 实现 result / idle / requires_action 生命周期跟踪
- [x] 实现独立 Agent Loop、Tool Registry、schema 子集验证与 fail-closed 权限层
- [x] 实现 warm Session、JSON 文件持久化与 interrupted-turn recovery
- [x] 实现 Anthropic Messages SSE adapter 与 fake-fetch 契约测试
- [ ] 实现自有 CLI 与新版 SDK stream-json 协议的可验证子集
- [ ] 接入有明确 CLI 需求的工具、权限与 MCP

## 代码入口

- [agent-cil CLI](packages/cli/README.md)：一次性非交互命令、参数解析、文本流式输出与 JSON 结果。
- [CLI 入口新旧对照](docs/reverse-engineering/cli-entry-comparison.md)：新版 2.1.304 入口、旧版 2.1.88 query loop 与现有自有实现的差异和证据等级。
- [@agent-cil/protocol](packages/protocol/README.md)：JSONL framing、控制请求关联、子进程 transport 与 Query 生命周期。
- [@agent-cil/runtime](packages/runtime/README.md)：provider-neutral Agent Loop、Anthropic Messages SSE adapter、工具注册、输入校验、权限决策、Session 与多轮 tool_result 回填。
- [anthropic-messages-adapter.md](docs/design/anthropic-messages-adapter.md)：API 请求映射、SSE 事件转换、凭证边界和当前不支持的事件。
- [agent-loop-runtime.md](docs/design/agent-loop-runtime.md)：运行时事件契约、工具权限边界、测试范围和未实现项。
- [session-persistence.md](docs/design/session-persistence.md)：Session / Turn 数据模型、revision 检查、文件原子写入和中断恢复语义。
- [agent-loop-comparison.md](docs/reverse-engineering/agent-loop-comparison.md)：旧版 2.1.88 与新版 2.1.304 的代码级对照。
- [protocol-runtime-slice.md](docs/design/protocol-runtime-slice.md)：协议实现范围、证据对应和验收条件。
- [process-transport.md](docs/design/process-transport.md)：子进程状态机、stdio 生命周期和测试边界。
- [query-protocol-session.md](docs/design/query-protocol-session.md)：初始化、双向控制请求和 run-end 生命周期。
- [baseline.md](docs/reverse-engineering/baseline.md)：样本版本、目录、完整性记录与证据等级。
- [architecture.md](docs/reverse-engineering/architecture.md)：新版 Desktop、SDK、CLI 的组件职责。
- [protocol-contracts.md](docs/reverse-engineering/protocol-contracts.md)：控制请求、权限、MCP 与生命周期契约。
- [symbol-map.md](docs/reverse-engineering/symbol-map.md)：旧新版职责映射。
- [tool-execution-comparison.md](docs/reverse-engineering/tool-execution-comparison.md)：工具调度、取消、输入校验和 MCP 发现路径。
- [roadmap.md](docs/roadmap.md)：分阶段实现和验收标准。

## 开发与测试

要求 Node.js 22 或更高版本；协议包不需要第三方运行依赖。

~~~bash
npm test
npm run cli -- --help
~~~

测试覆盖 JSONL 与 SSE 分块 UTF-8、CRLF、坏帧恢复、控制响应关联、进程与 Query 生命周期、Anthropic SSE 事件映射、多轮 API 工具调用、权限拒绝/批准/取消、schema 校验、Session 文件持久化、冷恢复、revision 冲突、CLI 参数/快速路径、文本输出、stdin 输入与 JSON 结果。

## 研究与实现边界

新仓库只提交原创分析、接口契约、独立实现和测试。不要提交逆向压缩包、第三方二进制、提取的第三方源码/Source Map、凭证或运行时缓存。旧版源码只用于理解与对照；不把旧版函数直接复制成新版实现。静态代码中存在某分支，不代表某账号或某次运行一定启用；未经动态验证的结论会明确标记。

当前 CLI 首个可执行切片只实现 --print 一次性模式，不支持交互式 REPL、内置文件/命令工具或官方 SDK stream-json 协议；这些限制会在对应代码与测试完成前持续明确标注。不得把该入口当作 Desktop 的直接替代品。

## 参考仓库

- [旧版 CLI 2.1.88 参考源码](https://github.com/wwxst/-)
- [既有 Agent Desktop 项目（仅作产品/工程参考）](https://github.com/wwxst/agent-desktop)
