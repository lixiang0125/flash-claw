# 飞书接入知识库

## 当前架构

飞书接入由两层组成：

- `src/integrations/feishu-manager.ts`：`FeishuBotManager`，负责读取配置、创建多个机器人实例、路由 webhook 事件和发送通知。
- `src/integrations/feishu.ts`：`FeishuBot`，负责单个机器人的 Webhook / WebSocket 连接、消息上下文解析、ChatEngine 调用和消息发送。

DI token 名称仍为 `FEISHU_BOT`，但实际注册的是 manager 实例。对外接口保持兼容，旧代码仍可调用 `isConfigured()`、`handleEvent()`、`notify()` 等方法。

## 配置方式

### Legacy 单机器人

没有配置 `FEISHU_BOTS` 时，manager 会读取旧环境变量并创建 `default` 机器人：

```bash
FEISHU_WEBHOOK_URL=https://open.feishu.cn/open-apis/bot/v2/hook/xxx
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
FEISHU_VERIFICATION_TOKEN=xxx
FEISHU_ENCRYPT_KEY=xxx
```

只要旧环境变量存在，原机器人无需改配置即可继续运行。

### 多机器人

多机器人通过 `FEISHU_BOTS` JSON 配置：

```json
{
  "growth": {
    "appId": "cli_growth",
    "appSecret": "secret",
    "verificationToken": "token",
    "mode": "websocket",
    "isDefault": true
  },
  "ops": {
    "webhookUrl": "https://open.feishu.cn/open-apis/bot/v2/hook/xxx",
    "mode": "webhook"
  }
}
```

也支持数组形式，每个元素必须包含非空 `id`：

```json
[
  { "id": "growth", "appId": "cli_growth", "appSecret": "secret" },
  { "id": "ops", "webhookUrl": "https://open.feishu.cn/open-apis/bot/v2/hook/xxx" }
]
```

默认机器人选择顺序：

1. `FEISHU_DEFAULT_BOT_ID`。
2. `FEISHU_BOTS` 内 `isDefault: true` 的机器人。
3. 第一个已配置且可用的机器人。

## Webhook 路由

新路径：

- `POST /api/webhooks/feishu`
- `POST /api/webhooks/feishu/:botId`
- `GET /api/webhooks/feishu/status`
- `GET /api/webhooks/feishu/:botId/status`

兼容旧路径：

- `POST /api/feishu/webhook`
- `POST /api/feishu/webhook/:botId`
- `GET /api/feishu/webhook/status`
- `GET /api/feishu/webhook/:botId/status`

路由选择顺序：

1. URL 中显式 `:botId`。
2. 飞书事件 `header.app_id`、`event.app_id` 或顶层 `app_id`。
3. 飞书事件 `header.token`、`event.token` 或顶层 `token`。
4. 默认机器人。

该顺序保证命名 webhook 可以稳定路由，也让未改造的旧飞书回调继续落到默认机器人。

## 会话与记忆隔离

飞书入口必须向 `ChatEngine` 传入隔离后的 `sessionId` 和 `userId`。

当前约定：

- 会话维度包含 `connectorId`、`tenantKey`、`chatId`、sender。
- 长期记忆用户维度包含 `connectorId`、`tenantKey`、sender。
- 错误响应和系统消息也使用带 `connectorId` 的系统 userId，避免落到默认用户。

修改会话格式时必须同时更新：

- `src/integrations/feishu.ts`
- `tests/feishu.test.ts`
- `tests/feishu-manager.test.ts`
- 相关 README / CHANGELOG / docs 说明

## 通知目标

多机器人场景下只保存 `chatId` 不够，任务和心跳通知必须携带结构化 target：

```ts
interface FeishuNotificationTarget {
  channel: "feishu";
  connectorId: string;
  chatId: string;
}
```

任务创建时会冻结当前来源 target，执行任务时优先使用 `notifyTarget(target, text)`。没有结构化 target 时才回退到旧的 `chatId` 通知方式。

修改通知逻辑时必须覆盖：

- `TaskScheduler.setLastNotificationTarget()`
- `TaskScheduler.getLastNotificationTarget()`
- 任务创建时 target 冻结
- 心跳通知 target 优先级
- `notifyTarget()` 对 connector 的路由

## 兼容性要求

- 旧单机器人环境变量必须继续有效。
- 旧 webhook 路径 `/api/feishu/webhook` 必须继续有效。
- 旧任务通知的 `lastChatId` 兼容层必须保留，直到有明确迁移计划。
- 状态接口不得返回明文 secret、token、webhook 完整敏感信息。
- Webhook challenge、普通消息、流式响应、非流式响应都要保持一致的 session/user 归属。

## 测试建议

飞书相关变更默认执行：

```bash
bun run typecheck
bun test --run tests/feishu.test.ts tests/feishu-manager.test.ts tests/hono-app.test.ts tests/tasks.test.ts
```

涉及 DI 或启动 wiring 时追加：

```bash
bun test --run src/core/container/bootstrap.test.ts tests/integration.test.ts
```

变更面较大或触碰对话引擎时执行：

```bash
bun test --run
```
