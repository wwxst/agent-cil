# SDK ↔ CLI 协议契约（静态重建）

**证据来源：** 上传资料包中的 evidence/local-agent-protocol.md，以及新版 Desktop SDK wrapper 与 CLI 2.1.304 的提取模块。下文是基于静态代码重建的契约摘要，不是来自真实用户会话的抓包记录。

## 1. 帧格式

- 通道是 stdin/stdout 上的 JSON Lines；每个非空行是一条独立 JSON 对象。
- SDK 写入时序列化一个对象并追加换行符；读取侧逐行解析。
- stdout 上不能解析为 JSON 的行在样本中会记录诊断并跳过；独立实现应将诊断与协议输出分开，不能向协议 stdout 打印普通日志。
- 一条 Query 可持续接受多个 user 输入，不要求每轮都启动新 CLI 进程。

## 2. 外层消息类型

| type | 方向（常见） | 作用 |
| --- | --- | --- |
| user | SDK → CLI | 输入消息和会话上下文 |
| assistant / stream_event | CLI → SDK | 助手消息及增量事件 |
| result | CLI → SDK | 回合结果 |
| control_request | 双向 | 带 request_id 的控制调用 |
| control_response | 双向 | 对控制调用的成功/错误应答 |
| control_cancel_request | 双向 | 取消一项控制请求/回调 |
| system | CLI → SDK | 状态变化、诊断和系统事件 |
| keep_alive | CLI → SDK | 通道/启动诊断 |
| transcript_mirror | CLI → SDK | 可选的 transcript 镜像批次 |

方向表示主要用法，不是封闭的 schema 列表。应根据具体 subtype 与协议版本验证字段。

## 3. 控制请求关联

请求与响应的关联 ID 不能和 tool_use_id 混用。

~~~json
{"type":"control_request","request_id":"r1","request":{"subtype":"interrupt"}}
{"type":"control_response","response":{"subtype":"success","request_id":"r1","response":{}}}
{"type":"control_response","response":{"subtype":"error","request_id":"r1","error":"error text","error_code":"optional-code"}}
{"type":"control_cancel_request","request_id":"r1"}
~~~

已确认的语义：

- 请求顶层有 request_id；响应的 ID 位于 response.request_id。
- SDK 与 CLI 两侧都维护待处理请求集合，并根据请求的响应 schema 验证结果。
- SDK 可能先收到暂时没有等待者的 response；样本会暂存有限数量的未匹配响应，以支持等待者后注册的情况。
- AbortSignal 取消一个已写出的控制请求时，SDK 可发送 control_cancel_request；对端应取消相应的宿主回调。
- 取消控制回调、interrupt 当前回合、close 整个 Query/子进程是不同动作。
- 并非所有 request_id 都保证是 UUID；不得在自有协议里假定 ID 格式等同于工具调用 ID。

## 4. Initialize 屏障与 Query 状态

Query 启动后会先发 initialize 控制请求。样本中的 initialize-written 标志表示初始化帧已经写出，并不等于 CLI 已经成功完成初始化。

initialize 可携带的配置组包括：

- system prompt、追加 prompt、plan-mode 指令、JSON schema 与工具别名；
- hooks、agents、skills 和宿主回调 ID；
- SDK MCP server 配置、manifest 和工具策略；
- 支持的 dialog 类型、prompt suggestions、workspace trust 等能力。

CLI 返回的初始化信息可能包含 commands、models、agents、account 和未完成的 permission/dialog 请求。样本仅在 initialize 应答路径重新投递这类待处理请求；这不是重新执行工具。

建议独立实现至少区分以下状态，而不要用单个布尔值表达所有生命周期：

| 状态/事实 | 含义 |
| --- | --- |
| initialize written | initialize 帧已经写入 transport |
| running | 当前回合正在执行 |
| result received | 已收到当前回合的 result |
| session idle | CLI 报告当前会话空闲 |
| requires action | 存在需要宿主回答的动作 |
| closing / closed | 正在清理 / 资源已终止 |

收到 result 不一定意味着可以立即关闭 stdin。如果仍有宿主 MCP、权限、hook、dialog 或 token refresh 等待回答，样本会等待 idle/回调收束，并有兜底终止计时。

## 5. 权限审批契约

权限决策由多层共同完成：

~~~text
CLI 规则/模式判定
  → allow / deny：CLI 直接处理
  → ask：发送 control_request(can_use_tool)
  → SDK 路由到 Desktop permission broker
  → 用户/宿主返回 allow 或 deny
  → CLI 校验返回 schema、应用输入/规则更新并再次检查
  → 执行工具或产生拒绝结果
~~~

典型请求核心字段：

~~~json
{"subtype":"can_use_tool","tool_name":"example_tool","input":{},"tool_use_id":"tool-1"}
~~~

典型回答：

~~~json
{"behavior":"allow","updatedInput":{},"updatedPermissions":[],"toolUseID":"tool-1"}
{"behavior":"deny","message":"user rejected","interrupt":true,"toolUseID":"tool-1"}
~~~

这些示例只展示核心字段。新版还可能带 MCP server 信息、权限建议、阻止路径、决策来源、展示标题、agent/plugin 信息等字段。自有实现应定义自己的稳定类型，并明确对未知字段的处理策略。

样本中拒绝、输入 schema 失败和工具错误都可能被转换为 tool_result 并回填消息历史；不能把“用户拒绝”实现成静默丢弃整个回合。

## 6. 宿主 MCP 桥接契约

SDK 内存 MCP server 的实际 JavaScript handler 留在宿主进程。CLI 通过控制通道发送 MCP JSON-RPC 消息，SDK 按 server_name 将请求路由到对应的宿主 transport，再按内层 JSON-RPC id 将响应返回 CLI。

~~~text
CLI → control_request(subtype=mcp_message, server_name, message)
    → SDK MCP transport
    → host-side handler
    → pending MCP response lookup
    → control_response(response.mcp_response)
    → CLI
~~~

要区分两个 ID 空间：

- 外层 control request_id：关联 SDK/CLI 控制调用。
- 内层 JSON-RPC id：关联 MCP client/server 请求。

普通独立 stdio/HTTP MCP server 与 SDK 内存 MCP bridge 是不同路径，应分别建模。通知或无 id 的 JSON-RPC 消息也不一定需要一个有业务内容的响应。

## 7. interrupt、resume 与 close

| 动作 | 契约含义 | 不应等同于 |
| --- | --- | --- |
| interrupt | 请求 CLI 中断当前回合；某些能力允许取消排队消息 | 关闭进程 |
| control_cancel_request | 取消某个控制回调 | 中断全部工具/会话 |
| resume / continue / fork | 通常由启动选项、session store 和 CLI session ID 协作完成 | 重新发送 initialize |
| close / cleanup | 终止 Query 资源，取消挂起回调并关闭 transport/进程 | 普通的单回合结束 |

interrupt 的应答可能包含仍排队或已取消的消息 ID；是否支持相应能力取决于协议协商。实现时应把能力协商、回合中断和资源终止分开测试。

## 8. 独立实现的最低测试矩阵

| 场景 | 预期 |
| --- | --- |
| initialize 成功 | 发送 initialize 后才开放普通输入 |
| initialize 失败 | 返回有上下文的错误，不伪装成成功初始化 |
| 多行 JSONL | 每行独立解析，不把多帧当作一个 JSON |
| 无效 stdout 行 | 记录诊断，协议 stdout 不被普通日志污染 |
| 控制请求响应乱序 | 通过 request_id 匹配，不按到达顺序配对 |
| 响应先于等待者 | 若自有协议允许，有限暂存并可被后续等待者领取 |
| abort 控制回调 | 取消对应请求，不误取消其他请求 |
| tool permission deny | 返回明确拒绝结果，按策略决定是否中断 |
| MCP 请求 | 用外层 ID 和内层 JSON-RPC ID 分别匹配 |
| result 后仍有回调 | 不过早关闭 transport |
| interrupt 与 close | 分别验证回合中断和整体资源清理 |
| 多轮 Query | 同一会话可继续输入，事件和回合边界清楚 |

这些测试是为自有实现提炼的契约，不表示当前仓库已经实现或通过了它们。
