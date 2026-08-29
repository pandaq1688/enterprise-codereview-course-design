# 二次过滤政策（人工说明）

本文档复述 PF-001…PF-010，供人阅读与验收参考。程序化二次过滤由 PostReviewPolicy 实现；RuleResolver **不会**将本文件加载为 Agent 审查规则。

## PF-001 字段与枚举归一化

- 风险转为大写。
- 非法风险改为 LOW。
- 非法类别改为 OTHER。
- 路径转换为项目相对正斜杠路径。
- 非整数行号转为 null。

## PF-002 审查范围

不属于本次选中文件的 Finding 标记为 EXEMPTED，原因是 OUT_OF_SCOPE_FILE。

## PF-003 定位证据

- 文件不存在或行号越界时，Finding 标记为 EXEMPTED。
- Git 模式下，非崩溃类中高风险 Finding 未定位到新增或修改行时降为 LOW。
- 缺少精确位置的问题不能保持 MEDIUM、HIGH 或 CRITICAL。

## PF-004 推测性结论

使用“可能、也许、推测、假设、无法确认”等措辞，且没有同时给出明确代码证据的问题标记为 EXEMPTED。

明确的语法、未初始化、内存越界等问题不能仅因中文描述包含条件词而被豁免，必须结合类别、位置和证据判断。

## PF-005 未知接口与兼容性

基于未知第三方接口行为、未知异步语义、未提供的旧版本或升级路径作出的结论标记为 EXEMPTED。

## PF-006 设计、风格与性能

- MAINTAINABILITY 默认最高为 LOW。
- PERFORMANCE 没有复杂度、循环、调用次数或明确热点证据时最高为 LOW。
- OTHER 类别不能保持中高风险。

## PF-007 严重风险修正

具备准确位置和明确证据的以下问题，最终风险不低于 HIGH：

- 未初始化使用。
- 明确空指针解引用。
- 越界访问。
- use-after-free 或重复释放。
- 确定的数据竞争或死锁。
- 可执行的注入路径。
- 明确导致进程退出或服务不可用的错误。

CRITICAL 必须同时满足灾难性影响类别、准确位置和直接证据；否则最高修正为 HIGH。

## PF-008 需求不符合

REQUIREMENT_MISMATCH 必须同时提供 requirement_reference 和代码位置。缺少任一项时降为 LOW；明确违反验收条件且后果严重时可以保持 MEDIUM 或 HIGH。

## PF-009 重复问题

根据规范化文件路径、重叠行号、类别和标题指纹识别重复 Finding。重复项标记为 MERGED，主项保留最高合法最终风险和全部证据。

## PF-010 最终风险重算

忽略 EXEMPTED 和 MERGED 从项。overallRisk 等于其余 Finding 的最高 finalRisk；没有有效 Finding 时为 LOW。
