# Query Protocol Session — 设计与逆向对应

## 目标

ProcessTransport 负责子进程 I/O；QueryProtocolSession 负责 initialize 顺序、control request/response 关联、宿主回调分发、取消与关闭；QueryRunLifecycle 区分 CLI result 和宿主侧 run 完成。三者不负责模型推理、工具执行或 MCP server 本身。

## 静态证据

来源：新版 Desktop 3.1623.1 的 index.chunk-J7YnW_mh.js。

- 约 offset 1191250：buildInitializeRequest() 构造 subtype=initialize，包含 hooks callback IDs、SDK MCP server 配置、JSON schema、system prompt、tool aliases、agents 和 skills。
- 约 offset 1208545：streamInput() 等待 initializeWritten 后再把输入序列化成 JSONL。这个屏障表示 initialize 帧已写出，不代表 initialize control_response 已成功返回。
- 约 offset 1185331：processControlRequest() 按 subtype 分发宿主回调；can_use_tool 传递工具建议、decision reason、tool_use_id、agent ID 等上下文。
- 约 offset 1182425：收到 result 后，只有在 sessionState 未知、为 idle，或没有双向需求时才立即结束 run；否则启动 run-end ceiling。
- 约 offset 1182597：session_state_changed 到 idle 且已经收到 result 时结束 run；requires_action 清除 ceiling；其他状态下若 result 已到达，则重新启动 ceiling。
- 约 offset 1209237：streamInput 完成输入消息处理后，如果存在双向需求，会等待 run end 再调用 transport.endInput()。

以上是样本中的静态行为，不代表当前独立实现已经覆盖所有状态。

## 实现契约

- initialize() 只允许调用一次；普通输入必须等 initialize 帧写入后才能写入 stdin。
- initialize() 返回值等待匹配的 control_response；帧写入屏障与初始化应答是两个独立事实。
- requestControl() 使用独立 request_id 并按 response.request_id 关联应答；AbortSignal 触发时发送 control_cancel_request。
- registerControlHandler() 分派 CLI 发起的 control_request，并返回相同 request_id 的 success/error 响应。
- control_cancel_request 只中止匹配的宿主回调，不会自动中止整个 Query。
- NO_CONTROL_RESPONSE 允许明确把请求交给另一个执行 host。
- QueryRunLifecycle 追踪 result、session_state_changed、requires_action、idle 和 run-end ceiling。调用方可 await waitForRunEnd()，不必把 result 误当作所有宿主交互已经结束。
- close/transport error 会拒绝挂起的控制请求并取消仍运行的宿主回调；生命周期监听器也会在 session close 时清理。

## 尚未实现

- initialize payload 的完整版本化 schema 验证；
- 自动组装 SDK MCP server manifest 与 mcp_message JSON-RPC bridge；
- can_use_tool 数据转换和完整权限结果 schema；
- warm Query 复用、resume 与 cold session 恢复；
- QueryRunLifecycle 与多消息 streamInput 的完整编排，以及平台特定 target 的结束语义。

## 验收

fake transport 测试覆盖 initialize 屏障、输入写入顺序、request ID 关联、host callback success/error、control cancel 和关闭清理。事件测试覆盖 result/idle/requires_action/ceiling 转换。测试不启动第三方 CLI，也不需要真实凭证。
