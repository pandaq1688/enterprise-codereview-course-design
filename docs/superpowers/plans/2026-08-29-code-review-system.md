# 代码审查系统 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现单机本地代码审查系统：从项目目录与需求 Markdown 采集 C/C++/Java 源码，经固定规则 + 可选 checklist 调用审查 Provider，再做确定性二次过滤，产出可审计的 JSON/HTML 报告、Web 界面、RemoteLlmReviewProvider 与 ReviewScheduler。

**Architecture:** 分层单体。`src/create-app.js` 用构造函数注入组装组件；Domain（parser、policy）纯函数，不读文件、不启进程、不访问 HTTP；Application（`ReviewJobService`）只编排；Infrastructure（Git/FS/Cursor/HTTP/报告）通过注入适配器接入。WebAdapter 只用 Node `http`，只调用 Application。Provider 可替换（Fake / Cursor / Remote），调度器复用同一 `ReviewJobService.enqueue`。

**Tech Stack:** Node.js 22、ESM JavaScript、node:test + node:assert/strict、Node 原生 `http` / `child_process.spawn` / `crypto` / `fs/promises`。无框架、无数据库。测试运行：`node --test tests`（递归执行 `tests/**/*.test.js`）。

**Spec:** `spec/spec.md`（唯一基线）。归档原稿 `reference/2026-08-28-enterprise-codereview-course-design.md` 只读，实现不得对照原 kdop-green 源码。

## Global Constraints

- 技术栈：Node.js 22、ESM JavaScript、原生 Web 页面、node:test
- 实现约束：本 Spec 为唯一产品与技术基线；实现不依赖原 kdop-green 源码对照
- Domain 不读取文件、不启动进程、不访问 HTTP。Application 负责编排，不包含具体文件系统、Git、Cursor 或 HTML 实现
- 组件通过普通 JavaScript 对象契约和构造函数注入协作，不创建没有行为价值的抽象基类
- MVP 固定支持：C：.c；C++：.cc、.cpp、.cxx、.h、.hpp、.hxx；Java：.java。扩展名比较不区分大小写
- 固定排除目录：.git、node_modules、dist、build、out、target、coverage、data/reports、data/logs
- 默认输入限制：最大源码文件数 50；单文件最大字符数 80,000；所有源码或 diff 最大字符数 240,000；需求文档最大字符数 50,000；checklist 最大字符数 80,000。超过限制时任务在 REVIEWING 前失败，不得静默截断
- 合法风险：LOW < MEDIUM < HIGH < CRITICAL。AI 的 overall_risk 只保存为原始元数据，不作为最终风险
- 合法类别：SECURITY、CORRECTNESS、MEMORY_SAFETY、CONCURRENCY、RESOURCE_LIFECYCLE、REQUIREMENT_MISMATCH、MAINTAINABILITY、PERFORMANCE、OTHER
- 除代码、符号和路径外，报告文本使用简体中文
- spawn 的 shell 为 false；command 与 args 分开配置；占位符只能替换完整参数值 `{promptFile}`、`{projectDir}`、`{outputFile}`
- 全局 Cursor 并发固定为 1；队列 FIFO；人工任务优先于新到期的定时任务，但不打断正在执行的任务
- 真实 API Key 只能来自环境变量；app.config.example.json 可以提交；app.config.json 不提交
- 自动化测试不得依赖真实 Cursor 或真实远程 API；远程 Provider 与定时调度分别使用 Mock Server 与 FakeClock
- 未完成 §19 与 §20 的系统不得视为交付完成
- 仓库当前不是 git 仓库：Task 1 必须 `git init` 后再开始提交

## Scope note

§4.1 核心闭环、§19 RemoteLlmReviewProvider、§20 ReviewScheduler 共享同一套 Job/报告契约，不是可独立交付的子系统。本计划按依赖顺序写成一份：先核心闭环（可测），再 Remote，再 Scheduler。不要拆成互不相认的三份计划。

---

## File Structure

每个文件一件事。后任务只依赖前任务 **Produces** 里的导出名称。

| Path | Responsibility |
|------|----------------|
| `package.json` | ESM、`engines.node >= 22`、`npm test` → `node --test tests`、`npm start` → `node src/main.js` |
| `.gitignore` | `node_modules/`、`data/`、`app.config.json`、`.worktrees/` |
| `app.config.example.json` | 与 spec §14.1 同结构，并含 `ai` 与 `scheduler` 段 |
| `src/shared/error-codes.js` | 冻结错误码常量 |
| `src/shared/app-error.js` | `AppError`：`code`、中文 `message`、`details` |
| `src/shared/path-security.js` | realpath、allowedRoots 段边界包含、Windows 大小写、符号链接逃逸 |
| `src/shared/hash.js` | `sha256Text(text)` → hex |
| `src/shared/clock.js` | `{ now() }` 系统时钟 |
| `src/shared/logger.js` | JSON Lines；禁止完整路径/源码/Key |
| `src/shared/html-escape.js` | HTML 转义 |
| `src/shared/source-extensions.js` | 扩展名→语言、排除目录名、二进制判断 |
| `src/shared/config.js` | 读 JSON 配置；缺项/非法则启动失败 |
| `src/request-validator.js` | HTTP 请求 → 规范化绝对路径；4xx `AppError` |
| `src/requirement-loader.js` | 只读 .md/.markdown，UTF-8，空/超限失败 |
| `src/git-changed-source-collector.js` | Git 工作区相对 HEAD 的暂存+未暂存+未跟踪；只读 git |
| `src/full-directory-source-collector.js` | 递归受支持文件；不跟随符号链接；排除固定目录与二进制 |
| `src/rule-resolver.js` | 固定全局/C++/Java + 可选 checklist；SHA-256；match 清单 |
| `src/prompt-builder.js` | 固定 9 段顺序的 UTF-8 提示词 |
| `src/review-result-parser.js` | 去围栏、别名、枚举归一化、Schema 校验 |
| `src/post-review-policy.js` | PF-001…PF-010 纯函数；不写 timestamp |
| `src/html-report-renderer.js` | 结构化报告 → 自包含转义 HTML |
| `src/file-report-repository.js` | 原子写 `data/reports/{id}/report.json|html`；历史倒序 |
| `src/providers/cursor-review-provider.js` | spawn Cursor；超时杀进程树；读 output 或 stdout |
| `src/providers/remote-llm-review-provider.js` | Bearer HTTP；错误映射；不记录 Key |
| `src/review-job-service.js` | 状态机、单并发、FIFO+人工优先、尽力写报告 |
| `src/review-scheduler.js` | ReviewProfile、FakeClock、inputHash 去重、single-flight |
| `src/web/templates.js` | 首页/任务/报告 HTML 字符串 |
| `src/web/web-adapter.js` | 原生 HTTP 路由 |
| `src/create-app.js` | 组合根：读配置、注入依赖、返回 `{ server, start, stop }` |
| `src/main.js` | 进程入口、SIGINT/SIGTERM |
| `docs/rules/*.md` | 固定规则与默认 checklist、政策说明 |
| `tests/helpers/*.js` | 临时目录、临时 Git 库、FakeProvider、FakeClock、Mock HTTP |
| `tests/*.test.js` | 与生产文件一一对应 |
| `tests/e2e/acceptance.test.js` | AC-01…AC-08、§19.4、§20.3 |

---

### Shared contracts (all later tasks use these names)

`src/shared/error-codes.js` 必须导出：

```js
export const ErrorCodes = Object.freeze({
  INVALID_REQUEST: 'INVALID_REQUEST',
  PATH_NOT_FOUND: 'PATH_NOT_FOUND',
  PATH_OUTSIDE_ALLOWED_ROOT: 'PATH_OUTSIDE_ALLOWED_ROOT',
  PATH_SYMLINK_ESCAPE: 'PATH_SYMLINK_ESCAPE',
  REQUIREMENT_NOT_MARKDOWN: 'REQUIREMENT_NOT_MARKDOWN',
  REQUIREMENT_EMPTY: 'REQUIREMENT_EMPTY',
  GIT_REPOSITORY_REQUIRED: 'GIT_REPOSITORY_REQUIRED',
  NO_REVIEWABLE_SOURCE: 'NO_REVIEWABLE_SOURCE',
  SOURCE_FILE_LIMIT_EXCEEDED: 'SOURCE_FILE_LIMIT_EXCEEDED',
  SOURCE_SIZE_LIMIT_EXCEEDED: 'SOURCE_SIZE_LIMIT_EXCEEDED',
  RULE_READ_FAILED: 'RULE_READ_FAILED',
  CURSOR_START_FAILED: 'CURSOR_START_FAILED',
  CURSOR_TIMEOUT: 'CURSOR_TIMEOUT',
  CURSOR_EXIT_NON_ZERO: 'CURSOR_EXIT_NON_ZERO',
  CURSOR_OUTPUT_TOO_LARGE: 'CURSOR_OUTPUT_TOO_LARGE',
  AI_OUTPUT_INVALID_JSON: 'AI_OUTPUT_INVALID_JSON',
  AI_OUTPUT_SCHEMA_INVALID: 'AI_OUTPUT_SCHEMA_INVALID',
  REPORT_WRITE_FAILED: 'REPORT_WRITE_FAILED',
  REMOTE_LLM_AUTH_FAILED: 'REMOTE_LLM_AUTH_FAILED',
  REMOTE_LLM_RATE_LIMITED: 'REMOTE_LLM_RATE_LIMITED',
  REMOTE_LLM_UNAVAILABLE: 'REMOTE_LLM_UNAVAILABLE',
  REMOTE_LLM_TIMEOUT: 'REMOTE_LLM_TIMEOUT',
  REMOTE_LLM_INVALID_RESPONSE: 'REMOTE_LLM_INVALID_RESPONSE'
});
```

`CollectedFile` 形状（采集器产出，报告 `source.files[]` 使用同一字段名；**不**包含源码正文）：

```js
/**
 * @typedef {object} CollectedFile
 * @property {string} path              posix 相对项目根，正斜杠
 * @property {'C'|'CPP'|'JAVA'} language
 * @property {'ADDED'|'MODIFIED'|'DELETED'|'RENAMED'|'UNTRACKED'} status
 * @property {string} contentHash       当前内容 SHA-256；DELETED 用空串的 hash
 * @property {number[]} changedLines    1-based；DELETED 为 []
 * @property {number|null} lineCount    当前文件行数；DELETED 为 null
 * @property {string|null} oldPath      RENAME 时旧相对路径
 */
```

`CollectedSource`（采集器返回，JobService 内存持有正文）：

```js
/**
 * @typedef {object} CollectedSource
 * @property {CollectedFile[]} files
 * @property {Record<string, string>} contents  path → 带行号源码或 unified diff 文本
 * @property {number} totalCharacters           contents 全部字符数之和
 */
```

`ReviewProvider` 契约（spec §7.2，一字不差的参数名）：

```js
/**
 * @typedef {object} ReviewProviderInput
 * @property {string} projectDir
 * @property {string} promptFile
 * @property {string} outputFile
 * @property {number} timeoutMs
 * @property {AbortSignal} [signal]
 *
 * @typedef {object} ReviewProviderResult
 * @property {string} rawOutput
 * @property {number} exitCode
 * @property {string} stdout
 * @property {string} stderr
 * @property {number} durationMs
 * @property {Record<string, unknown>} providerMetadata
 *
 * @typedef {{ review(input: ReviewProviderInput): Promise<ReviewProviderResult> }} ReviewProvider
 */
```

常量：

```js
export const REPORT_SCHEMA_VERSION = 1;
export const PROMPT_SCHEMA_VERSION = '1';
export const RISK_ORDER = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };
```

把 `REPORT_SCHEMA_VERSION` 与 `PROMPT_SCHEMA_VERSION` 放在 `src/shared/config.js` 旁边的 `src/shared/versions.js`。Task 1 创建该文件。

---

### Task 1: 仓库脚手架、AppError 与版本常量

**Files:**
- Create: `package.json`
- Create: `.gitignore`
- Create: `src/shared/error-codes.js`
- Create: `src/shared/app-error.js`
- Create: `src/shared/versions.js`
- Create: `src/shared/hash.js`
- Test: `tests/app-error.test.js`
- Test: `tests/hash.test.js`

**Interfaces:**
- Consumes: 无
- Produces: `ErrorCodes`, `AppError`, `REPORT_SCHEMA_VERSION`, `PROMPT_SCHEMA_VERSION`, `sha256Text(text: string): string`

- [ ] **Step 1: Write the failing test**

```js
// tests/app-error.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../src/shared/app-error.js';
import { ErrorCodes } from '../src/shared/error-codes.js';

test('AppError serializes code, Chinese message, and details', () => {
  const err = new AppError(ErrorCodes.INVALID_REQUEST, '请求无效', ['sourceMode']);
  assert.equal(err.code, 'INVALID_REQUEST');
  assert.equal(err.message, '请求无效');
  assert.deepEqual(err.toJSON(), {
    error: { code: 'INVALID_REQUEST', message: '请求无效', details: ['sourceMode'] }
  });
});
```

```js
// tests/hash.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sha256Text } from '../src/shared/hash.js';

test('sha256Text is stable for the same UTF-8 input', () => {
  const a = sha256Text('代码审查');
  const b = sha256Text('代码审查');
  assert.equal(a.length, 64);
  assert.equal(a, b);
  assert.notEqual(a, sha256Text('代码审查 '));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/app-error.test.js tests/hash.test.js`

Expected: FAIL with `Cannot find module` for `../src/shared/app-error.js` (or hash).

- [ ] **Step 3: Write minimal implementation**

`package.json`:

```json
{
  "name": "code-review-system",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "start": "node src/main.js",
    "test": "node --test tests"
  }
}
```

`.gitignore`:

```
node_modules/
data/
app.config.json
.worktrees/
```

`src/shared/error-codes.js`: 使用上文完整 `ErrorCodes` 对象。

`src/shared/app-error.js`:

```js
export class AppError extends Error {
  constructor(code, message, details = []) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
  }

  toJSON() {
    return { error: { code: this.code, message: this.message, details: this.details } };
  }
}
```

`src/shared/versions.js`:

```js
export const REPORT_SCHEMA_VERSION = 1;
export const PROMPT_SCHEMA_VERSION = '1';
```

`src/shared/hash.js`:

```js
import { createHash } from 'node:crypto';

export function sha256Text(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/app-error.test.js tests/hash.test.js`

Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git init
git add package.json .gitignore src/shared/error-codes.js src/shared/app-error.js src/shared/versions.js src/shared/hash.js tests/app-error.test.js tests/hash.test.js
git commit -m "feat: add AppError, error codes, and sha256 helper"
```

---

### Task 2: 路径安全

**Files:**
- Create: `src/shared/path-security.js`
- Test: `tests/path-security.test.js`
- Create: `tests/helpers/temp-workspace.js`

**Interfaces:**
- Consumes: `AppError`, `ErrorCodes`
- Produces: `resolveRealPath(inputPath: string): Promise<string>`, `assertInsideAllowedRoots(realPath: string, allowedRoots: string[]): void`, `toPosixRelative(fromRoot: string, absolutePath: string): string`

- [ ] **Step 1: Write the failing test**

```js
// tests/helpers/temp-workspace.js
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export async function makeTempDir(prefix = 'crs-') {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}
```

```js
// tests/path-security.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { makeTempDir } from './helpers/temp-workspace.js';
import { resolveRealPath, assertInsideAllowedRoots, toPosixRelative } from '../src/shared/path-security.js';
import { ErrorCodes } from '../src/shared/error-codes.js';

test('assertInsideAllowedRoots allows a realpath under an allowed root', async () => {
  const root = await makeTempDir();
  const project = path.join(root, 'workspaces', 'demo');
  await fs.mkdir(project, { recursive: true });
  const realProject = await resolveRealPath(project);
  const realRoot = await resolveRealPath(path.join(root, 'workspaces'));
  assert.doesNotThrow(() => assertInsideAllowedRoots(realProject, [realRoot]));
});

test('assertInsideAllowedRoots rejects a sibling that only shares a string prefix', async () => {
  const root = await makeTempDir();
  const allowed = path.join(root, 'work');
  const escapee = path.join(root, 'work-evil', 'p');
  await fs.mkdir(allowed, { recursive: true });
  await fs.mkdir(escapee, { recursive: true });
  const realAllowed = await resolveRealPath(allowed);
  const realEscapee = await resolveRealPath(escapee);
  assert.throws(
    () => assertInsideAllowedRoots(realEscapee, [realAllowed]),
    (err) => err.code === ErrorCodes.PATH_OUTSIDE_ALLOWED_ROOT
  );
});

test('toPosixRelative returns forward-slash paths', async () => {
  const root = await makeTempDir();
  const file = path.join(root, 'src', 'a.cpp');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, 'int x;\n', 'utf8');
  const rel = toPosixRelative(await resolveRealPath(root), await resolveRealPath(file));
  assert.equal(rel, 'src/a.cpp');
});
```

再写一个符号链接测试（Windows 无权限创建 symlink 时用 `test.skip` 检测 `fs.symlink` 失败并 skip，不要当成通过）：

```js
test('symlink whose realpath leaves allowedRoots is PATH_SYMLINK_ESCAPE', async (t) => {
  const root = await makeTempDir();
  const allowed = path.join(root, 'allowed');
  const outside = path.join(root, 'outside');
  await fs.mkdir(allowed, { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  const link = path.join(allowed, 'escape');
  try {
    await fs.symlink(outside, link, 'dir');
  } catch {
    t.skip('symlink not permitted on this machine');
    return;
  }
  const realLink = await resolveRealPath(link);
  const realAllowed = await resolveRealPath(allowed);
  const { assertInsideAllowedRoots } = await import('../src/shared/path-security.js');
  const { ErrorCodes } = await import('../src/shared/error-codes.js');
  assert.throws(
    () => assertInsideAllowedRoots(realLink, [realAllowed]),
    (err) => err.code === ErrorCodes.PATH_SYMLINK_ESCAPE || err.code === ErrorCodes.PATH_OUTSIDE_ALLOWED_ROOT
  );
});
```

实现里：若 `realpath` 结果不在 allowedRoots 内，且原始路径的 lexical 形式看起来在内，则用 `PATH_SYMLINK_ESCAPE`；否则 `PATH_OUTSIDE_ALLOWED_ROOT`。

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/path-security.test.js`

Expected: FAIL `Cannot find module` `path-security.js`

- [ ] **Step 3: Write minimal implementation**

```js
// src/shared/path-security.js
import fs from 'node:fs/promises';
import path from 'node:path';
import { AppError } from './app-error.js';
import { ErrorCodes } from './error-codes.js';

function normalizeForCompare(p) {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export async function resolveRealPath(inputPath) {
  try {
    return await fs.realpath(inputPath);
  } catch {
    throw new AppError(ErrorCodes.PATH_NOT_FOUND, '路径不存在或无法解析', [inputPath]);
  }
}

function isInside(realPath, realRoot) {
  const rel = path.relative(normalizeForCompare(realRoot), normalizeForCompare(realPath));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function assertInsideAllowedRoots(realPath, allowedRoots, lexicalPath = realPath) {
  if (!allowedRoots || allowedRoots.length === 0) {
    throw new AppError(ErrorCodes.INVALID_REQUEST, 'allowedRoots 必须至少配置一项', []);
  }
  const ok = allowedRoots.some((root) => isInside(realPath, root));
  if (ok) return;
  const lexicalInside = allowedRoots.some((root) => isInside(path.resolve(lexicalPath), root));
  if (lexicalInside && normalizeForCompare(lexicalPath) !== normalizeForCompare(realPath)) {
    throw new AppError(ErrorCodes.PATH_SYMLINK_ESCAPE, '路径通过符号链接逃出允许访问的根目录', []);
  }
  throw new AppError(ErrorCodes.PATH_OUTSIDE_ALLOWED_ROOT, '项目目录不在允许访问的根目录中', []);
}

export function toPosixRelative(fromRoot, absolutePath) {
  return path.relative(fromRoot, absolutePath).split(path.sep).join('/');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/path-security.test.js`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/shared/path-security.js tests/path-security.test.js tests/helpers/temp-workspace.js
git commit -m "feat: add realpath-based allowedRoots path security"
```

---

### Task 3: 源码扩展名、排除目录、二进制检测

**Files:**
- Create: `src/shared/source-extensions.js`
- Test: `tests/source-extensions.test.js`

**Interfaces:**
- Consumes: 无
- Produces: `SUPPORTED_EXTENSIONS`, `EXCLUDED_DIR_NAMES`, `languageFromFileName(name: string): 'C'|'CPP'|'JAVA'|null`, `shouldSkipDirName(name: string): boolean`, `isBinaryBuffer(buf: Buffer): boolean`

- [ ] **Step 1: Write the failing test**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  languageFromFileName,
  shouldSkipDirName,
  isBinaryBuffer
} from '../src/shared/source-extensions.js';

test('languageFromFileName maps supported extensions case-insensitively', () => {
  assert.equal(languageFromFileName('a.C'), 'C');
  assert.equal(languageFromFileName('Foo.CPP'), 'CPP');
  assert.equal(languageFromFileName('Bar.Java'), 'JAVA');
  assert.equal(languageFromFileName('readme.md'), null);
  assert.equal(languageFromFileName('Makefile'), null);
});

test('shouldSkipDirName matches the fixed exclusion list', () => {
  assert.equal(shouldSkipDirName('node_modules'), true);
  assert.equal(shouldSkipDirName('target'), true);
  assert.equal(shouldSkipDirName('src'), false);
});

test('isBinaryBuffer detects NUL bytes', () => {
  assert.equal(isBinaryBuffer(Buffer.from('int x;\n')), false);
  assert.equal(isBinaryBuffer(Buffer.from([0x00, 0x01, 0x02])), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/source-extensions.test.js`

Expected: FAIL module not found

- [ ] **Step 3: Write minimal implementation**

```js
const CPP_EXT = new Set(['.cc', '.cpp', '.cxx', '.h', '.hpp', '.hxx']);

export const SUPPORTED_EXTENSIONS = ['.c', '.cc', '.cpp', '.cxx', '.h', '.hpp', '.hxx', '.java'];

export const EXCLUDED_DIR_NAMES = new Set([
  '.git', 'node_modules', 'dist', 'build', 'out', 'target', 'coverage', 'reports', 'logs'
]);

export function languageFromFileName(name) {
  const ext = name.includes('.') ? `.${name.split('.').pop().toLowerCase()}` : '';
  if (ext === '.c') return 'C';
  if (CPP_EXT.has(ext)) return 'CPP';
  if (ext === '.java') return 'JAVA';
  return null;
}

export function shouldSkipDirName(name) {
  return EXCLUDED_DIR_NAMES.has(name);
}

export function isBinaryBuffer(buf) {
  return buf.includes(0);
}
```

排除目录名：遍历时对名为 `data` 的目录，若其子目录是 `reports` 或 `logs` 则跳过那些子目录。`shouldSkipDirName('reports')` 为 true 即可覆盖 `data/reports` 与任意名为 reports 的目录。这比解析完整相对路径更简单，且满足 spec 固定排除列表。

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/source-extensions.test.js`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/shared/source-extensions.js tests/source-extensions.test.js
git commit -m "feat: add source extension, exclusion, and binary detection"
```

---

### Task 4: GitChangedSourceCollector

**Files:**
- Create: `src/git-changed-source-collector.js`
- Create: `tests/helpers/temp-git-repo.js`
- Test: `tests/git-changed-source-collector.test.js`

**Interfaces:**
- Consumes: `languageFromFileName`, `sha256Text`, `toPosixRelative`, `AppError`, `ErrorCodes`
- Produces: `collectGitChangedSource({ projectDir, maxFiles, maxFileChars, maxInputChars }): Promise<CollectedSource>`

采集器通过 `child_process.execFile` 调用 `git`（`shell: false`）。只使用只读命令：`rev-parse`、`diff`、`ls-files`。禁止 `checkout`/`reset`/`clean`/`add`。

- [ ] **Step 1: Write helper and failing test**

```js
// tests/helpers/temp-git-repo.js
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { makeTempDir } from './temp-workspace.js';

const execFile = promisify(execFileCb);

export async function git(cwd, args) {
  const { stdout } = await execFile('git', args, { cwd, windowsHide: true });
  return stdout;
}

export async function makeGitRepo() {
  const dir = await makeTempDir('crs-git-');
  await git(dir, ['init']);
  await git(dir, ['config', 'user.email', 'test@example.com']);
  await git(dir, ['config', 'user.name', 'Test']);
  return dir;
}

export async function writeFile(root, rel, content) {
  const abs = path.join(root, ...rel.split('/'));
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, 'utf8');
  return abs;
}
```

```js
// tests/git-changed-source-collector.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeGitRepo, git, writeFile } from './helpers/temp-git-repo.js';
import { collectGitChangedSource } from '../src/git-changed-source-collector.js';

test('collects staged, unstaged, and untracked supported files once each', async () => {
  const dir = await makeGitRepo();
  await writeFile(dir, 'src/base.cpp', 'int a = 1;\n');
  await git(dir, ['add', 'src/base.cpp']);
  await git(dir, ['commit', '-m', 'base']);

  await writeFile(dir, 'src/staged.cpp', 'int s = 1;\n');
  await git(dir, ['add', 'src/staged.cpp']);

  await writeFile(dir, 'src/base.cpp', 'int a = 2;\n'); // unstaged modify
  await writeFile(dir, 'src/untracked.cpp', 'int u = 1;\n');
  await writeFile(dir, 'src/skip.txt', 'nope\n');

  const source = await collectGitChangedSource({
    projectDir: dir,
    maxFiles: 50,
    maxFileChars: 80000,
    maxInputChars: 240000
  });
  const paths = source.files.map((f) => f.path).sort();
  assert.deepEqual(paths, ['src/base.cpp', 'src/staged.cpp', 'src/untracked.cpp']);
  assert.equal(source.files.find((f) => f.path === 'src/untracked.cpp').status, 'UNTRACKED');
  assert.equal(source.files.find((f) => f.path === 'src/base.cpp').status, 'MODIFIED');
  assert.ok(source.files.find((f) => f.path === 'src/base.cpp').changedLines.includes(1));
});

test('treats all supported files as ADDED when HEAD is missing', async () => {
  const dir = await makeGitRepo();
  await writeFile(dir, 'src/new.cpp', 'int n = 1;\n');
  const source = await collectGitChangedSource({
    projectDir: dir, maxFiles: 50, maxFileChars: 80000, maxInputChars: 240000
  });
  assert.equal(source.files[0].status, 'ADDED');
  assert.equal(source.files[0].path, 'src/new.cpp');
});

test('fails with GIT_REPOSITORY_REQUIRED when not a git work tree', async () => {
  const { makeTempDir } = await import('./helpers/temp-workspace.js');
  const dir = await makeTempDir();
  await assert.rejects(
    () => collectGitChangedSource({
      projectDir: dir, maxFiles: 50, maxFileChars: 80000, maxInputChars: 240000
    }),
    (err) => err.code === 'GIT_REPOSITORY_REQUIRED'
  );
});

test('keeps deleted file diff without current line numbers', async () => {
  const dir = await makeGitRepo();
  await writeFile(dir, 'src/gone.cpp', 'int g = 1;\n');
  await git(dir, ['add', 'src/gone.cpp']);
  await git(dir, ['commit', '-m', 'add']);
  await git(dir, ['rm', 'src/gone.cpp']);
  const source = await collectGitChangedSource({
    projectDir: dir, maxFiles: 50, maxFileChars: 80000, maxInputChars: 240000
  });
  const gone = source.files.find((f) => f.path === 'src/gone.cpp');
  assert.equal(gone.status, 'DELETED');
  assert.equal(gone.lineCount, null);
  assert.deepEqual(gone.changedLines, []);
  assert.ok(source.contents['src/gone.cpp'].includes('-int g'));
});

test('records rename with final path and oldPath metadata', async () => {
  const dir = await makeGitRepo();
  await writeFile(dir, 'src/old.cpp', 'int r = 1;\n');
  await git(dir, ['add', 'src/old.cpp']);
  await git(dir, ['commit', '-m', 'add']);
  await git(dir, ['mv', 'src/old.cpp', 'src/new.cpp']);
  const source = await collectGitChangedSource({
    projectDir: dir, maxFiles: 50, maxFileChars: 80000, maxInputChars: 240000
  });
  const renamed = source.files.find((f) => f.path === 'src/new.cpp');
  assert.equal(renamed.status, 'RENAMED');
  assert.equal(renamed.oldPath, 'src/old.cpp');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/git-changed-source-collector.test.js`

Expected: FAIL module not found

- [ ] **Step 3: Write minimal implementation**

`collectGitChangedSource` 算法：

1. `git rev-parse --is-inside-work-tree` 非 `true` → `GIT_REPOSITORY_REQUIRED`（中文：当前项目不是 Git 工作区）。
2. `git rev-parse --verify HEAD` 失败 → 无 HEAD：递归列出受支持文件（复用 Task 5 会做的全量扫描太早；本任务内写一个仅限受支持扩展名的 `fs.readdir` 递归，排除 `shouldSkipDirName`），全部 `ADDED`，`changedLines` 为 `1..lineCount`，`contents[path]` 为带行号文本。
3. 有 HEAD：
   - `git diff --name-status -z HEAD` 得到 tracked 变更（含 D/R）。
   - `git ls-files -z --others --exclude-standard` 得到 untracked。
   - 同一 path 只保留一次（untracked 与 tracked 不应重叠；若重叠以 tracked 为准）。
4. 过滤 `languageFromFileName` 为 null 的文件。
5. DELETED：`git diff HEAD -- path` 作为 `contents[path]`；`lineCount` null；`changedLines` []。
6. 其他：读当前文件；`changedLines` 从 `git diff -U0 HEAD -- path` 的 `+` 行号解析；UNTRACKED/ADDED 的 changedLines 为全部行。
7. 超 `maxFiles` → `SOURCE_FILE_LIMIT_EXCEEDED`，details 列出文件数。单文件超 `maxFileChars` 或合计超 `maxInputChars` → `SOURCE_SIZE_LIMIT_EXCEEDED`，details 列出超限项。零个受支持文件 → `NO_REVIEWABLE_SOURCE`。
8. `files` 按 `path` 升序。

带行号文本格式（后续 Prompt 与全量模式共用，导出 `numberLines(text)` 于本文件）：

```
     1|int a = 2;
     2|
```

右对齐 6 位行号 + `|`。

解析 `git diff -U0` hunk 头 `@@ -a,b +c,d @@`：对每个 `+` 内容行（非 `+++`）记 `c, c+1, ...`。

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/git-changed-source-collector.test.js`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/git-changed-source-collector.js tests/git-changed-source-collector.test.js tests/helpers/temp-git-repo.js
git commit -m "feat: collect git staged, unstaged, and untracked sources"
```

---

### Task 5: FullDirectorySourceCollector

**Files:**
- Create: `src/full-directory-source-collector.js`
- Test: `tests/full-directory-source-collector.test.js`

**Interfaces:**
- Consumes: `languageFromFileName`, `shouldSkipDirName`, `isBinaryBuffer`, `sha256Text`, `toPosixRelative`, `numberLines`（从 git collector 抽出到 `src/shared/source-text.js` 以免循环依赖）
- Produces: `collectFullDirectorySource({ projectDir, maxFiles, maxFileChars, maxInputChars }): Promise<CollectedSource>`

若 Task 4 已把 `numberLines` 放在 git 文件中：本任务 **先** 把 `numberLines` 移到 `src/shared/source-text.js`，更新 git collector 的 import，再实现全量采集。这是重构，保持 git 测试绿。

- [ ] **Step 1: Write the failing test**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { makeTempDir } from './helpers/temp-workspace.js';
import { collectFullDirectorySource } from '../src/full-directory-source-collector.js';

test('collects supported files, skips excluded dirs and unsupported names', async () => {
  const dir = await makeTempDir();
  await fs.mkdir(path.join(dir, 'src'), { recursive: true });
  await fs.mkdir(path.join(dir, 'node_modules', 'x'), { recursive: true });
  await fs.writeFile(path.join(dir, 'src', 'a.cpp'), 'int a;\n', 'utf8');
  await fs.writeFile(path.join(dir, 'src', 'B.java'), 'class B {}\n', 'utf8');
  await fs.writeFile(path.join(dir, 'src', 'note.md'), '# n\n', 'utf8');
  await fs.writeFile(path.join(dir, 'node_modules', 'x', 'n.cpp'), 'int n;\n', 'utf8');
  const source = await collectFullDirectorySource({
    projectDir: dir, maxFiles: 50, maxFileChars: 80000, maxInputChars: 240000
  });
  assert.deepEqual(source.files.map((f) => f.path).sort(), ['src/B.java', 'src/a.cpp']);
  assert.equal(source.files[0].status, 'ADDED');
  assert.ok(source.contents['src/a.cpp'].includes('1|'));
});

test('rejects binary supported-extension files', async () => {
  const dir = await makeTempDir();
  await fs.writeFile(path.join(dir, 'blob.cpp'), Buffer.from([0x00, 0x01, 0x02]));
  await assert.rejects(
    () => collectFullDirectorySource({
      projectDir: dir, maxFiles: 50, maxFileChars: 80000, maxInputChars: 240000
    }),
    (err) => err.code === 'SOURCE_SIZE_LIMIT_EXCEEDED' || err.message.includes('二进制')
  );
});
```

二进制处理：对检测到的二进制文件抛 `AppError(SOURCE_SIZE_LIMIT_EXCEEDED, '检测到二进制文件，已拒绝', [relPath])`。不要静默跳过（否则用户不知道文件被丢）。

不跟随符号链接：`readdir` + `lstat`；若 `isSymbolicLink()` 则跳过该条目。

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/full-directory-source-collector.test.js`

Expected: FAIL module not found

- [ ] **Step 3: Write minimal implementation**

递归、排序路径、读文件、填 `CollectedSource`。空结果 → `NO_REVIEWABLE_SOURCE`。

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/full-directory-source-collector.test.js tests/git-changed-source-collector.test.js`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/full-directory-source-collector.js src/shared/source-text.js src/git-changed-source-collector.js tests/full-directory-source-collector.test.js
git commit -m "feat: collect full-directory supported sources"
```

---

### Task 6: RequirementLoader

**Files:**
- Create: `src/requirement-loader.js`
- Test: `tests/requirement-loader.test.js`

**Interfaces:**
- Consumes: `AppError`, `ErrorCodes`
- Produces: `loadRequirement({ filePath, maxChars }): Promise<{ text: string, characterCount: number, contentHash: string }>`

- [ ] **Step 1: Write the failing test**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { makeTempDir } from './helpers/temp-workspace.js';
import { loadRequirement } from '../src/requirement-loader.js';
import { ErrorCodes } from '../src/shared/error-codes.js';

test('loads utf8 markdown without rewriting', async () => {
  const dir = await makeTempDir();
  const file = path.join(dir, 'req.md');
  await fs.writeFile(file, '# 需求\n必须返回 0\n', 'utf8');
  const loaded = await loadRequirement({ filePath: file, maxChars: 50000 });
  assert.equal(loaded.text, '# 需求\n必须返回 0\n');
});

test('rejects non-markdown and empty files', async () => {
  const dir = await makeTempDir();
  const txt = path.join(dir, 'req.txt');
  await fs.writeFile(txt, 'x', 'utf8');
  await assert.rejects(
    () => loadRequirement({ filePath: txt, maxChars: 50000 }),
    (err) => err.code === ErrorCodes.REQUIREMENT_NOT_MARKDOWN
  );
  const md = path.join(dir, 'empty.md');
  await fs.writeFile(md, '   \n', 'utf8');
  await assert.rejects(
    () => loadRequirement({ filePath: md, maxChars: 50000 }),
    (err) => err.code === ErrorCodes.REQUIREMENT_EMPTY
  );
});
```

`.markdown` 与 `.md` 都合法。trim 后长度为 0 视为空。超限 `SOURCE_SIZE_LIMIT_EXCEEDED`（details: `requirement`）。

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/requirement-loader.test.js`

Expected: FAIL module not found

- [ ] **Step 3: Write minimal implementation**

只 `readFile` UTF-8；不改写内容。

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/requirement-loader.test.js`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/requirement-loader.js tests/requirement-loader.test.js
git commit -m "feat: load requirement markdown with size and type checks"
```

---

### Task 7: 固定规则文件与 RuleResolver

**Files:**
- Create: `docs/rules/global-review.md`
- Create: `docs/rules/cpp-review.md`
- Create: `docs/rules/java-review.md`
- Create: `docs/rules/review-checklist.md`
- Create: `docs/rules/post-review-policy.md`
- Create: `src/rule-resolver.js`
- Test: `tests/rule-resolver.test.js`

**Interfaces:**
- Consumes: `sha256Text`, `toPosixRelative`, `AppError`, `ErrorCodes`
- Produces: `resolveRules({ projectDir, files, checklist, rulesDir }): Promise<ResolvedRules>`

```js
/**
 * @typedef {object} ResolvedRule
 * @property {string} ruleId            GLOBAL | CPP | JAVA | CHECKLIST
 * @property {'GLOBAL'|'CPP'|'JAVA'|'CHECKLIST'} ruleType
 * @property {boolean} builtIn
 * @property {string} content
 * @property {string} contentHash
 * @property {string[]} matchPaths
 * @property {string[]} matchedFiles
 *
 * @typedef {{ rules: ResolvedRule[], checklistLoaded: boolean }} ResolvedRules
 */
```

`rulesDir` 默认 `path.join(process.cwd(), 'docs/rules')`，测试传入临时目录或仓库内 `docs/rules`。

全局、C++、Java 路径 **硬编码** 为 `docs/rules/global-review.md` 等相对 `rulesDir` 的文件名。checklist 才用 `checklist.path`。

- [ ] **Step 1: Write rule files and failing test**

`docs/rules/global-review.md` 必须覆盖 spec §9.1 全部要点（只基于证据、不猜测外部接口、优先正确性/安全/内存/并发/生命周期、允许需求不符合、无位置的中高风险不成立、JSON Schema、简体中文）。不得出现 KDOP、仓库轮询、提交作者、邮件、工单。

`docs/rules/cpp-review.md` 覆盖 §9.2 列表，无企业私有宏/固定目录/数据库方言。

`docs/rules/java-review.md` 覆盖 §9.3 列表，无固定数据库方言/内部约定。

`docs/rules/review-checklist.md` 覆盖并发、内存边界、外部输入、错误处理、资源生命周期、控制流。

`docs/rules/post-review-policy.md` 用中文复述 PF-001…PF-010（给人读，不给 Agent 当规则加载；RuleResolver **不**加载此文件）。

测试：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRules } from '../src/rule-resolver.js';

const rulesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'rules');

test('always loads global rules and language rules only when those files exist in the input', async () => {
  const resolved = await resolveRules({
    projectDir: '/proj',
    files: [
      { path: 'src/a.cpp', language: 'CPP' },
      { path: 'src/B.java', language: 'JAVA' }
    ],
    checklist: { enabled: false, path: null, includePaths: ['.'], excludePaths: [] },
    rulesDir
  });
  const types = resolved.rules.map((r) => r.ruleType).sort();
  assert.deepEqual(types, ['CPP', 'GLOBAL', 'JAVA']);
  assert.equal(resolved.rules.find((r) => r.ruleType === 'GLOBAL').builtIn, true);
  assert.ok(resolved.rules.find((r) => r.ruleType === 'CPP').matchedFiles.includes('src/a.cpp'));
});

test('loads checklist only for includePaths minus excludePaths', async () => {
  const resolved = await resolveRules({
    projectDir: '/proj',
    files: [
      { path: 'src/a.cpp', language: 'CPP' },
      { path: 'src/generated/x.cpp', language: 'CPP' }
    ],
    checklist: {
      enabled: true,
      path: path.join(rulesDir, 'review-checklist.md'),
      includePaths: ['src'],
      excludePaths: ['src/generated']
    },
    rulesDir
  });
  const cl = resolved.rules.find((r) => r.ruleType === 'CHECKLIST');
  assert.equal(cl.builtIn, false);
  assert.deepEqual(cl.matchedFiles, ['src/a.cpp']);
});

test('does not load checklist when disabled', async () => {
  const resolved = await resolveRules({
    projectDir: '/proj',
    files: [{ path: 'src/a.cpp', language: 'CPP' }],
    checklist: { enabled: false, path: path.join(rulesDir, 'review-checklist.md'), includePaths: ['.'], excludePaths: [] },
    rulesDir
  });
  assert.equal(resolved.rules.some((r) => r.ruleType === 'CHECKLIST'), false);
});
```

路径匹配：把 `includePaths`/`excludePaths` 当成相对项目的前缀，按路径段边界比较（`src` 匹配 `src/a.cpp`，不匹配 `src2/a.cpp`）。`'.'` 匹配全部。

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/rule-resolver.test.js`

Expected: FAIL module not found

- [ ] **Step 3: Write minimal implementation**

读规则失败 → `RULE_READ_FAILED`。checklist 超 80,000 字符 → `SOURCE_SIZE_LIMIT_EXCEEDED`。

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/rule-resolver.test.js`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add docs/rules src/rule-resolver.js tests/rule-resolver.test.js
git commit -m "feat: resolve built-in rules and optional checklist"
```

---

### Task 8: PromptBuilder

**Files:**
- Create: `src/prompt-builder.js`
- Test: `tests/prompt-builder.test.js`

**Interfaces:**
- Consumes: `PROMPT_SCHEMA_VERSION`
- Produces: `buildPrompt({ requirementText, sourceMode, files, contents, rules }): { text: string, characterCount: number }`

固定顺序，每段以标题行开始（便于测试断言）：

1. `## 角色与证据原则`
2. `## JSON 输出契约`（把 spec §10.1 的 JSON 例子原文放入）
3. `## 需求文档`
4. `## 审查范围`（模式、文件清单）
5. `## 固定全局规则`
6. `## 固定语言规则`（仅包含已解析的 CPP/JAVA 段，按 CPP 再 JAVA）
7. `## review-checklist`（无 checklist 则本段写 `未启用`）
8. `## 源码或 Diff`
9. `## 输出前自检`

- [ ] **Step 1: Write the failing test**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt } from '../src/prompt-builder.js';

test('emits sections in the required order and is stable', async () => {
  const input = {
    requirementText: '# 需求\n返回 0\n',
    sourceMode: 'GIT_CHANGES',
    files: [{ path: 'src/a.cpp', language: 'CPP', status: 'MODIFIED' }],
    contents: { 'src/a.cpp': '@@\n+int x;\n' },
    rules: [
      { ruleType: 'GLOBAL', content: '全局规则A' },
      { ruleType: 'CPP', content: 'C++规则B' }
    ]
  };
  const a = buildPrompt(input).text;
  const b = buildPrompt(input).text;
  assert.equal(a, b);
  const idx = [
    '## 角色与证据原则',
    '## JSON 输出契约',
    '## 需求文档',
    '## 审查范围',
    '## 固定全局规则',
    '## 固定语言规则',
    '## review-checklist',
    '## 源码或 Diff',
    '## 输出前自检'
  ].map((h) => a.indexOf(h));
  for (let i = 1; i < idx.length; i++) assert.ok(idx[i] > idx[i - 1]);
  assert.ok(a.includes('全局规则A'));
  assert.ok(a.includes('C++规则B'));
  assert.ok(a.includes('# 需求'));
  assert.ok(a.includes('src/a.cpp'));
});
```

角色段必须写明：只基于需求/源码/diff 证据；禁止猜测；中高风险必须有位置；只输出一个 JSON 对象。

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/prompt-builder.test.js`

Expected: FAIL module not found

- [ ] **Step 3: Write minimal implementation**

纯函数，不读盘。

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/prompt-builder.test.js`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/prompt-builder.js tests/prompt-builder.test.js
git commit -m "feat: build stable ordered review prompts"
```

---

### Task 9: ReviewResultParser

**Files:**
- Create: `src/review-result-parser.js`
- Test: `tests/review-result-parser.test.js`

**Interfaces:**
- Consumes: `AppError`, `ErrorCodes`
- Produces: `parseReviewOutput(raw: string): { summary: string, overall_risk: string, findings: RawFinding[], evidence: unknown[], recommended_actions: unknown[] }`

登记别名（仅这些）：`overallRisk`→`overall_risk`，`riskLevel`→`risk_level`，`filePath`→`file_path`，`lineStart`→`line_start`，`lineEnd`→`line_end`，`requirementReference`→`requirement_reference`，`fixSuggestion`→`fix_suggestion`，`fixCode`→`fix_code`。

- [ ] **Step 1: Write the failing test**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReviewOutput } from '../src/review-result-parser.js';
import { ErrorCodes } from '../src/shared/error-codes.js';

test('strips markdown fence and maps aliases', () => {
  const raw = '```json\n{"summary":"s","overallRisk":"low","findings":[{"category":"CORRECTNESS","riskLevel":"medium","title":"t","description":"d","filePath":"src/a.cpp","lineStart":10,"lineEnd":10,"evidence":"e","requirementReference":"","fixSuggestion":"f"}]}\n```';
  const parsed = parseReviewOutput(raw);
  assert.equal(parsed.overall_risk, 'LOW');
  assert.equal(parsed.findings[0].risk_level, 'MEDIUM');
  assert.equal(parsed.findings[0].file_path, 'src/a.cpp');
  assert.equal(parsed.findings[0].line_start, 10);
});

test('invalid json becomes AI_OUTPUT_INVALID_JSON without fabricating findings', () => {
  assert.throws(
    () => parseReviewOutput('not json'),
    (err) => err.code === ErrorCodes.AI_OUTPUT_INVALID_JSON && !('findings' in err)
  );
});

test('missing required finding fields becomes AI_OUTPUT_SCHEMA_INVALID', () => {
  assert.throws(
    () => parseReviewOutput(JSON.stringify({ summary: 's', overall_risk: 'LOW', findings: [{ title: 't' }] })),
    (err) => err.code === ErrorCodes.AI_OUTPUT_SCHEMA_INVALID
  );
});
```

必填 finding 字段：`category, risk_level, title, description, file_path, evidence`。`line_start`/`line_end` 若存在且非整数则先转 null（PF-001 也会做，parser 可先转）。`findings` 必须是数组。`summary` 必须是字符串。

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/review-result-parser.test.js`

Expected: FAIL module not found

- [ ] **Step 3: Write minimal implementation**

去围栏：若 trim 后以 ` ``` ` 开头，去掉第一行和末行 ` ``` `。然后取第一个 `{` 到最后一个 `}`。`JSON.parse` 失败 → `AI_OUTPUT_INVALID_JSON`。

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/review-result-parser.test.js`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/review-result-parser.js tests/review-result-parser.test.js
git commit -m "feat: parse and validate AI review JSON"
```

---

### Task 10: PostReviewPolicy PF-001 至 PF-005

**Files:**
- Create: `src/post-review-policy.js`
- Create: `tests/helpers/policy-fixtures.js`
- Test: `tests/post-review-policy.test.js`

**Interfaces:**
- Consumes: 无 IO
- Produces: `applyPostReviewPolicy({ rawFindings, selectedFiles, sourceMode }): PolicyResult`（**不**含 timestamp）

```js
/**
 * selectedFiles: { path, changedLines, lineCount, status }[]
 * PolicyResult.findings[].decisions[]: { policyId, action, beforeRisk, afterRisk, reason }
 * action: KEPT | CORRECTED | DOWNGRADED | EXEMPTED | MERGED
 * timestamp 由 ReviewJobService 在决策后写入每条 decision
 */
```

`tests/helpers/policy-fixtures.js`：

```js
export function rawFinding(overrides = {}) {
  return {
    category: 'CORRECTNESS',
    risk_level: 'HIGH',
    title: '空指针解引用',
    description: '在第 3 行对 p 解引用，p 可能为空',
    file_path: 'src/a.cpp',
    line_start: 3,
    line_end: 3,
    evidence: 'p->x 且 p 未判空',
    requirement_reference: '',
    fix_suggestion: '先判空',
    fix_code: '',
    ...overrides
  };
}

export function selected(path = 'src/a.cpp', changedLines = [3], lineCount = 10, status = 'MODIFIED') {
  return { path, changedLines, lineCount, status };
}
```

- [ ] **Step 1: Write the failing tests for PF-001…PF-005**

在 `tests/post-review-policy.test.js` 中逐条：

1. PF-001：`risk_level: 'medium'` → `finalRisk 'MEDIUM'`，`action CORRECTED`；非法风险 `FOO` → `LOW`；非法类别 `WEIRD` → `OTHER`；`file_path` 反斜杠改正斜杠。
2. PF-002：`file_path: 'src/other.cpp'` 不在 selected → `EXEMPTED`，reason 含 `OUT_OF_SCOPE_FILE`。
3. PF-003：`line_start: 99` 而 `lineCount: 10` → `EXEMPTED`；Git 模式 `sourceMode: 'GIT_CHANGES'`，`changedLines: [5]` 但 finding 在第 1 行、类别 CORRECTNESS HIGH → `DOWNGRADED` 到 `LOW`。崩溃类（MEMORY_SAFETY + 证据含「空指针」）即使不在 changedLines 也不因 PF-003 第三条降 LOW（spec：非崩溃类才降）。
4. PF-004：title/description 含「可能」且 evidence 为空或同为推测 → `EXEMPTED`；MEMORY_SAFETY 有具体 `p->x` 证据即使描述含「可能」→ 不因 PF-004 豁免。
5. PF-005：description 含「未知第三方接口」「旧版本升级路径」且无本仓库代码证据 → `EXEMPTED`。

每条测试断言 `decisions` 含对应 `policyId`（`PF-001` 等）和中文 `reason`。

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/post-review-policy.test.js`

Expected: FAIL module not found

- [ ] **Step 3: Write minimal implementation for PF-001…PF-005**

按固定顺序执行政策。findingId 在进入政策时分配为 `F-001` 起，按输入数组顺序。`originalRisk` 为归一化后、范围豁免前的风险。

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/post-review-policy.test.js`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/post-review-policy.js tests/post-review-policy.test.js tests/helpers/policy-fixtures.js
git commit -m "feat: apply post-review policies PF-001 through PF-005"
```

---

### Task 11: PostReviewPolicy PF-006 至 PF-010

**Files:**
- Modify: `src/post-review-policy.js`
- Modify: `tests/post-review-policy.test.js`

**Interfaces:**
- Consumes: Task 10 的 `applyPostReviewPolicy`
- Produces: 同一函数补齐 PF-006…PF-010；`overallRisk`、`activeFindingCount`、`exemptedFindingCount`、`mergedFindingCount`

- [ ] **Step 1: Write the failing tests**

1. PF-006：`MAINTAINABILITY` + `HIGH` → `finalRisk LOW`；`PERFORMANCE` 无「复杂度|循环|热点|O(」类证据 → 最高 LOW；`OTHER` + `CRITICAL` → 不能保持中高风险（降至 LOW）。
2. PF-007：`MEMORY_SAFETY`、有精确行号、evidence 含「use-after-free」→ `finalRisk` 不低于 HIGH；自称 CRITICAL 但无灾难性类别（例如只是越界）→ 最高 HIGH。
3. PF-008：`REQUIREMENT_MISMATCH` 缺 `requirement_reference` → 降至 LOW；同时有引用和位置且描述「违反验收：必须返回 0」可保持 MEDIUM/HIGH。
4. PF-009：两 Finding 同 path、行号重叠、同 category、标题规范化后相同 → 后者 `MERGED`，主项保留较高 `finalRisk`。
5. PF-010：忽略 EXEMPTED 与 MERGED 从项；`overallRisk` 为剩余最高 `finalRisk`；全豁免时 `LOW`。

标题规范化：NFKC、小写、去掉空白。行号重叠：闭区间相交。

- [ ] **Step 2: Run test to verify new cases fail**

Run: `node --test tests/post-review-policy.test.js`

Expected: 新断言 FAIL（旧 PF-001…005 仍 PASS）

- [ ] **Step 3: Extend implementation**

纯函数，不用 `Date.now()` / `Math.random()`。

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/post-review-policy.test.js`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/post-review-policy.js tests/post-review-policy.test.js
git commit -m "feat: complete post-review policies PF-006 through PF-010"
```

---

### Task 12: HtmlReportRenderer

**Files:**
- Create: `src/shared/html-escape.js`
- Create: `src/html-report-renderer.js`
- Test: `tests/html-report-renderer.test.js`

**Interfaces:**
- Consumes: `htmlEscape`
- Produces: `renderHtmlReport(report: object): string`

- [ ] **Step 1: Write the failing test**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderHtmlReport } from '../src/html-report-renderer.js';

test('escapes script tags and does not include CDN or full source', () => {
  const html = renderHtmlReport({
    schemaVersion: 1,
    reviewId: 'r1',
    status: 'SUCCEEDED',
    request: { projectName: 'demo', projectDirDisplay: 'ws/demo', sourceMode: 'GIT_CHANGES' },
    source: { files: [{ path: 'src/a.cpp' }], rules: [] },
    result: {
      summary: '<script>alert(1)</script>',
      overallRisk: 'LOW',
      findings: [{
        findingId: 'F-001',
        title: '"onclick=',
        description: '<img src=x onerror=alert(1)>',
        status: 'KEPT',
        finalRisk: 'LOW',
        decisions: [{ policyId: 'PF-001', action: 'KEPT', reason: '保持', beforeRisk: 'LOW', afterRisk: 'LOW' }]
      }]
    },
    ai: { rawOutput: '<script>alert(1)</script>' },
    errors: []
  });
  assert.equal(html.includes('<script>alert(1)</script>'), false);
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.equal(/https:\/\//.test(html), false);
  assert.equal(html.includes('int main'), false);
});
```

页面按 spec §12.6 顺序用 `<h2>`：概要、输入与规则、有效问题、降级、豁免与合并、决策轨迹、AI 元数据、错误。自包含 `<style>`，无外部 script。

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/html-report-renderer.test.js`

Expected: FAIL module not found

- [ ] **Step 3: Write minimal implementation**

`htmlEscape`：`& < > " '`。所有动态字段先转义再拼接。

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/html-report-renderer.test.js`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/shared/html-escape.js src/html-report-renderer.js tests/html-report-renderer.test.js
git commit -m "feat: render self-contained escaped HTML reports"
```

---

### Task 13: FileReportRepository

**Files:**
- Create: `src/file-report-repository.js`
- Test: `tests/file-report-repository.test.js`

**Interfaces:**
- Consumes: `REPORT_SCHEMA_VERSION`, `renderHtmlReport`, 可注入 `idFactory`（默认 `crypto.randomUUID`）
- Produces: `createFileReportRepository({ reportsDir, idFactory })` → `{ createReviewId(), save(report), read(reviewId), listSummaries() }`

`save`：写 `reportsDir/.tmp-{id}/report.json` 与 `report.html`，成功后 `rename` 为 `reportsDir/{id}/`。失败清理 tmp。`listSummaries` 按 `createdAt` 倒序，字段：createdAt、projectName、sourceMode、status、overallRisk、activeFindingCount、exemptedFindingCount、durationMs、reviewId。

JSON 默认不写完整绝对路径（由调用方传入已经过展示处理的 report 对象）。

- [ ] **Step 1: Write the failing test**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { makeTempDir } from './helpers/temp-workspace.js';
import { createFileReportRepository } from '../src/file-report-repository.js';

test('atomically writes json and html and lists newest first', async () => {
  const dir = await makeTempDir();
  let n = 0;
  const repo = createFileReportRepository({
    reportsDir: dir,
    idFactory: () => `id-${++n}`
  });
  const id = repo.createReviewId();
  await repo.save({
    schemaVersion: 1,
    reviewId: id,
    status: 'SUCCEEDED',
    createdAt: '2026-08-29T01:00:00.000Z',
    completedAt: '2026-08-29T01:00:01.000Z',
    durationMs: 1000,
    request: { projectName: 'p', sourceMode: 'GIT_CHANGES' },
    source: { files: [], inputHash: 'x', fileCount: 0, totalCharacters: 0 },
    rules: [],
    ai: {},
    result: { summary: 'ok', overallRisk: 'LOW', activeFindingCount: 0, exemptedFindingCount: 0, mergedFindingCount: 0, findings: [], recommendedActions: [] },
    errors: []
  });
  const json = JSON.parse(await fs.readFile(path.join(dir, id, 'report.json'), 'utf8'));
  assert.equal(json.reviewId, id);
  assert.equal(json.schemaVersion, 1);
  await fs.access(path.join(dir, id, 'report.html'));
  const list = await repo.listSummaries();
  assert.equal(list[0].reviewId, id);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/file-report-repository.test.js`

Expected: FAIL module not found

- [ ] **Step 3: Write minimal implementation**

`save` 失败抛 `REPORT_WRITE_FAILED`。

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/file-report-repository.test.js`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/file-report-repository.js tests/file-report-repository.test.js
git commit -m "feat: atomically persist JSON and HTML reports"
```

---

### Task 14: RequestValidator 与配置加载

**Files:**
- Create: `app.config.example.json`
- Create: `src/shared/config.js`
- Create: `src/request-validator.js`
- Test: `tests/config.test.js`
- Test: `tests/request-validator.test.js`

**Interfaces:**
- Consumes: `resolveRealPath`, `assertInsideAllowedRoots`, `AppError`
- Produces: `loadConfig(path): Config`, `validateCreateReviewRequest(body, config): NormalizedRequest`

`NormalizedRequest`：

```js
{
  projectDir,              // realpath
  requirementFile,         // realpath
  sourceMode,              // GIT_CHANGES | FULL_DIRECTORY
  checklist: {
    enabled, path,         // path realpath or null
    includePaths, excludePaths
  },
  projectName,             // basename(projectDir)
  projectDirDisplay,       // 最后两级
  requirementFileDisplay,
  checklistFileDisplay
}
```

展示路径：取绝对路径最后两个 segment，POSIX 斜杠，例如 `workspaces/demo`。

- [ ] **Step 1: Write example config and failing tests**

`app.config.example.json` 使用 spec §14.1 对象，并追加：

```json
{
  "ai": {
    "provider": "cursor",
    "remote": {
      "baseUrl": "https://api.example.com",
      "model": "review-model",
      "apiKeyEnv": "REMOTE_LLM_API_KEY",
      "timeoutMs": 600000
    }
  },
  "scheduler": {
    "stateFile": "./data/scheduler-state.json",
    "profiles": []
  }
}
```

`loadConfig`：文件不存在或 JSON 非法或 `allowedRoots` 为空 → throw，消息中文，进程应在 main 里非 0 退出。

RequestValidator 测试（用临时 allowedRoot）：

- 缺 `projectDir` → `INVALID_REQUEST`
- 路径在根外 → `PATH_OUTSIDE_ALLOWED_ROOT`
- Git 模式但目录无 `.git` → `GIT_REPOSITORY_REQUIRED`（可用 `fs.access(.git)` 或 `git rev-parse`；与 collector 一致用 git）
- `sourceMode` 非法 → `INVALID_REQUEST`
- checklist.enabled true 但 path 非 md → `REQUIREMENT_NOT_MARKDOWN` 或 `INVALID_REQUEST`（用 `INVALID_REQUEST`，message：checklist 必须是 Markdown 文件）

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/config.test.js tests/request-validator.test.js`

Expected: FAIL module not found

- [ ] **Step 3: Write minimal implementation**

配置默认值与 spec §8.5 / §14.1 一致。`cursor.args` 保持数组。禁止配置里出现全局/cpp/java 规则路径字段；若用户加了 `rules.globalPath` 之类，`loadConfig` 直接失败（防止「外部配置替换固定规则」）。

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/config.test.js tests/request-validator.test.js`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add app.config.example.json src/shared/config.js src/request-validator.js tests/config.test.js tests/request-validator.test.js
git commit -m "feat: load config and validate review requests"
```

---

### Task 15: CursorReviewProvider 与 FakeReviewProvider

**Files:**
- Create: `src/providers/cursor-review-provider.js`
- Create: `tests/helpers/fake-review-provider.js`
- Create: `tests/helpers/fake-cursor-script.js`（可被 spawn 的小脚本，测试里动态写入临时 js）
- Test: `tests/cursor-review-provider.test.js`

**Interfaces:**
- Consumes: `AppError`, `ErrorCodes`
- Produces: `createCursorReviewProvider({ command, args, timeoutMs, maxOutputChars, spawnImpl })`, `createFakeReviewProvider({ rawOutput, exitCode, delayMs, writeOutputFile })`

Fake 放在 `tests/helpers`，不是产品功能。

- [ ] **Step 1: Write the failing test**

用临时目录写 `fake-agent.mjs`：

```js
import fs from 'node:fs';
const output = process.argv[process.argv.indexOf('--output') + 1];
fs.writeFileSync(output, '{"summary":"ok","overall_risk":"LOW","findings":[]}');
```

Provider args：`['--prompt-file', '{promptFile}', '--workspace', '{projectDir}', '--output', '{outputFile}']`。

断言：替换后 argv 不含字面量 `{outputFile}`；`review()` 返回 `rawOutput` 为文件内容；`windowsHide` 在 spawn option 中为 true（通过包装 `spawnImpl` 记录 options）。

超时测试：脚本 `await setTimeout(60_000)`，`timeoutMs: 50`，期望 `CURSOR_TIMEOUT`。

非零退出：`process.exit(2)` → `CURSOR_EXIT_NON_ZERO`。

占位符只替换完整参数：args 含 `'pre{promptFile}'` 时不得替换（保持原样），避免命令注入。

finally：删除 prompt 与 output 临时文件（测试里由 provider 创建或由调用方传入路径；**JobService 稍后创建文件**，Provider 仍负责删除传入的两个路径）。本任务测试直接传入已存在的 temp 文件。

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/cursor-review-provider.test.js`

Expected: FAIL module not found

- [ ] **Step 3: Write minimal implementation**

`spawn(command, resolvedArgs, { shell: false, windowsHide: true })`。收集 stdout/stderr，超 `maxOutputChars` → `CURSOR_OUTPUT_TOO_LARGE`。超时：`taskkill /pid /T /F`（win32）或 `process.kill(-pid)` 回退 `child.kill('SIGKILL')`。`command` 找不到 → `CURSOR_START_FAILED`。

不把 `process.env` 写入返回值或抛错 message。

FakeReviewProvider：`review()` 等待 `delayMs`，若 `writeOutputFile` 则写 `outputFile`，返回固定 `rawOutput`。

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/cursor-review-provider.test.js`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/providers/cursor-review-provider.js tests/helpers/fake-review-provider.js tests/cursor-review-provider.test.js
git commit -m "feat: spawn Cursor provider with timeout and fake provider"
```

---

### Task 16: ReviewJobService

**Files:**
- Create: `src/shared/logger.js`
- Create: `src/shared/clock.js`
- Create: `src/review-job-service.js`
- Test: `tests/review-job-service.test.js`

**Interfaces:**
- Consumes: validator、两个 collector、requirementLoader、ruleResolver、promptBuilder、provider、parser、policy、repository、clock、logger、`idFactory`
- Produces: `createReviewJobService(deps)` → `{ enqueue(normalizedRequest, { triggerType }), getJob(reviewId), listReports(), getReport(reviewId), pauseAccepting(), waitForIdle(ms), computeInputHashFor(normalizedRequest) }`

状态机仅允许：

```
QUEUED → COLLECTING → REVIEWING → FILTERING → REPORTING → SUCCEEDED
QUEUED|COLLECTING|REVIEWING|FILTERING|REPORTING → FAILED
```

`enqueue`：同步完成校验已在 Web 层做完；此处接收 `NormalizedRequest`，创建 `reviewId`，内存 job `QUEUED`，入队。`triggerType`：`MANUAL` 或 `SCHEDULED`。两队列：`manualQueue`、`scheduledQueue`；worker 先取 manual。同一时刻只跑一个 worker 循环。

`inputHash`：对稳定 JSON 做 sha256，字段顺序固定：`sourceMode`、`requirementText`、每个文件 `path`+`contents[path]`、每条规则 `ruleType+content`、`PROMPT_SCHEMA_VERSION`。

成功报告填 spec §12 全部顶层字段。AI 原始 `overall_risk` 写入 `ai.rawOverallRisk`。policy 的 decisions 补 `timestamp: clock.now().toISOString()`。`request.triggerType` 写入报告。`config.reports.includeAbsolutePaths === true` 时 JSON 可含完整 `projectDir`；默认 false，JSON 与 HTML 都只用 `*Display` 两级路径。HTML 永不写完整绝对路径。

Provider / parser 失败：`FAILED` 报告，`errors: [{ code, message, details }]`，`result.findings` 为空，不得编造缺陷。`rawOutput` 保留在 `ai.rawOutput`（截断到 maxOutputChars）。

报告写入失败：job 内存 `FAILED` + 日志 `REPORT_WRITE_FAILED`，这是唯一可以没有报告文件的情况。

重启：服务不恢复 QUEUED 内存任务。`getJob` 若内存没有则 `repository.read`。

- [ ] **Step 1: Write the failing test**

使用 FakeReviewProvider 返回合法 JSON（含一个 HIGH finding）。临时项目 + 需求文件。断言：最终 `SUCCEEDED`、生成 json/html、`overallRisk` 来自 policy 而非 AI、`ai.rawOverallRisk` 保留。

第二个测试：Fake 返回 `not-json` → `FAILED`、`errors[0].code === 'AI_OUTPUT_INVALID_JSON'`、findings 为空。

第三个测试：连续 enqueue 两个 job，记录 provider 调用重叠标志；断言不同时进入 `review()`（concurrency 1）。

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/review-job-service.test.js`

Expected: FAIL module not found

- [ ] **Step 3: Write minimal implementation**

Logger：向可注入的 stream 写一行 JSON：`timestamp, level, event, reviewId, stage, durationMs, errorCode, message`。路径只写 `projectName`，不写绝对路径。

临时 prompt/output 文件放在 `os.tmpdir()`，命名 `crs-{reviewId}-prompt.txt` / `crs-{reviewId}-out.json`。

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/review-job-service.test.js`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/shared/logger.js src/shared/clock.js src/review-job-service.js tests/review-job-service.test.js
git commit -m "feat: orchestrate review jobs with single-flight queue"
```

---

### Task 17: WebAdapter API 与页面

**Files:**
- Create: `src/web/templates.js`
- Create: `src/web/web-adapter.js`
- Create: `src/create-app.js`
- Test: `tests/web-adapter.test.js`

**Interfaces:**
- Consumes: `createReviewJobService`、`validateCreateReviewRequest`、`loadConfig`
- Produces: `createWebAdapter({ jobService, config, validateRequest })` → Node `http.Server` 处理器

路由：

| Method | Path | Behavior |
|--------|------|----------|
| GET | `/` | 表单 + 历史表 |
| GET | `/jobs/:id` | 任务页，JS 轮询 `/api/jobs/:id` |
| GET | `/reports/:id` | Web 详情（读 JSON 渲染，转义） |
| GET | `/reports/:id/report.html` | 文件或 404 |
| GET | `/reports/:id/report.json` | 文件或 404 |
| POST | `/api/reviews` | 校验；202 `{ reviewId, status: "QUEUED" }` |
| GET | `/api/jobs/:id` | 内存或报告状态 |
| GET | `/api/reports` | 历史摘要 |
| GET | `/api/reports/:id` | 完整报告 JSON |
| GET | `/api/health` | `{ status, queueLength, currentReviewId, accepting }` 无路径无秘密 |

4xx：`{ error: { code, message, details } }`。页面输入字段名与 spec §13.3 一致：`projectDir`, `requirementFile`, `sourceMode`, `checklist.enabled`, `checklist.path`, `checklist.includePaths`（逗号分隔转数组）。

- [ ] **Step 1: Write the failing test**

用 `http.request` 打到 `createWebAdapter` listen 在 `127.0.0.1:0`。注入 fake jobService：`enqueue` 返回固定 id。POST 非法 body → 400 `INVALID_REQUEST`。POST 合法（路径落在测试 allowedRoots）→ 202。GET health 不含 `allowedRoots` 或环境变量。

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/web-adapter.test.js`

Expected: FAIL module not found

- [ ] **Step 3: Write minimal implementation**

`create-app.js` 组装真实依赖；测试可传入 overrides。首页 HTML 用 templates，所有回显转义。

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/web-adapter.test.js`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/web src/create-app.js tests/web-adapter.test.js
git commit -m "feat: add native HTTP API and review pages"
```

---

### Task 18: 进程入口、优雅退出、E2E AC-01 至 AC-04

**Files:**
- Create: `src/main.js`
- Create: `tests/e2e/acceptance.test.js`
- Create: `tests/helpers/e2e-fixtures.js`
- Modify: `README.md`（本任务只写能跑测试的最小 README 段落也可，完整 README 放 Task 22）

**Interfaces:**
- Consumes: `createApp`
- Produces: 可运行服务；E2E 覆盖 AC-01…AC-04

- [ ] **Step 1: Write E2E failing tests**

`e2e-fixtures.js`：创建临时 Git 仓库（暂存/未暂存/未跟踪 cpp）、临时全量目录（cpp+java+md）、临时需求 md、在 allowedRoots 下。

`acceptance.test.js` 通过 `createApp({ config, provider: fake })` 启动，用 HTTP 跑完任务（轮询直到 SUCCEEDED/FAILED，超时 10s）。

**AC-01：** Git 仓库三类变更均在 `source.files`；rules 含 GLOBAL 与 CPP；存在 report.json 与 report.html；status SUCCEEDED。

**AC-02：** 全量混合；files 只有 cpp/java；rules 含 CPP 与 JAVA；prompt 不由本测试直接读，但可通过 FakeProvider 记录 `promptFile` 内容断言无 `note.md`。

**AC-03：** 自定义 checklist include `src` exclude `src/generated`；prompt 含 checklist 正文且只应对 `src/a.cpp`（RuleResolver matchedFiles）；`enabled: false` 的第二次任务 prompt 不含 checklist 正文。配置对象无 `global-review.md` 路径字段。

**AC-04：** POST 项目路径在 allowedRoots 外 → 400 `PATH_OUTSIDE_ALLOWED_ROOT`。若可建 symlink，越界 → 4xx `PATH_SYMLINK_ESCAPE` 或 `PATH_OUTSIDE_ALLOWED_ROOT`。

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/e2e/acceptance.test.js`

Expected: FAIL（app 入口或用例未通过）

- [ ] **Step 3: Write `src/main.js` and fix gaps**

```js
import { createApp } from './create-app.js';

const app = await createApp();
await app.start();

async function shutdown() {
  await app.stop({ waitMs: 30_000 });
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
```

`app.stop`：`accepting=false`，等待当前 job 最多 30s，超时则 abort signal 终止 provider。

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/e2e/acceptance.test.js`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main.js tests/e2e tests/helpers/e2e-fixtures.js
git commit -m "feat: add process entry and acceptance tests AC-01 to AC-04"
```

---

### Task 19: E2E AC-05 至 AC-08 与日志安全

**Files:**
- Modify: `tests/e2e/acceptance.test.js`
- Test: `tests/logger.test.js`（若尚未覆盖脱敏）

- [ ] **Step 1: Write the failing tests**

**AC-05：** Fake 返回非法 JSON → FAILED、错误码 `AI_OUTPUT_INVALID_JSON`、findings 空、失败报告含 `ai.rawOutput`。

**AC-06：** Fake JSON 含：有效 HIGH、仅「可能」无证据、越界文件、重复两项、错误风险 FOO。断言各 status/policyId；`overallRisk` 只由有效主 finding 计算。

**AC-07：** finding description 含 `<script>`；report.json 保留原文字；report.html 为转义；html 不含原始 `<script>`。

**AC-08：** save 报告后丢弃 jobService 内存（模拟重启：新建 `createReviewJobService` 只注入同一 reportsDir）→ `listSummaries` 仍有该报告；旧 reviewId 的 QUEUED 任务不出现。

Logger：`message` 含绝对路径时应被替换为 `projectName` 或 `***`。

- [ ] **Step 2: Run test to verify new AC fail or pass**

Run: `node --test tests/e2e/acceptance.test.js tests/logger.test.js`

Expected: 新用例先 FAIL，再进入实现修补

- [ ] **Step 3: Fix any JobService/renderer/logger gaps with TDD**

只补使测试失败的行为。

- [ ] **Step 4: Run full suite**

Run: `node --test tests`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/acceptance.test.js tests/logger.test.js src
git commit -m "test: cover AC-05 through AC-08 and log redaction"
```

---

### Task 20: RemoteLlmReviewProvider（§19）

**Files:**
- Create: `src/providers/remote-llm-review-provider.js`
- Create: `tests/helpers/fake-http-server.js`
- Test: `tests/remote-llm-review-provider.test.js`
- Modify: `src/shared/config.js`（provider=remote 时启动检查 env 存在）
- Modify: `src/create-app.js` 按 `config.ai.provider` 选择 Provider

**Interfaces:**
- Consumes: ReviewProvider 契约
- Produces: `createRemoteLlmReviewProvider({ baseUrl, model, apiKeyEnv, timeoutMs, fetchImpl })`

实现前打开所选供应商**当前**官方文档核对请求路径。默认实现 OpenAI 兼容：`POST {baseUrl}/v1/chat/completions`，header `Authorization: Bearer ${process.env[apiKeyEnv]}`，body `{ model, messages: [{ role: 'user', content: promptText }], temperature: 0 }`。从 `choices[0].message.content` 取 `rawOutput`。若官方文档不是该形状，只改本文件的请求/响应映射，不改 JobService。

- [ ] **Step 1: Write the failing test**

`fake-http-server.js`：`http.createServer` 记录 method、url、authorization 是否以 `Bearer ` 开头（不断言 Key 值进测试日志以外的期望——可用固定 `test-key`）。返回 chat completions JSON。

用例：

1. 合法响应 → provider.review 得到 content 字符串。
2. 401 → `REMOTE_LLM_AUTH_FAILED`。
3. 429 → `REMOTE_LLM_RATE_LIMITED`。
4. 500 → `REMOTE_LLM_UNAVAILABLE`。
5. 不响应直到超时 → `REMOTE_LLM_TIMEOUT`。
6. 200 但 body 非 JSON → `REMOTE_LLM_INVALID_RESPONSE`。
7. 同一 Fake 文本经 JobService 得到与 Cursor/Fake 路径相同的 policy 结果（用相同 findings JSON 字符串作为模型 content）。
8. logger/report 不含 `test-key` 与 `Authorization`。

`create-app`：`provider==='remote'` 且 env 缺失 → 启动 throw（不打印 env 值）。`provider==='cursor'` 忽略 remote。

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/remote-llm-review-provider.test.js`

Expected: FAIL module not found

- [ ] **Step 3: Write minimal implementation**

用可注入 `fetchImpl`（测试传入；生产用 global fetch）。超时 `AbortController`。

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/remote-llm-review-provider.test.js tests/e2e/acceptance.test.js`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/providers/remote-llm-review-provider.js src/create-app.js src/shared/config.js tests/remote-llm-review-provider.test.js tests/helpers/fake-http-server.js
git commit -m "feat: add RemoteLlmReviewProvider with mock-server tests"
```

---

### Task 21: ReviewScheduler（§20）

**Files:**
- Create: `src/review-scheduler.js`
- Create: `tests/helpers/fake-clock.js`
- Test: `tests/review-scheduler.test.js`

**Interfaces:**
- Consumes: `jobService.enqueue`、`jobService` 查询上次成功报告的 `inputHash`、`clock`
- Produces: `createReviewScheduler({ profiles, jobService, clock, stateFile, computeInputHash })`

Profile 字段：`profileId, name, enabled, projectDir, requirementFile, sourceMode, checklist, intervalMinutes`。`intervalMinutes < 5` 在加载时 throw。

行为：

- 每次 `clock` 推进后 `tick()`：对 enabled profile，若 `now >= lastRunAt + interval`（首次 lastRunAt 为 epoch 或 state 中的值）则尝试调度。
- 该 profile 已有 job 在队列或运行中 → 跳过（single-flight）。
- 计算将要审查的 inputHash（可调用与 JobService 相同的预采集，或先 enqueue 让 JobService 在 COLLECTING 后比较——**采用调度器预检**：调用与 JobService 相同的 collect+rules+requirement 纯数据哈希；为避免复制业务，导出 `jobService.computeInputHashFor(normalizedRequest)` 在 enqueue 前可调用）。若与 state 中该 profile 的 `lastSuccessInputHash` 相同 → 不 enqueue，写日志事件 `SKIPPED_UNCHANGED`，仍更新 `lastCheckedAt`。
- enqueue 时 `triggerType: 'SCHEDULED'`。
- state 原子写 `data/scheduler-state.json`（先写 tmp 再 rename）。
- 定时失败只记报告/日志，不 `process.exit`。
- 人工 enqueue 走 manual 队列，已在 Task 16。

- [ ] **Step 1: Write the failing test**

FakeClock：`{ nowMs, now() { return new Date(this.nowMs); }, advance(ms) { this.nowMs += ms; } }`。

1. interval 10 分钟，advance 9 分钟 → 不 enqueue。
2. advance 到 10 分钟 → enqueue 一次。
3. job 未完成再 tick → 不第二次 enqueue。
4. 完成后相同 hash → SKIPPED，provider 调用次数不增加（用计数 FakeProvider）。
5. 写 state 后新 Scheduler 读同一 stateFile，能算出下次时间（lastRunAt + interval）。
6. 生成报告 `request.triggerType === 'SCHEDULED'` 且 schemaVersion 为 1。

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/review-scheduler.test.js`

Expected: FAIL module not found

- [ ] **Step 3: Write minimal implementation**

在 `create-app` 启动时若 profiles 非空则 `setInterval` 每 30s 调 `tick()`（测试直接调 `tick`，不依赖真实 interval）。生产 interval 用 `clock` 的墙钟，不要用 FakeClock 的 setInterval。

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/review-scheduler.test.js`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/review-scheduler.js src/review-job-service.js src/create-app.js tests/review-scheduler.test.js tests/helpers/fake-clock.js
git commit -m "feat: schedule reviews with FakeClock and inputHash skip"
```

---

### Task 22: README、示例工程与全量验收

**Files:**
- Create: `README.md`
- Create: `examples/sample-project/src/demo.cpp`
- Create: `examples/sample-project/src/Demo.java`
- Create: `examples/sample-project/docs/requirement.md`
- Modify: `app.config.example.json`（如有遗漏字段）

**Interfaces:**
- Consumes: 全部已实现行为
- Produces: 可交付仓库说明；AC-09 人工步骤（不自动化）

- [ ] **Step 1: Write README with exact run commands**

README 必须包含：Node 22 要求；复制 `app.config.example.json` 为 `app.config.json`；设置 `allowedRoots`；`npm test`；`npm start`；Cursor 命令需先在本机跑 help 再改 `cursor.command/args`；远程模式设置 `ai.provider=remote` 与 `REMOTE_LLM_API_KEY`；**不要**把真实 Key 写入仓库；AC-09 人工清单（启动 Cursor、跑 examples、确认源码未被修改、对比 raw vs final risk）。

示例 `demo.cpp` 含一处明显空指针解引用供人工审查；`requirement.md` 写明输入输出约定。

- [ ] **Step 2: Run the full automated suite**

Run: `node --test tests`

Expected: PASS，0 failures

- [ ] **Step 3: Grep the tree for secrets and out-of-scope**

确认无真实 API Key；无 SQLite；无对 kdop-green 的 import；`data/` 被 gitignore。

- [ ] **Step 4: Commit**

```bash
git add README.md examples app.config.example.json
git commit -m "docs: add README and sample project for manual Cursor acceptance"
```

---

## Self-review (author)

1. **Spec coverage:** §3–§8 采集/限制 → Tasks 3–6, 16；§9 规则 → Task 7；§10 协议 → Tasks 8–9；§11 政策 → Tasks 10–11；§12–13 报告与 Web → Tasks 12–13, 17；§14–16 配置/错误/安全/日志/退出 → Tasks 2, 14, 16, 18–19；§17 TDD → 各任务 Red-Green；§18 AC-01…08 → Tasks 18–19；AC-09 → Task 22 人工；§19 → Task 20；§20 → Task 21；§21 交付物 → 各 Create 路径。
2. **Placeholders:** 无 TBD；政策启发式（关键词）已写明；Remote 默认 OpenAI 兼容并要求对照官方文档。
3. **Types:** `CollectedFile` / `ReviewProvider` / `NormalizedRequest` / `applyPostReviewPolicy` 名称贯穿前后任务。
