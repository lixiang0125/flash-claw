# Skill 与工具系统知识库

## Skill 系统

Flash-Claw 的 Skill 系统兼容 Claude Code Agent Skills 标准，入口在 `src/skills/index.ts`。

Skill 查找目录按优先级排列：

1. `.flashclaw/skills/`
2. `.agents/skills/`
3. 向上查找父目录中的相同路径

单个 Skill 目录结构：

```text
.flashclaw/skills/
└── skill-name/
    ├── SKILL.md
    ├── scripts/
    ├── references/
    └── assets/
```

`SKILL.md` frontmatter 支持：

- `name`：唯一标识符，小写字母、数字、短横线。
- `description`：说明何时使用，最大 1024 字符。
- `version`：版本号，可选。
- `allowed_tools`：允许工具列表。
- `disable_user_invocation`：禁止用户显式调用。
- `disable_model_invocation`：禁止模型自动调用。

## Skill API

HTTP API：

| 方法 | 路径 | 描述 |
| --- | --- | --- |
| `GET` | `/api/skills` | 列出所有 Skill，支持 `q` 搜索 |
| `GET` | `/api/skills/:name` | 获取指定 Skill |
| `POST` | `/api/skills/:name/exec` | 执行 Skill 下的脚本 |

修改 Skill 扫描或脚本执行时，需要覆盖目录、普通文件、资源子目录、缺失脚本和非法路径场景。

## 工具系统

AI 可用工具定义在 `src/tools/`：

- `src/tools/index.ts`：工具注册入口。
- `src/tools/tool-registry.ts`：工具注册表。
- `src/tools/tool-executor.ts`：工具执行器。
- `src/tools/builtin/`：内置工具实现。
- `src/tools/sandbox/`：沙箱能力和类型。

当前内置工具包括：

| 工具 | 描述 |
| --- | --- |
| `Read` | 读取文件内容 |
| `Write` | 创建或写入文件 |
| `Edit` | 字符串替换编辑文件 |
| `Bash` | 执行 shell 命令 |
| `Glob` | 搜索匹配模式的文件 |
| `Grep` | 在文件中搜索内容 |
| `web_search` | Web 搜索 |
| `web_fetch` | 抓取网页内容 |
| `browser` | 本地浏览器 CDP 操作 |

## 工具调用协议

模型在响应中使用以下格式触发工具：

```text
[TOOL_CALL]<tool_name>:{"key":"value"}[/TOOL_CALL]
```

工具调用解析、执行和结果回注由对话引擎负责。改动协议时必须同步评估：

- `src/chat/engine.ts`
- `src/chat/chatStream.ts`
- `src/chat/parsers.ts`
- `src/tools/tool-executor.ts`
- `tests/engine.test.ts`
- `tests/llm-parser.test.ts`
- `tests/tools-builtin.test.ts`

## 安全边界

工具执行必须遵守安全层：

- 文件路径不能越过工作区边界。
- Shell 命令需要经过安全过滤和审计。
- Shell 命令解析异常必须 fail-closed，不允许因为解析失败而放行。
- `needsApproval: true` 是强制 gate，不只是模型提示；默认不执行，除非可信本地环境显式设置 `FLASH_CLAW_AUTO_APPROVE_TOOLS=true`。
- ChatEngine 默认只向模型暴露无需审批的工具；自动审批开启后才暴露写文件、bash、browser 等高权限工具。
- Web fetch / browser 不能绕过 SSRF 和本机访问限制。
- 不得在日志、工具结果或错误信息中泄露 `.env` 密钥。
- `Grep` 使用 `execFile("rg", ...)`，避免 shell 转义破坏正则或空格查询。
- Skill 脚本可来自 `.flashclaw/skills` 或 `.agents/skills`，脚本执行前必须通过同一套路径边界校验。

修改工具或安全层时默认执行：

```bash
bun run typecheck
bun test --run tests/tool-executor.test.ts tests/tools-builtin.test.ts tests/security.test.ts tests/skills.test.ts tests/browser-tool.test.ts tests/browser-helper.test.ts
```

如果变更影响 prompt 中工具描述或工具循环，追加：

```bash
bun test --run tests/engine.test.ts tests/llm-parser.test.ts
```
