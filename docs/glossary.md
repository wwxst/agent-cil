# 术语表

| 术语 | 含义 |
| --- | --- |
| Agent Loop | 负责模型请求、工具执行和下一轮判断的最小编排循环 |
| Approval | 对一项精确工具调用和输入的用户/宿主确认 |
| Attempt | 一次模型请求或工具执行尝试 |
| Command | 外部发出的操作意图，尚不代表已经发生 |
| Context Compaction | 将完整历史压缩为更短模型上下文视图的过程 |
| Context Projection | 从事件日志构建模型可见消息历史 |
| Event Journal | 仅追加的持久领域事件日志 |
| Execution Guard | 所有工具副作用必须经过的安全强制入口 |
| Follow-up | 当前 Turn 完成后排队开始的新 Turn |
| Fork | 从历史节点创建新 Thread，不继承旧授权和运行进程 |
| MCP | Model Context Protocol；一种工具接入与传输协议 |
| Outcome Unknown | 无法确认工具副作用是否完成的状态 |
| Provider Adapter | 负责具体模型 API 请求、流解析和语义映射的适配器 |
| Provider Replay State | Provider 专属且可能不透明的推理/签名/缓存回放状态 |
| Sandbox | 对文件、进程、网络和资源施加实际限制的执行环境 |
| Session | Thread 及其事件、状态投影和存储上下文的运行容器 |
| Step | Turn 内一次模型请求及其工具执行批次 |
| Steering | 在当前安全边界后向正在执行的 Turn 追加指令 |
| Thread | 可持续包含多个 Turn 的长期会话 |
| ToolCall | 模型提出的一次工具调用请求 |
| Turn | 一次用户指令触发的完整 Agent 工作 |
| Projection | 由持久事件计算出来的可读状态视图 |
| Exactly-once | 某项副作用恰好执行一次；对任意外部工具通常无法仅靠本地日志保证 |