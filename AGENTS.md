# 核心要求

本文件是 Flash-Claw 仓库规则与 Agent 执行契约的唯一入口。详细规则与知识库维护在根目录 `docs/` 下；`CLAUDE.md` 必须通过软链指向本文件，禁止并行维护两份规则。

## 必读文档

开始工作前，按本次任务范围阅读以下文档：

1. `docs/README.md`：规则库与知识库索引。
2. `docs/rules/development-guide.md`：开发规则、交付约束、代码规范、测试与提交流程。
3. `docs/knowledge-base/project-overview.md`：项目概览、技术栈、目录结构、核心子系统分工。
4. `docs/knowledge-base/feishu-integration.md`：飞书单/多机器人配置、路由、会话/记忆隔离与兼容约束。
5. `docs/knowledge-base/skills-and-tools.md`：Skill 系统、内置工具系统与工具调用协议。
6. `docs/test/verification-matrix.md`：不同变更类型对应的验证命令与回归范围。
7. `docs/channel-shared-memory-design.md`：跨 channel 共享长期记忆、隔离会话的设计草案；涉及多 IM / 记忆身份时必读。

## 强制要求

- Must：必须遵循 `docs/rules/development-guide.md` 中的所有规则。
- Always：Reconnaissance -> Plan -> Execute -> Verify -> Report。
- Read-before-write；write-then-reread。任何修改后必须重新检查变更并验证无副作用。
- 不允许使用 `any` 类型；确需表达未知结构时使用 `unknown`、具体接口或类型收窄。
- 核心协议、兼容层、边界条件和反直觉逻辑必须补充简洁注释。
- 所有功能变更必须补测试并通过与变更范围匹配的验证后再交付。
- 每次代码变更后必须同步更新 `README.md` 与 `CHANGELOG.md`。
- 每次准备 commit 时，必须根据实际变更同步更新 `docs/` 内对应知识库；影响结构、分层、约定、流程或核心能力边界时不得跳过。
- 敏感配置只能放在 `.env`；不得提交 `.env`、`MEMORY.md`、`USER.md`、`SOUL.md`、`data/` 或本地数据库数据。
- 测试完成后必须清理自己创建的测试数据，尤其是定时任务数据；不得删除用户已有数据。

## 禁止行为

- 使用 `git reset --hard`、`git checkout -- <path>` 等破坏性命令清理未确认改动。
- 为了提交而使用 `--no-verify` 或跳过项目要求的验证。
- 在未完成影响面分析时直接修改共享协议、DI token、记忆身份、飞书路由或工具执行安全边界。
- 复制其他项目业务规则到本项目；只能迁移适合 Flash-Claw 的文档治理和执行模式。
