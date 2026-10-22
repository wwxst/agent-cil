# Agent CIL

独立重建通用 Agent 客户端的研究与实现仓库。当前阶段以 **静态证据整理、旧新版映射和最小可验证实现** 为主；不把逆向样本直接当成可构建的产品工程。

## 目标

- 以 Claude Desktop 3.1623.1 / Claude Code CLI 2.1.304 的逆向资料为新版主要证据。
- 以旧版 CLI 2.1.88 的恢复源码和 Source Map 辅助理解模块职责与演进。
- 参考既有项目 [agent-desktop](https://github.com/wwxst/agent-desktop) 的产品需求和工程经验，但不把旧客户端架构当作新客户端的硬性约束。
- 通过独立设计实现会话生命周期、流式事件、工具调用、权限审批、MCP 和本地运行时。
- 每个阶段有清晰的文档、代码、测试和可审查的 Git 提交。

## 逆向基线

| Component | Version / scope |
| --- | --- |
| Claude Desktop sample | 3.1623.1 |
| Embedded SDK wrapper | 0.3.304 |
| CLI build pin | 2.1.304 (win32-x64) |
| Reference CLI | 2.1.88 |
| Current phase | Static baseline; no standalone rebuild yet |

新版资料包报告的主要调用链为：

~~~text
Desktop UI / IPC → local session manager → SDK Query → process transport → CLI
~~~

SDK 与 CLI 通过 stdin/stdout 上的 JSON Lines 消息交互。CLI 内部承担 Agent 循环、模型请求、工具调度和上下文处理；桌面层负责会话管理、权限回调、凭证刷新和运行环境适配。Host、VM、SSH/WSL 是需要分别验证的运行分支，不能混为单一路径。

## 文档导航

- [逆向基线与样本清单](docs/reverse-engineering/baseline.md)
- [新版架构与协议摘要](docs/reverse-engineering/architecture.md)
- [SDK ↔ CLI 协议契约](docs/reverse-engineering/protocol-contracts.md)
- [旧新版职责映射](docs/reverse-engineering/symbol-map.md)
- [工具执行路径对照](docs/reverse-engineering/tool-execution-comparison.md)
- [旧新版对照矩阵](docs/reverse-engineering/old-new-comparison.md)
- [阶段计划与验收标准](docs/roadmap.md)

## 参考资料

- [新版逆向资料包的来源仓库](https://github.com/wwxst/agent-cil)（本仓库）
- [旧版 CLI 2.1.88 参考源码](https://github.com/wwxst/-)
- [既有 Agent Desktop 项目](https://github.com/wwxst/agent-desktop)

## 研究边界

本仓库只提交原创分析、接口契约、独立实现与测试。不要提交整份逆向压缩包、第三方可执行文件、提取的第三方源码/Source Map、凭证、个人数据或运行时缓存。引用样本时记录版本、路径、哈希和证据等级；遵守适用的软件许可、服务条款和法律要求。对静态代码只能陈述静态证据支持的结论，未经动态验证的分支必须标记为“待验证”。

## 当前状态

- [x] 确认新旧样本版本与资料包结构
- [x] 整理新版本地 Agent 调用链的首轮结论
- [ ] 完成旧版与新版的符号/职责映射
- [ ] 定义独立 Runtime 与 Session 契约
- [ ] 实现并测试最小流式 Agent 闭环
