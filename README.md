# Flash Claw

基于 Hono + Bun + LangChain 的对话引擎。

## 技术栈

- **运行时**: Bun
- **Web 框架**: Hono
- **AI**: LangChain + Qwen (阿里云百炼)

## 快速开始

### 安装依赖

```bash
bun install
```

### 配置环境变量

复制 `.env.example` 为 `.env` 并配置:

```bash
cp .env.example .env
```

修改 `.env` 中的配置:

```
OPENAI_API_KEY=your-api-key
OPENAI_BASE_URL=https://coding.dashscope.aliyuncs.com/v1
MODEL=qwen3.5-plus
```

### 运行

```bash
bun run dev   # 开发模式 (热重载)
bun run start # 生产模式
```

服务启动后访问 http://localhost:3000

## API 接口

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | / | 健康检查 |
| POST | /chat | 对话接口 |
| POST | /chat/clear | 清除会话 |

### 对话接口

```bash
curl -X POST http://localhost:3000/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "你好", "sessionId": "user123"}'
```

响应:

```json
{
  "response": "你好！有什么我可以帮你的吗？",
  "sessionId": "user123"
}
```

### 清除会话

```bash
curl -X POST http://localhost:3000/chat/clear \
  -H "Content-Type: application/json" \
  -d '{"sessionId": "user123"}'
```

## 项目结构

```
flash-claw/
├── src/
│   ├── index.ts      # Hono 服务入口
│   └── chat.ts       # 对话引擎核心
├── scripts/
│   └── release.ts    # 自动发布脚本
├── .env              # 环境变量 (不提交)
├── .env.example      # 环境变量模板
├── package.json
└── tsconfig.json
```

## 发布

每次代码变更后运行:

```bash
bun run release
```

自动执行:
1. 生成 CHANGELOG.md
2. Git commit
3. 推送到远端
