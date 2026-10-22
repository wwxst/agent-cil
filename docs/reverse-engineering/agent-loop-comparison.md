# Agent Loop：旧版 2.1.88 与新版 2.1.304 的代码级对照

## 范围与结论

本轮直接读取上传样本中的旧版 TypeScript 和新版提取模块。结论限于静态调用关系；没有启动 CLI、发送模型请求或验证账号/组织 feature gate。

**核心循环的结构延续了旧版，但新版工具路由和工具执行状态更复杂。** 两侧都围绕“准备上下文 → 调用模型 → 消费 assistant/tool_use → 执行工具 → 追加 tool_result → 决定继续或结束”组织回合。不能因为文件布局或压缩符号变化就认定算法完全不同；也不能把旧版源码直接当作新版实现。

## 1. 主循环状态与边界

| 维度 | 旧版 CLI 2.1.88 | 新版 CLI 2.1.304 | 判断 |
| --- | --- | --- | --- |
| 入口与主循环 | reference-2.1.88/restored-src/src/query.ts：query() 约第 219 行；queryLoop() 约第 241 行 | cli-2.1.304/modules/chunk-smbjjyps.js：YL @135116；su @137532 | 职责对应清晰，符号名不对应 |
| 跨迭代状态 | State 包含 messages、toolUseContext、compact/recovery 状态、待完成 tool summary、stop hook 状态、turnCount 和 transition | su 初始化消息/上下文/回合状态；另有 query tracking、compact/repair 状态和更多会话/agent context 参数 | 新版状态面更宽；按行为映射，不逐字段强行对应 |
| 上下文准备 | getMessagesAfterCompactBoundary、用户上下文注入、预算/压缩和工具结果预算构造本轮输入 | su 准备消息并调用 I.autocompact；压缩后重组消息和追踪状态 | 两版的自动压缩都在实际执行路径中 |
| 模型调用 | deps.callModel(...) 以 for-await 消费模型流，传入 messages、system prompt、thinking config、tools、abort signal 和模型选项 | Td() 默认把 callModel 设为 zIt；chunk-4b60tdnk.js 中 zIt → mgn → Xmn，最终调用流式 beta.messages.create | 两侧都把 provider 请求置于循环依赖边界之后 |
| 工具流式执行 | config.gates.streamingToolExecution 决定是否创建 StreamingToolExecutor；另有 runTools 批执行路径 | class vs 是主循环使用的流式调度器候选；chunk-k3djx6vq.js 另有 vn/El 分组执行路径 | 旧版明确有 gate；新版具体分支仍取决于配置和调用上下文 |
| 结果回填 | 收集 assistant messages 与 tool results，递归进入下一轮；有中断、hook stop、prompt limit、max turns 等终止分支 | su 将 assistant/tool result 组合进下一轮 messages，并返回 next_round；也有 max-turns、abort 和 hook-stop 分支 | 回合推进和终止职责延续 |

## 2. 旧版的直接证据

### Query 状态与循环

来源：reference-2.1.88/restored-src/src/query.ts

- 第 219–239 行：query() 通过 yield* queryLoop(...) 产出事件，并在正常结束后处理命令生命周期。
- 第 241 行起：queryLoop() 解构 systemPrompt、userContext、systemContext、canUseTool、maxTurns 等输入。
- 第 203–217 行：State 显式记录跨迭代消息、上下文、compact/recovery 状态和 turn counter。
- 约 offset 21879：config.gates.streamingToolExecution 决定是否创建 StreamingToolExecutor。
- 约 offset 26465：主循环对 deps.callModel(...) 使用 for-await 消费模型流。
- 约 offset 29899：streaming fallback 时丢弃失败尝试的执行器并创建新执行器，避免旧 tool_use_id 的孤立结果进入新尝试。
- 约 offset 60042：工具执行中止后输出中断事实并检查 max turns。
- 约 offset 67747：追加工具结果后，在递归下一轮前检查 maxTurns。

### 工具调度

来源：reference-2.1.88/restored-src/src/services/tools/StreamingToolExecutor.ts

- 第 35–39 行注释描述执行模型：可并发工具可以一起运行；非并发工具需要独占执行；结果按工具接收顺序缓冲。
- 第 40 行定义 StreamingToolExecutor。
- 第 45–49 行有 sibling abort controller 与 discarded 状态；注释明确 sibling abort 不等于中止父 Query。
- 第 69–71 行 discard() 只设置 discard 状态；调用者负责处理失败尝试后的生命周期。
- 第 76 行 addTool() 查找工具定义；该方法中的未知工具分支立即生成错误 tool_result。这是该调度器路径的证据，不能外推成旧版所有 MCP 路径都没有动态发现。

来源：reference-2.1.88/restored-src/src/services/tools/toolExecution.ts

- runToolUse() 负责工具路由。
- streamedCheckPermissionsAndCallTool() 与 checkPermissionsAndCallTool() 将权限/hook 检查与实际工具调用区分开。

## 3. 新版的直接证据

### Query 与模型调用

来源：cli-2.1.304/modules/chunk-smbjjyps.js

- YL @135116 和 su @137532 是 query/agent 主循环候选入口。
- Td() @122660 默认提供 callModel: zIt、autocompact: rkr、uuid 和 now，表明模型与压缩行为通过依赖对象进入 query loop。
- su 中存在消息准备、自动压缩、模型调用、工具结果收集、下一轮消息构造与 max-turns/abort 分支。
- 约 @208776 的下一轮路径将已有 messages、assistant messages 与 tool results 组合后继续递归；next_round 是显式的内部循环结果。

来源：cli-2.1.304/modules/chunk-4b60tdnk.js

- @2743622 构造主请求参数，包含 model、messages、system、tools、tool choice、max tokens 与 thinking 等字段。
- @2780615 调用流式 beta.messages.create(..., stream: true)，这是主循环可达的真实流式请求点，不应与 token 计数或密钥校验请求混淆。
- @3957580 的 wG 处理工具名称/别名、工具缺失、MCP 工具等待和执行路由。
- @3967595 的 AYr 涉及 JSON/schema 校验、输入 coercion/repair、PreToolUse hook 与执行前校验。
- @3976664 的 Svr 计算权限决定；后续路径根据 allow/deny/ask 分支执行工具或生成错误结果。
- @3980050 附近的非 allow 路径会产生带原 tool_use_id 的错误 tool_result；@3985545 附近的 allow 路径才调用工具实现。

### 新版流式工具调度器

来源：cli-2.1.304/modules/chunk-smbjjyps.js，class vs @52975 附近。

新版调度器字段除工具列表和权限回调外，还包括 responseOpen、drainableResolve、drainGeneration、pendingBridgeEvents、contextLayers 等状态。discardAndAbortInFlight() 能区分已经完成、排队未开始和执行中的调用；执行中的工具有各自的 AbortController，返回被中止与已开始的 tool-use ID 集合。

这表明新版需要更精确地区分“模型响应仍在流式产生”“当前队列可排空”“工具正在执行”“结果已被消费”和“失败尝试被丢弃”等状态。它不等于所有工具都并发执行，也不意味着 abort 能撤销已发生的外部副作用。

### 动态 MCP 工具发现

来源：chunk-4b60tdnk.js @3957580 附近的 wG 路径：工具未找到时，若名称符合待连接 MCP 工具路径，则等待工具/连接状态变化；找到后用更新的工具集合重新路由，取消时返回相应的工具结果，等待失败后再走未知工具错误路径。

旧版 StreamingToolExecutor.addTool() 的本地查找失败会立即产生错误结果；但旧版 runToolUse() 和 MCP 服务管理仍有各自的动态连接逻辑。因此当前结论是**新版工具调度器路径中能观察到更明确的等待与重试路由**，不是已经证明动态 MCP 在整个产品中首次出现。

## 4. 已确认的行为差异与待确认事项

### 可以确认

1. 旧版主循环将流式工具执行作为 feature gate 控制的路径；新版提取模块具有更丰富的流式调度状态与 discardAndAbortInFlight()。
2. 新版工具缺失路径中存在针对待连接 MCP 工具的等待/重试逻辑。
3. 新版执行前路径可见输入 parse/schema/coercion/repair、hook 与权限决策阶段；非 allow 路径会构造可回填的 tool_result。
4. 两版都把工具结果与原始 tool_use_id 关联，并把结果纳入后续模型上下文。
5. 两版都有上下文压缩、取消与最大回合数控制；这些属于 Runtime 必须处理的语义，而不是 UI 可选项。

### 仍需逐项确认

- 新版每个调度状态的所有迁移条件、结果排序、yield/drain 与 streaming fallback 时序。
- 动态 MCP 等待的精确超时、连接状态与取消边界。
- 输入修复后权限检查是否在每条路径上重新执行，以及不同工具 schema 的 coercion 范围。
- permission ask 被拒绝、hook 阻止、输入无效、turn abort 与 session close 对下一轮和 tool_result 的区别。
- 新版 host handoff 分支与旧版远端/bridge 能力的完整对应关系。

## 5. 对独立 Agent CIL Runtime 的实现约束

不复制第三方模块实现；将观察到的行为转化为自有契约：

1. TurnLoop 只负责模型迭代、消息历史和终止原因，不把进程通信写进循环。
2. ToolDispatcher 分开处理 registry lookup、输入验证、权限决策、执行和结果归一化。
3. 每个工具调用有独立 ID、状态与取消信号；所有结果按该 ID 回填。
4. 工具拒绝、校验失败和执行失败必须能被模型看见，且不冒充成功。
5. “中止单个工具/控制回调”“中止当前 Turn”“关闭整个 Session/进程”必须是不同操作。
6. 流式调度和动态 MCP 等待应在基础闭环稳定后再接入，并用确定性测试覆盖竞态、取消与乱序结果。

## 6. 下一轮

1. 画出权限决策时序：CLI 规则 → SDK can_use_tool → Desktop broker → CLI 二次校验 → 执行/拒绝。
2. 对比旧新版模型请求参数构造、重试与流式 fallback，不把不同用途的 API 调用合并成一个请求。
3. 建立 Session ID、Query ID、Turn ID、control request_id 和 tool_use_id 的独立身份模型。
4. 基于 JSONL parser 与控制请求关联器，开始实现可由 fake CLI 驱动的进程 transport 测试。
