import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createConfigServer } from '../scripts/config-ui.mjs'
import { configPath } from '../lib/config.js'
import { dateKey } from '../lib/time.js'
import { Store } from '../lib/store.js'

function tmpHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tmem-ui-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function dataRoot(home) {
  return path.join(home, 'memory', 'temporal')
}

async function start(t, home) {
  const server = createConfigServer({ rawConfig: { dir: home } })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const port = server.address().port
  return { server, port, base: `http://127.0.0.1:${port}` }
}

function save(base, body, headers = {}) {
  return fetch(`${base}/api/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

function rec(over = {}) {
  const at = Date.now()
  return {
    kind: 'decision',
    text: '确定了示例网关就用 8080 端口',
    status: 'active',
    event_start_ms: at,
    event_end_ms: at + 60_000,
    time_precision: 'minute',
    time_basis: 'stated',
    recorded_at: at,
    topics: ['示例网关'],
    entities: [],
    source: { session: 'sess_ui', seq_from: 1, seq_to: 2 },
    namespace: 'default',
    ...over,
  }
}

test('页面与状态接口可用，且带安全头', async (t) => {
  const home = tmpHome(t)
  const { base } = await start(t, home)
  const page = await fetch(`${base}/`)
  assert.equal(page.status, 200)
  assert.match(page.headers.get('content-security-policy'), /default-src 'none'/)
  assert.equal(page.headers.get('x-frame-options'), 'DENY')
  assert.match(await page.text(), /配置台/)

  const health = await fetch(`${base}/api/health`)
  assert.equal(health.status, 200)
  const h = await health.json()
  assert.equal(h.root, dataRoot(home))
  assert.equal(h.records, 0)
  assert.equal(h.writable, true)

  const cfg = await fetch(`${base}/api/config`)
  const data = await cfg.json()
  assert.equal(data.configFile, configPath(dataRoot(home)))
  assert.equal(data.effective.timeZone, 'Asia/Shanghai')
  assert.deepEqual(data.effective.entities, [])
})

test('保存配置只写显式项并即时回读', async (t) => {
  const home = tmpHome(t)
  const { base } = await start(t, home)
  const res = await save(base, {
    timeZone: 'UTC',
    entities: ['示例网关', '示例系统'],
    capture: { maxRecordsPerTurn: 5 },
    inject: { maxTokens: 900 },
  })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.restartRequired, true)
  assert.equal(body.effective.inject.maxTokens, 900)
  assert.equal(body.effective.inject.maxItems, 6)

  const file = JSON.parse(fs.readFileSync(configPath(dataRoot(home)), 'utf8'))
  assert.deepEqual(file, {
    timeZone: 'UTC',
    entities: ['示例网关', '示例系统'],
    capture: { maxRecordsPerTurn: 5 },
    inject: { maxTokens: 900 },
  })
  const cfg = await (await fetch(`${base}/api/config`)).json()
  assert.equal(cfg.effective.timeZone, 'UTC')
  assert.deepEqual(cfg.file.inject, { maxTokens: 900 })
})

test('隐私与成长开关保存到 config.json 并可回读', async (t) => {
  const home = tmpHome(t)
  const { base } = await start(t, home)
  const res = await save(base, { privacy: { enhanced: true }, growth: { enabled: true } })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.effective.privacy.enhanced, true)
  assert.equal(body.effective.growth.enabled, true)
  const file = JSON.parse(fs.readFileSync(configPath(dataRoot(home)), 'utf8'))
  assert.deepEqual(file, { privacy: { enhanced: true }, growth: { enabled: true } })
})

test('非法配置拒绝保存且不覆盖原文件', async (t) => {
  const home = tmpHome(t)
  const { base } = await start(t, home)
  assert.equal((await save(base, { namespace: 'keep' })).status, 200)
  const before = fs.readFileSync(configPath(dataRoot(home)), 'utf8')

  const bad = await save(base, { timeZone: 'Not/AZone', ui: { port: 70000 } })
  assert.equal(bad.status, 400)
  const errors = (await bad.json()).errors
  assert.ok(errors.some((e) => /timeZone/.test(e)))
  assert.ok(errors.some((e) => /ui\.port/.test(e)))
  assert.equal(fs.readFileSync(configPath(dataRoot(home)), 'utf8'), before)

  const dir = await save(base, { dir: 'C:\\elsewhere' })
  assert.equal(dir.status, 400)
})

test('拒绝跨站 Origin、跨站 Fetch 元数据与外来 Host', async (t) => {
  const home = tmpHome(t)
  const { base, port } = await start(t, home)
  const origin = await save(base, { namespace: 'x' }, { Origin: 'http://evil.example' })
  assert.equal(origin.status, 403)

  const site = await save(base, { namespace: 'x' }, { 'Sec-Fetch-Site': 'cross-site' })
  assert.equal(site.status, 403)

  const status = await new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/api/config',
      headers: { Host: 'evil.example' },
    }, (res) => {
      res.resume()
      resolve(res.statusCode)
    })
    req.on('error', reject)
    req.end()
  })
  assert.equal(status, 403)
  assert.equal(fs.existsSync(configPath(dataRoot(home))), false)
})

test('请求体超限返回 413', async (t) => {
  const home = tmpHome(t)
  const { base } = await start(t, home)
  const huge = JSON.stringify({ namespace: 'a'.repeat(70_000) })
  const res = await save(base, huge)
  assert.equal(res.status, 413)
  assert.equal(fs.existsSync(configPath(dataRoot(home))), false)
})

test('非 JSON 内容类型与非法 JSON 被拒绝', async (t) => {
  const home = tmpHome(t)
  const { base } = await start(t, home)
  const wrong = await fetch(`${base}/api/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'text/plain' },
    body: '{"namespace":"x"}',
  })
  assert.equal(wrong.status, 415)
  const broken = await save(base, '{oops')
  assert.equal(broken.status, 400)
})

test('记忆搜索只读、支持日期与状态，非法日期报错', async (t) => {
  const home = tmpHome(t)
  new Store(dataRoot(home)).append([rec()])
  const { base } = await start(t, home)
  const today = dateKey(Date.now(), 'Asia/Shanghai')

  const found = await (await fetch(
    `${base}/api/memories?query=${encodeURIComponent('示例网关')}&date_from=${today}&date_to=${today}`,
  )).json()
  assert.equal(found.status, 'ok')
  assert.equal(found.total, 1)
  assert.match(found.items[0].text, /8080/)
  assert.equal(found.items[0].source.session, 'sess_ui')

  const badDate = await fetch(`${base}/api/memories?date_from=2026-02-31`)
  assert.equal(badDate.status, 400)
  const badStatus = await fetch(`${base}/api/memories?status=deleted`)
  assert.equal(badStatus.status, 400)

  const write = await fetch(`${base}/api/memories`, { method: 'POST' })
  assert.equal(write.status, 405)
  assert.equal(new Store(dataRoot(home)).readAll().length, 1)
})

test('每个配置项都有悬停说明，保留天数带风险标注', async (t) => {
  const home = tmpHome(t)
  const { base } = await start(t, home)
  const html = await (await fetch(`${base}/`)).text()
  assert.equal((html.match(/class="help"/g) || []).length, 18)
  assert.match(html, /\.help:hover::after/)
  assert.match(html, /\.help:focus-visible::after/)
  assert.match(html, /data-tip="记忆块的长度上限[^"]*Token[^"]*"/)
  assert.match(html, /aria-label="说明：/)
  assert.doesNotMatch(html, /name="journal\./)
  assert.match(html, /name="privacy\.enhanced"/)
  assert.match(html, /name="growth\.enabled"/)
  assert.match(html, /L4 成长开关默认关闭/)
  assert.match(html, /class="risk">风险：调小会在当天日记写好之后清理旧记录/)
  assert.match(html, /function renderSources/)
  assert.match(html, /\.src-patch/)
})

test('配置接口逐字段返回来源，宿主覆盖项可见', async (t) => {
  const home = tmpHome(t)
  const server = createConfigServer({ rawConfig: { dir: home, namespace: 'patched' } })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const port = server.address().port

  const data = await (await fetch(`http://127.0.0.1:${port}/api/config`)).json()
  assert.equal(data.fields.namespace.effectiveValue, 'patched')
  assert.equal(data.fields.namespace.source, 'patch')
  assert.equal(data.fields.timeZone.source, 'default')
  assert.ok(data.hostOverrides.includes('namespace'))
  assert.equal(data.rootSource, 'dir')
})

test('未知路径与静态文件外访问返回 404', async (t) => {
  const home = tmpHome(t)
  const { base } = await start(t, home)
  const res = await fetch(`${base}/scripts/config-ui.mjs`)
  assert.equal(res.status, 404)
})
