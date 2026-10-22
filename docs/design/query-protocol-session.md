# Query Protocol Session — 设计与逆向对应

## 目标

在 ProcessTransport 之上建立协议层 Query session。它负责 initialize 帧顺序、control request / response 关联、宿主控制回调分发、取消和会话关闭。它不负责模型推理、工具执行策略、权限 UI、MCP server 本身或完整回合状态机。

## 静态证据

来源：新版 Desktop 3.1623.1 的 index.chunk-J7YnW_mh.js。

- 约 offset 1191250：buildInitializeRequest() 构造 subtype=initialize，包含 hooks callback IDs、SDK MCP server 名称/配置/manifest、JSON schema、system prompt、tool aliases、agents、skills 与其他能力配置。
- 约 offset 1208545：streamInput() 等待 initializeWritten，然后把每条输入序列化成 JSONL 写入 transport。这里等待的是 initialize 帧已写出，不是 initialize control_response 已成功返回。
- 约 offset 1185331：processControlRequest() 按 subtype 分发宿主回调；can_use_tool 会传递权限建议、blocked path、decision reason、tool_use_id、agent ID 等上下文。
- 约 offset 1182080：收到 result 后，如果 session state 仍未 idle 且存在双向回调需求，Query 不会立刻结束该轮；session_state_changed 到 idle 后才会收束，requires_action 会清除结束兜底计时。
- 约 offset 1208545：结束输入前可能等待双向需求完成，再调用 transport.endInput()。

以上是样本中的静态行为，不代表当前独立实现已经覆盖了所有状态。

## 本次实现的契约

- initialize() 只允许调用一次；普通输入必须等 initialize 帧写入后才能写入 stdin。
- initialize() 返回值仍等待匹配的 control_response；帧写入屏障与初始化应答是两个独立事实。
- requestControl() 生成独立 request_id，并按 response.request_id 关联应答；AbortSignal 触发时发送 control_cancel_request。
- registerControlHandler() 将 CLI 发起的 control_request 分派到宿主回调，并返回带相同 request_id 的 success/error 响应。
- control_cancel_request 只中止匹配的宿主回调，不会自动中止整个 Query。
- NO_CONTROL_RESPONSE 允许显式把某类请求交给另一个执行 host，避免伪造应答。
- close/transport error 会拒绝挂起的控制请求，并取消仍运行的宿主回调。

## 尚未实现

- result 与 session_state_changed 的组合状态机；
- idle / requires_action 等待、兜底结束计时与双向回调排空；
- SDK MCP server manifest 初始化与 mcp_message JSON-RPC bridge；
- permission broker 的 can_use_tool 数据转换和权限结果 schema；
- warm Query 复用、resume 与 cold session 恢复。

## 验收

使用 fake transport 验证 initialize 必须先写出、输入写入顺序、outbound request ID 关联、host callback success/error、control cancel、session close 清理，以及有意交给其他 host 的未应答路径。测试不启动第三方 CLI，也不需要真实凭证。
