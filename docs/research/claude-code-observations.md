# Claude Code / Desktop 静态观察摘要

## 1. 样本基线

历史研究材料记录的样本：

| 项目 | 版本 / 标识 |
| --- | --- |
| Desktop | 3.1623.1 |
| Desktop build commit | 99e484be3828a3767e90385312c83202bca35d8c |
| SDK wrapper | 0.3.304 |
| CLI build pin | 2.1.304 |
| CLI 平台样本 | win32-x64 |
| 旧版参考 CLI | 2.1.88 |
| 静态资料包 | claude-agent-reverse-kit-desktop-3.1623.1-cli-2.1.304.zip |

2.1.304 是该 Desktop 构建中观察到的 CLI pin，不代表所有安装客户端实际运行的版本。Host 更新与回退、VM build pin 和远程 target 可能不同。

## 2. Desktop 到 CLI 的分层

静态资料支持以下架构：

~~~text
Desktop Renderer / UI
  → Electron preload + IPC
  → Local Agent Session Manager
  → Embedded SDK Query / Wrapper
  → Process Transport
  → Claude Code CLI subprocess
  → Model request / Tool execution / Next turn
~~~

关键职责：
- Renderer / IPC：用户输入、附件、会话操作和 UI 事件。
- Session Manager：start、send、resume、interrupt、cwd/env 与 warm/cold 生命周期。
- SDK Wrapper：argv/env、JSONL transport、initialize、回调关联和关闭。
- CLI：模型请求、工具路由、权限结果处理、上下文和下一轮调度。
- Host / VM / SSH / WSL adapters：将进程接口映射到不同执行环境。
- MCP bridges：在 CLI、SDK 和宿主工具服务之间转发请求与响应。

Desktop SDK wrapper 不等于 Agent 核心循环；CLI 也不是纯 HTTP SDK。

## 3. SDK ↔ CLI JSONL 协议

样本显示 SDK 与 CLI 通过 stdin/stdout 上的 JSON Lines 传输。每个非空行是一条 JSON 对象。

观察到的外层消息包括：

| 类型 | 主要用途 |
| --- | --- |
| user | 输入消息和会话上下文 |
| assistant / stream_event | 助手消息和增量事件 |
| result | 当前回合结果 |
| control_request / control_response | 双向控制调用 |
| control_cancel_request | 取消单项控制请求 |
| system | 会话状态和诊断 |
| keep_alive | 通道和启动诊断 |
| transcript_mirror | 可选 transcript 镜像 |

控制请求的 request_id 位于请求顶层；响应关联 ID 位于 response.request_id。它与 tool_use_id、MCP JSON-RPC id 是不同 ID 空间。

Initialize written 与 initialize response 是两个独立事实。收到 result 也不一定表示宿主已经没有待处理的权限、MCP、Hook、dialog 或凭证刷新请求。

## 4. Agent 主循环

静态调用链支持以下通用闭环：

~~~text
准备上下文
  → 流式模型请求
  → assistant 内容 / tool_use
  → schema / hook / permission
  → allow 时执行；deny / invalid 时生成错误 tool_result
  → tool_result 回填消息历史
  → next_round 或结束
~~~

旧版 2.1.88 和新版 2.1.304 都存在模型请求、工具调用、结果回填和下一轮判断。新版样本可见更丰富的调度状态、工具注册等待和上下文传递。

不能因为文件布局、压缩符号或模块数量变化就推断算法完全不同；也不能把旧版源码直接当成新版实现。

## 5. 工具调度和权限观察

静态资料记录的关键行为：
- 工具输入经过解析和 schema 校验。
- 新版路径还可见 coercion / repair、validateInput、Hook 和权限决策阶段。
- allow / deny / ask 是不同决策；ask 可交给 Desktop permission broker。
- 宿主返回 updatedInput 后，CLI 需要重新校验最终输入，不能沿用旧输入的授权。
- 工具拒绝、输入错误和执行失败可以转成与 tool_use_id 配对的 tool_result。
- 只读工具可能按并发安全标记调度；写操作和 Bash 不能默认并发。
- 新版某些 MCP 工具缺失路径会等待注册或连接状态变化，再尝试路由。
- discard、interrupt、关闭 Query 和取消单个控制回调不是同一动作。

这些是样本中观察到的路径，不代表所有功能在所有环境和账户中都启用。

## 6. MCP 与执行环境

宿主进程内的 MCP JavaScript handler 不会被直接序列化给 CLI。CLI 通过控制消息请求宿主执行，宿主再按外层 control request ID 和内层 JSON-RPC ID 关联结果。

普通 stdio / HTTP MCP server 与宿主内存 MCP bridge 是不同路径。

样本还显示 Host、VM、SSH/WSL 存在不同启动与恢复路径，不能把它们视为同一种 spawn 机制。

## 7. 对 Agent CIL V2 的启示

1. 将 Agent Loop 与进程 Transport 分开。
2. 明确 Command、Event、Thread、Turn、Step 和各类 ID。
3. 把审批暂停、Turn interrupt、单回调取消和进程关闭区分开。
4. 所有工具统一走校验、授权和执行安全边界。
5. 保留 Provider 原生推理状态，不把它压成普通文本。
6. 将 MCP 视为工具传输适配，不让它绕过 Execution Guard。
7. 恢复时只重建状态，不自动重放工具副作用。

## 8. 证据限制

本研究主要来自指定版本的静态提取模块、旧版恢复源码和资料包报告。静态调用路径不等于动态运行验证，也不证明生产环境中的 feature gate 一定开启。

偏移量只适用于对应样本，不应作为新版本的稳定 API。不要将第三方二进制、提取源码、Source Map 或 native addon 重新提交到本仓库。