#!/usr/bin/env node
/**
 * Standalone configuration console: zero dependencies, loopback only, writes
 * only config.json.
 *
 *   node scripts/config-ui.mjs [--root <data dir>] [--home <DSH_HOME>] [--port 18790] [--host 127.0.0.1]
 *
 * Prefer Settings → Memory while DSH is running; this page is for times when
 * DSH is stopped, the host has no browser UI, or the machine is headless.
 * `--home` only derives `$DSH_HOME/memory/temporal`; `--root` names the final
 * data directory directly. When both are given, `--root` wins.
 */
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createConfigHandler } from '../lib/config-ui.js'
import { resolveConfig } from '../lib/config.js'

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/** Build the server with loopback guards and the bundled page enabled. */
export function createConfigServer(options = {}) {
  const handler = createConfigHandler({
    rawConfig: options.rawConfig,
    localOnly: true,
    servePage: true,
  })
  return http.createServer((req, res) => {
    handler(req, res)
  })
}

/** Minimal `--flag value` parser; missing or next-flag values fall back. */
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  if (i < 0) return fallback
  const value = process.argv[i + 1]
  return value && !value.startsWith('--') ? value : fallback
}

/** Promisified `listen`, detaching both listeners so a retry starts clean. */
function listenOnce(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.removeListener('listening', onListening)
      reject(err)
    }
    const onListening = () => {
      server.removeListener('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })
}

/**
 * Try the preferred port, then the next `attempts` ports on EADDRINUSE.
 * Any other listen error propagates. Passing 0 attempts makes an explicit
 * `--port` strict: the user asked for that port, so fail instead of drifting.
 */
export async function listenWithFallback(server, port, host, attempts) {
  let lastError = null
  for (let i = 0; i <= attempts; i++) {
    const candidate = port + i
    if (candidate > 65535) break
    try {
      await listenOnce(server, candidate, host)
      return candidate
    } catch (err) {
      lastError = err
      if (err.code !== 'EADDRINUSE') throw err
    }
  }
  throw lastError
}

/**
 * Validate CLI input, resolve the data root, and serve until Ctrl+C.
 * Config errors are printed but do not prevent serving — the console is where
 * the user fixes them.
 */
async function main() {
  const rootArg = arg('root', null)
  const homeArg = arg('home', null)
  const hasPortArg = process.argv.includes('--port')
  if (rootArg && homeArg) {
    console.warn('同时给出 --root 与 --home：以 --root 为准。')
  }
  const home = homeArg || process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  if (rootArg && !path.isAbsolute(rootArg)) {
    console.error(`--root 必须是绝对路径，收到：${rootArg}`)
    process.exitCode = 1
    return
  }
  const rawConfig = rootArg ? { root: rootArg } : { dir: home }
  const resolved = resolveConfig(rawConfig)
  const host = arg('host', resolved.ui.host)
  const port = Number.parseInt(arg('port', String(resolved.ui.port)), 10)
  if (!LOOPBACK.has(host)) {
    console.error(`只允许监听本机地址（127.0.0.1 / localhost / ::1），收到：${host}`)
    process.exitCode = 1
    return
  }
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    console.error('端口必须是 1024–65535 的整数')
    process.exitCode = 1
    return
  }
  for (const message of resolved.configErrors) console.error(`配置错误：${message}`)
  for (const message of resolved.configWarnings) console.error(`配置提示：${message}`)

  const server = createConfigServer({ rawConfig })
  let actualPort
  try {
    actualPort = await listenWithFallback(server, port, host, hasPortArg ? 0 : 20)
  } catch (err) {
    console.error(err.code === 'EADDRINUSE'
      ? (hasPortArg ? `端口 ${port} 已被占用；--port 显式指定，不再顺延。` : `端口 ${port} 及其后 20 个端口均被占用。`)
      : `启动失败：${err.message}`)
    process.exitCode = 1
    return
  }
  server.on('error', (err) => {
    console.error(`配置台运行错误：${err.message}`)
    process.exitCode = 1
  })
  const shown = host.includes(':') ? `[${host}]` : host
  if (actualPort !== port) console.warn(`端口 ${port} 已被占用，已顺延到 ${actualPort}。`)
  console.log(`DSH 时间记忆配置台：http://${shown}:${actualPort}/`)
  console.log(`数据目录（${resolved.rootSource}）：${resolved.root}`)
  console.log(`配置文件：${resolved.configFile}`)
  console.log('DSH 运行中请优先使用 设置 → 记忆；本页面改动需重启 DSH 生效。Ctrl+C 退出。')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`启动失败：${err.message}`)
    process.exitCode = 1
  })
}
