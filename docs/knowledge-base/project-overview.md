# 项目概述

## 应用入口

| 名称 | 类型 | 入口 |
| --- | --- | --- |
| Flash-Claw API | Bun + Hono 服务 | `src/index.ts` |
| Flash-Claw CLI | 命令行入口 | `src/cli.ts` |
| Web Chat | React + Vite 单页应用 | `src/web/main.tsx` |

## 技术栈

- 运行时：Bun。
- Web 框架：Hono。
- 前端：React 19 + Vite。
- AI 推理：OpenAI SDK，支持 OpenAI-compatible 网关，通过 `OPENAI_API_KEY`、`OPENAI_BASE_URL`、`MODEL` 配置。
- 数据：SQLite / JSON 文件，本地运行默认落在仓库工作区。
- 记忆：工作记忆、短期记忆、长期向量记忆、Markdown 记忆。
- 集成：飞书 Webhook / WebSocket、任务调度、心跳通知。
- 测试：Bun test + TypeScript `tsc --noEmit`。

## 目录结构

- `src/index.ts`：服务启动入口，加载环境变量并启动 HTTP 服务。
- `src/cli.ts`：CLI 入口。
- `src/infra/`：Hono app、LLM 配置、网络和文件系统基础设施。
- `src/core/container/`：IoC 容器、DI token、服务 bootstrap。
- `src/chat/`：对话引擎、流式解析、LLM parser、ChatRequest/ChatResponse 类型。
- `src/agent/`：系统提示词构建。
- `src/memory/`：四级记忆、embedding、vector store、mem0 适配。
- `src/tools/`：内置工具注册、执行、sandbox、工具类型。
- `src/skills/`：Claude Code Agent Skills 兼容实现。
- `src/integrations/`：飞书机器人、飞书多机器人管理器、流式卡片。
- `src/tasks/`：cron / interval / one-time 任务调度。
- `src/heartbeat/`：心跳检查与通知。
- `src/security/`：路径、命令、SSRF 和速率限制等安全边界。
- `src/subagents/`：子代理运行管理。
- `src/evolution/`：反馈分析、自进化策略规划。
- `src/web/`：React 前端。
- `tests/`：Bun 测试。
- `docs/`：规则库与知识库。

## 核心子系统

### 对话引擎

`ChatEngine` 负责编排用户请求、记忆检索、提示词构建、LLM 调用和工具循环。它支持普通响应与流式响应，并会在会话级 `sessionId` 和用户级 `userId` 之间保持边界。

### 记忆系统

Flash-Claw 使用多层记忆：

- 工作记忆：当前会话上下文。
- 短期记忆：近期对话历史。
- 长期记忆：向量检索和 mem0 适配。
- Markdown 记忆：面向用户资料和长期事实的 Markdown 存储。

任何改变 `sessionId`、`userId` 或跨 channel identity 的逻辑，都必须同时评估短期会话隔离和长期记忆归属。

### 工具与 Skill

工具系统定义在 `src/tools/`，Skill 系统定义在 `src/skills/`。模型通过 `[TOOL_CALL]...[/TOOL_CALL]` 协议触发工具，工具执行必须经过注册表和安全边界。

### 飞书集成

飞书集成由 `FeishuBotManager` 管理多个 `FeishuBot` 实例。旧单机器人环境变量仍然兼容；多机器人场景通过 `FEISHU_BOTS` 配置，并按 `botId`、`app_id` 或 token 路由。详细约束见 `docs/knowledge-base/feishu-integration.md`。

### 任务与心跳

任务调度支持 cron、固定间隔和一次性延时。飞书入口创建的任务会保存结构化通知目标，心跳系统也优先使用结构化 target，避免多机器人场景通知发错群。

## 高影响改动清单

以下区域变更需要额外谨慎，必须补影响面分析和回归测试：

- `src/core/container/tokens.ts`、`src/core/container/bootstrap.ts`：服务接口和依赖注入边界。
- `src/chat/engine.ts`、`src/chat/chatStream.ts`：对话主路径和流式工具调用。
- `src/memory/**`：记忆归属、检索、写入和隐私边界。
- `src/integrations/feishu*.ts`：飞书配置、路由、消息上下文、通知目标。
- `src/tasks/index.ts`、`src/heartbeat/index.ts`：任务执行和通知回调。
- `src/tools/**`、`src/security/**`：工具执行和安全边界。
