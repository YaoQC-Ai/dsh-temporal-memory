/**
 * L4 画像与月度成长：四条硬约束各一个用例。
 *
 *   1. 开关关闭 → 一个文件都不写；
 *   2. 证据不足 → 保持原状；
 *   3. 生成成功 → 版本、diff、证据、索引齐备；
 *   4. 人工改过 → 不再自动覆盖；
 * 外加一条最容易漏的：画像必须真的进了 pre-step 的消息里。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { apply } from '../index.js'
import { PROFILE_SOURCE_KIND, isMemoryMessage } from '../lib/inject.js'
import {
  MIN_RECORDS,
  formatProfileBlock,
  growMonthly,
  growthStatus,
  historyDiffPath,
  historyPath,
  lineDiff,
  previousMonth,
  profileIndexPath,
  readPersonality,
  renderProfileIndex,
} from '../lib/profile.js'
import { runtime } from '../lib/runtime.js'
import { zonedTimeToUtc } from '../lib/time.js'

const TZ = 'Asia/Shanghai'

function tmpRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tmem-l4-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return path.join(dir, 'memory', 'temporal')
}

function rec(month, day, over = {}) {
  const at = zonedTimeToUtc(2026, month, day, 10, 0, 0, TZ)
  return {
    kind: 'decision',
    text: '确定了示例网关就用 8080 端口，先不动老网关',
    status: 'active',
    event_start_ms: at,
    event_end_ms: at + 60_000,
    recorded_at: at,
    topics: ['示例网关'],
    entities: ['示例网关'],
    namespace: 'default',
    ...over,
  }
}

function septRecords(count = MIN_RECORDS + 4) {
  return Array.from({ length: count }, (_, i) => {
    const day = 3 + (i % 20)
    if (i % 4 === 1) return rec(9, day, { kind: 'preference', text: '回答尽量短一点，先给结论' })
    if (i % 4 === 2) return rec(9, day, { kind: 'correction', text: '不是 8080，是 8081' })
    if (i % 4 === 3) return rec(9, day, { kind: 'plan', text: '下周把旧网关下线' })
    return rec(9, day)
  })
}

test('previousMonth 按本地时区取上一个月', () => {
  assert.equal(previousMonth(zonedTimeToUtc(2026, 10, 26, 9, 0, 0, TZ), TZ), '2026-09')
  assert.equal(previousMonth(zonedTimeToUtc(2026, 1, 2, 9, 0, 0, TZ), TZ), '2025-12')
})

test('开关关闭时一个文件都不写', (t) => {
  const root = tmpRoot(t)
  const result = growMonthly({ root, records: septRecords(), tz: TZ, month: '2026-09', enabled: false })
  assert.equal(result.status, 'disabled')
  assert.equal(fs.existsSync(path.join(root, 'profile')), false)
})

test('证据不足时保持原状，只在状态里留 pending', (t) => {
  const root = tmpRoot(t)
  const result = growMonthly({
    root,
    records: septRecords(MIN_RECORDS - 1),
    tz: TZ,
    month: '2026-09',
    enabled: true,
  })
  assert.equal(result.status, 'insufficient_evidence')
  assert.equal(readPersonality(root).available, false)
  const status = growthStatus(root, { enabled: true, tz: TZ })
  assert.equal(status.pending_month, '2026-09')
  assert.equal(status.last_run.status, 'insufficient_evidence')
})

test('生成画像：月份版本、diff、证据、索引齐备', (t) => {
  const root = tmpRoot(t)
  const result = growMonthly({
    root,
    records: septRecords(),
    journals: [
      { key: '2026-09-03', status: 'ok', summary: '定了 8080 端口' },
      { key: '2026-09-04', status: 'ok', summary: '调整了导出脚本' },
      { key: '2026-08-31', status: 'ok', summary: '上个月的事' },
    ],
    concepts: [{ slug: 'income-gateway' }, { slug: 'exam-system' }],
    tz: TZ,
    month: '2026-09',
    enabled: true,
  })
  assert.equal(result.status, 'ok')
  assert.equal(result.month, '2026-09')

  const current = readPersonality(root)
  assert.equal(current.available, true)
  assert.equal(current.month, '2026-09')
  assert.equal(current.humanEdited, false)
  assert.match(current.text, /月份：2026-09/)
  assert.match(current.text, /## 表达风格/)
  assert.match(current.text, /## 提醒方式/)
  assert.match(current.text, /旧结论 → 新结论/)
  // 关注面只来自实体计数
  assert.match(current.text, /示例网关（\d+ 次）/)

  assert.ok(fs.existsSync(historyPath(root, '2026-09')))
  const diff = fs.readFileSync(historyDiffPath(root, '2026-09'), 'utf8')
  assert.match(diff, /^\+\+\+ 2026-09/m)
  assert.match(diff, /^\+# Agent 软画像/m)
  // 8 月的日记不能被算进 9 月的证据
  assert.doesNotMatch(diff, /上个月的事/)

  const evidence = fs.readFileSync(path.join(root, 'profile', 'evidence', '2026-09.jsonl'), 'utf8')
  const lines = evidence.trim().split('\n')
  assert.ok(lines.length >= 3)
  assert.ok(lines.some((line) => JSON.parse(line).layer === 'L2'))
  assert.ok(lines.some((line) => JSON.parse(line).layer === 'L3'))

  assert.match(fs.readFileSync(profileIndexPath(root), 'utf8'), /\| 2026-09 \| ok \|/)

  // 用户画像只摘用户明说过的偏好原文
  const user = fs.readFileSync(path.join(root, 'profile', 'user', 'profile.md'), 'utf8')
  assert.match(user, /回答尽量短一点/)

  // 同一月份再跑一次不重复生成
  const again = growMonthly({ root, records: septRecords(), tz: TZ, month: '2026-09', enabled: true })
  assert.equal(again.status, 'up_to_date')
})

test('人工编辑画像后不再自动覆盖', (t) => {
  const root = tmpRoot(t)
  growMonthly({ root, records: septRecords(), tz: TZ, month: '2026-09', enabled: true })
  const file = path.join(root, 'profile', 'agent', 'personality.md')
  const handEdited = '# Agent 软画像（L4）\n\n> 月份：2026-09\n\n## 表达风格\n\n- 我自己定的一条\n'
  fs.writeFileSync(file, handEdited)

  const result = growMonthly({
    root,
    records: [...septRecords(), ...Array.from({ length: 6 }, (_, i) => rec(10, 3 + i))],
    tz: TZ,
    month: '2026-10',
    enabled: true,
  })
  assert.equal(result.status, 'human_edited')
  assert.equal(fs.readFileSync(file, 'utf8'), handEdited)
  assert.equal(growthStatus(root, { enabled: true, tz: TZ }).human_edited, true)
  // 历史版本不应该被写出来顶掉人工版本
  assert.equal(fs.existsSync(historyPath(root, '2026-10')), false)
})

test('lineDiff 标出增删行', () => {
  const diff = lineDiff('a\nb\nc', 'a\nB\nc')
  assert.equal(diff, ' a\n-b\n+B\n c')
})

test('formatProfileBlock 去掉机器表头，只留画像正文', (t) => {
  const root = tmpRoot(t)
  growMonthly({ root, records: septRecords(), tz: TZ, month: '2026-09', enabled: true })
  const block = formatProfileBlock(readPersonality(root))
  assert.match(block, /^## Agent 软画像（L4，2026-09）/)
  assert.doesNotMatch(block, /月份：2026-09/)
  assert.doesNotMatch(block, /^# Agent 软画像/m)
})

test('renderProfileIndex 区分归档与人工接管', () => {
  const text = renderProfileIndex({
    state: { month: '2026-10', status: 'ok', evidence: 12, generated_at: Date.UTC(2026, 9, 1) },
    humanEdited: false,
    months: ['2026-10', '2026-09'],
  })
  assert.match(text, /\| 2026-10 \| ok \| 12 \|/)
  assert.match(text, /\| 2026-09 \| archived \|/)
})

// ---------------------------------------------------------------- 注入链路

function fakeCtx() {
  const handlers = new Map()
  return {
    handlers,
    ctx: {
      logger: () => ({ info() {}, warn() {}, debug() {}, error() {} }),
      get: () => undefined,
      on(event, handler) {
        handlers.set(event, handler)
      },
      plugin() {},
      inject() {},
      effect() {},
    },
  }
}

test('画像真的进了 pre-step 的消息，且同会话同版本只注一次', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tmem-l4-inject-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const root = path.join(home, 'memory', 'temporal')
  growMonthly({ root, records: septRecords(), tz: TZ, month: '2026-09', enabled: true })

  const { ctx, handlers } = fakeCtx()
  apply(ctx, { dir: home, growth: { enabled: true } })
  const preStep = handlers.get('agent/pre-step')
  assert.equal(typeof preStep, 'function')

  const session = { id: 'sess_l4' }
  const decision = {
    messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '接着改配置' }] }],
  }
  const out = await preStep({ agent: { session }, step: 1 }, async () => decision)
  assert.equal(out.messages.length, 2)
  const injected = out.messages[1]
  assert.equal(injected.source.kind, PROFILE_SOURCE_KIND)
  assert.match(injected.content[0].text, /Agent 软画像（L4，2026-09）/)
  // 画像块不能冒充召回块，否则会把后续召回注入一起挡住
  assert.equal(isMemoryMessage(injected), false)

  assert.equal(runtime.growthApplied.applied, true)
  assert.equal(runtime.growthApplied.month, '2026-09')
  assert.equal(runtime.growthApplied.session, 'sess_l4')

  const again = await preStep({ agent: { session }, step: 1 }, async () => decision)
  assert.equal(again.messages.length, 1)
})

test('开关关闭时不注入画像', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tmem-l4-off-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const root = path.join(home, 'memory', 'temporal')
  growMonthly({ root, records: septRecords(), tz: TZ, month: '2026-09', enabled: true })

  const { ctx, handlers } = fakeCtx()
  apply(ctx, { dir: home, growth: { enabled: false } })
  const session = { id: 'sess_l4_off' }
  const decision = {
    messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '接着改配置' }] }],
  }
  const out = await handlers.get('agent/pre-step')({ agent: { session }, step: 1 }, async () => decision)
  assert.equal(out.messages.length, 1)
})
