# 逆向基线与样本清单

## 1. 版本基线

| 项目 | 值 | 证据状态 |
| --- | --- | --- |
| Desktop | 3.1623.1 | 资料包版本清单 |
| Desktop 构建 commit | 99e484be3828a3767e90385312c83202bca35d8c | 提取构建元数据 |
| Desktop 构建时间 | 2026-10-21T17:34:43Z | 提取构建元数据 |
| SDK wrapper | 0.3.304 | Desktop 内嵌元数据/报告 |
| CLI build pin | 2.1.304 | Desktop manifest 与版本管理代码 |
| CLI 平台 | win32-x64 | 样本目标平台 |
| 旧版参考 CLI | 2.1.88 | 参考仓库 package 元数据 |
| CLI 是否在本轮运行 | 否 | 资料包明确记录 |

> 2.1.304 是该 Desktop 构建中发现的 CLI pin，不代表所有已安装客户端的实际运行版本。Host 有更新与已安装版本回退逻辑；VM 准备路径使用构建 pin。

## 2. 上传样本统计

压缩包：**claude-agent-reverse-kit-desktop-3.1623.1-cli-2.1.304.zip**

| 指标 | 值 |
| --- | ---: |
| ZIP 文件大小 | 215,770,104 bytes |
| ZIP 条目数 | 5,201 |
| ZIP 条目解压大小 | 546,284,096 bytes |
| Manifest 中 payload 文件数 | 5,199 |
| Manifest 中 payload 总大小 | 544,710,100 bytes |

以上是对上传 ZIP 的目录/元数据盘点；不意味着每个文件都经过人工审阅或动态验证。

## 3. 关键样本组成

| 样本 | 路径（相对资料包根目录） | 说明 |
| --- | --- | --- |
| Desktop 提取目录 | **extracted-3.1623.1/asar/** | 编译后的 Electron 主进程、preload、workers 和本地资源 |
| Desktop SDK wrapper | **extracted-3.1623.1/asar/.vite/build/index.chunk-J7YnW_mh.js** | SDK Query、进程 transport 与回调适配 |
| Local Agent IPC | **extracted-3.1623.1/asar/.vite/build/index.chunk-CnYzLcGN.js** | Renderer 到会话管理器的适配 |
| Local Agent manager | **extracted-3.1623.1/asar/.vite/build/index.chunk-pO0kQf5K.js** | 会话 start/send/resume 与运行环境分支 |
| 权限/会话适配 | **extracted-3.1623.1/asar/.vite/build/index.chunk-C7nJwi7_.js** | 权限 broker 等宿主逻辑 |
| 宿主 MCP 适配 | **extracted-3.1623.1/asar/.vite/build/index.chunk-BT1aFaVF.js** | SDK MCP server 与工具 handler 桥接 |
| CLI 原生样本 | **cli-2.1.304/claude.exe** | 与该版本 pin 对应的 Windows x64 CLI |
| CLI 提取模块 | **cli-2.1.304/modules/** | Bun 打包模块的静态提取 |
| 旧版源码参考 | **reference-2.1.88/restored-src/src/** | 恢复的旧版 TypeScript/TSX 文件 |
| 旧版 Source Map | **downloads/reference-claude-code-2.1.88.cli.js.map** | 旧版 Source Map 与 sourcesContent |

## 4. 模块与完整性记录

资料包中的报告记录：

- CLI Bun 模块表共 2,707 个条目，其中 2,461 个为 JavaScript 文件；入口模块名为 **cli**。
- 提取后的 CLI 模块没有随包提供的模块 Source Map。
- Desktop **.vite/build** 目录约有 418 个 JS 文件，未发现配套 .map 文件。
- **MANIFEST.json** 记录 payload 文件大小和 SHA-256；**evidence/cli-bun-modules.json** 记录 CLI 模块映射与模块哈希。
- 资料包报告中的 Windows CLI SHA-256 为 **019e5174d5d954585edb1a946fe280e44a973050b4897034adf0e16306f85fdd**，下载压缩载荷 SHA-256 为 **aed62990b91e94efb35482fd7068cc616c6c2414084c6aa32148ca2a359e4e81**。

这里引用的是样本资料包内的记录，不把报告中的签名/哈希检查扩大解释为“本仓库已独立重建或运行验证”。

## 5. 旧版 2.1.88 源码与可执行基线

- 固定参照提交：`wwxst/-@57d4d4d05121f84601af119091455832d37de5df`。该仓库同时保留 `package/cli.js` 发布文件、包元数据及 `restored-src/` 恢复源码。
- 恢复源码不是独立构建工程：`restored-src` 缺少其自身完整的 package / TypeScript / Bun 构建配置，存在未恢复的别名、宏、SDK 和 UI 依赖，不能把代码可读等同于可编译。
- [PR #11](https://github.com/wwxst/agent-cil/pull/11) 已合并：GitHub Actions 在空凭证环境、超时限制下验证固定来源 `cli.js --version` 的退出码和输出；这**仅**证明该发布产物的版本快路径，不证明交互启动、真实模型调用或恢复源码的可构建性。
- `package/LICENSE.md` 声明「© Anthropic PBC. All rights reserved」，并指向官方法律协议。旧仓库在本人名下并不自动消除其原有版权约束。只有核实实际权利与适用授权后，才可以直接复制、修改、再分发对应源码。当前 [PR #12](https://github.com/wwxst/agent-cil/pull/12) 的直接源码导入因此仍待确认。
- 开发方向仍为**有权复用的成熟旧版实现优先移植**：以已经进入 CLI 活动调用链的权限、调度和工具执行子集（PR #14–#18）为例，保留来源说明、修复依赖、补充行为测试，不另起通用 Runtime。

## 6. 证据等级

后续文档统一使用以下标签：

- **已确认（静态）**：在样本中找到相互支持的实现与调用路径。
- **报告记录**：逆向资料包记录了结果，但本轮没有重新执行其校验流程。
- **推断**：由命名、调用关系或旧版结构推导，仍需要更直接证据。
- **待动态验证**：需要在授权测试环境中实际运行才能确定。
- **未知**：现有样本不足以回答。

## 7. 样本处理原则

不要把逆向 ZIP、CLI/桌面二进制、提取后的第三方源码、Source Map 或 native addon 直接提交到公开仓库。Git 中优先保存原创的结构分析、证据索引、独立实现与测试。任何外部源码或资源如需使用，先确认其许可证与再分发条件。
