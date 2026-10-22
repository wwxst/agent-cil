# 旧版源码 ↔ 新版模块职责映射（第一轮）

本文件是职责级映射，不是逐行 diff。旧版源码可读，新版主要是压缩后的模块；相同职责不代表实现完全相同。新版偏移是该样本 UTF-8 解码后的字符偏移，仅用于定位。

## 已建立的映射

| 子系统 | 旧版 2.1.88 参考位置 | 新版 2.1.304 / Desktop 3.1623.1 位置 | 置信度 | 结论与下一步 |
| --- | --- | --- | --- | --- |
| Agent query 主循环 | reference-2.1.88/restored-src/src/query.ts：query（约第 219 行）、queryLoop（约第 241 行） | cli-2.1.304/modules/chunk-smbjjyps.js：YL（offset 135116）、su（offset 137532） | 高（职责） | 两侧都承担 query/turn 循环职责。下一步比较上下文准备、模型重试、compact、turn 限额与结束条件。 |
| 流式工具调度 | reference-2.1.88/restored-src/src/services/tools/StreamingToolExecutor.ts：StreamingToolExecutor（第 40 行） | cli-2.1.304/modules/chunk-smbjjyps.js：class vs（offset 52975） | 高（职责） | 新版类含工具队列、执行/完成状态与排空控制等字段，符合流式调度器职责。需继续比对并发安全判定、yield 与取消语义。 |
| 工具调用与路由 | reference-2.1.88/restored-src/src/services/tools/toolExecution.ts：runToolUse（第 337 行） | cli-2.1.304/modules/chunk-4b60tdnk.js：wG（offset 3957580）、AYr（offset 3967595） | 高（职责） | 新版路径涉及工具名/别名解析、输入 schema、hooks、权限判定、工具执行及结果转换。下一步逐项核对拒绝结果和错误封装。 |
| 模型请求 | reference-2.1.88/restored-src/src/services/api/claude.ts：queryModelWithoutStreaming（第 709 行）、queryWithModel（第 3300 行） | cli-2.1.304/modules/chunk-4b60tdnk.js：流式 beta.messages.create 调用（offset 2780615） | 高（职责） | 新版主回路可达流式模型请求。下一步对照参数构造、请求头、缓存、重试和 token/usage 归一化；不要把 token 估算请求误认成主请求。 |
| 权限决策 | reference-2.1.88/restored-src/src/utils/permissions/permissions.ts：规则匹配与 checkRuleBasedPermissions（第 1071 行） | cli-2.1.304/modules/chunk-4b60tdnk.js 的工具权限路径；chunk-451m4237.js 中 can_use_tool 控制路径（offset 8426 附近） | 中 | 新版至少有 CLI 规则/策略、SDK 回调和 Desktop broker 多层。当前不是一对一映射；下一步画清 allow/deny/ask、schema 校验和二次复核顺序。 |
| SDK 内存 MCP 桥 | reference-2.1.88/restored-src/src/services/mcp/SdkControlTransport.ts：SdkControlClientTransport（第 60 行）、SdkControlServerTransport（第 109 行） | extracted-3.1623.1/asar/.vite/build/index.chunk-J7YnW_mh.js：control request/response、MCP message 路由与 SDK MCP manifest 初始化 | 高（架构职责） | 两侧都需要跨进程控制消息承载宿主进程中的 MCP handler。下一步比较 request ID、初始化握手、迟到响应和取消。 |
| Session 恢复 | reference-2.1.88/restored-src/src/utils/sessionRestore.ts：restoreSessionStateFromLog（第 99 行）、restoreAgentFromSession（第 200 行）、processResumedConversation（第 409 行） | Desktop 的 index.chunk-pO0kQf5K.js 会话管理器，以及 SDK wrapper 的 resume/session-store 参数路径 | 中 | 这是 CLI transcript 恢复与 Desktop 进程生命周期的跨层职责，不应强行映射为单个函数。下一步区分 CLI session ID、Desktop session ID、warm Query 与 cold resume。 |
| Desktop 启动与目标选择 | 旧版 CLI 参考仓库没有对应的新版 Desktop 主进程层 | extracted-3.1623.1/asar/.vite/build/index.chunk-CnYzLcGN.js、index.chunk-pO0kQf5K.js、index.chunk-J7YnW_mh.js | 高（新版存在） | 新版增加了 Desktop IPC/session manager/SDK wrapper 的集成层。Host、VM、SSH/WSL 启动分支必须分开分析。 |

## 证据解释

- 旧版源码行号来自本次上传资料包内的 reference-2.1.88/restored-src；新版偏移来自对应的 2.1.304 提取模块。
- 新版 query/工具/模型请求路径还由资料包 evidence/local-agent-core.md 交叉记录；Desktop 启动与协议由 evidence/local-agent-launch.md、evidence/local-agent-protocol.md 和 evidence/architecture-analysis.md 交叉记录。
- 当前只确认职责对应与调用路径，不声称已证明所有行为相同或已经列全新版差异。
- 所有偏移都绑定到样本版本；新版本、重新打包或不同平台的偏移可能变化。

## 下一轮对照任务

1. 对 query 主循环列出输入、输出、终止分支、重试和上下文压缩条件。
2. 对 StreamingToolExecutor 比较队列状态、并发安全、yield、结果顺序和 abort。
3. 对工具权限路径画出决策时序图，并建立 allow/deny/ask 的独立测试契约。
4. 对模型请求区分主推理、token 估算、压缩摘要和权限分类等不同 API 调用。
5. 对 SDK MCP bridge 定义消息 schema、request ID 生命周期、取消和错误回传。
