# Protocol Runtime Slice — 设计与实现范围

## 为什么先做协议基础

新版 Desktop 与 CLI 的本地边界是 stdin/stdout 上的 JSON Lines。它同时承载普通输入、流式事件、回合结果和双向控制回调。若分帧或 request ID 关联不可靠，后续会把权限审批、MCP 响应和中断错误地配对，甚至在仍有待处理回调时过早结束会话。

## 本次实现

包：**@agent-cil/protocol**，Node.js 原生模块，无第三方运行依赖。

- **JsonlParser**：处理分块 UTF-8、CRLF、最后一帧无换行、空行、BOM、坏帧恢复与最大帧大小。
- **encodeJsonlFrame**：将一个协议对象编码成一行 JSONL。
- **ControlRequestRegistry**：按 response.request_id 关联响应，支持乱序响应、有限 TTL/容量的早到响应缓存、AbortSignal、超时、peer error 和统一关闭。
- **createControlCancelFrame**：生成取消单个控制回调的协议帧。

## 与逆向证据的对应

样本的 SDK wrapper index.chunk-J7YnW_mh.js 通过 stdin/stdout 传输 JSONL；控制响应 ID 位于 control_response.response.request_id；取消请求使用 control_cancel_request.request_id。样本也处理在 waiter 尚未就绪时到达的响应，并区分单个控制回调取消、当前回合 interrupt 和整体 Query close。

本包只实现通用协议原语，不复刻第三方 SDK 的内部类、变量名、私有定时策略或完整私有消息 schema。实际 CLI 版本的 schema 仍应通过协议版本适配器进行验证。

## 明确不在本次范围

- 不启动或捆绑第三方 CLI 二进制。
- 不实现认证、模型供应商调用、权限 UI 或 MCP server。
- 不声称已经实现完整的 SDK Query 生命周期。
- 不把未知的 control subtype 当作成功；上层仍需按请求类型验证 payload。

## 验收

在 Node.js 22+ 上运行 npm test。测试覆盖 JSONL 编解码、分块/UTF-8、坏帧、大小上限、响应乱序、早到响应、peer error、取消、超时和关闭清理。
