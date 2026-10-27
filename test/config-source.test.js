import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { apply as applyIndex } from '../index.js'
import { apply as applyTools } from '../tools.js'
import { resolveConfig } from '../lib/config.js'
import { runtime } from '../lib/runtime.js'
import { createConfigServer, listenWithFallback } from '../scripts/config-ui.mjs'

const TZ = 'Asia/Shanghai'

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tmem-v12-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function resetRuntime(t) {
  const initial = { ...runtime }
  t.after(() => Object.assign(runtime, initial))
}

function makeCtx(extra = {}) {
  const tools = new Map()
  return {
    tools: { register: (definition) => tools.set(definition.name, definition) },
    map: tools,
    logger: () => ({ info() {}, warn() {} }),
    ...extra,
  }
}

function writeConfig(root, value) {
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(value))
}

test('配置来源逐叶标注：宿主覆盖 > config.json > 默认，非法覆盖不算来源', (t) => {
  const root = path.join(tmpDir(t), 'data')
  writeConfig(root, {
    timeZone: 'UTC',
    retentionDays: 120,
    inject: { maxItems: 9, maxTokens: 777 },
  })

  const resolved = resolveConfig({
    root,
    timeZone: 'Asia/Tokyo',
    retentionDays: 30,
    inject: { maxTokens: 500 },
  })

  assert.equal(resolved.root, root)
  assert.equal(resolved.rootSource, 'root')
  assert.equal(resolved.timeZone, 'Asia/Tokyo')
  assert.equal(resolved.configSources.timeZone, 'patch')
  assert.equal(resolved.inject.maxTokens, 500)
  assert.equal(resolved.configSources['inject.maxTokens'], 'patch')
  assert.equal(resolved.inject.maxItems, 9)
  assert.equal(resolved.configSources['inject.maxItems'], 'config.json')
  assert.equal(resolved.inject.coldStartDays, 3)
  assert.equal(resolved.configSources['inject.coldStartDays'], 'default')
  assert.equal(resolved.retentionDays, 30)
  assert.equal(resolved.configSources.retentionDays, 'patch')
  assert.deepEqual(resolved.entities, [])
  assert.equal(resolved.configSources.entities, 'default')
})

test('非法 patch 值回退后不冒领 patch 来源', (t) => {
  const root = path.join(tmpDir(t), 'data')
  const resolved = resolveConfig({ root, retentionDays: 'forever' })
  assert.equal(resolved.retentionDays, 365)
  assert.equal(resolved.configSources.retentionDays, 'default')
  assert.ok(resolved.configErrors.some((message) => /retentionDays/.test(message)))
})

test('--root 优先于 --home，非法 root 回退并报错', (t) => {
  const home = tmpDir(t)
  const dataRoot = path.join(home, 'memory', 'temporal')

  const direct = resolveConfig({ root: dataRoot, dir: home })
  assert.equal(direct.root, dataRoot)
  assert.equal(direct.rootSource, 'root')

  const fallback = resolveConfig({ root: 'relative/data', dir: home })
  assert.equal(fallback.root, path.join(home, 'memory', 'temporal'))
  assert.equal(fallback.rootSource, 'dir')
  assert.ok(fallback.configErrors.some((message) => /root 必须是绝对路径/.test(message)))
})

test('memory_health 默认轻量、deep 才扫明细，并报告 root 分叉', async (t) => {
  resetRuntime(t)
  const root = tmpDir(t)
  const ctx = makeCtx()
  applyTools(ctx, { dir: root, timeZone: TZ })
  const health = ctx.map.get('memory_health')

  const light = await health.execute()
  assert.equal(light.status, 'ok')
  assert.equal(typeof light.timings.store, 'number')
  assert.equal(typeof light.timings.total, 'number')
  assert.ok(light.timings.total >= light.timings.store)
  assert.equal(light.layers.L2.entries, 0)
  assert.equal(light.capture, undefined)
  assert.equal(light.compile, undefined)
  assert.equal(light.ui, undefined)
  assert.equal(light.digest, undefined)
  assert.equal(light.journal.entries, 0)
  assert.equal(light.journal.authored_by, 'agent')
  assert.match(light.retention.notice, /L1 默认保留 365 天/)

  const deep = await health.execute({ deep: true })
  assert.equal(deep.capture.maxRecordsPerTurn, 8)
  assert.equal(deep.compile.minRecords, 2)
  assert.equal(deep.ui.port, 8790)
  assert.deepEqual(deep.digest.by_kind, {})
  assert.equal(typeof deep.journal.newest_at, 'object')
  assert.equal(typeof deep.malformed, 'number')
  assert.ok(Array.isArray(deep.months))

  runtime.hostRoot = path.join(root, 'another-root')
  const mismatch = await health.execute()
  assert.ok(mismatch.configErrors.some((message) => /不一致/.test(message)))
})

test('宿主 /memory-ui 前缀路由复用配置处理器，内嵌工具共享同一 root', async (t) => {
  resetRuntime(t)
  const home = tmpDir(t)
  const dataRoot = path.join(home, 'thread-root')
  const tools = new Map()
  const routes = []
  const embedded = []
  const ctx = {
    map: tools,
    on: () => {},
    logger: () => ({ info() {}, warn() {} }),
    tools: { register: (definition) => tools.set(definition.name, definition) },
    plugin: (plugin, options) => {
      embedded.push({ plugin, options })
      plugin.apply(ctx, options)
    },
    inject: (deps, callback) => {
      callback({
        effect: (fn) => fn(),
        webServer: { register: (route) => { routes.push(route); return () => {} } },
      })
    },
  }

  applyIndex(ctx, { root: dataRoot, timeZone: TZ, namespace: 'route' })

  assert.equal(routes.length, 1)
  assert.equal(routes[0].kind, 'prefix')
  assert.equal(routes[0].path, '/memory-ui')
  assert.ok(tools.has('memory_health'))
  assert.ok(tools.has('memory_save'))
  assert.equal(embedded.length, 1)
  assert.equal(embedded[0].options.resolved.root, dataRoot)
  assert.equal(embedded[0].options.resolved.namespace, 'route')

  const standalone = makeCtx()
  applyTools(standalone, { dir: home, timeZone: TZ })
  assert.equal(standalone.map.size, 0)

  const server = http.createServer((req, res) => routes[0].handler(req, res))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}`

  const config = await (await fetch(`${base}/memory-ui/api/config`)).json()
  assert.equal(config.root, dataRoot)
  assert.equal(config.rootSource, 'root')
  assert.equal(config.effective.namespace, 'route')
  assert.equal(config.fields.namespace.source, 'patch')
  assert.equal(config.fields.retentionDays.source, 'default')
  assert.ok(config.hostOverrides.includes('namespace'))

  const health = await (await fetch(`${base}/memory-ui/api/health`)).json()
  assert.equal(health.root, dataRoot)
  assert.equal(health.firstRun, true)
  assert.match(health.retentionNotice, /365 天/)

  const saved = await fetch(`${base}/memory-ui/api/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ capture: { maxRecordsPerTurn: 4 } }),
  })
  assert.equal(saved.status, 200)
  const body = await saved.json()
  assert.equal(body.effective.capture.maxRecordsPerTurn, 4)
  assert.equal(body.restartRequired, true)
  assert.ok(fs.existsSync(path.join(dataRoot, 'config.json')))

  const page = await fetch(`${base}/memory-ui/`)
  assert.equal(page.status, 404)
})

test('独立配置台端口被占用时顺延，显式端口不降级', async (t) => {
  const home = tmpDir(t)
  const occupied = http.createServer((req, res) => res.end('busy'))
  await new Promise((resolve) => occupied.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => occupied.close(resolve)))
  const port = occupied.address().port

  const fallback = createConfigServer({ rawConfig: { dir: home } })
  const actual = await listenWithFallback(fallback, port, '127.0.0.1', 20)
  t.after(() => new Promise((resolve) => fallback.close(resolve)))
  assert.equal(actual, port + 1)

  const strict = createConfigServer({ rawConfig: { dir: home } })
  await assert.rejects(
    () => listenWithFallback(strict, port, '127.0.0.1', 0),
    (err) => err.code === 'EADDRINUSE',
  )
})
