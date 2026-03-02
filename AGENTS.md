# 项目约束

## 开发规范【必须遵守】

- 核心位置需补充注释
- 不允许使用 any 类型
- 所有的功能都需要经过测试后再交付

## 前端开发

- UI 使用 React 实现
- 代码维护在 `/src/web` 目录
- 组件化开发，保持代码组织合理
- 使用 Vite 构建前端

## 环境变量

- 所有敏感配置存储在 `.env` 中
- `.env` 文件不提交到 git（已在 .gitignore 中）
- 使用 `dotenv` 加载环境变量

## 代码变更流程

每次代码变更后：
1. 更新 README.md 说明新功能
2. 更新 CHANGELOG.md 记录变更
3. 运行 `git add -A && git commit -m "..." && git push`

或者运行：
```bash
bun run release
```

自动执行：
1. 生成 CHANGELOG.md 记录变更
2. 自动 git commit
3. 推送到远端

## 重要规则

- 每次代码变更后必须更新 README.md 和 CHANGELOG.md
- 每次代码变更后必须推送到远端
- 隐私文件（MEMORY.md, USER.md, SOUL.md, data/）不提交到远端
- 测试完成后必须清理测试数据（尤其是 SQLite 中的定时任务），只删除自己测试时新增的任务，不要删除已有的任务

## 对话引擎

- 模型配置通过环境变量 `MODEL` 设置
- baseURL 通过 `OPENAI_BASE_URL` 配置
- 支持多会话管理（sessionId 隔离）

## API 端点

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | / | 健康检查 |
| GET | /index.html | 前端页面 |
| POST | /api/chat | 对话接口 |
| POST | /api/chat/clear | 清除会话 |
| GET | /api/skills | 列出所有 Skills |
| GET | /api/skills/:name | 获取指定 Skill |
| POST | /api/skills/:name/exec | 执行 Skill 脚本 |

## Skill 系统

符合 Claude Code Agent Skills 标准。

### 目录结构

Skills 放置在以下目录（按优先级查找）：
- `.flashclaw/skills/` (项目级)
- `.agents/skills/` (项目级)
- 向上查找父目录的相同路径

单个 Skill 目录结构：
```
.flashclaw/skills/
├── skill-name/
│   ├── SKILL.md          # 必需：Skill 定义
│   ├── scripts/          # 可选：可执行脚本
│   │   ├── script.sh
│   │   └── script.py
│   ├── references/      # 可选：参考文档
│   │   └── guide.md
│   └── assets/          # 可选：静态资源
```

### SKILL.md 格式

```yaml
---
name: skill-name
description: Skill 描述，说明何时使用
allowed_tools: Bash,Read,Write,Edit
---

# Skill 指令

这里是详细的技能指令...
```

### Frontmatter 字段

- `name`: 唯一标识符（小写字母、数字、短横线）
- `description`: 描述（说明何时触发，最大 1024 字符）
- `version`: 版本号（可选）
- `allowed_tools`: 允许使用的工具列表
- `disable_user_invocation`: 禁止用户调用
- `disable_model_invocation`: 禁止模型自动调用

## 工具系统

AI 可使用的工具，定义在 `src/tools/index.ts`。

### 可用工具

| 工具 | 描述 |
|------|------|
| Read | 读取文件内容 |
| Write | 创建或写入文件 |
| Edit | 编辑文件（字符串替换） |
| Bash | 执行 shell 命令 |
| Glob | 搜索匹配模式的文件 |
| Grep | 在文件中搜索内容 |

### 工具调用格式

AI 在响应中使用以下格式触发工具：
```
[TOOL_CALL]<tool_name>:{<args>}[/TOOL_CALL]
```

## IM 集成

支持接入外部 IM 系统（如飞书、企业微信等）。

### 飞书机器人

#### 配置方式

**方式1: Webhook (简单)**
```
FEISHU_WEBHOOK_URL=https://open.feishu.cn/open-apis/bot/v2/hook/xxx
```

**方式2: 开放平台 API (完整功能)**
```
FEISHU_APP_ID=your-app-id
FEISHU_APP_SECRET=your-app-secret
```

#### API 端点

| 方法 | 路径 | 描述 |
|------|------|------|
| POST | /api/webhooks/feishu | 飞书 Webhook 接收地址 |

#### 使用方式

1. 在飞书创建自定义机器人，获取 Webhook URL
2. 配置环境变量
3. 将 Webhook URL 配置为服务地址
