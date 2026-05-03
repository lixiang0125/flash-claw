# 验证矩阵

本文件用于按变更类型选择验证命令。验证前先确认是否有用户未提交改动，避免误判测试结果或误提交无关文件。

## 基础命令

| 命令 | 用途 |
| --- | --- |
| `bun run typecheck` | TypeScript 类型检查 |
| `bun test --run` | 全量 Bun 测试 |
| `bun run build:web` | 构建 React Web 前端 |
| `bun run release` | 项目封装的 changelog、commit、push 流程 |

## 变更类型矩阵

| 变更类型 | 必跑命令 | 追加命令 |
| --- | --- | --- |
| 纯文档 / AGENTS / CLAUDE | `bun run typecheck` | 无；若只改注释可在汇报中说明跳过测试原因 |
| README / CHANGELOG / docs 知识库 | `bun run typecheck` | 无 |
| Web UI / `src/web/**` | `bun run typecheck`、`bun run build:web` | 需要时浏览器 smoke |
| 对话引擎 / prompt / tool loop | `bun run typecheck`、`bun test --run tests/engine.test.ts tests/llm-parser.test.ts` | `bun test --run` |
| 记忆系统 / userId / sessionId | `bun run typecheck`、`bun test --run tests/working-memory.test.ts tests/engine.test.ts` | `bun test --run` |
| 飞书机器人 / webhook / 多机器人路由 | `bun run typecheck`、`bun test --run tests/feishu.test.ts tests/feishu-manager.test.ts tests/hono-app.test.ts tests/tasks.test.ts` | `bun test --run src/core/container/bootstrap.test.ts tests/integration.test.ts` |
| 任务调度 / 心跳 | `bun run typecheck`、`bun test --run tests/tasks.test.ts` | 飞书通知相关追加 `tests/feishu-manager.test.ts` |
| Skill 系统 | `bun run typecheck`、`bun test --run tests/skills.test.ts` | `bun test --run` |
| 工具 / 沙箱 / 安全 | `bun run typecheck`、`bun test --run tests/tools-builtin.test.ts tests/security.test.ts` | browser 相关追加 `tests/browser-tool.test.ts tests/browser-helper.test.ts` |
| LLM 网关配置 | `bun run typecheck`、`bun test --run tests/openai-compatible-config.test.ts tests/engine.test.ts` | `bun test --run` |
| DI container / bootstrap | `bun run typecheck`、`bun test --run src/core/container/bootstrap.test.ts tests/integration.test.ts` | `bun test --run` |

## 失败处理

- 如果验证失败且属于本次引入，继续修复直到通过。
- 如果失败来自既有基线，最终汇报必须写明失败命令、错误摘要和为什么判断不是本次引入。
- 如果命令不存在，不要临时创造新流程；先查看 `package.json` 和相邻测试，再选择等价命令。
- 不要在未读测试输出的情况下声称验证通过。

## 测试数据清理

- 测试任务、临时 jobs 文件、浏览器产物和临时数据库必须限制在测试路径或临时目录。
- 清理时只删除本次测试创建的数据。
- 不要删除用户已有 `data/`、SQLite 文件或 `.env`。
