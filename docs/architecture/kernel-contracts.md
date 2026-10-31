# Kernel Contract：核心类型与协议草案

> 本文是 V2 契约草案。正式实现前应通过 RFC 评审冻结字段、错误码和兼容策略。

## 1. 核心实体

~~~ts
interface Thread {
  threadId: string;
  createdAt: string;
  forkedFrom?: { threadId: string; eventSeq: number };
}

interface Turn {
  turnId: string;
  threadId: string;
  status: TurnStatus;
  startedAt: string;
  completedAt?: string;
}

interface Step {
  stepId: string;
  turnId: string;
  attemptIds: string[];
  toolCallIds: string[];
}

interface ToolCall {
  toolCallId: string;
  turnId: string;
  stepId: string;
  name: string;
  input: unknown;
}
~~~

## 2. Command

Command 是外部意图，不是已经发生的事实。

~~~ts
type KernelCommand =
  | { type: "turn.start"; threadId: string; input: UserInput }
  | { type: "turn.steer"; turnId: string; instruction: string }
  | { type: "turn.follow_up"; threadId: string; input: UserInput }
  | { type: "turn.interrupt"; turnId: string; reason?: string }
  | { type: "approval.respond"; approvalId: string; decision: ApprovalDecision }
  | { type: "thread.resume"; threadId: string }
  | { type: "thread.fork"; threadId: string; eventSeq: number };
~~~

## 3. Event

持久事件采用统一信封：

~~~ts
interface KernelEvent<T> {
  eventId: string;
  sessionId: string;
  seq: number;
  schemaVersion: number;
  type: string;
  timestamp: string;
  correlationId?: string;
  causationId?: string;
  payload: T;
}
~~~

事件类型按领域拆分，建议使用 turn.started、step.started、model.completed、tool.requested、tool.approved、tool.started、tool.settled、tool.outcome_unknown、context.compacted 和 turn.completed 等类型。

实时 UI 事件可以比持久事件更细，但不能被误认为已提交事实。

## 4. Model Contract

~~~ts
interface ModelRequest {
  providerHint?: string;
  model?: string;
  messages: NeutralMessage[];
  tools: ToolDefinition[];
  signal: AbortSignal;
  metadata?: RequestMetadata;
}

interface ModelResponse {
  provider: string;
  model: string;
  blocks: ContentBlock[];
  toolCalls: ToolCall[];
  usage?: TokenUsage;
  stopReason: StopReason;
  providerState?: ProviderReplayState;
}
~~~

## 5. Tool Contract

~~~ts
interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  capabilities: Capability[];
  concurrency: "safe" | "exclusive" | "serialized";
  execute(input: unknown, context: ToolExecutionContext): Promise<ToolResult>;
}
~~~

ToolDefinition 描述工具能力，不代表授权。是否可以执行由 Execution Guard 根据当前用户、workspace、策略和审批状态决定。

## 6. Error Contract

错误必须携带稳定类别、可诊断信息和是否允许安全重试的标记。

建议类别：
- VALIDATION_FAILED；
- PERMISSION_DENIED；
- APPROVAL_REQUIRED；
- APPROVAL_STALE；
- SANDBOX_VIOLATION；
- PROVIDER_AUTH；
- PROVIDER_RATE_LIMIT；
- PROVIDER_TRANSIENT；
- PROVIDER_CONTEXT_LIMIT；
- PROVIDER_PROTOCOL；
- TOOL_EXECUTION_FAILED；
- TOOL_OUTCOME_UNKNOWN；
- SESSION_CONFLICT；
- SESSION_CORRUPT；
- TURN_INTERRUPTED；
- EXTENSION_DEPENDENCY_FAILED。

错误文案可本地化，机器判断依赖稳定 code，不应解析自然语言。

## 7. 兼容策略

- 所有持久事件带 schemaVersion。
- 协议字段默认向后兼容；删除或改变语义需要新版本。
- 未知事件可被保存，但只有可识别且满足安全要求的事件才能驱动副作用。
- 未知工具能力默认按不可信处理。
- Provider-private state 不做通用反序列化。