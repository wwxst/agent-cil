# CLI 入口与主执行链：2.1.304、2.1.88 与 agent-cil 对照

## 范围与证据等级

- 新版：上传资料包中的 **cli-2.1.304/modules/cli** 及相关提取模块。只读静态检查；没有启动第三方 EXE 或发出模型请求。
- 旧版：**wwxst/-** 仓库的 **restored-src/src/entrypoints/cli.tsx**、**restored-src/src/query.ts**、**restored-src/src/services/tools/StreamingToolExecutor.ts**。
- 自有实现：**wwxst/agent-cil** 的 main 分支及本分支新增的 **packages/cli**。
- **已证实**表示源码路径/调用点可直接定位；**推断**表示由已定位的调用关系得出的实现判断；**尚未确认**表示缺少动态执行或完整 schema 证据。

这份文件只保留行为结论和定位，不复制新版发布模块或旧版第三方源码。

## 1. 新版 CLI 入口

| 新版定位 | 可直接确认的行为 | 证据 |
| --- | --- | --- |
| **cli-2.1.304/modules/cli** 文件头 | 发布样本标记版本 **2.1.304**；入口使用 Bun 模块图导入 | 已证实 |
| **le()**，约字符 offset 953 | 通过 **process.cwd()** 检查当前目录；目录已删除/不可读时生成错误 | 已证实 |
| **pe()**，约 offset 1585 | 检查参数是否只包含 debug 类选项，用于分流判断 | 已证实 |
| **Ge()**，约 offset 1926 | 从参数中提取 permission mode、model、effort、agent 等 dispatch defaults，并将这些参数从剩余参数中分离 | 已证实 |
| **Ve()**，约 offset 2602 | 入口启动函数；在主路径前执行 relay token guard、启动参数验证、版本快速路径和 cwd 检查 | 已证实 |
| 版本分支，约 offset 2945 | 参数仅为版本标志（或另带 **--verbose**）时直接打印版本；verbose 分支还输出构建 commit | 已证实 |
| 正常路径，约 offset 14219 | 调用参数解析器 **Zht(e)**，组合 dispatch defaults，再进入主分流 | 已证实 |
| 正常主入口，约 offset 25105 | 动态加载主模块 **chunk-9b0nx8jt.js** 并调用其 **main(s)** | 已证实 |

桌面样本的 SDK 启动参数明确包含：

~~~text
--output-format stream-json --verbose --input-format stream-json
~~~

用户输入经 stdin JSONL 传递，不是作为每轮 prompt 固定拼进 argv。完整 argv 会随 model、permission mode、tools、MCP、resume、settings 和运行 target 变化；不能把上面的固定参数误称为完整命令行。

## 2. 旧版 CLI 与主循环

### 入口：旧版 2.1.88

**restored-src/src/entrypoints/cli.tsx**：

- 文件前段将 **COREPACK_ENABLE_AUTO_PIN** 设为 **0**，并在 **CLAUDE_CODE_REMOTE=true** 时追加远端环境的 Node heap 设置。
- **main()** 在加载启动 profiler 与其他大模块前处理独立的 **--version/-v/-V** 快速路径。
- 非快速路径通过动态 import 加载功能模块；该文件还负责分流特殊子命令和常规主流程。

**差异：** 新旧入口都采用轻量启动/参数分流，但新版入口的 guard、参数分离、特殊运行模式和启动路径更多。旧版不能直接证明新版每个参数的语义。

### Agent Loop：旧版 2.1.88

**restored-src/src/query.ts**：

- **query()** 把 **queryLoop()** 的事件向外 yield，并在正常结束时完成已消费命令的生命周期。
- **queryLoop()** 保存跨迭代 state，包括 messages、toolUseContext、compact/recovery 状态、待完成 tool summary、stop-hook 状态、turnCount 与 transition。
- 每轮通过 **deps.callModel(...)** 的异步流消费模型输出，收集 assistant messages 和 tool results，再决定继续或终止。

**restored-src/src/services/tools/StreamingToolExecutor.ts**：

- 工具可在模型流还在输出时进入队列。
- 根据 **isConcurrencySafe** 决定并发安全工具能否并行，非并发安全工具需要独占执行。
- 结果按工具接收顺序缓冲；streaming fallback 可以丢弃失败尝试的执行器，避免旧工具结果混入重试。

### Agent Loop：新版 2.1.304

- **chunk-smbjjyps.js**：**YL** @135116 → **su** @137532 是已定位的主 query/agent 路径。
- 同文件 @181956 左右把流式 **tool_use** 交给 **streamingToolExecutor.addTool**。
- 同文件 @209036 左右将历史、assistant messages 与工具结果合并成下一轮 messages；@209492 左右的外层循环继续消费 **next_round**。
- **chunk-4b60tdnk.js**：模型请求链最终到达流式 **beta.messages.create(..., stream:true)**；工具分派函数 **wG** 位于 @3957580 左右。
- 工具输入校验、PreToolUse hooks、权限决策、执行 host 路由和错误 **tool_result** 在工具分派路径中串联。不是所有工具都必然在 CLI 本地执行。

这些调用点与资料包中的 **evidence/local-agent-core.md** 一致。这里是静态调用图证据，不代表所有 feature gate 或 Desktop target 都已动态验证。

## 3. 当前 agent-cil 的审计结论

| 现有部分 | 结论 | 证据等级 / 当前限制 |
| --- | --- | --- |
| **packages/protocol/src/jsonl.js** | 保留。JSONL framing、坏帧诊断与帧大小限制是 CLI transport 的合理基础 | 自有实现已有测试；尚未对真实 2.1.304 全量 schema 做逐帧回放 |
| **process-transport.js、query-session.js** | 保留。分别负责进程 I/O 与控制请求，不应塞进 Agent Loop | fake child/fake transport 测试；没有启动官方 CLI 做端到端比对 |
| **query-lifecycle.js** | 保留但不宣称完全兼容。result、idle、requires_action 是不同事实 | 参考 SDK 静态路径；完整多消息编排和异常恢复仍待补 |
| **runtime/agent-loop.js** | 保留为独立最小 runtime，不直接改写成第三方混淆符号的逐行移植 | 目前工具按顺序执行；新版有流式执行、并发安全分组、fallback discard、hooks、host tool routing 等更复杂机制 |
| **tool-registry.js / validation.js** | 保留；schema 子集明确小于新版完整工具 schema 与 hook 规则 | 单元测试不代表与全部内建工具 schema 兼容 |
| **session-manager.js / session-store.js** | 保留为自有 session journal，不当作新版 transcript/resume 的等价实现 | JSON 文件存储不等于 CLI 原生 session 文件格式；没有实现官方 resume/continue/fork |
| **anthropic-messages-adapter.js** | 保留为最小 provider adapter | fake-fetch/SSE 测试；不覆盖所有 Anthropic 事件、重试、extended thinking 或真实凭证端到端 |
| CLI 可执行入口（本分支新增） | 填补仓库缺少入口的真实缺口，先提供可验证的一次性非交互模式 | 不宣称 SDK **stream-json** 协议或完整 Claude Code 参数兼容 |

## 4. 当前 CLI 实现的明确边界

本分支新增自有入口支持 **--help**、**--version**、**--print**、**--model**、**--max-turns**、**--system-prompt**、**--output-format text|json** 和 **--verbose**。默认 adapter 从宿主环境读取 **ANTHROPIC_API_KEY**；帮助和版本路径不初始化模型。

以下不是已实现功能：交互式 REPL、内置文件/命令工具、权限交互 UI、**--input-format stream-json**、**--output-format stream-json**、MCP、resume/continue/fork、上下文压缩、hooks、subagents，以及 Claude Code 的全部参数语义。

**自主设计理由：** 先有可执行、可测试的 CLI 命令与错误/退出码，再按逆向证据接入 SDK JSONL 子集。当前文本/JSON 输出不是官方 SDK stream-json 协议的替代品。

## 5. 下一项待实现的行为闭环

1. 以 Desktop 启动链的真实输入帧与初始化 control request 为基准，建立版本化的 **stream-json** 子集 schema。
2. 将 CLI user 输入与 AgentLoop history 正确映射；输出 assistant/stream_event/result/system 状态帧，并保持 stdout 仅含协议 JSONL。
3. 将 **interrupt** 与进程关闭分离；信号取消不应被误认为正常结果。
4. 再接入受权限策略保护的内置工具与 MCP，不默认开放文件/命令执行。
5. 对比新旧权限输入修复、拒绝结果、streaming fallback 与工具并发规则，再决定是否扩展 runtime。

不把 UI、Desktop 窗口、Renderer 或前端集成列入当前实现范围。
