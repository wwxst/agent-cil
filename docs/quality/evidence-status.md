# 证据与验证状态

## 1. 证据等级

后续研究和实现记录统一使用：

| 标签 | 含义 |
| --- | --- |
| Confirmed / Static | 在指定样本静态代码中找到可定位的实现与调用路径 |
| Reported | 来自资料包或历史报告，本轮未重新执行 |
| Tested / Fixture | 在确定性本地 fixture 或模拟服务上验证 |
| Tested / Live | 使用真实凭证连接真实 Provider 并完成指定验收 |
| Inferred | 根据结构或调用关系推断，仍需更直接证据 |
| Pending | 尚未验证 |
| Unknown | 现有材料不足以回答 |

## 2. V2 状态

| 能力 | 当前文档状态 |
| --- | --- |
| V2 总体架构 | 已形成设计草案 |
| Kernel Contract | 草案，待 RFC 冻结 |
| Thread / Turn / Step | 已定义目标模型，未实现 |
| Event Journal | 已定义目标语义，未实现 |
| Model Gateway | 已定义目标契约，未实现 |
| Execution Guard / Sandbox | 已定义目标边界，未实现 |
| Context Engine | 已定义目标流水线，未实现 |
| Extension Host | 已定义目标边界，未实现 |
| V2 Benchmark | 尚无结果 |

本分支是文档仓库，不包含可执行 V2 Runtime。

## 3. 历史代码验证记录

旧仓库文档曾记录 Node.js 单元/集成测试、本地 SSE fixture、npm tarball 安装、TTY Bash 审批、Windows launcher 和 Session 恢复测试。

这些测试证明的是所测试 commit 中对应的自有代码行为，不自动证明第三方 CLI 完整兼容，也不证明当前 V2 已实现。

## 4. 历史 DeepSeek Live 记录

历史 PR #25 文档记录了一次 DeepSeek 真实 API 验收：
- commit：562bfb674e4791b51955c454e758c5c907855061；
- 时间：2026-10-23；
- 环境：Windows / Node.js v24.13.1；
- 结果：流式请求和 Read → Edit → Read 任务通过；
- 当次 Windows 运行使用临时验证脚本调整启动 Node CLI 的方式；
- 同一 commit 的测试记录为 206 total、199 passed、7 skipped、0 failed。

后续永久 Windows launcher 修复的回归测试使用本地 fixture，不是第二次真实凭证化验收。

## 5. 尚无证据支持的结论

现有材料不支持以下结论：
- V2 已经实现或可以运行。
- V2 的 Coding 能力已经超过 Pi、Codex 或 DSH。
- 当前 main 已通过所有真实 Provider 验收。
- OpenAI 已完成真实凭证化 Coding 任务验收。
- 所有 Claude Code / Desktop 的 Host、VM、SSH 路径均已动态验证。
- 任意 Bash 或第三方工具可实现 Exactly-once。

## 6. 更新规则

每条验证记录应附：
- 被测 commit；
- 操作系统和 Runtime 版本；
- Provider / model / endpoint（不含凭证）；
- 测试任务和工具权限；
- 结果、退出码和失败情况；
- 是否使用 fixture 或真实服务；
- 是否有临时修改；
- 可复现的测试命令和日志位置（需脱敏）。

不得把旧 commit 的通过结果自动标记为当前分支或当前主线通过。