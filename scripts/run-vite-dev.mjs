#!/usr/bin/env node
/**
 * 从环境中移除 ELECTRON_RUN_AS_NODE，否则 Electron 会像 Node 一样解析 `electron` 模块，
 * 主进程 `import from 'electron'` / `require('electron')` 会得到 npm 占位包（路径字符串），
 * 应用无法启动（见 electron 文档与 issue #8200 类问题）。
 */
import { spawn } from 'node:child_process'

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const child = spawn('vite', process.argv.slice(2), {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env,
})

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  process.exit(code ?? 1)
})
