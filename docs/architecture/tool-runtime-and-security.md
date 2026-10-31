# Tool Runtime 与 Execution Guard

## 1. 目标

Tool Runtime 负责工具注册、调用归一化、批次调度和结果收集。Execution Guard 是所有副作用的强制边界。

原生工具、MCP 工具和插件工具必须走同一安全入口，不能由插件或 Provider 直接启动 Shell、写文件或访问受保护资源。

## 2. 统一执行管线

~~~text
Model ToolCall
  → Registry Lookup
  → 参数解析与规范化
  → JSON Schema / Value Validation
  → Permission Policy
  → Ask / Approval（如需要）
  → 输入变更后的重新校验与重新授权
  → 执行意图持久化
  → Sandbox / Process Manager
  → 执行结果确认
  → ToolResult 归一化与持久提交
  → 下一轮 Context Projection
~~~

每一步都应产生可测试的结果和明确错误类型。

## 3. 授权语义

建议使用 allow / deny / ask 三类决定：

- allow：仅允许执行被检查的精确输入和能力范围。
- deny：终态拒绝，不能被后续输入改写或插件覆盖。
- ask：需要用户或宿主显式批准；未配置审批处理器时 fail closed。

授权必须绑定：
- toolCallId；
- 规范化后的输入摘要；
- workspace / resource scope；
- 所需 capability；
- approvalId 和有效期（如有）。

如果审批返回 updatedInput，必须重新执行 Schema 校验、Value Validation 和 Permission Policy。输入改变后不能沿用旧输入的授权结论。

## 4. Approval 与 Sandbox 不可互相替代

Approval 解决“用户是否同意这次操作”。

Sandbox 解决“即使工具或模型行为异常，进程实际能访问什么”。

Sandbox 应尽可能通过操作系统或受控运行环境限制：
- 可读写目录；
- 进程创建与子进程树；
- 网络出口；
- 环境变量与凭证可见性；
- CPU、内存、执行时间和输出大小；
- 工作目录和挂载边界。

仅在 UI 上弹出确认，不构成 Sandbox。仅把命令字符串做 allowlist，也不能替代文件系统和进程隔离。

## 5. 调度策略

初始策略采用保守调度：

- 明确只读且声明 concurrency-safe 的工具可并发。
- Write、Edit、Bash 和其他副作用操作默认串行或独占。
- 未知工具不自动获得并发资格。
- 工具结果按原 toolCall 顺序回填，除非协议明确支持并验证其他顺序。
- 一个工具失败导致 sibling abort 时，要区分尚未开始、正在执行和已完成的调用。
- 已完成的副作用不能因为 sibling abort 而从历史中删除。

流式预执行不是第一阶段能力。只有工具被明确声明为只读、权限决策不依赖不完整消息、输入不可变且取消可验证时，才考虑提前执行。

## 6. 取消与结果状态

取消工具执行不保证撤销外部副作用。

ToolCall 状态至少需要表达：
- requested；
- validated；
- awaiting_approval；
- approved / denied；
- intended；
- started；
- settled；
- cancelled_before_start；
- outcome_unknown。

如果进程已启动但未收到可靠结算，恢复时应标记 outcome_unknown，不盲目重试。

## 7. 工具结果契约

无论成功、拒绝、输入错误还是执行异常，都必须产生与原 toolCallId 对应的明确结果，或者记录尚未能生成结果的终态事件。

模型可见结果应：
- 明确区分成功与错误；
- 控制输出大小；
- 脱敏凭证和敏感数据；
- 保留必要结构化内容；
- 对超大结果使用受控引用，而不是无限扩张上下文。

## 8. 插件与 MCP

MCP 只是工具接入方式，不是安全策略。MCP server 的工具执行也必须经过统一权限和 Sandbox。

插件可以注册工具描述和执行适配器，但不能自行宣布自己可信、跳过授权、直接写 Session Journal 或替换 Execution Guard。