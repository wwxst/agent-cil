# 阶段计划与验收标准

## 工作方式

- 每个阶段先提交可复核的分析证据，再实现对应的独立代码。
- 一个提交聚焦一个可审查变化；提交信息使用 docs(reverse):、feat(protocol):、feat(runtime):、test(protocol): 等前缀。
- 不把“静态找到符号”视为“行为已验证”；每个结论标注证据等级。
- 不将逆向样本、第三方提取源码、二进制、Source Map 或凭证推送到公开仓库。
- 旧版源码只作为理解和比对资料。产品实现采用独立命名、独立接口和可验证测试。

## Phase 0 — 基线与范围

- [x] 确认 Desktop、SDK wrapper、CLI 和旧版参考版本
- [x] 确认新旧样本目录与可用证据类型
- [x] 记录本地 Agent 调用链、JSONL 协议和运行 target

**验收：** 样本版本、组件职责、证据限制和后续任务有记录；没有提交样本二进制或提取源码。

## Phase 1 — 旧新版职责映射

- [x] 建立 query/agent loop 的入口和状态初步映射
- [x] 对照 streaming tool executor、tool routing、tool_result 回填
- [x] 定位新版主模型请求的流式发送点，区分其他 API 调用
- [ ] 完成权限决策顺序、输入修复和拒绝语义对照
- [ ] 完成 Session ID、resume、continue、fork 与恢复策略对照
- [ ] 完成 MCP 初始化、request ID 与取消语义的逐路径对照

**验收：** 每项差异都有源位置、输入输出、调用关系、置信度和未确认项。

## Phase 2A — 自有 CLI 入口与首个运行模式

- [x] 在仓库根 package 声明 agent-cil 可执行入口与 npm run cli
- [x] 实现 help/version 快速路径、参数解析和明确的未知参数报错
- [x] 实现 --print 一次性输入，支持位置 prompt 与管道 stdin
- [x] 实现文本增量输出、独立 stderr 诊断与单对象 JSON 结果
- [x] 将 SIGINT/SIGTERM 转换为 AgentLoop 的 AbortSignal
- [x] 用 fake model 覆盖参数、stdin、输出、凭证缺失和错误退出码
- [ ] 实现与新版 SDK 真实契约一致的 stream-json 输入/输出子集
- [ ] 接入经权限策略保护的 CLI 内置工具

**验收：** help/version 不需要模型凭证；fake model 下可以运行一次性 prompt；CI 不访问网络。当前入口不宣称兼容 Desktop SDK stream-json 协议。

## Phase 2 — 协议基础与 CLI Transport

- [x] 实现 JSONL 编码与分帧解析
- [x] 实现坏帧诊断、最大帧限制与 UTF-8 分块处理
- [x] 实现按 response.request_id 关联控制响应
- [x] 实现早到响应有限缓存、取消信号、超时和关闭清理
- [x] 实现 spawn / stdin / stdout / stderr 的进程 transport
- [x] 用 fake child process 验证启动、输出帧、输入写入、退出和资源清理
- [x] 实现 initialize 屏障与双向 control request 分发
- [x] 实现 result / idle / requires_action / end-ceiling 生命周期跟踪
- [ ] 完成真实样本 schema 与完整 Query streaming 编排的适配

**验收：** Transport 层测试覆盖进程启动、JSONL I/O、错误和关闭；普通日志不污染协议 stdout。Query 生命周期仍需单独验收。

## Phase 3 — 最小独立 Agent Runtime

- [x] 建立 provider-neutral Model stream 与 Tool registry 最小契约（Session 单独放在 Phase 5）
- [x] 实现模型流式输出与 tool_use 调度
- [x] 实现 tool_result 回填与 next-round 循环
- [x] 加入最大轮次、取消与明确错误传播
- [x] 使用 fake model + fake tool 覆盖至少两轮调用
- [x] 实现 Anthropic Messages SSE adapter，并用 fake fetch 覆盖文本、tool JSON、usage、错误与取消
- [ ] 完成真实凭证下的可选端到端 smoke test

**验收：** 确定性 fake model + fake tool 可完成多轮闭环；adapter 的 HTTP/SSE 契约由 fake-fetch 测试覆盖。CI 通过不等于真实 API 端到端已验证。

## Phase 4 — 工具与权限

- [x] 定义 allow/deny/ask 与权限决策结果
- [x] 为工具输入建立受限 JSON Schema 契约
- [x] 将审批逻辑隔离为 approvalHandler adapter
- [x] 覆盖默认拒绝、无审批处理器、输入校验失败与策略异常
- [x] 覆盖审批拒绝、审批期间取消与工具执行异常

**验收：** 工具不会绕过权限层；失败和拒绝可以被会话记录并被模型看到。

## Phase 5 — Session 与持久化

- [x] 支持多轮输入与 warm session
- [x] 实现 JSON 文件存储，并用全新 manager 验证 cold resume
- [x] 分离 Session ID、Turn ID、control request ID 与 tool-use ID；Query ID 的实际生成/恢复仍待接入真实 adapter
- [x] 明确 result / idle / requires_action 生命周期与 user turn 生命周期是两层状态
- [x] 实现 revision 检查、显式 interrupted-turn recovery、close 与 delete
- [ ] 增加过期清理策略与跨进程锁/多写者存储

**验收：** 新增测试覆盖 warm 多轮、文件冷恢复、失败 turn 记录、revision 冲突、中断 reconciliation 和关闭后的资源清理；文件存储当前按单写进程设计。

## Phase 6 — MCP 与扩展工具

- [ ] 区分宿主内存 MCP bridge 与独立 stdio/HTTP server
- [ ] 实现初始化握手、请求 ID、错误响应与取消
- [ ] 将外部服务配置和密钥存储隔离在宿主层
- [ ] 为每次工具调用保留审批和诊断事件

**验收：** fake MCP server 测试覆盖成功、错误、超时、取消和断开重连。

## 当前范围之外 — Desktop / 前端 / 平台包装

- 不实现 Renderer、聊天 UI、设置页面或 Desktop 窗口。
- 不迁移 agent-desktop 前端代码。
- 不实现 VM、SSH/WSL 等 target，除非后续 CLI 行为契约证明它们是当前命令行运行的必要条件。
- 仅在解释新版 CLI 参数、环境变量、进程启动和宿主控制协议时研究 Desktop wrapper；这不构成开发 Desktop 本身的任务。

## Phase 8 — 回归与发布

- [ ] 对照旧版与新版的行为矩阵补充契约测试
- [ ] 增加端到端任务、权限与会话恢复验收
- [ ] 检查依赖许可证、打包资源、日志和敏感数据
- [ ] 固定可复现构建与发布检查

**验收：** 核心测试通过、许可清单齐全、打包产物不含研究样本和敏感信息。

## 当前下一步

先实现新版 SDK 所需的 stream-json 输入/输出子集：核实 initialize/control_request、user 消息、assistant/stream_event/result/system 状态帧的真实字段，保证协议 stdout 不混入普通日志，并把 interrupt 与进程 close 分开。然后将权限策略与实际工具调用接入 CLI。MCP 放在这条真实 CLI 主路径稳定之后；Desktop UI 不属于本项目范围。
