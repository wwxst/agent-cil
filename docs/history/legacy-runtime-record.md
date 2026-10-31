# 旧版 Agent CIL Runtime 与 CLI 历史记录

> 本文记录旧代码仓库中曾实现或验证过的行为，作为 V2 设计经验。它不是 V2 的实现说明，也不表示这些代码仍保留在当前文档分支中。

## 1. 历史技术路线

旧版项目最初以独立 Node.js CLI 为目标，围绕自有 AgentLoop、Anthropic Messages SSE Adapter、ToolRegistry、权限策略和 Session 原型建立最小可运行闭环。随后逐步引入 2.1.88 的部分执行语义。

早期方向曾强调尽量复用旧版成熟源码、避免从零重建 Runtime；V2 架构决策后来明确允许破坏性重构，不再以旧 AgentLoop + legacy-query 的内部接口作为约束。这是路线变化，不应把两份文档混为同一阶段。

## 2. 已记录的实现里程碑

| PR | 历史内容 | 可保留的工程经验 |
| --- | --- | --- |
| #9 | updatedInput 变更后的 schema 复验与重新授权 | 授权必须绑定最终输入；输入变化必须重新校验和授权 |
| #11 | 固定来源旧 CLI 的版本快路径隔离冒烟 | 版本快路径测试不等于完整 CLI 验收 |
| #13 | 第一版可执行 CLI、模型流、多轮工具回填和基础工具 | 先做可安装、可测试的最小闭环 |
| #14–#18 | 权限上下文、流式工具调度、runToolUse 桥接、权限规则和执行前校验 | 调度、授权、schema 和实际执行要分层 |
| #19 | tool-specific permission 决策阶段 | 工具级策略不能覆盖全局 deny，也不能放宽全局 ask |
| #20 | Tool.call 与结果映射 | 工具结果需要统一校验、大小限制和 tool_use ID 配对 |
| #21 | Query / queryLoop 的消息与工具循环语义 | 实际 tool_use block 比单独 stop_reason 更能说明是否需要继续 |
| #22 | 模型请求重试与 transport 子集 | 只重试安全的响应前失败；流开始后重放可能重复副作用 |
| #25 | Thinking / signature / redacted-thinking 流处理 | 不透明推理状态应按 Provider 规则保留；不能打印或伪造签名 |
| #26 | Read / Glob / Grep 的安全流式调度 | 预执行只允许明确只读且可验证的工具；写操作必须等待完整校验 |
| #27 | 完成工具批次后的交互式恢复检查点 | 已完成副作用不能因后续模型失败而被要求重做 |
| #29 | DeepSeek 上下文自动压缩 | 只压缩完整 API round；摘要失败不得破坏旧历史 |
| #30 | Prompt-too-long 的响应前压缩恢复 | 只对明确的响应前 context length error 尝试安全压缩 |

## 3. 历史行为约束

以下经验对 V2 仍然有价值：

- 默认拒绝未知工具和没有审批处理器的 ask。
- 输入 schema 校验发生在权限决策之前。
- 权限或审批返回 updatedInput 后，必须重新校验并重新授权。
- 拒绝、校验失败和执行异常必须产生模型可见错误结果。
- tool_use_id 与 tool_result 必须正确配对。
- 工具取消、Turn 中断和 Session/进程关闭必须区分。
- 写入、编辑和 Bash 默认采用保守的互斥调度。
- 模型流已经开始后，不应无条件重放请求。
- Compaction 不得拆散工具调用和结果配对。
- 工具副作用可能发生在失败记录提交之前，不能承诺任意命令 Exactly-once。

## 4. 历史验证记录

旧文档记录了以下验证类型：
- Node.js 单元测试和集成测试。
- 本地确定性 SSE fixture 驱动的真实 CLI 子进程。
- npm tarball 打包、安装和安装后命令验收。
- TTY 场景下用户批准 Bash 的端到端测试。
- Windows 子进程启动与清理回归。
- Session turn journal 和中断恢复测试。

这些验证不能相互替代。Local fixture 验证协议和执行边界，不证明真实 Provider 兼容。

## 5. DeepSeek 实际 API 验收记录

旧文档记录 PR #25 在 2026-10-23 对 DeepSeek 官方 Anthropic-compatible endpoint 进行过一次凭证化测试：

- 测试 commit：562bfb674e4791b51955c454e758c5c907855061。
- 环境：Windows，Node.js v24.13.1。
- Endpoint：DeepSeek Anthropic-compatible API。
- Model：deepseek-flash。
- 结果：流式响应通过；Read → Edit → Read 编程任务通过；测试确认了实际文件内容。
- 当次 Windows 运行使用临时验证脚本调整，将 Node CLI 入口交给 process.execPath 启动；提示、模型参数和验收断言未改变。
- 同一 commit 的测试报告为 206 tests，199 passed、7 skipped、0 failed。

之后文档记录了永久 Windows launcher 修复和无凭证回归测试。永久修复的 fixture 测试不是第二次凭证化 DeepSeek 验收。

该记录只适用于所列 commit 和环境，不能外推为当前 main、V2 或所有 Provider 均已通过真实验收。

## 6. 尚未形成证据的事项

现有文档没有提供：
- 当前 V2 Runtime 的实际实现或 Benchmark。
- 当前 V2 与 Pi / Codex 的同条件 Coding 能力对比。
- OpenAI 真实凭证化端到端验收记录。
- 当前 main 的完整 Anthropic 真实服务验收记录。
- 对所有 Host / VM / SSH 路径的动态兼容验证。

应将这些事项保持为待验证，不用历史测试填补证据空白。