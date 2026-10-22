# Agent CIL

**当前只开发自有 CLI，不开发前端 UI 或 Desktop 窗口。** 以 CLI 2.1.304 的静态逆向证据为主、2.1.88 旧版源码为行为参照，先逐模块确认新旧差异，再在 `agent-cil` 中独立实现必要行为。旧版恢复源码不是可复现构建工程，且没有证明其代码可按宽松开源许可证复用，因此不直接复制第三方代码。

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
- [ ] 按真实源码证据逐项核对 Agent Loop、工具调度、权限、Session 和 Query 行为
- [ ] 对真实 SDK stream-json 协议建立经源码确认的兼容子集

Session manager、MCP 和平台包装当前只保留已有原型；新扩张暂停，直到新旧行为对照证明必要性。

## 代码入口

- [@agent-cil/protocol](packages/protocol/README.md)：JSONL framing、控制请求关联、子进程 transport 与 Query 生命周期。
- [@agent-cil/runtime](packages/runtime/README.md)：provider-neutral Agent Loop、Anthropic Messages SSE adapter、工具注册、输入校验、权限决策、Session 与多轮 tool_result 回填。
- [anthropic-messages-adapter.md](docs/design/anthropic-messages-adapter.md)：API 请求映射、SSE 事件转换、凭证边界和当前不支持的事件。
- [agent-loop-runtime.md](docs/design/agent-loop-runtime.md)：运行时事件契约、工具权限边界、测试范围和未实现项。
- [session-persistence.md](docs/design/session-persistence.md)：Session / Turn 数据模型、revision 检查、文件原子写入和中断恢复语义。
- [agent-loop-comparison.md](docs/reverse-engineering/agent-loop-comparison.md)：旧版 2.1.88 与新版 2.1.304 的代码级对照。
- [baseline.md](docs/reverse-engineering/baseline.md)：旧版源码完整性、可运行性与授权/复用边界。
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
~~~

测试覆盖 JSONL 与 SSE 分块 UTF-8、CRLF、坏帧恢复、控制响应关联、进程与 Query 生命周期、Anthropic SSE 事件映射、多轮 API 工具调用、权限拒绝/批准/取消、schema 校验、Session 文件持久化、冷恢复、revision 冲突与 interrupted-turn reconciliation。

## 研究与实现边界

新仓库只提交原创分析、接口契约、独立 CLI 实现和测试。不要提交逆向压缩包、第三方二进制、提取的第三方源码/Source Map、凭证或运行时缓存。旧版源码只用于理解与对照；当前没有证据证明恢复代码可合法复制，也没有完整的恢复源码构建工程。静态代码中存在某分支，不代表某账号或某次运行一定启用；未经动态验证的结论会明确标记。

## 参考仓库

- [旧版 CLI 2.1.88 参考源码](https://github.com/wwxst/-)
- [既有 Agent Desktop 项目（仅作产品/工程参考）](https://github.com/wwxst/agent-desktop)
