# Agent CIL V2 实施路线图

## 总体策略

先冻结契约，再实现最小闭环；先保证状态提交和安全恢复，再扩展模型、工具并发和插件能力。

本路线图描述目标顺序，不表示任何阶段已经完成。

## Phase 0：文档与架构基线

- [x] 汇总旧仓库文档、历史实现记录和参考架构研究。
- [x] 明确 V2 目标架构与旧实现边界。
- [ ] 评审 Kernel Contract RFC。
- [ ] 冻结事件 envelope、ID 空间、状态机和错误分类。
- [ ] 完成第三方来源与许可审查。

验收：所有核心术语一致；目标设计、历史观察和已验证事实明确区分。

## Phase 1：Protocol 与 Session Controller

- 定义 Command、Event、Thread、Turn、Step 和 ToolCall 类型。
- 实现状态机与合法状态转换。
- 实现 Command Bus、取消、审批暂停、Steering 和 Follow-up。
- 建立单一 Session 状态投影。

验收：CLI/Headless/SDK 可通过统一命令启动、追加指令、取消和恢复；不需要直接修改消息数组。

## Phase 2：Event Journal 与恢复

- 实现 append-only Event Store。
- 实现序号、schema version、correlationId 和 causationId。
- 实现快照、投影重建和 Fork。
- 定义工具执行意图、开始、结算和 outcome_unknown。
- 注入崩溃测试，验证提交边界。

验收：恢复能区分未执行、已执行和结果未知；Replay 不会调用模型或工具。

## Phase 3：Model Gateway 与 Agent Loop

- 实现中立 Message / ContentBlock / ToolCall。
- 接入 Anthropic Messages、OpenAI Responses 和 OpenAI-compatible Chat。
- 保留 Provider-private replay state。
- 实现流式事件、错误分类、usage、stop reason 和取消。
- 实现不依赖 CLI 的 Agent Loop。

验收：三类协议通过契约测试；多轮工具调用配对正确；断流和错误不提交不完整响应。

## Phase 4：Tool Runtime 与 Execution Guard

- 实现工具注册、Schema、Value Validation 和调度。
- 实现 allow / deny / ask 与精确输入绑定的审批。
- 输入变更后重新校验和重新授权。
- 建立 Sandbox、Process Manager 和 Workspace。
- 接入 Read、Write、Edit、Bash 等基础工具，再扩展搜索工具。

验收：未经授权的工具不能产生受保护副作用；Sandbox 实际限制资源；崩溃后不自动重放不确定操作。

## Phase 5：Context Engine

- 实现历史投影、相关性选择和 token budget。
- 实现工具结果截断与引用。
- 实现事务式 Compaction。
- 保留完整事件日志和 Provider 原生状态。
- 验证长任务压缩、恢复和 Fork 连续性。

验收：压缩不会拆散工具调用结果；失败摘要不破坏旧上下文；恢复后模型看到的上下文可追溯。

## Phase 6：Extensions 与 Host 接入

- 实现 Provider / Context / Store 服务注册。
- 接入 MCP、Skills 和 Hooks。
- 建立插件依赖验证和资源卸载。
- 以 CLI、Headless 和 SDK 作为同一内核的不同 Host。

验收：替换 Provider、Store 或 Context Strategy 不需要修改 Agent Loop；扩展不能绕过安全入口。

## Phase 7：Benchmark 与发布

- 选择跨文件修改、测试修复、仓库搜索、长会话、断流和崩溃恢复任务。
- 在相同模型、任务集、预算和环境下比较旧基线与 V2。
- 记录成功率、成本、延迟、工具调用和恢复正确性。
- 完成许可证、依赖、凭证和日志审计。

验收：Coding 成功率不低于旧基线；安全和恢复硬性门槛全部通过。

## 明确延期

在 Phase 0–5 稳定前，不优先建设多 Agent、动态插件生成、PTC、分布式执行和复杂的自动规划系统。