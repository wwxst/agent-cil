# 架构决策记录（ADR）

本文件记录 V2 已提出的关键取舍。状态为 **Proposed**，除非后续 RFC 或实现记录明确将其升级为 Accepted。

## ADR-001：以小核心 Agent Loop 为主导

**状态：Proposed**

决策：Agent Loop 只负责模型请求、工具批次和 Turn 终止编排。Provider、Context、Tool Runtime、Persistence、Approval 和 Host UI 都通过明确接口接入。

原因：避免旧版 AgentLoop 再次演化成同时协调权限、Hook、Shell、日志、Session 和 Provider 的超级类。

## ADR-002：Session Event Journal 是唯一事实来源

**状态：Proposed**

决策：持久事件为事实，消息数组和内存对象为投影。所有可恢复状态都必须能从事件日志和快照重建。

原因：消除多份消息状态和隐藏回调之间的不一致，统一 Resume、Fork、Replay、审计和成本统计。

## ADR-003：Thread / Turn / Step 作为正式生命周期层级

**状态：Proposed**

决策：Thread 表示长期会话，Turn 表示一次用户指令的完整工作，Step 表示一次模型请求及其工具批次。

原因：将“用户任务”和“模型请求次数”分开，支持长任务、审批暂停、Steering 和恢复。

## ADR-004：内部模型协议中立，Provider 状态原样保留

**状态：Proposed**

决策：Core 使用中立 Message / ContentBlock / ToolCall 表示；Provider-specific reasoning、签名和缓存状态作为不透明数据保留。

原因：减少单一厂商协议对内核的约束，同时避免把不透明推理状态错误转换成普通文本。

## ADR-005：所有副作用必须经过 Execution Guard

**状态：Proposed**

决策：原生工具、MCP 和插件工具统一经过参数校验、授权、审批和 Sandbox。

原因：工具来源不同不应形成安全旁路。权限审批和 OS 级隔离必须分别存在。

## ADR-006：不承诺任意工具 Exactly-once

**状态：Proposed**

决策：对无法确认执行结果的副作用记录 outcome_unknown，不自动重试。

原因：外部进程可能在副作用完成后、结果提交前崩溃。本地日志不能单独证明外部动作是否发生。

## ADR-007：扩展开放，但核心不变量不可插件化

**状态：Proposed**

决策：Provider、Context Strategy、Store、Tools、MCP、Skills 和 Hooks 可扩展；状态机、Event Journal 提交语义和 Execution Guard 不可绕过或替换。

原因：防止扩展生态把内核安全边界变成可选策略。

## ADR-008：先做单机可靠内核，再扩展分布式能力

**状态：Proposed**

决策：初期采用 TypeScript / Node.js Workspace，先验证单机 Session、工具执行、Sandbox 和恢复；暂不优先建设多 Agent、分布式调度和 PTC。

原因：先建立可以被故障注入验证的状态与副作用语义，再讨论规模化部署。