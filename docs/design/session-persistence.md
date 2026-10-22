# Session / Turn Persistence — 实现契约

## 数据模型

Session 记录具有独立的 session ID、revision、status、createdAt/updatedAt、metadata、已提交 messages、成功 user turn 数、累计 model round 数，以及 turns journal。每个 journal entry 有独立 turn ID、input、status、startedAt/completedAt、结果摘要或错误。

Tool-use ID 来自模型流；control request ID 由协议层生成。它们与 session ID 和 turn ID 不共用命名空间或字段。

## 存储契约

- `InMemorySessionStore` 与 `FileSessionStore` 实现 create/get/save/delete。
- save 使用 expectedRevision 做乐观并发检查；过期写入抛出 SessionConflictError。
- 文件存储按 session ID 生成 JSON 文件名，拒绝路径分隔符与不安全字符。
- 文件写入先落临时文件并 fsync，再以 link（创建）或 rename（更新）提交，避免读取半写入的 JSON。
- 文件权限使用受限创建模式，但现有目录权限仍由宿主负责。
- FileSessionStore 是单写进程契约；它不声称实现跨进程分布式锁。

## Turn 生命周期

1. run 前检查 Session 为 active，且当前 manager 没有正在执行的 turn。
2. 先将 turn journal 写成 running，再调用 AgentLoop。
3. 成功时原子提交完整消息历史、stop reason 摘要、user turn 计数与累计 model round 计数。
4. 失败或取消时记录 failed/cancelled 状态和错误，不把未完成的对话历史当作已提交历史。
5. 重启后，宿主可在确认旧进程已退出后调用 recoverInterruptedTurns，将残留 running 标记为 interrupted。
6. close 阻止新 turn；delete 需要 revision 匹配。

## 语义边界

持久化 turn journal 不等于 exactly-once 执行。工具可能已经产生外部副作用，而进程在保存结果之前崩溃。系统不会自动重放失败或 interrupted turn；宿主应先检查副作用，再决定是否重试。

文件内容为明文 JSON，可能含用户输入、工具输出和敏感上下文。目录、加密、保留期、密钥轮换和日志脱敏由宿主配置。当前 manager 通过单个 AgentLoop 串行执行 turn，不支持同一个 manager 内并行 turn。

## 测试

自动化测试覆盖 warm 多轮历史、全新 manager 从文件恢复、revision 冲突、失败 turn 日志、interrupted turn reconciliation、关闭与删除，以及不安全 session ID。
