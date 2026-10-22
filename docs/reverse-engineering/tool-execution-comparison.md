# 工具执行路径：旧版与新版行为对照（候选差异）

## 结论

旧版与新版都采用“解析 tool_use → 权限/输入校验 → 执行 → 产生 tool_result → 回填下一轮”的结构。新版工具调度器周围可见更多生命周期、动态 MCP 工具发现和上下文传递逻辑。以下差异是本轮静态对照中观察到的行为，不等于已经证明每一项都是该版本首次新增；需要继续检查调用方、feature gate 和完整控制流。

## 1. 调度器对照

| 维度 | 旧版 2.1.88 | 新版 2.1.304 | 判断 |
| --- | --- | --- | --- |
| 调度器 | StreamingToolExecutor 类；状态包含 queued/executing/completed/yielded | class vs；保留相同的主要状态，增加 drain generation、responseOpen 和 bridge event 等状态 | 职责延续，生命周期更复杂 |
| 并发策略 | 依据 isConcurrencySafe 分组；不安全工具需要独占执行；结果按接收顺序缓冲 | 同样依据 isConcurrencySafe；队列无法继续时保持顺序，并增加结束回合层的应用逻辑 | 基本策略延续 |
| 未知工具 | addTool 找不到定义时立即构造错误 tool_result | 先尝试别名/工具目录；某些待注册 MCP 工具会先排队等待；仍无法找到时产生带建议的错误结果 | 新版可见动态等待/更丰富错误建议 |
| 取消/丢弃 | discard 标记后不再采用结果；使用 sibling AbortController 处理特定兄弟进程错误 | discardAndAbortInFlight 可中止执行中的工具，并报告已开始/未开始工具；每个工具记录自己的 AbortController | 取消与中止状态显式化 |
| 同轮上下文 | 主要按队列与结果消息组织 | 构造 sameTurnToolUses 和 sameTurnErroredToolUseIds 并传入工具执行上下文 | 新版支持更明确的同轮关联上下文 |
| 进度/排空 | progressAvailableResolve 唤醒结果消费者 | 保留进度通知，并增加 drainableResolve/waitForDrainable/wakeWaiters | 等待条件更细分 |
| 事件/结果 | pendingProgress 与结果列表 | 增加 pendingBridgeEvents、contextLayers 等状态 | 需要继续追踪桥接事件和 context layer 的消费点 |

## 2. 旧版工具执行路径

参考文件：

- reference-2.1.88/restored-src/src/services/tools/StreamingToolExecutor.ts
  - 第 40 行：StreamingToolExecutor。
  - 第 76 行：addTool。
  - 第 129 行：canExecuteTool。
  - 第 140 行：processQueue。
- reference-2.1.88/restored-src/src/services/tools/toolExecution.ts
  - 第 337 行：runToolUse。
  - 第 492 行：streamedCheckPermissionsAndCallTool。
  - 第 599 行：checkPermissionsAndCallTool。

静态可见的职责：

1. StreamingToolExecutor 根据工具定义和输入 schema 计算并发安全性，维护工具队列。
2. runToolUse 查找工具；对别名、MCP 连接和未知工具有单独处理。
3. 工具执行经过权限与 hook 检查，再调用工具实现。
4. 未知工具、拒绝和执行错误可以转换为 tool_result 消息，而不是静默丢弃。
5. 调度器负责缓冲结果、进度以及用户中断/流式回退时的收束。

## 3. 新版工具执行路径

参考文件：

- cli-2.1.304/modules/chunk-smbjjyps.js
  - offset 52975：class vs。
  - offset 135116 / 137532：query 入口与主循环候选函数。
- cli-2.1.304/modules/chunk-4b60tdnk.js
  - offset 3957580：wG，工具路由候选函数。
  - offset 3967595：AYr，工具输入验证与执行前置逻辑。
- evidence/local-agent-core.md 对 query、工具路由和结果回填有交叉记录。

新版样本中可见：

- 未找到 MCP 工具时，可能等待工具注册/连接状态变化，再决定执行或返回错误。
- 未知工具错误可以结合 tool catalog 生成建议，而不仅是简单报告名称不存在。
- 工具输入有 JSON parse、schema validation、可选 coercion/repair 和 validateInput 等分阶段处理。
- 存在 tool isolation latch 的拒绝路径。
- 工具执行可以交给其他 host；并非所有 tool 都在当前 CLI 进程内执行。
- 调度器为单个工具建立 AbortController，并支持 discard 时中止执行中的工具。
- 结果回填继续使用 tool_use_id 关联，并为输入错误、权限拒绝等构造可反馈的 tool_result。

## 4. 候选行为差异与待验证问题

### A. 动态 MCP 工具发现

新版在工具缺失路径中出现待连接 MCP 工具检查、短暂等待和重试路由；旧版 StreamingToolExecutor 的 addTool 在找不到可用定义时直接生成错误结果。旧版其他模块也有 MCP 连接与工具搜索，所以这不能单凭该方法断言为全局新增功能。

需要继续确认：

- 等待只用于 MCP server 尚未完成连接，还是也覆盖动态工具目录刷新？
- 等待期间是否可以被 turn abort、Query close 或 server disconnect 立即取消？
- 工具最终未出现时的错误是否会影响本轮剩余工具执行？

### B. 工具输入校验与修复

新版 AYr 路径可见原始 JSON 解析错误、schema 校验、coercion/repair、validateInput 与补充修复提示。旧版也有 inputSchema.safeParse、validateInput 和工具错误封装，但本轮未在旧版工具执行路径发现相同的 coercion/repair 标记。

需要继续确认：

- 哪些工具/输入 schema 允许 coercion，何时会再次校验？
- 修复后的输入是否会再次经过权限检查，防止修改参数扩大权限？
- 错误提示是否只包含截断/脱敏后的输入信息？

### C. 单工具取消与同轮关联

旧版使用 sibling AbortController 处理特定工具错误并维护队列；新版为每个执行项记录 AbortController、callStarted 和同轮工具上下文，并能区分 turn abort、background cancellation、user rejection、conversation ended 和 streaming fallback 等结束原因。

需要继续确认：

- 每一种结束原因映射到的 tool_result 内容、denial kind 和 turn 中断行为。
- 已开始的外部副作用能否真正取消；无法取消时如何报告结果。
- sameTurnToolUses / sameTurnErroredToolUseIds 如何影响权限、提示或后续工具执行。

### D. 远端执行与隔离

新版 wG 路径存在 host handoff 和 isolation latch 拒绝分支。旧版也有 sandbox、remote/bridge 相关能力，但当前没有建立一对一映射。

需要继续确认：

- 哪些工具允许 handoff，host 选择依据是什么。
- handoff 前后的权限上下文、AbortSignal 和 tool_use_id 是否保持关联。
- isolation latch 与普通 permission deny 的差别，以及结果如何回填。

## 5. 对自有 Runtime 的设计启示

这里提炼的是可验证的工程需求，不要求复制第三方实现：

1. 让 ToolRegistry 查询与 ToolExecutor 调度分离，以便支持动态注册和清晰的未知工具错误。
2. 将输入解析、schema 校验、权限决策、执行与结果归一化视为可测试的不同步骤。
3. 每个工具调用保留稳定的 toolCallId、AbortSignal、状态和关联的回合 ID。
4. 将“停止本回合”“取消某个回调”“关闭整个会话”定义为不同操作。
5. 结果必须按原工具调用 ID 回填；拒绝、校验失败和执行失败都要有明确的结果类型。
6. 只在真实需求出现时引入动态等待、跨 host handoff 或复杂的调度状态，不为未来假设提前建立通用框架。
