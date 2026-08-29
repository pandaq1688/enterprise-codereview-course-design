# 代码审查系统

基于 Node.js 的本地代码审查服务：采集 Git 变更或全量源码，组装审查 Prompt，调用 Cursor Agent 或远程大模型，经后处理策略生成 HTML/JSON 报告。

## 环境要求

- **Node.js 22 或更高版本**（`package.json` 中 `engines.node` 为 `>=22`）
- 使用 Cursor 模式时，本机需安装 Cursor CLI，且命令行模板与 `app.config.json` 中 `cursor.command` / `cursor.args` 一致

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 复制并编辑配置

```bash
cp app.config.example.json app.config.json
```

在 Windows PowerShell 中可使用：

```powershell
Copy-Item app.config.example.json app.config.json
```

**必须**将 `security.allowedRoots` 设为本机允许审查的根目录列表（至少一项）。示例工程路径需落在其中，例如：

```json
"allowedRoots": ["C:/Users/you/Desktop/代码评审项目/examples"]
```

请将路径改为你本机实际绝对路径。

### 3. 运行自动化测试

```bash
npm test
```

`npm test` 通过 `node --test tests/**/*.test.js` 发现全部测试文件（在 Windows + Node 24 上，`node --test tests` 无法将目录当作测试根目录，故使用显式 glob）。

预期：全部通过（部分 symlink 相关用例在无权限环境会 skip）。

### 4. 启动服务

确保 `app.config.json` 已配置非空 `allowedRoots` 后：

```bash
npm start
```

默认监听 `http://127.0.0.1:3100`。在浏览器打开首页，填写项目路径、需求文档等提交审查任务。

## Cursor 命令配置

`app.config.example.json` 中的 `cursor.command` 与 `cursor.args` 仅为占位示例。**部署前请在本机执行 Cursor CLI 的 help**，确认实际子命令与参数名，再写入 `app.config.json`：

```bash
cursor-agent --help
```

根据输出调整，例如：

```json
"cursor": {
  "command": "cursor-agent",
  "args": [
    "--prompt-file", "{promptFile}",
    "--workspace", "{projectDir}",
    "--output", "{outputFile}"
  ]
}
```

占位符 `{promptFile}`、`{projectDir}`、`{outputFile}` 由程序替换，请勿删除。

## 远程大模型模式

将 `ai.provider` 设为 `"remote"`，并配置 `ai.remote`（`baseUrl`、`model`、`apiKeyEnv` 等）。API Key **只**通过环境变量提供，例如：

```bash
export REMOTE_LLM_API_KEY=your-key-here
```

Windows PowerShell：

```powershell
$env:REMOTE_LLM_API_KEY = "your-key-here"
```

**切勿**将真实 API Key 写入仓库、`app.config.json` 或任何已跟踪文件。`app.config.example.json` 中仅保留占位 URL 与环境变量名 `REMOTE_LLM_API_KEY`。

远程接口默认按 OpenAI 兼容 Chat Completions 形态对接；若使用其他厂商，请对照其官方文档调整 `baseUrl` 与模型名。

## 示例工程（AC-09 人工验收）

目录：`examples/sample-project/`

| 文件 | 说明 |
|------|------|
| `src/demo.cpp` | 与需求一致的 `normalize()` 实现，含一处**明显空指针解引用**供 AC-09 审查 |
| `src/Demo.java` | 同等语义的 Java `normalize()` 实现 |
| `docs/requirement.md` | 输入输出约定 |

### AC-09 人工验收清单

在本机完成 Cursor CLI 模板确认后，使用上述示例项目执行以下步骤（**不自动化**）：

1. **启动 Cursor 模式服务**：`ai.provider` 为 `cursor`，`npm start`，确认进程正常监听。
2. **提交审查任务**：项目路径指向 `examples/sample-project`，需求文档为 `docs/requirement.md`，源模式选「全量目录」或 Git 变更（若已初始化仓库）。
3. **确认 Cursor 正常启动**：任务进入 RUNNING，无 `CURSOR_START_FAILED` 等错误。
4. **确认 Provider 获得合法 JSON**：任务最终 `SUCCEEDED`，报告中有结构化 findings。
5. **对比 raw vs final risk**：在 `report.json` / 报告页查看 `ai.rawOverallRisk`（AI 原始风险）与 `overallRisk`（经后处理策略的最终风险）；`demo.cpp` 空指针问题应被识别，策略可能对部分 finding 做降级或豁免。
6. **确认源码未被修改**：审查完成后，`examples/sample-project/src/` 下文件内容与 Git 或验收前快照一致，无 AI 或工具写入的改动。

## 项目结构（摘要）

- `src/` — 服务实现
- `tests/` — 自动化测试（含 E2E AC-01…AC-08）
- `docs/rules/` — 审查规则与 checklist
- `data/` — 运行时报告与调度状态（已 gitignore，不提交）

## 许可证

内部交付项目；使用前请遵守组织安全与密钥管理规范。
