# Docs Index

该目录承载 Flash-Claw 的规则库与知识库，避免顶层 `AGENTS.md` 过度膨胀。`AGENTS.md` 是唯一入口，`CLAUDE.md` 通过软链指向它。

## Rules

- `docs/rules/development-guide.md`
  - 开发规则、交付约束、代码规范、测试要求、文档同步与提交流程。

## Test

- `docs/test/verification-matrix.md`
  - 按变更类型选择验证命令，覆盖 Bun、TypeScript、前端、飞书、任务、记忆和安全相关回归。

## Knowledge Base

- `docs/knowledge-base/project-overview.md`
  - 项目概览、技术栈、目录结构、核心子系统职责。
- `docs/knowledge-base/feishu-integration.md`
  - 飞书单机器人兼容、多机器人管理器、路由分发、会话/记忆隔离和通知目标。
- `docs/knowledge-base/skills-and-tools.md`
  - Skill 系统目录规范、工具调用格式、内置工具能力与安全边界。
- `docs/channel-shared-memory-design.md`
  - 多 channel 共享长期记忆、隔离短期会话的设计草案。

## Reading Order

1. 所有任务先读 `docs/rules/development-guide.md`。
2. 对项目陌生或需要系统上下文时读 `docs/knowledge-base/project-overview.md`。
3. 涉及飞书、IM 接入、任务通知或 webhook 路由时读 `docs/knowledge-base/feishu-integration.md`。
4. 涉及 Skill、工具调用、沙箱或内置工具时读 `docs/knowledge-base/skills-and-tools.md`。
5. 涉及记忆身份、多 channel 隔离或跨 IM 共享长期记忆时读 `docs/channel-shared-memory-design.md`。
6. 修改完成后按 `docs/test/verification-matrix.md` 选择验证命令。
