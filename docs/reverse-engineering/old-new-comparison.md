# 旧版与新版对照矩阵

## 1. 样本对照

| 维度 | 旧版参考 | 新版样本 | 当前结论 |
| --- | --- | --- | --- |
| CLI 版本 | 2.1.88 | 2.1.304 build pin | 版本已确认；语义差异需逐模块核对 |
| 发布形式 | npm package @anthropic-ai/claude-code，入口 cli.js | Windows x64 原生 claude.exe，内部为 Bun 模块图 | 打包方式不同，不能直接按文件名比较 |
| 可读源码 | cli.js.map 和恢复的 restored-src/src/ | 2,707 个提取模块，其中 2,461 个 JS；未发现配套模块 Source Map | 旧版更适合语义命名，新版更依赖调用图、字符串与模块映射 |
| Desktop 集成 | 该参考仓库主要提供 CLI 包及恢复源码 | Desktop 3.1623.1 的 Electron 主进程、preload、IPC、SDK wrapper 和会话管理器 | 新版桌面端需要单独逆向，不能从 CLI 仓库完整推导 |
| SDK wrapper | 需在旧版源码中进一步确认具体对应实现 | 内嵌 wrapper 0.3.304 | 已知版本，符号映射待完成 |
| Agent loop | 旧版源码可用于寻找同类职责与数据结构 | 新版可静态追踪 query → callModel → tool_use → tool_result → next_round | 主闭环已确认；行为变化还未逐项比较 |
| 权限处理 | 旧版有可读的工具和权限源码可供对照 | 新版有 CLI 策略、SDK can_use_tool 和 Desktop permission broker 多层协作 | 需要比较决策顺序、schema 与中断行为 |
| MCP | 旧版 MCP/工具实现可作为命名与职责参考 | 新版存在宿主内存 MCP bridge 和独立 server 连接路径 | 需要区分本地桥接与外部传输 |
| 运行 target | 旧版 CLI 参考不能单独证明新版 Desktop 的 target 选择 | 新版存在 Host、VM、SSH/WSL 平行路径 | 需要分别建立启动/恢复/凭证契约 |

## 2. 比较原则

1. **先比职责，再比实现。** 旧版符号名可帮助定位，新版压缩变量名不应成为新工程的接口名称。
2. **把结构变化与行为变化分开。** 文件拆分、模块数量和打包格式变化不代表产品行为变化。
3. **每条差异都附证据。** 至少记录旧版路径/符号、新版路径/符号、输入输出、调用方、测试状态。
4. **明确缺失证据。** 旧版未发现某实现，不等于新版新增；新版存在代码分支，也不等于生产环境一定启用。
5. **只保留兼容所需的契约。** 新客户端按自己的接口实现，不直接复制整段第三方源码或依赖混淆变量名。

## 3. 首批需要映射的职责

| 优先级 | 职责 | 新版已知定位 | 对照目标 |
| --- | --- | --- | --- |
| P0 | CLI 入口与参数 | cli-2.1.304/modules/cli | 旧版 package/cli.js / CLI 参数定义 |
| P0 | Query 生命周期与传输 | Desktop SDK wrapper chunk index.chunk-J7YnW_mh.js | 旧版 SDK/Query/transport 相关源码 |
| P0 | Agent 主循环 | chunk-smbjjyps.js 中 query/next-round 路径 | 旧版 query/agent loop 相关源码 |
| P0 | 模型请求 | chunk-4b60tdnk.js 中流式 messages 请求 | 旧版 provider/client/model 请求路径 |
| P0 | 工具调度与结果回填 | chunk-smbjjyps.js、chunk-4b60tdnk.js | 旧版 Tool executor、tool result、并发策略 |
| P1 | 权限审批 | chunk-451m4237.js 与 Desktop permission broker | 旧版 PermissionMode、规则与提示处理 |
| P1 | Session 恢复 | Desktop manager 与 CLI resume/session store | 旧版 session restore/resume |
| P1 | MCP 桥接 | SDK wrapper 与 Desktop MCP adapter | 旧版 MCP client/server、stdio 与配置 |
| P2 | Host/VM/SSH | Desktop target managers 与 spawn adapters | 旧版 CLI target / environment 分支 |

## 4. 对照状态

本表只记录第一轮资料盘点与新版静态证据。尚未完成按函数、schema、消息序列和测试逐项核对；因此当前不宣称新版相对 2.1.88 的具体功能增删清单。后续每次完成一项映射时，应更新本文件并提交对应的独立证据与测试。
