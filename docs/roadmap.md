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

**验收：** 确定性 fake model + fake tool 可完成多轮闭环，不需要真实凭证；CI 仍需确认新增运行时测试通过。

## Phase 4 — 工具与权限

- [x] 定义 allow/deny/ask 与权限决策结果
- [x] 为工具输入建立受限 JSON Schema 契约
- [x] 将审批逻辑隔离为 approvalHandler adapter
- [x] 覆盖默认拒绝、无审批处理器、输入校验失败与策略异常
- [ ] 补齐审批取消与工具执行异常的回归测试

**验收：** 工具不会绕过权限层；失败和拒绝可以被会话记录并被模型看到。

## Phase 5 — Session 与持久化

- [ ] 支持多轮输入、warm session 和 cold resume
- [ ] 区分会话 ID、Query ID、回合 ID、control request ID 与 tool-use ID
- [ ] 明确 result、idle、待处理控制请求之间的关系
- [ ] 定义重启恢复、清理与过期策略

**验收：** 测试覆盖新会话、多轮发送、中断、恢复和关闭后的资源清理。

## Phase 6 — MCP 与扩展工具

- [ ] 区分宿主内存 MCP bridge 与独立 stdio/HTTP server
- [ ] 实现初始化握手、请求 ID、错误响应与取消
- [ ] 将外部服务配置和密钥存储隔离在宿主层
- [ ] 为每次工具调用保留审批和诊断事件

**验收：** fake MCP server 测试覆盖成功、错误、超时、取消和断开重连。

## Phase 7 — 平台运行时与桌面集成

- [ ] 实现 Host 子进程适配
- [ ] 单独评估 VM 的文件挂载、凭证通道和进程代理
- [ ] 单独评估 SSH/WSL 的远端进程协议
- [ ] 将 Renderer、IPC、Session manager 和 Runtime 接入自有客户端

**验收：** 每种实际支持的 target 都有独立测试和清楚的能力边界；未实现的 target 不对外宣称支持。

## Phase 8 — 回归与发布

- [ ] 对照旧版与新版的行为矩阵补充契约测试
- [ ] 增加端到端任务、权限与会话恢复验收
- [ ] 检查依赖许可证、打包资源、日志和敏感数据
- [ ] 固定可复现构建与发布检查

**验收：** 核心测试通过、许可清单齐全、打包产物不含研究样本和敏感信息。

## 当前下一步

完成运行时测试与 CI 验证后，下一步补齐 Session / Turn 的持久化契约，再开始权限取消、工具错误与 MCP bridge 的完整集成。权限必须是独立的 allow/deny/ask 决策层；没有实现权限策略的工具不得默认放行。
