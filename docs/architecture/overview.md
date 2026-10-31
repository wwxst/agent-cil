# V2 总体架构

## 1. 架构总览

~~~text
CLI / Headless / SDK
        │
        ▼
   Command Bus
        │
        ▼
 Session Controller ─────────────── Session Store
   Thread / Turn / Step                    │
        │                                  ▼
        ├─────────────── Event Journal ◄───┘
        │                    │
        ▼                    ▼
    Agent Loop          State Projections
        │
        ├──────── Context Engine
        │      History Projection
        │      Relevance Selection
        │      Token Budget
        │      Compaction
        │      Provider Serialization
        │
        ├──────── Model Gateway
        │      Provider Adapters
        │      Neutral Message Model
        │      Provider Replay State
        │
        └──────── Tool Runtime
                   Registry / Scheduler
                          │
                          ▼
                    Execution Guard
                    Schema / Policy
                    Approval / Sandbox
                    Process / Workspace
                          │
              ┌───────────┼───────────┐
              ▼           ▼           ▼
           Built-ins     MCP       Extensions
~~~

## 2. 组件职责

| 组件 | 唯一职责 | 不应该承担的职责 |
| --- | --- | --- |
| Command Bus | 接收 start、steer、follow-up、interrupt、approval、resume 等命令 | 直接改写模型消息数组或执行工具 |
| Session Controller | 管理 Thread / Turn / Step 生命周期和合法状态转换 | 实现 Provider、Shell 或 CLI UI |
| Agent Loop | 编排模型请求、工具批次和终止判断 | 写日志、审批、直接启动子进程 |
| Event Journal | 追加已提交的领域事件并提供有序读取 | 执行事件所描述的副作用 |
| State Projection | 从事件重建 Session、Turn、ToolCall 和统计视图 | 成为第二份权威状态 |
| Model Gateway | 将中立请求交给 Provider，并将响应归一化 | 决定工具是否有权限执行 |
| Context Engine | 从事件投影生成有预算的模型上下文 | 删除或改写完整事件历史 |
| Tool Runtime | 注册工具、规范化调用、调度批次并收集结果 | 绕过 Execution Guard 执行 |
| Execution Guard | 强制参数校验、授权、审批和 Sandbox | 依赖模型自觉遵守提示词 |
| Extension Host | 管理扩展依赖、注册和卸载生命周期 | 覆盖核心状态机和安全入口 |
| Session Store | 持久化事件、快照和恢复所需元数据 | 与 Event Journal 并行维护另一份事实 |

## 3. 主要数据流

### 模型请求

1. Session Controller 确认当前 Turn 可运行。
2. Context Engine 从已提交事件和当前 Turn 投影构建上下文。
3. Model Gateway 选择 Provider Adapter 并发起请求。
4. Provider Adapter 将流式事件转换为中立响应块。
5. Agent Loop 提交完整 Assistant 响应，或记录未完成的 Attempt。
6. 若有工具调用，交给 Tool Runtime。

### 工具执行

1. Tool Runtime 解析工具名和参数。
2. Execution Guard 规范化参数、执行 Schema 校验和权限判定。
3. 需要用户确认时，Session Controller 将 Turn 挂起并等待审批命令。
4. 执行意图先持久化，再由 Sandbox/Process Manager 执行。
5. 工具结果经过确认和归一化后提交事件。
6. Context Engine 将匹配的 tool_result 投影到下一次模型上下文。

### 恢复

1. 从 Event Journal 读取最后一个有效序号。
2. 重建 Session、Turn、Step 和 ToolCall 投影。
3. 对处于执行中但没有结算事件的调用标记结果未知。
4. 不自动重新执行结果未知的副作用。
5. 只有明确可安全重试的操作，才按工具声明和恢复策略处理。

## 4. 依赖方向

- Core 只依赖自有 protocol/type 契约。
- Provider SDK 只出现在 providers 适配层。
- Shell、文件系统和进程实现只出现在 execution adapters。
- CLI、Headless 和 SDK 是外部 host，不反向成为 Core 的依赖。
- Extension API 只能调用公开服务，不能访问或修改内部状态投影。

## 5. 部署形态

初期使用一个 TypeScript / Node.js Workspace 即可。模块边界先通过目录、接口和依赖规则表达，不要求立即拆成多个独立发布的 npm 包。

同一个内核可由 CLI、Headless Worker 或 SDK 驱动；不同 Host 可以提供不同的 Approval UI、Workspace、Sandbox 和凭证存储，但必须遵循同一执行契约。