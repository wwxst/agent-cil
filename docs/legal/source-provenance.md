# 来源、版权与许可证边界

## 1. 仓库许可证

仓库根目录保留 Apache License 2.0。它适用于明确由项目维护者提供并纳入该许可证的仓库内容。

**根目录 Apache License 2.0 不会自动覆盖第三方源代码、二进制、Source Map 或恢复源码。**

## 2. 历史第三方源码来源

旧仓库曾导入 Claude Code 2.1.88 的局部源码切片，来源记录为：

- 仓库：wwxst/-。
- 固定提交：57d4d4d05121f84601af119091455832d37de5df。
- 原始路径包括 query、Tool、StreamingToolExecutor、toolExecution、权限 Hook 和权限类型等文件。
- 导入时的说明指出这不是完整恢复源码树，也不是可独立构建的工程。

旧 package 中的许可证声明为：

> © Anthropic PBC. All rights reserved. Use is subject to the Legal Agreements outlined here: https://code.claude.com/docs/en/legal-and-compliance.

这与仓库根目录 Apache 2.0 是不同的许可边界。

## 3. 本次文档化处理原则

本分支只保留项目文档和根目录许可证，不保留第三方恢复源码、CLI 可执行代码、构建产物、测试脚本或二进制。

研究文档仅保留架构观察、职责映射和行为层面的摘要；不把删除代码理解为取得了第三方源码的复制、修改或再分发授权。

## 4. 后续使用要求

- 如未来需要重新引入第三方代码，先核实具体文件的权利归属和适用许可。
- 保留适用的版权、NOTICE 和 attribution。
- 不因仓库位于个人账户或历史上曾经提交，就推断拥有全部源码权利。
- 不将第三方提取二进制、Source Map、native addon 或完整恢复源码放入公开仓库，除非许可明确允许。
- 对不具备再分发权利的部分，只保留原创行为规格和独立实现。

本文件是项目工程记录，不构成法律意见。