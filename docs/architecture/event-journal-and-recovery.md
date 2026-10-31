# Event Journal 与故障恢复

## 1. 核心原则

**事件日志是事实，消息历史和运行状态是投影。**

Session 的持久状态由仅追加的类型化事件构成。内存中的 Thread、Turn、Step、Message 和 ToolCall 对象都可由事件重建，不应成为第二份独立权威状态。

## 2. 事件信封

每条持久事件至少包含：

~~~ts
interface EventEnvelope<T> {
  sessionId: string;
  seq: number;
  schemaVersion: number;
  eventId: string;
  type: string;
  timestamp: string;
  correlationId?: string;
  causationId?: string;
  payload: T;
}
~~~

约束：

- seq 在同一 Session 内严格递增。
- eventId 全局唯一。
- schemaVersion 用于事件格式演进。
- correlationId 关联一次跨组件工作。
- causationId 指向触发当前事件的事件。
- 事件提交后不可原地修改；更正通过追加新事件表达。

## 3. 核心事件类型

建议的事件集合：

~~~ts
type SessionEvent =
  | { type: "turn.started"; turnId: string }
  | { type: "turn.steered"; turnId: string; instruction: string }
  | { type: "step.started"; turnId: string; stepId: string }
  | { type: "model.attempt.started"; attemptId: string }
  | { type: "model.completed"; attemptId: string; responseRef: string }
  | { type: "model.failed"; attemptId: string; error: RuntimeError }
  | { type: "tool.requested"; call: ToolCall }
  | { type: "tool.approved"; approvalId: string; inputDigest: string }
  | { type: "tool.denied"; callId: string; reason: string }
  | { type: "tool.execution.intended"; callId: string; inputDigest: string }
  | { type: "tool.started"; callId: string; executionId: string }
  | { type: "tool.settled"; callId: string; resultRef: string }
  | { type: "tool.outcome_unknown"; callId: string; reason: string }
  | { type: "context.compacted"; snapshotRef: string }
  | { type: "turn.completed"; turnId: string }
  | { type: "turn.interrupted"; turnId: string; reason: string };
~~~

以上是 V2 契约草案。最终事件 schema 应在 Kernel Contract RFC 中冻结，并为 payload 设计独立版本策略。

## 4. 持久事件与临时流事件

不需要把每个 Token 都同步写入持久日志。

- text_delta、临时进度、UI 动画等可作为实时流事件发送。
- 完整模型响应、工具执行意图、工具启动/结算、审批决定、Turn 终态和压缩提交属于持久化边界。
- 未完成模型流可记录为 Attempt failed/interrupted，但不能伪装成已提交的完整 Assistant 响应。
- 实时流丢失不能导致持久状态无法恢复。

## 5. 工具副作用与 Exactly-once

任意 Bash 或外部工具都无法仅靠本地日志保证 Exactly-once。

典型崩溃窗口：

1. 写入 tool.execution.intended。
2. 启动外部进程。
3. 外部进程完成写文件或远程副作用。
4. 进程在提交 tool.settled 前崩溃。

恢复时无法仅凭日志判断步骤 3 是否发生。因此：

- 已有 settled 事件：恢复为已完成，不重新执行。
- 只有 intended、没有 started：可根据执行适配器证据判断是否尚未启动。
- 有 started、没有 settled：默认标记 outcome_unknown。
- outcome_unknown 不自动重试，除非工具具有可验证的幂等键或外部状态检查机制。

## 6. Replay 与 Projection

Replay 的含义是重建状态，不是重新执行工作。

恢复流程：

1. 读取最后一个完整提交的事件序号。
2. 校验事件版本和序号连续性。
3. 从快照加载基础投影（若存在）。
4. 顺序应用后续事件，重建 Session、Turn、Step 和 ToolCall。
5. 检查未结算的执行意图。
6. 将不确定副作用标记为 outcome_unknown，并等待人工或专用恢复策略。

禁止在事件回放时重新调用模型或 Bash。

## 7. 快照和存储

- Event Store 负责追加和读取事件。
- Session Store 保存快照、索引和恢复元数据。
- 快照必须记录所覆盖的 eventSeq。
- 快照损坏时可回退到更早快照或从头投影。
- 初期可以使用单机文件或 SQLite；存储实现不能改变事件提交语义。
- 并发写入需要 revision / compare-and-swap 或事务，不能只依赖进程内锁。

完整事件日志与模型上下文压缩是两件事：压缩不能删除事实日志。