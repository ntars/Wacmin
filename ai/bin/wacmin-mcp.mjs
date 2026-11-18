#!/usr/bin/env node
/**
 * MCP server 的可执行入口。
 *
 * 责任只有一件：把进程的 stdin/stdout/stderr 接到 `src/server.mjs`，
 * 并把退出信号处理好。协议逻辑一概不在这里。
 *
 * ## 为什么单独一个文件
 *
 * `src/server.mjs` 是纯逻辑，被 import 时零副作用 —— 测试直接 import 它，
 * 注入内存里的读写流，不必起子进程。而这个文件是给别人配 MCP 客户端时
 * 填进配置文件的那一行，必须可执行、必须有 shebang。
 *
 * ## 退出方式
 *
 * stdio 传输没有专门的关闭消息。规范给的做法是：客户端关闭 stdin，
 * server 读到 EOF 后自行退出。所以这里等 `closed` 而不是等信号 ——
 * 收到 SIGTERM 时也要先取消在途任务再退，否则会留下跑了十分钟的
 * 构建进程。
 */

import { startMcpServer } from '../src/server.mjs'

const server = startMcpServer()

/** 优雅退出：先在途任务全部取消，再退。 */
const shutdown = () => {
  server.stop()
    .then(() => { process.exit(0) })
    .catch(() => { process.exit(1) })
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

/*
 * 兜底：进程要退时若还有在途任务，一并取消。
 *
 * `beforeExit` 只在事件循环空了才触发，所以它不会阻止正常退出；但能
 * 覆盖「客户端直接关掉管道、SIGTERM 没送到」这类情况。
 */
process.on('beforeExit', () => {
  void server.stop()
})

server.closed.catch((error) => {
  process.stderr.write(`[wacmin-mcp] 致命错误：${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
