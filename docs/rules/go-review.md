# Go 审查规则

审查 Go 源码时，重点检查以下通用高价值问题：

- 错误处理：忽略 `err`、错误包装丢失、哨兵比较不当
- 并发：goroutine 泄漏、未关闭的 channel、data race、错误的 `WaitGroup` 用法
- 资源生命周期：未关闭的 `Body`/`Conn`/文件、defer 在循环中的陷阱
- 空指针与 nil interface 陷阱、slice/map 并发写
- 上下文：未传递 `context.Context`、忽略 cancel、超时缺失
- 输入校验与路径安全、命令执行参数未分隔
- 整数溢出与切片越界、错误的互斥粒度

仅基于本次输入中的证据报告问题，不引入未在输入中出现的内部约定。
