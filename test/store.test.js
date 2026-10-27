import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Store, applySupersedes, recordId } from '../lib/store.js'
import { monthFile } from '../lib/paths.js'

function tmpRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tmem-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

const AT = Date.UTC(2026, 9, 25, 2, 0, 0)

function rec(over = {}) {
  return {
    kind: 'event',
    text: '部署示例网关到 8080',
    status: 'active',
    event_start_ms: AT,
    event_end_ms: AT,
    recorded_at: AT,
    source: { session: 'sess_a', seq_from: 1, seq_to: 2 },
    ...over,
  }
}

test('append 去重、跳过 secret、按月分片', (t) => {
  const root = tmpRoot(t)
  const store = new Store(root)
  const first = rec()
  first.id = recordId(first)
  const written = store.append([
    first,
    { ...first }, // 同 id：重复写
    rec({ text: '密码是 hunter2', sensitivity: 'secret', source: { session: 'sess_a', seq_from: 3 } }),
    rec({ text: '新记录', source: { session: 'sess_a', seq_from: 4 } }),
  ])
  assert.equal(written, 2)
  assert.ok(fs.existsSync(monthFile(root, AT)))
  const ids = store.readAll().map((r) => r.id)
  assert.equal(ids.length, 2)
  assert.ok(ids.includes(first.id))
})

test('recordId 与空白无关、跨字段稳定', () => {
  const a = rec({ text: '甲  乙' })
  const b = rec({ text: '甲 乙' })
  assert.equal(recordId(a), recordId(b))
  assert.notEqual(recordId(a), recordId(rec({ text: '甲 乙', kind: 'decision' })))
})

test('supersedes 生效：target 变 superseded 并补 valid_to', (t) => {
  const root = tmpRoot(t)
  const store = new Store(root)
  const old = rec({ id: 'm_old', text: '端口是 8080' })
  const fix = rec({ id: 'm_new', kind: 'correction', text: '端口是 8081', supersedes: ['m_old'] })
  store.append([old, fix])
  const [a, b] = store.readAll().sort((x, y) => x.id.localeCompare(y.id))
  const target = a.id === 'm_old' ? a : b
  assert.equal(target.status, 'superseded')
  assert.equal(target.superseded_by, 'm_new')
  assert.equal(target.valid_to, AT)
})

test('applySupersedes 对缺失 target 静默忽略', () => {
  const list = [rec({ id: 'm_x', supersedes: ['m_missing'] })]
  assert.doesNotThrow(() => applySupersedes(list))
  assert.equal(list[0].status, 'active')
})

test('delete 写墓碑并从 readAll 消失', (t) => {
  const root = tmpRoot(t)
  const store = new Store(root)
  const a = rec({ id: 'm_del' })
  store.append([a])
  assert.equal(store.delete('m_del'), true)
  assert.equal(store.readAll().length, 0)
  const raw = fs.readFileSync(monthFile(root, AT), 'utf8')
  assert.match(raw, /"_type":"tombstone"/)
  assert.equal(store.delete('m_del'), false)
})

test('坏行被跳过并计入 health.malformed', (t) => {
  const root = tmpRoot(t)
  const store = new Store(root)
  store.append([rec({ id: 'm_ok' })])
  fs.appendFileSync(monthFile(root, AT), 'not-json\n')
  const health = store.health()
  assert.equal(health.records, 1)
  assert.equal(health.malformed, 1)
  assert.equal(health.status, 'ok')
  assert.equal(health.last_recorded_at, AT)
})

test('cursor 读写幂等', (t) => {
  const root = tmpRoot(t)
  const store = new Store(root)
  assert.equal(store.getCursor('sess_a'), undefined)
  store.setCursor('sess_a', 42)
  store.setCursor('sess_b', 7)
  assert.equal(store.getCursor('sess_a'), 42)
  assert.equal(store.getCursor('sess_b'), 7)
})

test('空 append 不建目录', (t) => {
  const root = tmpRoot(t)
  const store = new Store(root)
  assert.equal(store.append([]), 0)
  assert.equal(fs.existsSync(path.join(root, 'events')), false)
})

test('跨月文件都参与 readAll', (t) => {
  const root = tmpRoot(t)
  const store = new Store(root)
  store.append([rec({ id: 'm_sep', recorded_at: Date.UTC(2026, 8, 30) })])
  store.append([rec({ id: 'm_oct', recorded_at: Date.UTC(2026, 9, 1) })])
  assert.equal(store.readAll().length, 2)
  assert.equal(store.health().months.length, 2)
})

test('append 是脱敏写入边界：正文与 quote 都不落凭据', (t) => {
  const root = tmpRoot(t)
  const store = new Store(root)
  store.append([rec({
    id: 'm_secretish',
    text: '我的 token = ghp_abcdefghijklmnop123456',
    source: { session: 's', seq_from: 1, quote: '我的 token = ghp_abcdefghijklmnop123456' },
  })])
  const stored = store.readAll()[0]
  assert.doesNotMatch(stored.text, /ghp_/)
  assert.doesNotMatch(stored.source.quote, /ghp_/)
  assert.equal(stored.sensitivity, 'private')
})

test('supersede 持久化 valid_from/valid_to', (t) => {
  const root = tmpRoot(t)
  const store = new Store(root)
  store.append([rec({ id: 'm_old', event_start_ms: AT - 1000 })])
  assert.equal(store.supersede('m_old', 'm_new', AT), true)
  const target = store.readAll().find((r) => r.id === 'm_old')
  assert.equal(target.status, 'superseded')
  assert.equal(target.superseded_by, 'm_new')
  assert.equal(target.valid_from, AT - 1000)
  assert.equal(target.valid_to, AT)
})

test('pending 快照写入后可取回并清除', (t) => {
  const root = tmpRoot(t)
  const store = new Store(root)
  store.savePending('sess_a', { turn: 2, userMessages: [] })
  assert.equal(store.takePending('sess_a').turn, 2)
  assert.equal(store.takePending('sess_a'), null)
})

test('prune 只清理已有 L2 覆盖的超期记录', (t) => {
  const root = tmpRoot(t)
  const store = new Store(root)
  const now = AT + 200 * 86_400_000
  store.append([
    rec({ id: 'm_cov', event_start_ms: AT, recorded_at: AT }),
    rec({ id: 'm_unc', event_start_ms: AT - 86_400_000, recorded_at: AT - 86_400_000 }),
  ])
  const res = store.prune(90, {
    nowMs: now,
    tz: 'UTC',
    hasJournal: (day) => day === '2026-10-25',
  })
  assert.equal(res.removed, 1)
  assert.equal(res.retained_uncovered, 1)
  assert.equal(res.retained[0].id, 'm_unc')
  assert.deepEqual(store.readAll().map((r) => r.id), ['m_unc'])
  const blocked = store.prune(90, { nowMs: now, tz: 'UTC', hasJournal: () => false })
  assert.equal(blocked.removed, 0)
})
