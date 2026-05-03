# 开发指引

Flash-Claw 是 Bun + Hono + React + OpenAI-compatible SDK 驱动的本地 AI 智能体项目。开发时优先保持现有行为兼容，复用已有模块和类型，不为短期需求引入新的框架层。

## AI Coding 速查

默认执行顺序：

1. 判断变更类型：飞书/IM、记忆、对话引擎、工具/沙箱、任务/心跳、Web UI、配置脚本、纯文档/测试。
2. 读取对应知识库和相邻代码，先确认现有接口、测试和兼容层。
3. 对共享协议、DI token、会话 ID、userId、通知目标、工具执行边界做影响面分析。
4. 先补或更新回归测试，再实现变更；无法先写测试时，至少在同一提交补齐覆盖。
5. 执行与变更范围匹配的验证命令，读取结果后再汇报。

常见场景速查：

| 场景 | 额外必读 | 默认验证 | 追加验证 |
| --- | --- | --- | --- |
| 飞书/IM/webhook/通知变更 | `docs/knowledge-base/feishu-integration.md` | `bun run typecheck`、`bun test --run tests/feishu.test.ts tests/feishu-manager.test.ts tests/hono-app.test.ts tests/tasks.test.ts` | 必要时启动服务做 webhook smoke |
| 对话引擎/记忆变更 | `docs/knowledge-base/project-overview.md`、`docs/channel-shared-memory-design.md` | `bun run typecheck`、相关 `tests/engine.test.ts` / `tests/working-memory.test.ts` | `bun test --run` |
| 工具/沙箱/安全变更 | `docs/knowledge-base/skills-and-tools.md` | `bun run typecheck`、`bun test --run tests/tools-builtin.test.ts tests/security.test.ts` | 需要时补手动沙箱 smoke |
| Web UI 变更 | `docs/knowledge-base/project-overview.md` | `bun run typecheck`、`bun run build:web` | 浏览器手动 smoke |
| 根脚本/配置变更 | 当前文档即可 | 对应脚本 dry-run 或语法检查 | `bun run typecheck` |
| 纯文档变更 | 当前文档即可 | `bun run typecheck` 可按风险豁免 | 无 |

## 代码规范

- TypeScript 禁止使用 `any`。外部输入先用 `unknown` 承接，再通过类型守卫、schema 或显式接口收窄。
- 核心协议和兼容层必须保持类型明确，特别是 `ChatRequest`、DI token、Feishu routing、Task notification target、Memory user identity。
- 注释只解释业务约束、协议约束、兼容性前提、边界条件和反直觉实现；不要为显而易见的代码写注释。
- 优先复用已有工具、容器 token、解析函数、测试 helper 和安全校验，不重复发明平行实现。
- 保持 diff 小而可回滚；不要在功能变更中混入无关格式化或大规模重排。
- 不新增依赖，除非用户明确要求或现有能力无法合理实现。

## 前端开发

- UI 使用 React，代码维护在 `src/web`。
- 使用 Vite 构建前端，验证命令为 `bun run build:web`。
- 组件保持职责清晰，优先复用现有样式变量和组件结构。
- 用户可见状态和 API 错误展示应避免泄露敏感配置，例如 API key、app secret、webhook token。

## 环境变量与隐私

- 敏感配置存储在 `.env`，通过 `dotenv` 加载。
- `.env`、`MEMORY.md`、`USER.md`、`SOUL.md`、`data/`、SQLite 本地数据文件不得提交。
- 文档中只能写示例值，不能写真实 app id、secret、webhook URL、tenant token 或用户数据。
- 运行测试或 smoke 时不要打印完整密钥；只能输出“是否配置”或脱敏后缀。

## 测试与验证

- 所有功能变更必须有测试覆盖；优先覆盖主路径、边界条件、非法输入、异常分支和兼容路径。
- 飞书相关变更必须覆盖 legacy 单机器人兼容和多机器人路由，不得只测新路径。
- 任务调度测试完成后，只清理自己新增的测试任务数据，不删除已有任务。
- 验证失败时先判断是否本次引入；是本次引入则继续修复，不是本次引入也要在最终汇报中说明失败命令和阻塞摘要。
- 详细命令矩阵见 `docs/test/verification-matrix.md`。

## 文档同步

- 每次代码变更后必须同步更新 `README.md` 和 `CHANGELOG.md`。
- 影响项目结构、分层、运行流程、配置方式、接口契约或核心能力边界时，必须同步更新 `docs/` 下对应知识库。
- `AGENTS.md` 只作为入口和强制规则摘要；细节放入 `docs/`，避免顶层规则持续膨胀。
- 新增知识库文档后必须更新 `docs/README.md` 和 `AGENTS.md` 必读索引。

## 提交流程

项目约定每次代码变更后需要提交并推送：

```bash
git add -A
git commit -m "<message>"
git push
```

也可以运行：

```bash
bun run release
```

自动执行 changelog、commit 与 push。

提交前必须确认：

- 工作区没有误加入隐私文件或测试数据。
- `README.md`、`CHANGELOG.md` 和必要的 `docs/` 知识库已同步。
- 已执行与变更范围匹配的验证命令并读取结果。
- commit message 遵循仓库当前约定；外层任务要求 Lore Commit Protocol 时，按对应 trailer 格式补充上下文。
