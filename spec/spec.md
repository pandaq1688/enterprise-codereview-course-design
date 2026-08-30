# 代码审查系统 Spec

## 1. 文档信息

- 工程根目录：本仓库根目录（与 `reference/`、`spec/` 并列）
- 产品名称：代码审查系统
- 文档路径：`spec/spec.md`
- 文档日期：2026-08-30
- 文档状态：等待书面审阅（新增 §21/§22/§23 必做扩展点）
- 技术栈：Node.js 22、ESM JavaScript、原生 Web 页面、node:test
- 归档原稿：`reference/2026-08-28-enterprise-codereview-course-design.md`（只读归档，非基线）
- 实现约束：本 Spec 为唯一产品与技术基线；实现不依赖原 kdop-green 源码对照

本文档是代码审查系统的唯一总体产品与技术基线。后续测试、实现和验收都必须引用本 Spec，不得自行扩大范围。

## 2. 背景

企业本地开发场景需要可审计的代码审查能力：将需求与源码变更交给本机 Agent 做语义分析，再由程序做确定性二次过滤，输出结构化报告。完整企业流水线常包含远程仓库同步、工单回写、多用户权限与通知等基础设施；本系统 MVP 聚焦最小但完整的审查闭环，保留边界、可靠性和审计能力，暂不纳入上述周边能力。

核心业务闭环：

## 3. 项目目标

### 3.1 产品目标

用户通过本地 Web 页面指定一个本地项目目录和一个需求 Markdown 文件，启动一次代码审查，并得到可追溯的结构化报告。

系统必须支持：

1. 审查 Git 工作区中未提交的变更。
2. 审查非 Git 项目或 Git 项目的全部受支持源码。
3. 根据文件语言自动装配固定规则。
4. 加载唯一可自由配置的 review-checklist。
5. 通过可配置命令调用本机 Cursor Agent。
6. 将 Agent 输出校验为固定数据结构。
7. 通过程序进行确定性的风险修正、去重和豁免。
8. 保留 AI 原始结论到最终结论的完整审计轨迹。
9. 在 Web 页面查看当前任务、历史报告和报告详情。
10. 将报告保存为本地 JSON 和自包含 HTML。
11. 通过配置切换 RemoteLlmReviewProvider，在不改动核心编排的前提下调用远程大模型（必做，见 §19）。
12. 通过 ReviewScheduler 按 ReviewProfile 定时执行审查（必做，见 §20）。
13. 通过 REMOTE_GIT 模式从 Git 远程仓库拉取后审查（必做，见 §21）。
14. 内置 clang-tidy 外部静态分析器，结果与 AI Finding 并列进同一报告（必做，见 §22）。
15. 超输入限制时自动分片多轮 Agent 并聚合（必做，见 §23）。

### 3.2 成功标准

MVP 达成以下结果即视为完成：

1. 使用 FakeReviewProvider 的自动化端到端测试可以从两个本地路径生成 JSON 和 HTML 报告。
2. Git 模式能同时识别暂存、未暂存和未跟踪的受支持文件。
3. 全量模式能正确包含受支持文件并排除固定目录和二进制文件。
4. 混合 C/C++、Java、JavaScript、Python、Go 输入能自动加载对应固定规则。
5. 用户只能替换或配置 review-checklist，不能从外部配置替换全局、 C/C++、Java、JavaScript、Python、Go 规则。
6. 每个被降级、修正、合并或豁免的问题都有规则编号和中文原因。
7. Cursor 输出非法时生成失败任务和失败报告，不伪造代码缺陷。
8. 真实 Cursor 的人工验收能够完成一次审查并显示报告。
9. RemoteLlmReviewProvider 通过配置可切换，自动化测试（Mock Server）验收通过，且满足 §19。
10. ReviewScheduler 按 ReviewProfile 定时触发审查，自动化测试（含 FakeClock）验收通过，且满足 §20。
11. REMOTE_GIT 模式能完成 clone 与 fetch/pull 并进入审查，错误码与重试行为满足 §21，自动化测试（本地 bare 仓库）验收通过。
12. 内置 clang-tidy / ruff / go vet 分析器能与 AI Finding 并列进同一报告并经 PostReviewPolicy 去重，自动化测试满足 §22。
13. 超输入限制时自动分片多轮 Agent 并聚合为单一报告，分片上限与失败处理满足 §23，自动化测试验收通过。

未完成 §19、§20、§21、§22 与 §23 的系统不得视为交付完成。

## 4. 范围

### 4.1 核心审查范围

- 单机、单用户、本地 Web 服务。
- 手工提交审查任务。
- 本地项目目录输入。
- 本地需求 Markdown 路径输入。
- Git 变更模式。
- 全量目录模式。
- C、C++、Java、JavaScript、Python 和 Go 源文件。
- 固定全局、C/C++、Java、JavaScript、Python、Go 规则。
- 可配置 review-checklist。
- 本机 Cursor Agent Provider。
- 异步任务状态。
- 确定性二次过滤。
- 本地 JSON 和 HTML 报告。
- 本地历史列表与详情。
- 结构化日志、健康检查和安全退出。

### 4.2 明确不包含

- 修改、格式化或自动修复被审查源码。
- SVN 远程仓库拉取（Git 远程拉取见 §21）。
- 已提交历史和分支间差异审查。
- SQLite 或其他数据库。
- 登录、SSO、权限中心和多用户。
- 邮件、企微和其他通知。
- Bug 自动提交或工单回写。
- 消息队列和分布式 Worker。
- SQL、XML、Lua 等额外语言或文件类型。
- 自动修复、自动提交和自动合并。

### 4.3 必做扩展点

以下扩展点是产品交付的**硬性必做项**，不是可选后续。实现顺序可在核心审查闭环（§4.1）稳定之后推进，但验收完成前必须全部交付：

1. RemoteLlmReviewProvider（§19）：通过 API Key 调用真实远程大模型。
2. ReviewScheduler（§20）：按照本地 ReviewProfile 定时执行相同的审查用例。
3. Git 远程仓库拉取（§21）：支持 clone 与 fetch/pull，拉取后转本地工作目录再走现有审查流程。
4. 外部静态分析器组合（§22）：内置 clang-tidy、ruff、go vet，结果与 AI Finding 并列进同一报告。
5. 大项目分片与并行 Agent（§23）：超输入限制时自动分片多轮 Agent，再聚合后统一二次过滤。

这些扩展点必须复用 ReviewJobService、二次过滤和报告组件，不得复制主业务流程。缺少任一扩展点均视为未完成。

## 5. 核心概念

### 5.1 静态规则阶段

本项目中的“静态规则”指静态、确定的 Markdown 审查规则，不表示运行编译器或静态分析工具。

RuleResolver 根据文件扩展名和目录确定应该加载哪些规则，再由 PromptBuilder 将这些规则交给 Cursor Agent。规则选择本身是确定性程序行为，规则内容由 Agent 进行语义解释。

### 5.2 AI 候选结论

Cursor Agent 生成的是候选问题，不能直接作为最终企业审查结论。

所有候选问题必须经过 Schema 校验和 PostReviewPolicy。最终报告风险只能由程序根据有效问题重新计算。

### 5.3 审计轨迹

程序不静默删除候选问题。每个问题必须保留原始风险、最终风险、最终状态和决策步骤。

## 6. 用户流程

### 6.1 创建审查任务

用户打开本地首页，填写：

- 项目目录。
- 需求 Markdown 文件。
- 审查模式：Git 变更、全量目录或 REMOTE_GIT（§21，需提供 remoteUrl 与 ref）。
- review-checklist 是否启用。
- review-checklist 文件路径。
- checklist 适用目录，默认是项目根目录。

用户点击“开始审查”后，Web API 完成同步输入校验。合法请求返回 reviewId 和 QUEUED 状态；非法请求直接返回明确的 4xx 错误。

### 6.2 查看任务状态

页面按照 reviewId 轮询任务状态：

任务完成后页面跳转到报告详情。任务失败后显示错误码、中文说明和建议操作。

### 6.3 查看历史报告

首页显示报告历史，至少包含：

- 创建时间。
- 项目名称。
- 审查模式。
- 最终状态。
- 最终风险。
- 有效问题数。
- 豁免问题数。
- 执行时长。

用户可以打开 JSON 文件、HTML 报告或 Web 详情页。

## 7. 系统架构

### 7.1 架构原则

系统采用分层单体。组件通过普通 JavaScript 对象契约和构造函数注入协作，不创建没有行为价值的抽象基类。

依赖方向固定为：

Domain 不读取文件、不启动进程、不访问 HTTP。Application 负责编排，不包含具体文件系统、Git、Cursor 或 HTML 实现。

### 7.2 组件职责

#### RequestValidator

- 校验必填字段和模式。
- 将输入转换为规范化绝对路径。
- 使用 realpath 解析真实路径。
- 校验路径位于 allowedRoots 中。
- 校验项目目录、需求文件和 checklist 的文件类型与可读性。
- Git 模式校验项目是否为 Git 工作区。

#### GitChangedSourceCollector

- 使用 Git 命令读取当前工作区相对于 HEAD 的暂存和未暂存变更。
- 使用 git ls-files 读取未跟踪且未被 ignore 的文件。
- HEAD 不存在时将全部受支持文件作为新增文件处理。
- 将路径统一为相对于项目根目录的正斜杠路径。
- 只返回受支持文件。
- 生成当前文件行号和变更行集合。
- 不执行 checkout、reset、clean、add 或任何写操作。

#### FullDirectorySourceCollector

- 从项目根目录递归读取受支持文件。
- 不跟随符号链接。
- 排除固定目录。
- 检测并拒绝二进制文件。
- 为源码生成稳定的行号表示。

#### RequirementLoader

- 只接受 .md 和 .markdown 文件。
- 使用 UTF-8 读取。
- 拒绝空文件和超过限制的文件。
- 不对需求内容做隐藏的语义改写。

#### RuleResolver

- 始终加载固定全局规则。
- 输入包含 C/C++文件时加载固定 C/C++ 规则。
- 输入包含 Java 文件时加载固定 Java 规则。
- 输入包含 JavaScript 文件时加载固定 JavaScript 规则。
- 输入包含 Python 文件时加载固定 Python 规则。
- 输入包含 Go 文件时加载固定 Go 规则。
- 根据 includePaths 和 excludePaths 判断是否加载 review-checklist。
- 对规则内容计算 SHA-256。
- 输出规则与匹配文件的可追溯清单。

#### PromptBuilder

按照固定顺序生成 UTF-8 提示词文件：

1. 角色、证据原则和禁止猜测约束。
2. JSON 输出契约。
3. 需求文档。
4. 审查模式、文件清单和范围说明。
5. 固定全局规则。
6. 固定语言规则。
7. 可配置 review-checklist。
8. Git diff 或带行号的全量源码。
9. 输出前自检要求。

同一输入必须产生语义等价且顺序稳定的提示词，以便测试和排错。

#### ReviewProvider

Provider 契约为：

Provider 只负责与模型交互，不解析业务 Finding，不进行风险决策，也不写正式报告。

#### CursorReviewProvider

- 从配置读取 command 和 args 数组。
- 只允许替换 {promptFile}、{projectDir}、{outputFile} 三种完整参数占位符。
- 使用 child_process.spawn，shell 固定为 false。
- Windows 下隐藏子进程窗口。
- 捕获退出码、stdout 和 stderr。
- 限制执行时间和输出字符数。
- 超时后终止子进程及其进程树。
- args 中存在 {outputFile} 时优先读取输出文件，否则读取 stdout。
- finally 中删除临时提示词和临时输出文件。
- 不把命令中的敏感环境变量写入日志或报告。

Cursor 命令名和参数因本机安装方式而异，因此示例配置不被视为可直接运行的保证。首次人工验收前必须先运行本机命令的 help 参数并据此调整配置。

#### ReviewResultParser

- 去除可识别的外层 Markdown JSON 代码围栏。
- 提取单个 JSON 对象。
- 支持经过明确登记的字段别名。
- 将风险转为大写。
- 将数值行号转换为整数或 null。
- 按 AI 输出 Schema 校验必填字段和字段类型。
- 解析失败返回协议错误，不创建伪 Finding。

#### PostReviewPolicy

- 对 Finding 执行纯函数形式的确定性决策。
- 不读取文件系统，不调用 Agent。
- 为每一步转换附加 policyId、action 和中文 reason。
- 根据最终有效 Finding 重新计算 overallRisk。

#### FileReportRepository

- 使用 crypto.randomUUID 创建 reviewId。
- 每个任务写入 data/reports/{reviewId}/report.json 和 report.html。
- 先写同级临时目录，两个文件成功后再重命名为正式目录。
- 按创建时间倒序读取历史。
- 报告 Schema 必须包含 schemaVersion。
- 服务重启后能从本地报告恢复历史列表。

#### HtmlReportRenderer

- 接收结构化报告对象，不读取 AI 原始文件。
- 对所有动态内容执行 HTML 转义。
- 输出不依赖 CDN、远程字体或脚本的自包含 HTML。
- 展示有效问题、豁免问题和完整决策轨迹。
- 不嵌入完整项目源码。

#### ReviewJobService

- 编排完整流程。
- 维护任务状态转换。
- 同一进程最多运行一个 Cursor 任务。
- 将已接受任务放入内存 FIFO 队列。
- 无论成功或失败都尽力生成报告。
- 服务重启后不恢复未完成任务，但保留已生成报告。

#### WebAdapter

- 使用 Node.js 原生 http 模块。
- 提供输入页、任务状态、历史列表和报告详情。
- 只调用 Application Service。
- 不直接读取项目源码、加载规则或调用 Cursor。

#### RemoteGitFetcher（§21）

- 接收 remoteUrl 与 ref，执行 clone 或 fetch/pull 到本地工作目录。
- 鉴权通过环境变量注入，不持有明文凭据。
- 拉取失败映射为 REMOTE_FETCH_FAILED / REMOTE_AUTH_FAILED / REMOTE_REF_NOT_FOUND。

#### ClangTidyAnalyzer / RuffAnalyzer / GoVetAnalyzer（§22）

- 对受支持 C/C++、Python、Go 文件分别运行对应分析器，解析结果为 Analyzer Finding。
- 失败时按该项 onAnalyzerError 跳过或失败。
- 不修改被审查源码。

#### ShardPlanner / ShardAggregator（§23）

- ShardPlanner 按文件与字符预算生成分片计划。
- ShardAggregator 汇总各片原始 Finding，交由 PostReviewPolicy 统一去重与定级。
- 任一片失败即整任务 FAILED。

## 8. 源码采集规范

### 8.1 支持的扩展名

MVP 固定支持：

- C：.c
- C++：.cc、.cpp、.cxx、.h、.hpp、.hxx
- Java：.java
- JavaScript：.js、.mjs、.cjs
- Python：.py
- Go：.go

扩展名比较不区分大小写。没有扩展名或不在列表中的文件不进入审查。

### 8.2 固定排除目录

- .git
- node_modules
- dist
- build
- out
- target
- coverage
- data/reports
- data/logs

MVP 不提供页面配置这些排除目录，避免误删必要安全边界。

### 8.3 Git 变更模式

Tracked 文件使用相对于 HEAD 的最终工作区差异，覆盖暂存和未暂存修改。Untracked 文件通过 git ls-files --others --exclude-standard 获取，并以新增文件形式加入。

同一文件同时含暂存和未暂存修改时只出现一次。Deleted 文件保留 diff 供审查，但不要求当前文件行号。Rename 使用最终相对路径，并保留旧路径元数据。

中高风险 Finding 必须定位到新增或修改行。仅定位到未变更上下文的非崩溃问题降为 LOW。

### 8.4 全量目录模式

所有受支持文件以相对路径排序后读取，内容使用从 1 开始的稳定行号表示。全量模式的合法行号可以位于文件任意位置。

### 8.5 输入限制

MVP 推荐默认值：

- 最大源码文件数：50。
- 单文件最大字符数：80,000。
- 所有源码或 diff 最大字符数：240,000。
- 需求文档最大字符数：50,000。
- checklist 最大字符数：80,000。

超过限制时任务在 REVIEWING 前失败，错误必须列出超限项目。系统不得静默截断代码或规则后继续审查。

启用分片（§23）后，超过上述限制不再直接失败：ShardPlanner 按文件与字符预算自动分片，多轮调用 Agent 后聚合。分片数超过 `sharding.maxShards` 时仍以 `SHARD_LIMIT_EXCEEDED` 失败。

### 8.6 输入哈希

inputHash 使用以下内容的稳定表示计算 SHA-256：

- 审查模式。
- 需求内容。
- 选中源码或 diff。
- 所有生效规则内容。
- Prompt Schema 版本。

inputHash 用于报告追溯和后续定时任务去重，不用于安全签名。

## 9. 规则规范

### 9.1 固定全局规则

全局规则必须覆盖：

- 只基于需求、源码和 diff 中的证据。
- 不猜测外部接口和未知运行环境。
- 优先发现正确性、安全性、内存安全、并发和资源生命周期问题。
- 明确需求与代码冲突时允许报告需求不符合。
- 无准确位置和证据的中高风险结论不成立。
- 输出必须符合 JSON Schema。
- 除代码、符号和路径外，报告文本使用简体中文。

全局规则不得包含 KDOP、仓库轮询、提交作者、邮件或工单语义。

### 9.2 固定 C/C++ 规则

精简规则只保留通用高价值项：

- 未初始化使用和未定义行为。
- 空指针、悬空指针、use-after-free、重复释放。
- 数组和缓冲区越界。
- 整数溢出、符号转换和长度回绕。
- 资源所有权与 RAII。
- 返回值和错误码处理。
- 数据竞争、死锁和错误内存序。
- 信号、线程和进程生命周期。
- 外部输入长度校验。

删除原规则中的企业私有宏名称、固定目录名称、数据库方言和项目专属命名约定。

### 9.3 固定 Java 规则

精简规则只保留通用高价值项：

- 空指针和 Optional 误用。
- 资源关闭和异常吞噬。
- 集合修改和并发安全。
- 线程池边界和任务异常。
- 事务失效和同类自调用。
- 入参校验。
- BigDecimal 精度。
- 强制类型转换。
- 无界静态缓存和大对象加载。
- 远程调用超时与幂等证据。

删除原规则中的固定数据库方言、固定目录名称和企业内部约定。

### 9.4 固定 JavaScript 规则

精简规则只保留通用高价值项：

- 空值与可选链误用、隐式类型转换、`==` 与 `===`。
- 异步正确性：未 await、未捕获的 Promise rejection、竞态与回调时序。
- 资源关闭：文件句柄、流、定时器、监听器与连接的生命周期。
- 闭包变量捕获、循环中的异步引用、`this` 绑定与箭头函数误用。
- 原型链污染、`__proto__` 注入、不受信的 `eval`/`Function`/动态属性访问。
- 命令注入：`child_process` 的 shell 拼接、`exec` 与未分隔的 argv。
- 路径穿越：`path.join`/`path.resolve` 后未做根目录越界校验、符号链接逃逸。
- 正则灾难性回溯与未转义的输入拼接。
- 未校验的外部输入长度、类型与结构。
- 并发控制：信号量、互斥与限流是否正确释放与归还。

删除原规则中的项目专属命名约定或未在输入中出现的约定。

### 9.5 固定 Python 规则

精简规则只保留通用高价值项：

- 可变默认参数、闭包晚绑定、意外的全局可变状态。
- 异常吞没、裸 `except`、资源未用 `with` 关闭。
- 并发竞态与未 await 的协程。
- SQL/命令/路径注入与不安全的 `eval`/`exec`/`pickle`。
- 外部输入边界与路径穿越。

### 9.6 固定 Go 规则

精简规则只保留通用高价值项：

- 错误处理与错误包装。
- goroutine 泄漏、channel 与 data race。
- 资源关闭与 defer 陷阱。
- context 传递与超时。
- 输入校验与命令执行安全。

### 9.7 可配置 review-checklist

review-checklist 是唯一允许自由配置的审查规则：

- 可以启用或停用。
- 可以替换 Markdown 文件路径。
- 可以修改文件内容。
- 可以配置 includePaths。
- 可以配置 excludePaths。

默认 checklist 精简保留并发、内存边界、外部输入、错误处理、资源生命周期和控制流检查。

全局、C/C++、Java、JavaScript、Python 和 Go 规则路径不出现在外部配置中，由 RuleResolver 固定引用。这里的“只有 checklist 可配置”只限制审查规则；端口、允许根目录、超时和输入上限等运行参数仍可配置。

### 9.8 规则追溯

报告中每条生效规则记录：

- ruleId。
- ruleType：GLOBAL、CPP、JAVA、JS、PYTHON、GO 或 CHECKLIST。
- builtIn。
- contentHash。
- matchPaths。
- matchedFiles。

## 10. AI 输入与输出协议

### 10.1 AI 输出 Schema

Cursor 必须只返回一个 JSON 对象：

合法风险等级：

合法类别：

- SECURITY
- CORRECTNESS
- MEMORY_SAFETY
- CONCURRENCY
- RESOURCE_LIFECYCLE
- REQUIREMENT_MISMATCH
- MAINTAINABILITY
- PERFORMANCE
- OTHER

AI 的 overall_risk 只保存为原始元数据，不作为最终风险。

### 10.2 证据要求

每个 Finding 至少必须具有：

- 非空标题和说明。
- 属于本次审查范围的相对文件路径。
- 可验证的行号。
- 具体证据。
- 与证据相匹配的风险说明。

需求不符合问题必须提供 requirement_reference。没有需求引用的业务偏好不得作为需求不符合问题。

## 11. 二次过滤与风险政策

### 11.1 风险含义

- LOW：代码风格、可维护性或证据有限但值得提示的问题。
- MEDIUM：有准确证据的功能错误、资源问题或明确需求偏差，但影响受限。
- HIGH：可导致崩溃、越界、注入、死锁、重要数据错误、严重需求违背或服务不可用的问题。
- CRITICAL：有准确证据的远程代码执行、关键鉴权绕过、大范围不可恢复数据破坏或同级灾难性影响。

### 11.2 决策动作

- KEPT：原始 Finding 直接生效。
- CORRECTED：程序修正字段、类别、位置或风险。
- DOWNGRADED：Finding 仍展示并计入有效问题，但最终风险降低。
- EXEMPTED：Finding 保留在审计区，不计入最终风险。
- MERGED：重复 Finding 合并到一个主 Finding。

### 11.3 固定政策

#### PF-001 字段与枚举归一化

- 风险转为大写。
- 非法风险改为 LOW。
- 非法类别改为 OTHER。
- 路径转换为项目相对正斜杠路径。
- 非整数行号转为 null。

#### PF-002 审查范围

不属于本次选中文件的 Finding 标记为 EXEMPTED，原因是 OUT_OF_SCOPE_FILE。

#### PF-003 定位证据

- 文件不存在或行号越界时，Finding 标记为 EXEMPTED。
- Git 模式下，非崩溃类中高风险 Finding 未定位到新增或修改行时降为 LOW。
- 缺少精确位置的问题不能保持 MEDIUM、HIGH 或 CRITICAL。

#### PF-004 推测性结论

使用“可能、也许、推测、假设、无法确认”等措辞，且没有同时给出明确代码证据的问题标记为 EXEMPTED。

明确的语法、未初始化、内存越界等问题不能仅因中文描述包含条件词而被豁免，必须结合类别、位置和证据判断。

#### PF-005 未知接口与兼容性

基于未知第三方接口行为、未知异步语义、未提供的旧版本或升级路径作出的结论标记为 EXEMPTED。

#### PF-006 设计、风格与性能

- MAINTAINABILITY 默认最高为 LOW。
- PERFORMANCE 没有复杂度、循环、调用次数或明确热点证据时最高为 LOW。
- OTHER 类别不能保持中高风险。

#### PF-007 严重风险修正

具备准确位置和明确证据的以下问题，最终风险不低于 HIGH：

- 未初始化使用。
- 明确空指针解引用。
- 越界访问。
- use-after-free 或重复释放。
- 确定的数据竞争或死锁。
- 可执行的注入路径。
- 明确导致进程退出或服务不可用的错误。

CRITICAL 必须同时满足灾难性影响类别、准确位置和直接证据；否则最高修正为 HIGH。

#### PF-008 需求不符合

REQUIREMENT_MISMATCH 必须同时提供 requirement_reference 和代码位置。缺少任一项时降为 LOW；明确违反验收条件且后果严重时可以保持 MEDIUM 或 HIGH。

#### PF-009 重复问题

根据规范化文件路径、重叠行号、类别和标题指纹识别重复 Finding。重复项标记为 MERGED，主项保留最高合法最终风险和全部证据。

#### PF-010 最终风险重算

忽略 EXEMPTED 和 MERGED 从项。overallRisk 等于其余 Finding 的最高 finalRisk；没有有效 Finding 时为 LOW。

### 11.4 审计要求

每次政策处理必须写入：

相同输入和相同 AI JSON 必须得到相同的最终 Finding 与风险。决策函数不得使用当前时间、随机数或外部服务；timestamp 由编排层在决策完成后添加。

## 12. 报告模型

### 12.1 顶层字段

### 12.2 request

triggerType：手工任务为 MANUAL；定时任务（§20，必做）为 SCHEDULED。

报告中的绝对路径默认只保留最后两级用于展示，完整路径不写入 HTML。JSON 是否保留完整路径由配置控制，默认不保留。

### 12.3 source

source 不保存完整源码。

### 12.4 ai

rawOutput 可能包含模型复述的代码片段，因此报告目录必须按本地敏感开发数据保护。

### 12.5 result

每个 Finding 包含：

~~~text
findingId
category
title
description
filePath
lineStart
lineEnd
evidence
requirementReference
fixSuggestion
fixCode
originalRisk
finalRisk
status
decisions[]
source              # ai | analyzer；§22 引入 analyzer 来源
~~~

### 12.6 HTML 页面

HTML 报告按顺序展示：

1. 项目、需求、模式、时间和最终风险。
2. 输入文件和生效规则。
3. 有效 Finding。
4. 被降级 Finding。
5. 被豁免和合并 Finding。
6. 每个 Finding 的决策轨迹。
7. AI 与任务执行元数据。
8. 失败任务的错误说明和建议操作。

## 13. Web 与 API

### 13.1 页面

- GET /：创建任务和历史报告列表。
- GET /jobs/{reviewId}：任务状态页。
- GET /reports/{reviewId}：Web 报告详情。
- GET /reports/{reviewId}/report.html：自包含 HTML。
- GET /reports/{reviewId}/report.json：JSON 文件。

### 13.2 API

- POST /api/reviews：校验请求并创建任务，成功返回 202。`sourceMode` 取值 `GIT_CHANGES`、`FULL_DIRECTORY` 或 `REMOTE_GIT`（见 §21）。
- GET /api/jobs/{reviewId}：读取内存任务或已持久化报告状态。
- GET /api/reports：读取历史摘要。
- GET /api/reports/{reviewId}：读取结构化报告。
- GET /api/health：返回进程状态、队列长度和当前任务，不返回路径或配置秘密。

### 13.3 请求示例

### 13.4 HTTP 错误

同步校验失败使用 4xx，并返回：

已进入队列后的执行错误使用 FAILED 报告表达，不通过延迟 HTTP 请求返回。

## 14. 配置

### 14.1 示例配置

示例中的 Cursor 命令只表达参数模板，不保证与本机安装完全一致。部署前必须根据本机 Cursor Agent 的帮助信息调整 command 和 args。

### 14.2 配置安全

- app.config.example.json 可以提交。
- app.config.json 不提交。
- 真实 API Key 只能来自环境变量。
- remoteGit 凭据（token、用户名）只能来自环境变量，配置只保存环境变量名；启动阶段确认存在但不得打印其值。
- 配置解析错误必须在服务启动时失败。
- 日志不得输出完整环境变量、命令环境或敏感 Header。

## 15. 错误处理

固定错误码至少包括：

- INVALID_REQUEST
- PATH_NOT_FOUND
- PATH_OUTSIDE_ALLOWED_ROOT
- PATH_SYMLINK_ESCAPE
- REQUIREMENT_NOT_MARKDOWN
- REQUIREMENT_EMPTY
- GIT_REPOSITORY_REQUIRED
- NO_REVIEWABLE_SOURCE
- SOURCE_FILE_LIMIT_EXCEEDED
- SOURCE_SIZE_LIMIT_EXCEEDED
- RULE_READ_FAILED
- CURSOR_START_FAILED
- CURSOR_TIMEOUT
- CURSOR_EXIT_NON_ZERO
- CURSOR_OUTPUT_TOO_LARGE
- AI_OUTPUT_INVALID_JSON
- AI_OUTPUT_SCHEMA_INVALID
- REPORT_WRITE_FAILED
- REMOTE_FETCH_FAILED
- REMOTE_AUTH_FAILED
- REMOTE_REF_NOT_FOUND
- ANALYZER_SKIPPED
- ANALYZER_FAILED
- SHARD_LIMIT_EXCEEDED

错误对象必须包含 code、中文 message 和安全的 details。不得把完整 stderr、环境变量或绝对敏感路径直接返回页面。

如果报告存储本身失败，ReviewJobService 在内存任务状态和结构化日志中记录 REPORT_WRITE_FAILED；这是唯一无法保证生成失败报告的场景。

MVP 不自动重试 Cursor。用户可以在页面重新运行任务。这样可以避免模型重复调用造成隐藏成本和不确定行为。

## 16. 安全、可靠性与可观察性

### 16.1 路径安全

- allowedRoots 必须至少配置一项。
- 使用 realpath 后再判断路径包含关系。
- 比较必须以路径段为边界，不能使用简单字符串前缀。
- Windows 路径比较不区分大小写。
- 拒绝通过符号链接逃出允许根目录。
- 不跟随源码目录中的符号链接。

### 16.2 子进程安全

- spawn 的 shell 为 false。
- command 与 args 分开配置。
- 占位符只能替换完整参数值。
- 不接受页面输入额外命令参数。
- 设置 windowsHide。
- 超时后终止进程树。
- stdout、stderr 和输出文件均有限制。

### 16.3 报告安全

- HTML 对动态内容转义。
- 报告不执行 AI 返回的 HTML、脚本或 Markdown。
- 报告默认隐藏完整绝对路径。
- data 目录加入 .gitignore。

### 16.4 日志

使用 JSON Lines 结构化日志，字段至少包含：

日志不记录完整源码、完整 Prompt、API Key 或未脱敏的绝对路径。

### 16.5 并发与退出

- 默认全局 Cursor 并发固定为 1。
- 启用分片（§23）后并发上限由 `sharding.maxConcurrency` 配置，默认仍为 1；并发任务受同一全局上限约束。
- 队列使用 FIFO。
- 收到 SIGINT 或 SIGTERM 后停止接受任务。
- 等待当前任务最多 30 秒。
- 超过等待时间后终止 Cursor 子进程并记录失败。

## 17. 工程测试策略

### 17.1 必须使用 TDD 的组件

- RequestValidator。
- GitChangedSourceCollector。
- FullDirectorySourceCollector。
- RequirementLoader。
- RuleResolver。
- PromptBuilder。
- CursorReviewProvider 的命令构造、超时和错误处理。
- ReviewResultParser。
- PostReviewPolicy。
- FileReportRepository。
- HtmlReportRenderer。
- ReviewJobService 状态机。
- Web API 的输入与状态行为。
- RemoteGitFetcher（§21）：clone/fetch、ref 解析、重试与错误码映射。
- ClangTidyAnalyzer（§22）：命令构造、结果解析、失败处理与 Finding 归一。
- ShardPlanner 与 ShardAggregator（§23）：字符预算分片、聚合与去重。

### 17.2 不要求形式化 TDD 的内容

- 纯 CSS。
- 静态页面布局微调。
- 简单常量文件。
- 示例 Markdown 文案。
- 本机 Cursor 的人工配置。

这些部分仍需通过适当的人工或集成验证，但不为了覆盖率创建无行为价值的测试。

### 17.3 每个 TDD 步骤的证据

每个核心行为按以下顺序完成：

1. 写一个描述单一行为的测试。
2. 运行测试并确认因缺少该行为而失败。
3. 编写使该测试通过的最小实现。
4. 运行相关测试并确认通过。
5. 在测试保护下重构。
6. 运行完整测试集。

禁止先实现再补一个立即通过的测试并称为 TDD。

### 17.4 测试分层

#### 单元测试

- 路径规范化和包含关系。
- 扩展名、排除目录和符号链接判断。
- 规则匹配和装配顺序。
- Prompt 顺序和内容边界。
- Schema 归一化。
- 每条 PF 政策。
- 风险重算。
- HTML 转义。
- 状态机合法转换。

#### 集成测试

- 临时 Git 仓库中的暂存、未暂存、未跟踪和删除文件。
- 临时目录全量扫描。
- 可执行 Fake Cursor 脚本的 spawn、超时、非零退出和输出文件。
- 临时报告目录的原子写入和历史恢复。
- Web API 与 FakeReviewProvider。

#### 端到端测试

使用固定 Fixture 和 FakeReviewProvider：

真实 Cursor 只做人工冒烟测试，不作为 npm test 的依赖。

## 18. 验收标准

### AC-01 Git 变更闭环

给定包含暂存、未暂存和未跟踪 C++ 文件的临时 Git 仓库，以及合法需求 Markdown，使用 FakeReviewProvider 运行后：

- 三类变更均进入输入清单。
- 固定全局和 C++ 规则生效。
- JSON 与 HTML 同时生成。
- 状态为 SUCCEEDED。

### AC-02 全量混合语言

给定包含 C++、Java、JavaScript、Python、Go 和不支持文件的目录：

- 只采集受支持文件。
- 同时装配 C++、Java、JavaScript、Python 和 Go 规则。
- 不支持文件不进入 Prompt。

### AC-03 checklist 可配置

- 自定义 checklist 只对 includePaths 内且不在 excludePaths 内的文件生效。
- 禁用 checklist 后不进入 Prompt。
- 外部配置无法替换全局、C++ 或 Java 规则。

### AC-04 路径安全

项目、需求或 checklist 位于 allowedRoots 外时请求失败。通过路径片段、大小写差异或符号链接尝试越界也必须失败。

### AC-05 Agent 协议失败

FakeReviewProvider 返回非法 JSON 或缺少必填字段时：

- 任务状态为 FAILED。
- 错误码准确。
- 不生成虚假代码 Finding。
- 能生成失败报告时保留原始输出。

### AC-06 二次过滤审计

同一份 AI JSON 中包含有效问题、推测问题、越界文件、重复问题和错误风险：

- 每项得到确定的最终状态。
- 每次转换都有 policyId 和中文原因。
- overallRisk 只由有效主 Finding 计算。

### AC-07 报告安全

AI 文本包含 script 标签、HTML 属性和特殊字符时：

- report.json 保留原始文本。
- report.html 只展示转义文本。
- 打开报告不会执行注入内容。

### AC-08 服务重启

服务生成报告并退出后再次启动：

- 历史列表仍能读取该报告。
- 未完成的内存任务不被伪装成已恢复任务。

### AC-09 真实 Cursor 人工验收

在本机确认 Cursor 命令模板后，使用一个小型示例项目运行：

- Cursor 正常启动。
- Provider 获得合法 JSON。
- 报告展示 AI 原始风险和程序最终风险。
- 被审查源码没有发生修改。

### AC-10 Git 远程拉取闭环

使用本地 bare 仓库作为远端，REMOTE_GIT 模式分别验证 clone 与 fetch/pull：

- 拉取后进入审查并生成报告。
- ref 不存在返回 REMOTE_REF_NOT_FOUND；鉴权失败返回 REMOTE_AUTH_FAILED 且不重试；网络错误重试耗尽返回 REMOTE_FETCH_FAILED。
- 拉取目录不在 allowedRoots 内时任务失败。
- ephemeral 模式审查后清理临时目录。
- 日志不含 token/用户名明文。

### AC-11 外部静态分析器组合

在含 C++ 文件的临时仓库启用 analyzer：

- 报告同时出现 AI Finding 与 clang-tidy Finding，均带规则编号与审计步骤。
- clang-tidy 未安装时任务不失败，含 ANALYZER_SKIPPED。
- onAnalyzerError = fail 时失败导致任务 FAILED。
- Analyzer Finding 与重复 AI Finding 经 PF-009 正确去重。
- 被审查源码运行前后内容一致。

### AC-12 大项目分片与聚合

构造超过 §8.5 字符数限制的源码集：

- 启用自动分片后不因超限失败，生成单一报告并含分片清单。
- 分片数超过 maxShards 时任务 FAILED，错误码 SHARD_LIMIT_EXCEEDED。
- 任一片 Agent 失败时整任务 FAILED，不产生部分结果报告。
- 跨片重复 Finding 聚合后经 PF-009 正确去重。
- maxConcurrency = 1 与 >1 配置下最终报告一致。

## 19. 远程大模型 API（必做扩展点）

本节为交付必做项。未实现或未通过 §19.4 验收，产品不得视为完成。

### 19.1 目标

必须实现 RemoteLlmReviewProvider，使用户可以通过真实 API Key 调用远程模型，同时保持 ReviewJobService、PromptBuilder、PostReviewPolicy 和报告模型不变。

### 19.2 约束

- Provider 从环境变量读取 API Key。
- 配置只保存 API 地址、模型、超时和 Key 的环境变量名称。
- 不在 Web 页面接收或展示 API Key。
- 不在报告和日志中保存 Authorization Header。
- HTTP 状态、超时、限流、协议错误映射为统一 Provider 错误。
- 自动化测试使用本地 Mock Server。
- 实现前必须核对所选供应商当时的官方 API 文档，禁止根据过期示例猜测接口。

### 19.3 配置切换

provider 为 cursor 时忽略 remote；provider 为 remote 时启动阶段确认环境变量存在，但不得打印其值。

### 19.4 验收

- Fake HTTP Server 能验证请求结构和 Bearer Header 是否存在。
- 401、429、5xx、超时和非法 JSON 均有稳定错误码。
- 替换 Provider 后同一 Fake 响应得到相同的最终报告。
- 代码库、报告和日志中不存在真实 Key。

## 20. 定时自动审查（必做扩展点）

本节为交付必做项。未实现或未通过 §20.3 验收，产品不得视为完成。

### 20.1 ReviewProfile

每个定时配置包含：

`scheduleType` 三选一，互斥：

- **interval**：固定分钟间隔，`intervalMinutes` 最小为 5。无 `scheduleType` 的旧配置按 interval 兼容。
- **calendar**：结构化固定时刻。`calendar.daysOfWeek` 为 0（周日）–6（周六）的非空数组；`hour` 0–23；`minute` 0–59。按 `timezone` 计算下次运行点。
- **cron**：标准 5 段表达式（支持 `*`、`,`、`-`、`/`；周字段 0–7，7 等同周日）。不支持秒字段与 `@weekly` 等扩展。按 `timezone` 计算。

固定时间在宕机错过窗口后，恢复时最多补跑一次（不堆积多次）。

### 20.2 调度行为

- Scheduler 启动后读取 ReviewProfile。
- 到期时通过 ReviewJobService 创建 triggerType 为 SCHEDULED 的任务。
- 同一个 Profile 运行中时不重复入队。
- 对比 inputHash；与上次成功报告相同则记录 SKIPPED_UNCHANGED，不调用模型。
- Scheduler 状态原子写入 data/scheduler-state.json。
- 人工任务优先于新到期的定时任务，但不打断正在执行的任务。
- 定时失败只记录报告和日志，不导致服务退出。

### 20.3 验收

- 使用可控 FakeClock 验证到期、未到期和重复触发。
- 同 Profile single-flight 生效。
- 相同 inputHash 不产生远程模型调用。
- 服务重启后能读取上次运行状态并计算下一次时间。
- 定时任务生成与人工任务相同 Schema 的报告。

## 21. Git 远程仓库拉取（必做扩展点）

本节为交付必做项。未实现或未通过 §21.4 验收，产品不得视为完成。

### 21.1 目标

支持用户通过 `sourceMode = REMOTE_GIT` 指定一个 Git 远程仓库，由系统拉取到本地工作目录后，转走现有 Git 变更或全量目录审查流程，复用 ReviewJobService、二次过滤与报告组件。

### 21.2 约束

- 仅支持 Git，不支持 SVN。
- 支持两种拉取：
  - **clone**：首次拉取远程仓库到本地。
  - **fetch/pull**：本地已存在该仓库 clone 时，更新到指定 ref。
- 必须指定 **ref**（分支、tag 或 commit）；不指定 ref 时任务失败。
- 拉取后审查模式仍由用户在 Git 变更（§8.3）与全量目录（§8.4）中选择。
- 不引入已提交历史差异审查（保持 §4.2）。
- 鉴权：配置中填写 HTTPS token/用户名的环境变量名，落盘脱敏（参考 §14.2），启动阶段确认存在但不得打印其值；SSH 鉴权交由本机 git 默认机制（`GIT_SSH_COMMAND` 等），系统不持有私钥。
- clone 落盘：默认到 `remoteGit.workspaceDir` 下按仓库名建子目录并复用；`remoteGit.ephemeral = true` 时使用临时目录，审查后清理。
- 失败处理：网络错误与 ref 不存在有限次重试（`remoteGit.fetchRetries`，默认 3）后 FAILED；鉴权失败不重试，直接 FAILED。
- 拉取产生的本地工作目录必须落在 `allowedRoots` 内，否则任务失败。

### 21.3 配置

见 §14.1 中 `remoteGit` 段。请求体扩展字段：

`reviewMode` 表示拉取完成后采用的审查模式，取值 `GIT_CHANGES` 或 `FULL_DIRECTORY`。

### 21.4 验收

- 使用本地 bare 仓库作为远端，验证 clone 与 fetch/pull 两种路径均能进入审查并生成报告。
- ref 缺失或不存在时返回 `REMOTE_REF_NOT_FOUND`。
- 鉴权失败返回 `REMOTE_AUTH_FAILED` 且不重试。
- 网络错误重试次数耗尽后返回 `REMOTE_FETCH_FAILED`。
- 拉取后的本地工作目录不在 `allowedRoots` 内时任务失败。
- ephemeral 模式下审查完成后临时目录被清理。
- 拉取过程不向日志输出 token 或用户名明文。

## 22. 外部静态分析器组合（必做扩展点）

本节为交付必做项。未实现或未通过 §22.4 验收，产品不得视为完成。

### 22.1 目标

在 AI 语义分析之外，内置 clang-tidy、ruff、go vet 作为外部静态分析器，将其结果作为独立 Finding 源与 AI Finding 并列进入同一报告，统一走 PostReviewPolicy 去重与定级，复用现有报告模型与审计轨迹。

### 22.2 约束

- 本阶段内置三个工具：clang-tidy（C/C++）、ruff（Python）、go vet（Go）；Java / JavaScript 本阶段不内置分析器。
- 配置使用 `analyzers[]` 列表，每项可独立开关；兼容旧版单个 `analyzer` 对象。
- Analyzer Finding 与 AI Finding **并列**进同一报告，统一走 PostReviewPolicy；不在策略中偏袒工具结果。
- 每条 Analyzer Finding 分配 `analyzerId`（如 `clang-tidy` / `ruff` / `go-vet`）与 `ruleId`，走与 AI Finding 相同的 PostReviewPolicy 决策步骤。
- 分析器未安装、超时或结果解析失败时，默认**跳过**并记录 `ANALYZER_SKIPPED` warning，审查继续；该项 `onAnalyzerError = fail` 时升级为 `ANALYZER_FAILED` 并使任务 FAILED。
- Analyzer 仅对各自受支持扩展名运行；不匹配语言的文件跳过。
- Analyzer 不修改被审查源码。

### 22.3 配置

见 §14.1 中 `analyzers` 段（及兼容用 `analyzer`）。某项 `enabled = false` 时该项不生效。

### 22.4 验收

- 在含 C++ / Python / Go 文件的临时仓库中分别启用对应分析器，报告同时出现 AI Finding 与 Analyzer Finding。
- 分析器未安装时任务不失败，报告与日志含 `ANALYZER_SKIPPED`。
- `onAnalyzerError = fail` 时分析器失败导致任务 FAILED。
- Analyzer Finding 经 PostReviewPolicy 后与重复 AI Finding 正确去重（PF-009）。
- 被审查源码在 Analyzer 运行前后内容一致。

## 23. 大项目分片与并行 Agent（必做扩展点）

本节为交付必做项。未实现或未通过 §23.4 验收，产品不得视为完成。

### 23.1 目标

当受审查源码超过 §8.5 输入限制时，自动按文件与字符预算分片，多轮调用 Agent，再聚合后统一二次过滤，输出单一报告；同时允许在未超限时通过配置开启并行以提速。

### 23.2 约束

- 触发：
  - **自动分片**（刚需）：超过 §8.5 文件数或字符数限制时，自动分片后多轮 Agent，再聚合；不再因超限直接失败，除非分片数超过上限。
  - **可选并行**：未超限时 `sharding.enabled = true` 可开启分片并行；默认关闭。
- 分片键：**按文件 + 字符预算**打包成片，每片不超过 `sharding.shardChars`（默认 120,000，留规则与协议余量）；不跨文件拆分单文件，单文件超 `shardChars` 时该片单独成片并记录 warning。
- 并发：分片模式下并发上限由 `sharding.maxConcurrency` 配置，默认 1（串行多轮）；并发 > 1 时按提交顺序调度，受全局并发上限约束（§16.5）。
- 聚合：所有片原始 Finding 汇总后**统一跑一次** PostReviewPolicy；片内只做 Schema 校验，不做去重与定级。
- 审计：对外仍是单任务、单报告、单 inputHash；分片清单（每片文件列表、字符数、Agent 调用次序）写入报告审计子节。
- 失败：任一片 Agent 失败 → 整任务 FAILED（与 AC-05“不伪造结论”一致），不静默丢片。
- 上限：最大分片数 `sharding.maxShards`（默认 20），超过则任务 FAILED，错误码 `SHARD_LIMIT_EXCEEDED`。

### 23.3 配置

见 §14.1 中 `sharding` 段。`sharding.enabled = false` 时仅在超限时自动分片，未超限不分片。

### 23.4 验收

- 构造超过 §8.5 字符数限制的源码集，启用自动分片后任务不因超限失败，生成单一报告，报告含分片清单。
- 分片数超过 `maxShards` 时任务 FAILED，错误码 `SHARD_LIMIT_EXCEEDED`。
- 任一片 Agent 失败时整任务 FAILED，不产生部分结果报告。
- 跨片重复 Finding 经聚合后 PostReviewPolicy 正确去重（PF-009）。
- `maxConcurrency = 1` 与 `maxConcurrency > 1` 两种配置下最终报告一致。
- 报告 inputHash 与不分片等价输入一致。

## 24. 产品交付物

仓库交付物至少包含：

实现与验收必须以 `spec/spec.md` 为唯一基线。自动化测试不得依赖真实 Cursor 或真实远程 API；远程 Provider 与定时调度的自动化验收分别使用 Mock Server 与 FakeClock；Git 远程拉取使用本地 bare 仓库；clang-tidy 验收在工具缺失时验证跳过路径，在工具可用时验证 Finding 合并。

交付完成条件：§4.1 核心审查闭环、§19 RemoteLlmReviewProvider、§20 ReviewScheduler、§21 Git 远程仓库拉取、§22 外部静态分析器组合、§23 大项目分片与并行 Agent 均已实现并通过对应验收。