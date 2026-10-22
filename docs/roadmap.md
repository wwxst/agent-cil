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
- [x] 盘点旧版仓库：5,723 个 tree 条目；restored-src 下只有 src、node_modules、vendor，没有 package.json、tsconfig、lockfile、构建/测试配置
- [x] 核实旧版发布包标记 2.1.88；package/LICENSE.md 声明 Anthropic 保留所有权利，使用受官方法律协议约束
- [x] 确认恢复源码不等于可重建工程；在没有明确授权前，不将恢复出的第三方代码直接复制进 agent-cil
- [ ] 对旧版发布包做安全的版本/帮助快速路径 smoke test，并保存原始退出码与输出；当前尚未在本环境实际运行旧版 CLI

**验收：** 区分“可运行的发布 bundle”和“可复现构建的源工程”；记录来源、构建缺口和授权限制；没有提交样本二进制、提取源码或 Source Map。

## Phase 1 — 旧新版职责映射

- [x] 建立 query/agent loop 的入口和状态初步映射
- [x] 对照 streaming tool executor、tool routing、tool_result 回填
- [x] 定位新版主模型请求的流式发送点，区分其他 API 调用
- [x] 确认 allow/ask 的 permission updatedInput 传递与新版 schema 复验要求
- [ ] 完成权限决策顺序、输入修复、deny-rule 复验和取消/拒绝语义对照
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

## Phase 5 — Session 与持久化（已实现自有原型，暂停扩张）

- [x] 自有 Session manager、JSON journal、revision 与 interrupted-turn recovery 的单元测试
- [ ] 对照 2.1.88/2.1.304 的真实 Session ID、resume、continue、fork 与恢复策略
- [ ] 核实自有 journal 与官方 transcript/session 文件格式之间的差异

**验收：** 现有实现只证明自有数据结构的行为，不代表兼容 Claude Code 的 session/transcript 格式。完成源码对照前不增加过期清理、多写者或新的持久化抽象。

## Phase 6 — MCP 与扩展工具（暂缓）

只有在 CLI 主路径、权限契约和真实 SDK 输入输出得到证据验证后，才按具体调用链决定是否实现 MCP。当前不开发新的 MCP bridge。

## 当前范围之外 — Desktop / 前端 / 平台包装

- 不开发 Renderer、聊天 UI、设置页面或 Desktop 窗口。
- 不迁移 agent-desktop 前端代码。
- 不实现 VM、SSH/WSL 等平台包装，除非后续证据证明它们是目标 CLI 本身的必要运行条件。
- 可以研究 Desktop wrapper 的启动参数、环境变量、IPC/SDK 调用，只为解释 CLI 契约；不因此实现 Desktop。

## Phase 8 — 回归与发布

- [ ] 对照旧版与新版的行为矩阵补充契约测试
- [ ] 增加端到端任务、权限与会话恢复验收
- [ ] 检查依赖许可证、打包资源、日志和敏感数据
- [ ] 固定可复现构建与发布检查

**验收：** 核心测试通过、许可清单齐全、打包产物不含研究样本和敏感信息。

## 当前下一步

旧版基线与授权边界已完成静态盘点；旧版发布 bundle 仍未在本环境运行。按入口、Agent Loop、工具调度、权限四条链继续逐函数比对 2.1.88 与 2.1.304。首个已确认的代码差异是 permission updatedInput：旧版允许权限/审批返回更新后的输入，新版明确在执行前重新校验该输入；PR #9 提出传递与 schema 复验修正，尚待合并。Session、MCP 和平台包装暂停扩张，直到对应行为有源码证据。
