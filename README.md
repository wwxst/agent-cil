# Agent CIL

> 纯文档仓库：Agent CIL Kernel V2 的架构、研究、契约与实施计划。

本仓库当前分支只保存文档，不包含可执行 Runtime、CLI、工具实现、测试代码、构建脚本或 CI 工作流。它的用途是沉淀 Agent CIL 的架构决策与工程知识，为后续独立实现提供统一依据。

## 项目定位

Agent CIL V2 是一个模型中立、事件驱动、具有强制安全执行边界、可扩展但保持小核心的 Coding Agent Runtime。

核心设计组合：

- **Pi**：简洁、可替换的 Agent Loop 与模型协议适配边界。
- **Codex**：Thread / Turn / Step 生命周期、审批、Sandbox 与执行可靠性。
- **DeepSeek Harness（DSH）**：事件日志、状态投影、服务注册和插件生命周期。
- **Agent CIL 的历史经验**：工具执行、权限二次校验、Session Journal、取消和故障恢复行为。

以上是设计借鉴，不表示复制这些项目的代码，也不表示 Agent CIL V2 已经实现这些能力。

## 建议阅读顺序

1. [项目概览](docs/overview.md)
2. [总体架构](docs/architecture/overview.md)
3. [生命周期与状态机](docs/architecture/lifecycle-and-state-machine.md)
4. [事件日志与恢复](docs/architecture/event-journal-and-recovery.md)
5. [模型网关](docs/architecture/model-gateway.md)
6. [工具运行时与执行安全](docs/architecture/tool-runtime-and-security.md)
7. [上下文引擎](docs/architecture/context-engine.md)
8. [控制平面与扩展系统](docs/architecture/control-plane-and-extensions.md)
9. [架构决策记录](docs/architecture/decision-records.md)
10. [实施路线图](docs/roadmap.md)

## 文档地图

| 目录 | 内容 |
| --- | --- |
| architecture | V2 目标架构、组件边界、状态机和关键契约 |
| research | Pi / Codex / DSH 参考研究，以及 Claude Code 静态观察 |
| history | 旧 Runtime 的实现记录、已验证行为和历史限制 |
| legal | 第三方源码来源、版权与许可证边界 |
| quality | 验收标准、证据等级和验证状态 |

## 五条内核不变量

1. **Session 是任务状态的唯一权威来源。** 消息历史、工具状态、压缩结果和恢复状态都由已提交事件派生。
2. **Agent Loop 只负责编排。** 它不直接写磁盘、不执行 Shell、不弹审批 UI，也不绑定具体 Provider。
3. **模型协议在边界适配。** 内部使用中立表示，同时保留 Provider 原生回放状态。
4. **所有副作用经过 Execution Guard。** 原生工具、MCP 和插件工具都不能绕过授权、执行记录和 Sandbox。
5. **扩展不能覆盖安全不变量。** Provider、Context Strategy、Store 和工具可以替换，状态机和安全入口不能被插件绕过。

## 状态声明

本仓库描述的是 **V2 目标设计和历史研究结论**，不是一份可直接运行的软件发行包。具体实现状态、测试证据和待验证事项见：

- [历史 Runtime 记录](docs/history/legacy-runtime-record.md)
- [证据与验证状态](docs/quality/evidence-status.md)
- [V2 验收标准](docs/quality/acceptance-criteria.md)

## 许可证

仓库根目录的 Apache License 2.0 适用于本仓库中由项目维护者提供并明确纳入该许可的内容。历史研究涉及的第三方代码及其声明不因该文件而自动获得 Apache 2.0 授权，详见[来源与许可说明](docs/legal/source-provenance.md)。