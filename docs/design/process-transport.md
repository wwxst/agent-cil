# CLI Process Transport — 设计与验收

## 目标

将操作系统子进程 I/O 与 Agent Query 状态机分开。Transport 只负责启动命令、JSONL 编解码、stdin 写入、stdout 帧分发、stderr 收集和进程关闭；它不决定初始化 payload、权限策略、模型请求或工具语义。

## 状态机

~~~text
new → starting → running → closing → closed
              ↘ closed (spawn/start failure)
running → closed (natural child exit)
~~~

- **start()**：通过注入的 spawn 函数创建子进程，使用 piped stdin/stdout/stderr；等待 spawn 事件后进入 running。
- **writeFrame(frame)**：只在 running 状态写入编码后的 JSONL 帧。
- **endInput()**：结束 stdin，供上层完成单次输入流收束。
- **stdout**：由 JsonlParser 解码为 frame 事件；格式错误作为 frameError 诊断，超大帧是致命 transport 错误。
- **stderr**：逐块发出 stderr 事件，并保留有界尾部供故障诊断；不自动写日志。
- **close()**：结束 stdin，等待宽限期后发送 SIGTERM，再经过宽限期发送 SIGKILL；进程 close 后统一结算 exit result。

## 证据对应

新版 Desktop SDK wrapper 的 ProcessTransport 使用子进程 stdin/stdout 上的 JSONL 交互，CLI 启动参数中包含 stream-json 输入/输出格式。这里实现的是独立的通用进程边界，不复制第三方 SDK 的类结构或私有消息 schema。

## 测试策略

所有生命周期测试使用 fake child process，不启动原版 CLI，不需要登录或凭证。测试覆盖：

- spawn 命令、参数、cwd 和 piped stdio；
- stdout 帧解析和 stdin JSONL 写入；
- 结束输入与自然退出；
- stderr 有界尾部；
- 未启动/关闭状态的写入拒绝；
- 忽略 stdin close 的子进程最终收到 SIGTERM；
- spawn 错误时启动 Promise 与 close 状态均收束。

## 限制

本次实现还不是完整 SDK Query：没有 initialize 屏障、双向 control request handler、session idle/requires_action 状态、interrupt 协议或 warm/cold resume。下一阶段会在 Transport 之上实现 Query 生命周期，并用 fake child 复现初始化、result 与 pending control callback 的竞态。
