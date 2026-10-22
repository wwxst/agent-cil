# Agent Loop Runtime — 当前实现契约

## 范围

`@agent-cil/runtime` 是 provider-neutral 的独立运行时。它接收由上层 adapter 实现的模型事件流，不包含第三方模型 SDK、CLI 认证、持久化 Session、桌面 UI 或 MCP server。

## Model adapter

`model.stream({ messages, tools, signal, turn })` 必须返回 async iterable。当前事件契约：

- `text_delta`: 文本增量。
- `tool_use`: 唯一 tool-use ID、工具名与对象输入。
- `message_end`: stop reason 为 `end_turn`、`tool_use` 或 `max_tokens`。
- `usage`: 可选的使用量事件。

若包含 tool_use，message_end 必须是 tool_use。模型流必须显式发出 message_end；重复 tool-use ID、未知事件和不完整消息都视为协议错误。provider adapter 应同时遵守 AbortSignal。

## Tool registry 与权限

ToolRegistry 维护工具名、描述、输入 schema、可选自定义验证器与执行函数。内建 validator 只实现 JSON Schema 的一个有界子集；需要更广覆盖时，应替换为成熟的完整 schema validator，而不是误称兼容完整 JSON Schema。

工具输入先验证，再调用 permissionPolicy。只有 `allow` 才执行；`ask` 必须由 approvalHandler 显式批准；缺失策略、非法策略结果、策略异常、缺失审批处理器、未知工具或校验失败都不会执行工具。工具失败会生成对应的 error tool_result，供模型决定是否恢复。

## 多轮闭环

每一轮将完整 history 和可调用工具描述传给模型。助手消息包含文本与 tool_use block；工具调用完成后，以 user 消息中的 tool_result blocks 回填，再启动下一轮模型请求。达到 maxTurns 后不再启动新请求，结果会标注 max_turns，并保留已产生的工具结果。

## 已覆盖的测试

- 至少两轮 tool_use → tool_result → 最终文本的闭环；
- 默认拒绝、显式批准与缺失审批处理器；
- schema 输入校验先于权限策略；
- 未知工具、重复 tool-use ID、模型消息不完整；
- 最大轮次、取消后的状态清理、权限策略异常；
- registry 注册、描述、移除与 schema 子集校验。

## 尚未覆盖

- 真实模型 provider adapter 的流式兼容；
- 并行工具调用与调度公平性；
- approval handler 取消和工具执行异常的专门回归测试；
- 持久化 Session、continue/resume、MCP bridge 与 host-specific 运行 target；
- 完整 JSON Schema、重试、token 预算与消息压缩。

静态逆向结论和独立运行时的实测行为分开记录；fake model 测试不能证明对某一真实模型 API 或第三方 CLI 的端到端兼容。
