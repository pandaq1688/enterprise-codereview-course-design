# 代码审查系统扩展（§21/§22/§23）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在已交付的核心审查闭环（§1–§20）之上，实现三个必做扩展点：Git 远程仓库拉取（§21）、外部静态分析器 clang-tidy 组合（§22）、大项目分片与并行 Agent（§23），三者均复用现有 ReviewJobService、PostReviewPolicy 与报告组件。

**Architecture:** 三个扩展点以可插拔模块接入既有编排。`RemoteGitFetcher` 在 `collectInputs` 前置拉取远程仓库到 `allowedRoots` 内的本地目录，再走现有 collector。`ClangTidyAnalyzer` 在 AI 解析后对同一批文件运行 clang-tidy，产出带 `source:'analyzer'` 的 RawFinding，与 AI RawFinding 合并后统一走一次 PostReviewPolicy。`ShardPlanner` 按文件+字符预算分片，`ReviewJobService` 多轮调用 provider 后聚合所有 RawFinding 再统一过滤；任一片失败即整任务 FAILED。并发由轻量 promise 信号量约束。

**Tech Stack:** Node.js 22、ESM JavaScript、node:test + node:assert/strict、Node 原生 `child_process.spawn/execFile`、`fs/promises`、`crypto`。无新依赖。测试运行：`node --test tests`。

**Spec:** `spec/spec.md` §21、§22、§23（唯一基线）。本计划实现这三节及验收 AC-10、AC-11、AC-12。

## Global Constraints

- 技术栈：Node.js 22、ESM JavaScript、node:test
- Domain 不读取文件、不启动进程、不访问 HTTP；Application 负责编排
- 组件通过普通 JavaScript 对象契约和构造函数注入协作，不创建无行为价值的抽象基类
- spawn/execFile 的 shell 为 false；command 与 args 分开配置；占位符只能替换完整参数值 `{promptFile}`、`{projectDir}`、`{outputFile}`、`{file}`
- 自动化测试不得依赖真实 Cursor、真实远程 API、真实 clang-tidy；Git 远程拉取使用本地 bare 仓库；clang-tidy 缺失时验证跳过路径，可用 fake 脚本模拟输出
- 真实凭据（API Key、Git token、用户名）只能来自环境变量；配置只保存环境变量名；日志不得输出其值
- 全局 Cursor 并发默认 1；分片模式下并发上限由 `sharding.maxConcurrency` 配置，默认仍为 1
- 合法风险：LOW < MEDIUM < HIGH < CRITICAL；合法类别同 §11
- 除代码、符号和路径外，报告文本使用简体中文
- 未完成 §21、§22、§23 的系统不得视为交付完成

## Scope note

§21/§22/§23 共享同一套 Job/报告/过滤契约，且 §22 与 §23 都修改 `ReviewJobService.processJob` 与 `PostReviewPolicy`。为避免接口漂移，写成一份计划，按依赖顺序推进：先 §21（独立前置步骤），再 §22（改 Finding 形状与 policy），再 §23（改 REVIEWING 编排）。

## File Structure

| Path | Responsibility |
|------|----------------|
| `src/shared/error-codes.js` | 新增 6 个错误码（修改） |
| `src/shared/config.js` | DEFAULTS 新增 `remoteGit`/`analyzer`/`sharding` 段与校验（修改） |
| `app.config.example.json`、`app.config.json` | 新增三段（修改） |
| `src/shared/git-env.js` | 构造 git 子进程 env（HTTPS token 注入） |
| `src/remote-git-fetcher.js` | clone/fetch/pull、ref checkout、重试、错误码映射、ephemeral 清理 |
| `src/analyzers/clang-tidy-analyzer.js` | 命令构造、按文件运行、解析结果为 RawFinding、失败处理 |
| `src/shard-planner.js` | 按文件+字符预算分片、maxShards 上限 |
| `src/shared/semaphore.js` | 轻量 promise 信号量 |
| `src/request-validator.js` | 支持 REMOTE_GIT（修改） |
| `src/review-job-service.js` | 接入 fetcher/analyzer/sharding（修改） |
| `src/post-review-policy.js` | Finding 增加 source/analyzerId/ruleId（修改） |
| `src/html-report-renderer.js` | 渲染 source 与分片审计（修改） |
| `src/create-app.js` | 装配新组件（修改） |
| `tests/helpers/temp-bare-repo.js` | 本地 bare 仓库夹具 |
| `tests/helpers/fake-clang-tidy.js` | 模拟 clang-tidy 脚本 |
| `tests/*.test.js` | 与生产文件一一对应 |

---

## Task 1: 错误码与配置扩展

**Files:** Modify `src/shared/error-codes.js`、`src/shared/config.js`、`app.config.example.json`、`app.config.json`；Test `tests/config.test.js`

**Interfaces:** Produces `ErrorCodes` 新增 6 项；`Config` 新增 `remoteGit`/`analyzer`/`sharding` 段

- [ ] **Step 1: Write failing tests**

在 `tests/config.test.js` 追加：默认值断言（`remoteGit.workspaceDir==='./data/remotes'`、`ephemeral===false`、`fetchRetries===3`；`analyzer.enabled===false`、`tool==='clang-tidy'`、`onAnalyzerError==='skip'`；`sharding.enabled===false`、`shardChars===120000`、`maxShards===20`、`maxConcurrency===1`）；`onAnalyzerError` 非 skip/fail 时 reject；`shardChars/maxShards/maxConcurrency` 非 >=1 整数时 reject；`ErrorCodes` 含 `REMOTE_FETCH_FAILED`/`REMOTE_AUTH_FAILED`/`REMOTE_REF_NOT_FOUND`/`ANALYZER_SKIPPED`/`ANALYZER_FAILED`/`SHARD_LIMIT_EXCEEDED`。

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/config.test.js` — Expected: FAIL

- [ ] **Step 3: Write minimal implementation**

`error-codes.js` 在 `REPORT_WRITE_FAILED` 后追加 6 项常量。`config.js` `DEFAULTS` 追加：

```js
remoteGit: { workspaceDir: './data/remotes', ephemeral: false, fetchRetries: 3, credentials: { type: 'https', tokenEnv: '', usernameEnv: '' } },
analyzer: { enabled: false, tool: 'clang-tidy', command: 'clang-tidy', args: ['--export-fixes={outputFile}', '{file}'], timeoutMs: 300000, onAnalyzerError: 'skip' },
sharding: { enabled: false, shardChars: 120000, maxShards: 20, maxConcurrency: 1 }
```

`loadConfig` return 前追加校验：`onAnalyzerError ∈ {skip,fail}`；`shardChars/maxShards/maxConcurrency` 为 >=1 整数；`fetchRetries >= 0`。`app.config.example.json` 与 `app.config.json` 追加同名段（example 用占位环境变量名 `REMOTE_GIT_TOKEN`）。

- [ ] **Step 4: Run tests to verify they pass** — Run: `node --test tests/config.test.js` — Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/shared/error-codes.js src/shared/config.js app.config.example.json app.config.json tests/config.test.js
git commit -m "feat: add remoteGit/analyzer/sharding config and error codes"
```

---

## Task 2: RemoteGitFetcher

**Files:** Create `src/shared/git-env.js`、`src/remote-git-fetcher.js`、`tests/helpers/temp-bare-repo.js`；Test `tests/remote-git-fetcher.test.js`

**Interfaces:** Produces `createRemoteGitFetcher({ workspaceDir, ephemeral, fetchRetries, credentials, allowedRoots, logger })` → `{ fetch({ remoteUrl, ref }) → { localDir, cleanup? } }`

行为：clone 落盘到 `workspaceDir/<repoName>`（已存在则 fetch+checkout）；ref checkout 失败 → `REMOTE_REF_NOT_FOUND`（不重试）；鉴权失败 → `REMOTE_AUTH_FAILED`（不重试）；其他非零 exit 重试 `fetchRetries` 次后 `REMOTE_FETCH_FAILED`；HTTPS token 经 `http.extraHeader=Authorization: Basic <base64(user:token)>` 注入；`workspaceDir` realpath 不在 `allowedRoots` 内 → `PATH_OUTSIDE_ALLOWED_ROOT`；ephemeral=true 用 `os.tmpdir()`，返回 `cleanup()`。

- [ ] **Step 1: Write failing tests**

`tests/helpers/temp-bare-repo.js`：用 `git init --bare` 建裸仓，再建工作仓提交一个 `a.c` 并 `push origin master`，导出 `{ bare, headRef:'master' }`。

`tests/remote-git-fetcher.test.js` 用例：① clone 后 `localDir/a.c` 存在；② 同 fetcher 二次 fetch 仍可读 `a.c`；③ ref 不存在 → `REMOTE_REF_NOT_FOUND`；④ `workspaceDir` 不在 allowedRoots → `PATH_OUTSIDE_ALLOWED_ROOT`；⑤ ephemeral 模式 `cleanup()` 后 localDir 不存在。

- [ ] **Step 2: Run tests to verify they fail** — Run: `node --test tests/remote-git-fetcher.test.js` — Expected: FAIL

- [ ] **Step 3: Write minimal implementation**

`git-env.js`：导出 `buildGitEnv(credentials)`，从 `process.env[tokenEnv]`/`[usernameEnv]` 读 token/用户名，返回 `{ env, extraArgs }`，其中 `extraArgs = ['-c', 'http.extraHeader=Authorization: Basic ' + Buffer.from(user+':'+token).toString('base64')]`（无凭据则空）。**不得把 token 写入 env 对象的可见字段，也不得日志输出。**

`remote-git-fetcher.js`：

```js
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile as cb } from 'node:child_process';
import { promisify } from 'node:util';
import { AppError } from './shared/app-error.js';
import { ErrorCodes } from './shared/error-codes.js';
import { resolveRealPath, assertInsideAllowedRoots } from './shared/path-security.js';
import { buildGitEnv } from './shared/git-env.js';
const execFile = promisify(cb);

function repoNameFromUrl(url) {
  return String(url).replace(/\\/g,'/').replace(/\.git$/i,'').split('/').filter(Boolean).pop() || 'remote';
}
function classifyGitError(stderr) {
  const s = String(stderr ?? '');
  if (/Authentication failed|Invalid username|403|401|not authorized/i.test(s)) return ErrorCodes.REMOTE_AUTH_FAILED;
  if (/pathspec|did not match|ref .* does not exist|unknown revision/i.test(s)) return ErrorCodes.REMOTE_REF_NOT_FOUND;
  return ErrorCodes.REMOTE_FETCH_FAILED;
}
export function createRemoteGitFetcher({ workspaceDir, ephemeral, fetchRetries, credentials, allowedRoots, logger }) {
  async function runGit(args, { cwd, env, retries }) {
    let last;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try { return (await execFile('git', args, { cwd, env, windowsHide: true })).stdout; }
      catch (err) {
        last = err;
        const code = classifyGitError(err.stderr || err.message);
        if (code === ErrorCodes.REMOTE_AUTH_FAILED || code === ErrorCodes.REMOTE_REF_NOT_FOUND) break;
        if (attempt === retries) break;
      }
    }
    throw new AppError(classifyGitError(last?.stderr || last?.message), 'Git 远程拉取失败', []);
  }
  async function fetch({ remoteUrl, ref }) {
    const { env, extraArgs } = buildGitEnv(credentials);
    let localDir, cleanup;
    if (ephemeral) {
      localDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crs-remote-'));
      cleanup = async () => { await fs.rm(localDir, { recursive: true, force: true }); };
    } else {
      const wsReal = await resolveRealPath(workspaceDir);
      if (allowedRoots) assertInsideAllowedRoots(wsReal, allowedRoots, workspaceDir);
      localDir = path.join(wsReal, repoNameFromUrl(remoteUrl));
      await fs.mkdir(localDir, { recursive: true });
    }
    const exists = await fs.stat(path.join(localDir, '.git')).then(()=>true).catch(()=>false);
    if (exists) {
      await runGit([...extraArgs, 'fetch', remoteUrl, ref], { cwd: localDir, env, retries: 0 });
      await runGit(['checkout', ref], { cwd: localDir, env, retries: 0 });
    } else {
      await runGit([...extraArgs, 'clone', remoteUrl, localDir], { cwd: process.cwd(), env, retries: fetchRetries });
      await runGit(['checkout', ref], { cwd: localDir, env, retries: 0 });
    }
    const real = await resolveRealPath(localDir);
    if (allowedRoots) assertInsideAllowedRoots(real, allowedRoots, localDir);
    return { localDir: real, cleanup };
  }
  return { fetch };
}
```

- [ ] **Step 4: Run tests to verify they pass** — Run: `node --test tests/remote-git-fetcher.test.js` — Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/shared/git-env.js src/remote-git-fetcher.js tests/helpers/temp-bare-repo.js tests/remote-git-fetcher.test.js
git commit -m "feat: fetch remote git repos with retry and error mapping"
```

---

## Task 3: RequestValidator 支持 REMOTE_GIT

**Files:** Modify `src/request-validator.js`；Test `tests/request-validator.test.js`

**Interfaces:** `SOURCE_MODES` 增加 `REMOTE_GIT`；`NormalizedRequest` 增加 `remoteUrl`、`ref`、`reviewMode`（仅 REMOTE_GIT）；REMOTE_GIT 时 `projectDir` 为 null（fetch 后由 JobService 填充）

- [ ] **Step 1: Write failing tests**

追加：REMOTE_GIT 缺 `remoteUrl` → `INVALID_REQUEST`；缺 `ref` → `INVALID_REQUEST`；`reviewMode` 非 GIT_CHANGES/FULL_DIRECTORY → `INVALID_REQUEST`；合法 REMOTE_GIT 返回 `{ sourceMode:'REMOTE_GIT', remoteUrl, ref, reviewMode:'GIT_CHANGES', projectDir:null }`；REMOTE_GIT 不调用 `assertGitWorkTree`（用一个非 git 目录的 requirementFile 即可，不应报 GIT_REPOSITORY_REQUIRED）。

- [ ] **Step 2: Run tests to verify they fail** — Run: `node --test tests/request-validator.test.js` — Expected: FAIL

- [ ] **Step 3: Write minimal implementation**

`SOURCE_MODES` 改为 `new Set(['GIT_CHANGES','FULL_DIRECTORY','REMOTE_GIT'])`。在 sourceMode 合法后：

```js
let remoteUrl = null, ref = null, reviewMode = null;
let projectDir = null;
if (body.sourceMode === 'REMOTE_GIT') {
  if (!body.remoteUrl || typeof body.remoteUrl !== 'string') throw new AppError(ErrorCodes.INVALID_REQUEST, '缺少必填字段 remoteUrl', []);
  if (!body.ref || typeof body.ref !== 'string') throw new AppError(ErrorCodes.INVALID_REQUEST, '缺少必填字段 ref', []);
  reviewMode = body.reviewMode ?? 'GIT_CHANGES';
  if (reviewMode !== 'GIT_CHANGES' && reviewMode !== 'FULL_DIRECTORY') throw new AppError(ErrorCodes.INVALID_REQUEST, 'reviewMode 非法', []);
  remoteUrl = body.remoteUrl; ref = body.ref;
} else {
  if (!body.projectDir || typeof body.projectDir !== 'string') throw new AppError(ErrorCodes.INVALID_REQUEST, '缺少必填字段 projectDir', []);
  projectDir = await resolveAndAssert(body.projectDir, allowedRoots);
  if (body.sourceMode === 'GIT_CHANGES') await assertGitWorkTree(projectDir);
}
const requirementFile = await resolveAndAssert(body.requirementFile, allowedRoots);
```

返回对象追加 `remoteUrl, ref, reviewMode`，`projectName` 在 REMOTE_GIT 时取 `repoNameFromUrl(remoteUrl)`（导出该 helper 或内联同逻辑），`projectDirDisplay` 为 null。

- [ ] **Step 4: Run tests to verify they pass** — Run: `node --test tests/request-validator.test.js` — Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/request-validator.js tests/request-validator.test.js
git commit -m "feat: validate REMOTE_GIT review requests"
```

---

## Task 4: ReviewJobService 接入 REMOTE_GIT

**Files:** Modify `src/review-job-service.js`、`src/create-app.js`；Test `tests/review-job-service.test.js`

**Interfaces:** `createReviewJobService` deps 新增可选 `remoteGitFetcher`；`collectInputs` 在 REMOTE_GIT 时先 `fetch` 得到 `localDir`，断言在 allowedRoots，以 `localDir` 为 projectDir、`reviewMode` 为内部 sourceMode 继续采集

- [ ] **Step 1: Write failing tests**

用 FakeFetcher（返回临时目录含 `a.c`）+ FakeReviewProvider：REMOTE_GIT 任务最终 SUCCEEDED，`request.sourceMode==='REMOTE_GIT'`，`source.files` 含 `a.c`，报告 `request.projectDir` 指向 fetch 的 localDir（仅 includeAbsolutePaths=true 时）。第二个测试：FakeFetcher 抛 `REMOTE_REF_NOT_FOUND` → 任务 FAILED，`errors[0].code==='REMOTE_REF_NOT_FOUND'`。第三个测试：ephemeral 模式完成后 cleanup 被调用（用 spy）。

- [ ] **Step 2: Run tests to verify they fail** — Run: `node --test tests/review-job-service.test.js` — Expected: FAIL

- [ ] **Step 3: Write minimal implementation**

`collectInputs` 开头：

```js
let projectDir = normalizedRequest.projectDir;
let innerSourceMode = normalizedRequest.sourceMode;
let fetchedCleanup = null;
if (normalizedRequest.sourceMode === 'REMOTE_GIT') {
  const fetched = await remoteGitFetcher.fetch({ remoteUrl: normalizedRequest.remoteUrl, ref: normalizedRequest.ref });
  projectDir = fetched.localDir;
  fetchedCleanup = fetched.cleanup;
  innerSourceMode = normalizedRequest.reviewMode;
  job._fetchedCleanup = fetchedCleanup; // 供 finally 清理
}
```

后续 collector 选择用 `innerSourceMode`、`projectDir`。`buildReport` 的 `request.sourceMode` 保留原始 `REMOTE_GING`，新增 `request.reviewMode` 与 `request.remoteUrl`（remoteUrl 不写完整凭据，仅 URL）。在 `processJob` 的 finally 中若 `job._fetchedCleanup` 存在则调用。`create-app.js` 在 `config.remoteGit` 存在时构造 `createRemoteGitFetcher({ ...config.remoteGit, allowedRoots: config.security.allowedRoots, logger })` 并注入。

- [ ] **Step 4: Run tests to verify they pass** — Run: `node --test tests/review-job-service.test.js` — Expected: PASS（含原有用例不回归）

- [ ] **Step 5: Commit**

```bash
git add src/review-job-service.js src/create-app.js tests/review-job-service.test.js
git commit -m "feat: route REMOTE_GIT through fetcher into existing collectors"
```

---

## Task 5: ClangTidyAnalyzer

**Files:** Create `src/analyzers/clang-tidy-analyzer.js`、`tests/helpers/fake-clang-tidy.js`；Test `tests/clang-tidy-analyzer.test.js`

**Interfaces:** Produces `createClangTidyAnalyzer({ command, args, timeoutMs, onAnalyzerError, logger })` → `{ analyze({ projectDir, files, signal }) → { findings: RawFinding[], skipped: boolean, error: AppError|null } }`

RawFinding 形状（与 parser 产出兼容，额外带来源标记）：

```js
{ category, risk_level, title, description, file_path, line_start, line_end, evidence, requirement_reference:'', fix_suggestion:'', fix_code:'',
  source: 'analyzer', analyzerId: 'clang-tidy', ruleId: '<check-name>' }
```

行为：对每个受支持 C/C++ 文件（`.c/.cc/.cpp/.cxx/.h/.hpp/.hxx`）运行 clang-tidy，Java 跳过；解析 `--export-fixes` 的 YAML（或 stderr warning 行）为 RawFinding；命令未找到（ENOENT）→ `skipped:true`、`error:AppError(ANALYZER_SKIPPED)`；超时/非零 exit → 按 `onAnalyzerError`：`skip` 则 `ANALYZER_SKIPPED`，`fail` 则抛 `ANALYZER_FAILED`；不修改源码（只用 `--export-fixes` 写临时文件）。

- [ ] **Step 1: Write failing tests**

`tests/helpers/fake-clang-tidy.js`：导出一个 node 脚本路径，脚本读 argv 中的 `{file}` 与 `{outputFile}`，向 outputFile 写 YAML：

```yaml
---
MainSourceFile: <file>
Diagnostics:
  - DiagnosticName: bugprone-use-after-move
    Message: 'use after move'
    FileOffset: 10
    Replacements: []
    FilePath: <file>
```

用例：① fake 脚本作为 command，analyze 一个 `.cpp` 文件 → 返回 1 条 finding，`source==='analyzer'`、`analyzerId==='clang-tidy'`、`ruleId==='bugprone-use-after-move'`、`file_path` 为相对路径；② `.java` 文件跳过（findings 空）；③ command 指向不存在的可执行 → `skipped:true`、`error.code==='ANALYZER_SKIPPED'`；④ `onAnalyzerError:'fail'` 且命令存在但 exit 非 0 → 抛 `ANALYZER_FAILED`。

- [ ] **Step 2: Run tests to verify they fail** — Run: `node --test tests/clang-tidy-analyzer.test.js` — Expected: FAIL

- [ ] **Step 3: Write minimal implementation**

```js
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { AppError } from '../shared/app-error.js';
import { ErrorCodes } from '../shared/error-codes.js';
import { languageFromFileName } from '../shared/source-extensions.js';

const CPP_EXT = new Set(['.c','.cc','.cpp','.cxx','.h','.hpp','.hxx']);

function parseFixesYaml(text, projectDir) {
  // 极简 YAML 解析：只取 Diagnostics 列表，按 DiagnosticName/Message/FilePath/FileOffset 提取
  const findings = [];
  const lines = String(text).split(/\r?\n/);
  let cur = null;
  for (const line of lines) {
    if (/^\s*-\s+DiagnosticName:/.test(line)) {
      if (cur) findings.push(cur);
      cur = { ruleId: line.split('DiagnosticName:')[1].trim(), message:'', filePath:'', fileOffset:0 };
    } else if (cur && /Message:/.test(line)) cur.message = line.split('Message:')[1].trim().replace(/^['"]|['"]$/g,'');
    else if (cur && /FilePath:/.test(line)) cur.filePath = line.split('FilePath:')[1].trim().replace(/^['"]|['"]$/g,'');
    else if (cur && /FileOffset:/.test(line)) cur.fileOffset = Number(line.split('FileOffset:')[1].trim()) || 0;
  }
  if (cur) findings.push(cur);
  return findings.map(f => ({
    category: 'CORRECTNESS', risk_level: 'MEDIUM',
    title: f.ruleId, description: f.message,
    file_path: path.relative(projectDir, f.filePath).replace(/\\/g,'/'),
    line_start: 1, line_end: 1, evidence: f.message,
    requirement_reference: '', fix_suggestion: '', fix_code: '',
    source: 'analyzer', analyzerId: 'clang-tidy', ruleId: f.ruleId
  }));
}

export function createClangTidyAnalyzer({ command, args, timeoutMs, onAnalyzerError, logger }) {
  async function analyzeOne(file, projectDir, signal) {
    const outFile = path.join(os.tmpdir(), `crs-clang-${Date.now()}-${Math.random().toString(36).slice(2)}.yaml`);
    const rendered = (args ?? []).map(a => a.replace('{file}', path.join(projectDir, file)).replace('{outputFile}', outFile));
    return await new Promise((resolve, reject) => {
      const p = spawn(command, rendered, { cwd: projectDir, windowsHide: true, signal, shell: false });
      let stderr = '';
      p.stderr.on('data', d => stderr += d);
      p.on('error', (err) => err.code === 'ENOENT' ? resolve({ skipped: true, error: new AppError(ErrorCodes.ANALYZER_SKIPPED, 'clang-tidy 未安装', []) }) : reject(err));
      p.on('close', async (code) => {
        try {
          if (code !== 0) {
            if (onAnalyzerError === 'fail') return reject(new AppError(ErrorCodes.ANALYZER_FAILED, 'clang-tidy 非零退出', [code]));
            return resolve({ skipped: true, error: new AppError(ErrorCodes.ANALYZER_SKIPPED, 'clang-tidy 非零退出', [code]) });
          }
          const text = await fs.readFile(outFile, 'utf8').catch(() => '');
          resolve({ findings: parseFixesYaml(text, projectDir), skipped: false, error: null });
        } finally { await fs.unlink(outFile).catch(()=>{}); }
      });
    });
  }
  async function analyze({ projectDir, files, signal }) {
    const out = [];
    for (const f of files ?? []) {
      if (!CPP_EXT.has(path.extname(f.path).toLowerCase())) continue;
      const r = await analyzeOne(f.path, projectDir, signal);
      if (r.skipped) return { findings: [], skipped: true, error: r.error };
      out.push(...(r.findings ?? []));
    }
    return { findings: out, skipped: false, error: null };
  }
  return { analyze };
}
```

- [ ] **Step 4: Run tests to verify they pass** — Run: `node --test tests/clang-tidy-analyzer.test.js` — Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/analyzers/clang-tidy-analyzer.js tests/helpers/fake-clang-tidy.js tests/clang-tidy-analyzer.test.js
git commit -m "feat: run clang-tidy and parse results into analyzer findings"
```

---

## Task 6: PostReviewPolicy 增加 source 字段

**Files:** Modify `src/post-review-policy.js`、`tests/helpers/policy-fixtures.js`；Test `tests/post-review-policy.test.js`

**Interfaces:** Finding 对象新增 `source`（默认 `'ai'`）、`analyzerId`（默认 `null`）、`ruleId`（默认 `null`）；PF-009 去重跨 source 生效；PF-010 计数不变

- [ ] **Step 1: Write failing tests**

`policy-fixtures.js` 新增 `analyzerRawFinding(overrides)`：与 `rawFinding` 同形但带 `source:'analyzer', analyzerId:'clang-tidy', ruleId:'bugprone-x'`。

测试：① AI finding 与 analyzer finding 同 `file_path`+`title`（归一化指纹）→ PF-009 合并，保留一条，`status==='MERGED'` 的那条 `source` 保留被合并者的来源；② AI finding 默认 `source==='ai'`、`analyzerId===null`；③ analyzer finding `source==='analyzer'`、`analyzerId==='clang-tidy'`、`ruleId==='bugprone-x'`；④ PF-010 `overallRisk` 仍由有效主 finding 计算（不受 source 影响）。

- [ ] **Step 2: Run tests to verify they fail** — Run: `node --test tests/post-review-policy.test.js` — Expected: FAIL

- [ ] **Step 3: Write minimal implementation**

在 `findings` map 的 finding 对象初始化追加：

```js
source: raw.source ?? 'ai',
analyzerId: raw.analyzerId ?? null,
ruleId: raw.ruleId ?? null,
```

PF-009 去重指纹函数（`normalizeTitleFingerprint`）已按 title 归一，确保跨 source 比较时也用同一指纹；合并时保留先出现者，被合并者 `status='MERGED'`，决策 `reason` 注明「与已有问题重复（跨来源）」。其余政策不变。

- [ ] **Step 4: Run tests to verify they pass** — Run: `node --test tests/post-review-policy.test.js` — Expected: PASS（含原有 PF-001…PF-010 不回归）

- [ ] **Step 5: Commit**

```bash
git add src/post-review-policy.js tests/helpers/policy-fixtures.js tests/post-review-policy.test.js
git commit -m "feat: tag findings with source/analyzerId and dedup across sources"
```

---

## Task 7: ReviewJobService 接入 Analyzer

**Files:** Modify `src/review-job-service.js`、`src/create-app.js`；Test `tests/review-job-service.test.js`

**Interfaces:** deps 新增可选 `analyzer`（null 表示禁用）；AI 解析后调用 `analyzer.analyze({ projectDir, files, signal })`，将其 RawFinding 与 AI `parsed.findings` 合并后统一 `policy(...)`

- [ ] **Step 1: Write failing tests**

用 FakeReviewProvider（返回 1 条 AI finding）+ FakeAnalyzer（返回 1 条 analyzer finding，同文件同标题）：① `analyzer.enabled=true` → 报告 `result.findings` 经 PF-009 合并为 1 条，`source` 字段存在；② FakeAnalyzer 返回 `skipped:true` → 报告仍含 AI finding，日志含 `ANALYZER_SKIPPED`，任务 SUCCEEDED；③ `onAnalyzerError:'fail'` 且 FakeAnalyzer 抛 `ANALYZER_FAILED` → 任务 FAILED，`errors[0].code==='ANALYZER_FAILED'`；④ `analyzer=null` → 行为与原单 AI 完全一致（回归）。

- [ ] **Step 2: Run tests to verify they fail** — Run: `node --test tests/review-job-service.test.js` — Expected: FAIL

- [ ] **Step 3: Write minimal implementation**

在 `processJob` 解析 `parsed` 之后、`policy(...)` 之前：

```js
let mergedRaw = [...(parsed.findings ?? [])];
if (analyzer) {
  const aResult = await analyzer.analyze({ projectDir: job.request.projectDir, files: collected.source.files, signal: currentAbort.signal });
  if (aResult.skipped) {
    logger.log({ level: 'warn', event: 'ANALYZER_SKIPPED', reviewId: job.reviewId, stage: 'REVIEWING', errorCode: ErrorCodes.ANALYZER_SKIPPED, message: aResult.error?.message ?? '' });
    if (aResult.error && config.analyzer?.onAnalyzerError === 'fail') {
      throw aResult.error;
    }
  } else {
    mergedRaw = mergedRaw.concat(aResult.findings ?? []);
  }
}
const policyResult = policy({ rawFindings: mergedRaw, selectedFiles: collected.source.files, sourceMode: job.request.sourceMode });
```

`create-app.js`：当 `config.analyzer?.enabled` 时构造 `createClangTidyAnalyzer({ ...config.analyzer, logger })` 注入，否则传 `null`。

- [ ] **Step 4: Run tests to verify they pass** — Run: `node --test tests/review-job-service.test.js` — Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/review-job-service.js src/create-app.js tests/review-job-service.test.js
git commit -m "feat: merge clang-tidy findings with AI findings before policy"
```

---

## Task 8: ShardPlanner

**Files:** Create `src/shard-planner.js`；Test `tests/shard-planner.test.js`

**Interfaces:** Produces `planShards({ files, contents, shardChars, maxShards }) → { shards: [{ files: string[], charCount: number }], warnings: string[] }`

行为：按文件顺序贪心装箱，每片不超过 `shardChars`；单文件内容超 `shardChars` 时单独成片并 push warning；片数 > `maxShards` 抛 `AppError(SHARD_LIMIT_EXCEEDED)`；`files` 为 `[{ path }]`，`contents` 为 `Record<path,string>`。

- [ ] **Step 1: Write failing tests**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planShards } from '../src/shard-planner.js';
import { ErrorCodes } from '../src/shared/error-codes.js';
import { AppError } from '../src/shared/app-error.js';

test('packs files by char budget', () => {
  const files = [{ path:'a.c' }, { path:'b.c' }, { path:'c.c' }];
  const contents = { 'a.c':'x'.repeat(60), 'b.c':'y'.repeat(60), 'c.c':'z'.repeat(60) };
  const { shards, warnings } = planShards({ files, contents, shardChars: 100, maxShards: 20 });
  assert.equal(shards.length, 2);
  assert.equal(warnings.length, 0);
});

test('single file over budget becomes its own shard with warning', () => {
  const files = [{ path:'big.c' }];
  const contents = { 'big.c':'x'.repeat(200) };
  const { shards, warnings } = planShards({ files, contents, shardChars: 100, maxShards: 20 });
  assert.equal(shards.length, 1);
  assert.equal(shards[0].files[0], 'big.c');
  assert.ok(warnings.length >= 1);
});

test('exceeding maxShards throws SHARD_LIMIT_EXCEEDED', () => {
  const files = Array.from({ length: 5 }, (_, i) => ({ path: `f${i}.c` }));
  const contents = Object.fromEntries(files.map(f => [f.path, 'x'.repeat(60)]));
  assert.throws(
    () => planShards({ files, contents, shardChars: 50, maxShards: 2 }),
    (err) => err instanceof AppError && err.code === ErrorCodes.SHARD_LIMIT_EXCEEDED
  );
});
```

- [ ] **Step 2: Run tests to verify they fail** — Run: `node --test tests/shard-planner.test.js` — Expected: FAIL

- [ ] **Step 3: Write minimal implementation**

```js
import { AppError } from './shared/app-error.js';
import { ErrorCodes } from './shared/error-codes.js';

export function planShards({ files, contents, shardChars, maxShards }) {
  const shards = [];
  const warnings = [];
  let cur = { files: [], charCount: 0 };
  for (const f of files ?? []) {
    const size = (contents?.[f.path] ?? '').length;
    if (size > shardChars) {
      if (cur.files.length > 0) { shards.push(cur); cur = { files: [], charCount: 0 }; }
      shards.push({ files: [f.path], charCount: size });
      warnings.push(`文件 ${f.path} 超过单片字符预算，单独成片`);
      continue;
    }
    if (cur.charCount + size > shardChars && cur.files.length > 0) {
      shards.push(cur); cur = { files: [], charCount: 0 };
    }
    cur.files.push(f.path); cur.charCount += size;
  }
  if (cur.files.length > 0) shards.push(cur);
  if (shards.length > maxShards) {
    throw new AppError(ErrorCodes.SHARD_LIMIT_EXCEEDED, `分片数 ${shards.length} 超过上限 ${maxShards}`, [shards.length, maxShards]);
  }
  return { shards, warnings };
}
```

- [ ] **Step 4: Run tests to verify they pass** — Run: `node --test tests/shard-planner.test.js` — Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/shard-planner.js tests/shard-planner.test.js
git commit -m "feat: plan shards by file and char budget"
```

---

## Task 9: 信号量与分片编排

**Files:** Create `src/shared/semaphore.js`；Modify `src/review-job-service.js`；Test `tests/shard-planner.test.js`（信号量单测）、`tests/review-job-service.test.js`

**Interfaces:** `createSemaphore(max)` → `{ run(fn) }`；JobService 在 REVIEWING 决定是否分片，分片时多轮 provider+parser 聚合后单次 policy

分片决策：`exceeds = totalChars > maxInputChars || fileCount > maxFiles`。若 `exceeds` → 必须分片；否则若 `sharding.enabled` → 分片（并行）；否则单次调用（原行为）。任一片 provider/parse 失败 → 整任务 FAILED（沿用既有错误码，不静默丢片）。报告新增 `ai.shards` 审计子节。

- [ ] **Step 1: Write failing tests**

信号量：`max=2`，提交 3 个返回 promise 的 fn，断言同时运行数峰值=2，全部完成。

JobService 用 FakeProvider（按 promptFile 内容计数调用）+ 构造超过 `maxInputChars` 的源码集：① `sharding.enabled=false` 但超限 → 自动分片，任务 SUCCEEDED，单报告，`ai.shards` 含每片文件列表与字符数；② 分片数 > `maxShards` → FAILED `SHARD_LIMIT_EXCEEDED`；③ 第二片 FakeProvider 抛 `AI_OUTPUT_INVALID_JSON` → 整任务 FAILED，`errors[0].code==='AI_OUTPUT_INVALID_JSON'`，不产生部分结果；④ `maxConcurrency=1` 与 `=2` 两种配置下最终报告 findings 一致（顺序无关）；⑤ 未超限且 `sharding.enabled=false` → 行为与原单次调用一致（回归，provider 调用 1 次）。

- [ ] **Step 2: Run tests to verify they fail** — Run: `node --test tests/review-job-service.test.js` — Expected: FAIL

- [ ] **Step 3: Write minimal implementation**

`semaphore.js`：

```js
export function createSemaphore(max) {
  let active = 0;
  const queue = [];
  function next() { if (queue.length > 0 && active < max) { active++; const { fn, resolve, reject } = queue.shift(); Promise.resolve().then(fn).then(resolve, reject).finally(() => { active--; next(); }); } }
  return { run(fn) { return new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); }); } };
}
```

`processJob` 在 REVIEWING 阶段：若不分片 → 原 `provider.review` + `parser` 流程；若分片 → `planShards` → 用 `createSemaphore(maxConcurrency)` 逐片 `{ files, contents, rules }` 构造子 prompt、写临时 promptFile、调 `provider.review`、`parser`，收集所有 `parsed.findings` 与 `summary`；任一片抛错则向上抛（被外层 catch 转为 FAILED 报告）。聚合后追加 analyzer（Task 7 逻辑，对全量 files），再单次 `policy`。`ai.shards = [{ index, files, charCount, durationMs }]`。

- [ ] **Step 4: Run tests to verify they pass** — Run: `node --test tests/review-job-service.test.js` — Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/shared/semaphore.js src/review-job-service.js tests/review-job-service.test.js
git commit -m "feat: shard large inputs with bounded concurrency and single policy pass"
```

---

## Task 10: 报告审计与 HTML 渲染

**Files:** Modify `src/review-job-service.js`（`buildReport`）、`src/html-report-renderer.js`；Test `tests/html-report-renderer.test.js`、`tests/review-job-service.test.js`

**Interfaces:** 报告 `ai` 新增 `shards`（不分片时为 `null` 或省略）；Finding `source`/`analyzerId`/`ruleId` 进入 JSON；HTML 新增「来源」列与「分片审计」节

- [ ] **Step 1: Write failing tests**

HTML 测试：含 analyzer finding 的报告 → HTML 每条 finding 行显示来源（`AI` 或 `clang-tidy`）；含 `ai.shards` 的报告 → HTML 含「分片审计」节列出每片文件数与字符数；HTML 对 `ruleId` 转义。JobService 测试：分片报告 `ai.shards` 非空且每片含 `files`/`charCount`；非分片报告 `ai.shards` 为 null。

- [ ] **Step 2: Run tests to verify they fail** — Run: `node --test tests/html-report-renderer.test.js tests/review-job-service.test.js` — Expected: FAIL

- [ ] **Step 3: Write minimal implementation**

`buildReport` 的 `aiPart` 追加 `shards: job.shards ?? null`。`html-report-renderer.js` 在 finding 行追加来源单元格（`source==='analyzer' ? escape(analyzerId) : 'AI'`）；在 AI 元数据节后追加分片审计节（若 `ai.shards` 非空），列出 `片N: 文件数 X, 字符数 Y`。所有动态内容经 `html-escape`。

- [ ] **Step 4: Run tests to verify they pass** — Run: `node --test tests/html-report-renderer.test.js tests/review-job-service.test.js` — Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/review-job-service.js src/html-report-renderer.js tests/html-report-renderer.test.js tests/review-job-service.test.js
git commit -m "feat: render finding source and shard audit in reports"
```

---

## Task 11: E2E 验收 AC-10、AC-11、AC-12

**Files:** Modify `tests/e2e/acceptance.test.js`、`tests/helpers/e2e-fixtures.js`

**Interfaces:** Consumes `createApp`、`temp-bare-repo`、`fake-clang-tidy`

- [ ] **Step 1: Write failing tests**

在 `acceptance.test.js` 追加三组：

**AC-10（Git 远程拉取闭环）：** 用 `makeBareRepoWithCommit` 造本地 bare 仓，POST `/api/reviews` 带 `sourceMode:'REMOTE_GIT'`、`remoteUrl:bare`、`ref:'master'`、`reviewMode:'GIT_CHANGES'`，FakeProvider。断言：SUCCEEDED、`source.files` 含 `a.c`；第二组 ref 不存在 → FAILED `REMOTE_REF_NOT_FOUND`；第三组 `remoteGit.workspaceDir` 在 allowedRoots 外 → 任务失败；日志不含 token 明文（用 spy logger 断言）。

**AC-11（外部静态分析器组合）：** 临时仓含 `a.cpp`，`analyzer.enabled=true`、command 指向 fake-clang-tidy 脚本，FakeProvider 返回 1 条 AI finding（与 analyzer 同文件同标题）。断言：报告 findings 经 PF-009 合并，含 `source==='analyzer'` 一条与 `source==='ai'` 一条（或合并后单条带来源）；第二组 command 指向不存在路径 → SUCCEEDED 且日志含 `ANALYZER_SKIPPED`；第三组 `onAnalyzerError:'fail'` + 命令存在但 exit 非 0 → FAILED `ANALYZER_FAILED`；源码运行前后内容一致（读文件比对）。

**AC-12（大项目分片与聚合）：** 构造超过 `maxInputChars` 的多文件源码集，FakeProvider。断言：SUCCEEDED、单报告、`ai.shards` 非空；第二组 `maxShards=1` 且必然 >1 片 → FAILED `SHARD_LIMIT_EXCEEDED`；第三组第二片 FakeProvider 抛错 → FAILED，无部分结果报告；第四组 `maxConcurrency=1` 与 `=2` 报告 findings 集合相等（按 findingId 排序比对）。

- [ ] **Step 2: Run tests to verify they fail** — Run: `node --test tests/e2e/acceptance.test.js` — Expected: FAIL

- [ ] **Step 3: Fix gaps**

补充 `e2e-fixtures.js`：`makeBareRepoWithCommit` 已在 helpers；新增 `makeLargeSourceTree(totalChars)` 生成多个 `.c` 文件；新增 fake-clang-tidy 脚本接入。确认 `createApp` 已装配 fetcher/analyzer/sharding（Task 4/7/9 已改 create-app）。

- [ ] **Step 4: Run tests to verify they pass** — Run: `node --test tests/e2e/acceptance.test.js` — Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/acceptance.test.js tests/helpers/e2e-fixtures.js
git commit -m "test: E2E acceptance for remote git, clang-tidy, and sharding"
```

---

## Self-review (author)

**Spec coverage:**
- §21.1 目标 → Task 2/3/4 ✓
- §21.2 约束（clone+fetch/pull、ref 必填、HTTPS token、复用/ephemeral、重试、allowedRoots）→ Task 2/4 ✓
- §21.3 配置 → Task 1/4 ✓
- §21.4 验收 → Task 11 AC-10 ✓
- §22.1 目标 → Task 5/6/7 ✓
- §22.2 约束（只内置 clang-tidy、并列、analyzerId+ruleId、跳过/fail、不改源码）→ Task 5/6/7 ✓
- §22.3 配置 → Task 1 ✓
- §22.4 验收 → Task 11 AC-11 ✓
- §23.1 目标 → Task 8/9 ✓
- §23.2 约束（自动分片刚需、可选并行、按文件+120k、并发可配默认1、聚合后单次 policy、单 inputHash、任一片失败=FAILED、maxShards=20）→ Task 8/9 ✓
- §23.3 配置 → Task 1 ✓
- §23.4 验收 → Task 11 AC-12 ✓
- §12.5 Finding `source` 字段 → Task 6 ✓
- §15 新错误码 → Task 1 ✓
- §16.5 并发可配 → Task 9 ✓
- §17.1 新 TDD 组件 → Task 2/5/8 ✓

**Placeholder scan:** 无 TBD/TODO；每个 Step 含具体测试与实现代码或精确断言。

**Type consistency:** `createRemoteGitFetcher`、`createClangTidyAnalyzer`、`planShards`、`createSemaphore` 在各 Task 间名称一致；RawFinding 形状在 Task 5/6/7 一致（`source`/`analyzerId`/`ruleId`）。

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-30-extensions-remote-static-shard.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
