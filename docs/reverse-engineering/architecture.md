# 新版架构与协议摘要

## 1. 组件分层

新版样本支持以下本地执行架构：

~~~text
Desktop Renderer / UI
  → Electron preload + IPC
  → Local Agent session manager
  → Embedded SDK Query / wrapper
  → Process transport
  → Claude Code CLI subprocess
  → model request / tool execution / next turn
~~~

职责划分：

| 层 | 已观察到的职责 | 不应混淆的边界 |
| --- | --- | --- |
| Renderer / IPC | 用户消息、附件、会话操作与 UI 事件 | IPC schema 不是公网 API schema |
| Session manager | start、send、resume、interrupt、cwd/env、warm/cold 生命周期 | UI 不直接拥有 CLI 子进程 |
| SDK wrapper | 生成 argv/env、JSONL 传输、初始化、回调关联和关闭 | SDK wrapper 不等于 Agent 核心循环 |
| CLI | 模型请求、工具路由、权限结果处理、上下文和下一轮调度 | CLI 不是纯粹的 HTTP SDK |
| Host/VM/SSH adapters | 把进程接口映射到本机、VM 或远端 target | 不同 target 不能默认视为同一启动路径 |
| MCP bridges | 在 CLI、SDK 和宿主工具服务间转发请求/响应 | 宿主内存 handler 不会简单地序列化成 CLI 函数 |

## 2. 启动链

资料包中已追踪的 Windows Host 主链：

**LocalAgentModeSessions.start/sendMessage → IPC handler → LocalAgentModeSessionManager → query(prompt, options) → ProcessTransport → spawn(claude.exe, args, { cwd, env, stdio })**

初始 CLI 参数包含：

~~~text
--output-format stream-json
--verbose
--input-format stream-json
~~~

根据会话配置，参数还可能包含模型、effort、权限模式、工具、MCP、额外目录、settings 和恢复会话等选项。因此上述参数是已观察到的基础参数，不是所有运行的完整 argv。

### 不同执行 target

- **Host**：Windows 样本的普通路径通过 SDK 默认进程 spawn 启动本机 CLI。
- **VM**：使用 native VM addon 建立 guest 进程适配；CLI 路径示例为 /usr/local/bin/claude，工作目录示例为 /sessions/<processName>。这不是普通的本机 spawn。
- **SSH/WSL**：属于另一套 Claude Code session manager/remote target 路径；SDK spawn 被远程进程适配器替换。不能推断 Cowork 的 LocalAgentModeSessions.start 默认走 SSH。

Host 与 VM 的版本管理也不同：Host 存在更新和已安装版本回退逻辑；VM prepare 路径使用 Desktop build pin。

## 3. SDK ↔ CLI：JSON Lines

SDK 与 CLI 通过 stdin/stdout 逐行传输 JSON。每行是一个独立 JSON 对象；消息关联、取消、初始化与双向回调都需要在协议层处理。

| 消息类型 / 子类型 | 作用 |
| --- | --- |
| user | 输入用户消息及多轮内容 |
| assistant | 助手输出内容 |
| stream_event | 流式增量事件 |
| result | 当前回合结果 |
| control_request / control_response | 初始化、权限、MCP、凭证刷新、interrupt 等双向控制 |
| control_cancel_request | 取消仍挂起的控制请求 |
| system | 会话状态及其他系统事件 |
| keep_alive | 维持传输通道 |

SDK 的 initialize 控制请求可以携带 system prompt、hooks、agents、skills、SDK MCP server manifest 和工具别名等信息。SDK 保留函数回调，并通过 ID/消息桥接把它们映射到 CLI 侧，而不是直接把宿主进程中的函数传给子进程。

## 4. 一轮 Agent 的核心闭环

静态证据支持以下通用闭环：

~~~text
准备上下文
  → 发起流式模型请求
  → 解析 assistant 内容与 tool_use
  → 工具 schema / hook / permission 决策
  → allow：执行工具；deny/invalid：生成可反馈的 tool_result
  → 将 tool_result 加回消息历史
  → 判断是否进入 next_round 或结束
~~~

CLI 内存在上下文压缩、hooks、子代理、取消和 max-turns 等控制。可并发工具受 concurrency-safety 判断约束；不能把所有工具执行都假定为并发或本地执行。

## 5. 权限和 MCP

- CLI 先依据工具规则和权限模式作 allow/deny/ask 决策。
- 需要宿主审批时，通过控制通道调用 can_use_tool；Desktop permission broker 返回审批结果。
- CLI 对宿主返回值进行 schema/策略复核；拒绝、输入校验失败等情况也可以作为 tool_result 返回给模型。
- SDK MCP server 的 JavaScript handler 留在宿主进程。CLI 通过 MCP control message 请求执行，宿主执行 handler 后返回 JSON-RPC 结果。
- 独立 stdio/HTTP MCP server 有各自的启动、连接和配置路径，不应与宿主内存 MCP bridge 混为一谈。

## 6. 生命周期与事件处理注意事项

- Warm session 可通过输入队列复用正在运行的 Query；没有可复用 Query 时走重新启动或冷恢复路径。
- interrupt 中断当前回合；close 清理 Query/子进程；resume 需要与 CLI session ID、session store 和恢复策略一起分析。
- 收到 result 不总意味着宿主已经没有待处理请求；存在双向回调时，还需考虑 idle/session state 与待处理控制请求。
- Desktop 的凭证刷新可能在进程启动后通过控制协议再次发生，不能把认证建模成仅启动时注入一次环境变量。

## 7. 静态分析的限制

以上是资料包支持的静态调用关系。当前没有启动 Desktop/CLI，没有登录、发起模型请求或读取真实凭证。账号/组织 feature gate、实际运行 argv/env、Host/VM 的最终选择、远程 helper 内部实现以及生产环境中的功能可达性，都需要单独的授权动态验证。

本仓库的实现目标是根据已确认的行为契约独立实现兼容层，不复制打包后的第三方代码，也不以压缩变量名作为公共 API。
