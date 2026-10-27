import assert from 'node:assert/strict'
import test from 'node:test'
import { searchDay, searchRecords, timeline, tokenize } from '../lib/search.js'
import { zonedTimeToUtc } from '../lib/time.js'

const TZ = 'Asia/Shanghai'
const DAY = (d, h = 10) => zonedTimeToUtc(2026, 10, d, h, 0, 0, TZ)

function r(over = {}) {
  const start = over.event_start_ms ?? DAY(20)
  return {
    id: over.id || `m_${Math.random().toString(36).slice(2, 8)}`,
    kind: 'event',
    text: '部署示例网关到 8080 端口',
    status: 'active',
    event_start_ms: start,
    event_end_ms: start + 60_000,
    time_precision: 'minute',
    time_basis: 'stated',
    recorded_at: start + 1000,
    topics: ['示例网关'],
    entities: ['8080'],
    source: { session: 'sess_a', seq_from: 1 },
    ...over,
  }
}

test('tokenize 中文双字与拉丁词，过滤停用词', () => {
  const tokens = tokenize('把示例网关部署到 example-gateway')
  assert.ok(tokens.includes('示例'))
  assert.ok(tokens.includes('网关'))
  assert.ok(tokens.includes('example-gateway'))
  assert.deepEqual(tokenize('我们'), [])
})

test('中文查询命中文本', () => {
  const res = searchRecords([r(), r({ id: 'm_b', text: '调整 示例看板配色', topics: [], entities: [] })], { query: '网关', tz: TZ })
  assert.equal(res.status, 'ok')
  assert.equal(res.total, 1)
  assert.equal(res.items[0].id.startsWith('m_'), true)
  assert.match(res.items[0].time_label, /2026-10-20 10:00/)
})

test('两字中文查询可命中（双字索引的核心理由）', () => {
  const records = [r({ text: '确定了迁移方案' }), r({ id: 'm_c', text: '顺手修了个拼写' })]
  const res = searchRecords(records, { query: '方案', tz: TZ })
  assert.equal(res.total, 1)
})

test('kind 与 status 过滤', () => {
  const records = [
    r({ id: 'm_a', kind: 'decision', status: 'active' }),
    r({ id: 'm_b', kind: 'decision', status: 'superseded' }),
    r({ id: 'm_c', kind: 'event', status: 'active' }),
  ]
  assert.equal(searchRecords(records, { kind: 'decision', tz: TZ }).total, 1)
  assert.equal(searchRecords(records, { kind: 'decision', status: 'history', tz: TZ }).total, 2)
  assert.equal(searchRecords(records, { status: 'all', tz: TZ }).total, 3)
})

test('时间窗过滤掉窗外记录', () => {
  const records = [r({ id: 'm_in', event_start_ms: DAY(20) }), r({ id: 'm_out', event_start_ms: DAY(18), event_end_ms: DAY(18) + 60_000 })]
  const res = searchRecords(records, { fromMs: DAY(20, 0), toMs: DAY(21, 0), tz: TZ })
  assert.equal(res.total, 1)
  assert.equal(res.items[0].id, 'm_in')
})

test('未知事件时间不进入时间窗筛选', () => {
  const records = [r({ id: 'm_unknown', event_start_ms: null, time_precision: 'unknown' })]
  assert.equal(searchRecords(records, { fromMs: DAY(20, 0), toMs: DAY(21, 0), tz: TZ }).status, 'no_match')
  assert.equal(searchRecords(records, {}).total, 1)
})

test('active 排在 superseded 前', () => {
  const records = [
    r({ id: 'm_old', status: 'superseded', text: '端口是 8080' }),
    r({ id: 'm_new', status: 'active', text: '端口是 8080' }),
  ]
  const res = searchRecords(records, { query: '8080', tz: TZ })
  assert.equal(res.items[0].id, 'm_new')
})

test('空库 -> no_data，查不到 -> no_match', () => {
  assert.equal(searchRecords([], {}).status, 'no_data')
  assert.equal(searchRecords([], { fromMs: Date.now() }).status, 'no_data')
  const res = searchRecords([r()], { query: '完全不相干的关键词' })
  assert.equal(res.status, 'no_match')
})

test('超出保留期 -> out_of_retention', () => {
  const old = zonedTimeToUtc(2024, 1, 1, 0, 0, 0, TZ)
  const res = searchRecords([], {
    fromMs: old,
    toMs: old + 86_400_000,
    nowMs: zonedTimeToUtc(2026, 10, 25, 0, 0, 0, TZ),
    retentionDays: 365,
  })
  assert.equal(res.status, 'out_of_retention')
})

test('分页 cursor 与 truncated', () => {
  const records = Array.from({ length: 5 }, (_, i) => r({ id: `m_${i}`, text: '部署示例网关' + i, event_start_ms: DAY(20, 10 + i) }))
  const first = searchRecords(records, { query: '部署', limit: 2, tz: TZ })
  assert.equal(first.returned, 2)
  assert.equal(first.total, 5)
  assert.equal(first.truncated, true)
  assert.match(first.next_cursor, /^s:[\d.]+:m_/)
  const second = searchRecords(records, { query: '部署', limit: 2, cursor: first.next_cursor, tz: TZ })
  assert.equal(second.returned, 2)
  assert.notEqual(second.items[0].id, first.items[0].id)
  const third = searchRecords(records, { query: '部署', limit: 2, cursor: second.next_cursor, tz: TZ })
  assert.equal(third.returned, 1)
  assert.equal(third.truncated, false)
  assert.equal(third.next_cursor, null)
})

test('searchDay 分组且含未知时间待确认区', () => {
  const records = [
    r({ id: 'm_e', kind: 'event' }),
    r({ id: 'm_d', kind: 'decision' }),
    r({ id: 'm_p', kind: 'plan' }),
    r({ id: 'm_u', kind: 'fact', event_start_ms: null, time_precision: 'unknown' }),
  ]
  const res = searchDay(records, '2026-10-20', TZ)
  assert.equal(res.status, 'ok')
  const sections = res.items.map((g) => g.section)
  assert.deepEqual(sections, ['happened', 'decisions', 'plans', 'pending'])
})

test('searchDay 的 view=recorded 按写入日归档', () => {
  const records = [r({ id: 'm_r', recorded_at: DAY(21, 3), event_start_ms: DAY(20) })]
  assert.equal(searchDay(records, '2026-10-20', TZ).total, 1)
  assert.equal(searchDay(records, '2026-10-21', TZ, { view: 'recorded' }).total, 1)
})

test('searchDay 非法日期返回 error', () => {
  assert.equal(searchDay([r()], '10/20', TZ).status, 'error')
})

test('timeline 按事件时间升序并按主题过滤', () => {
  const records = [
    r({ id: 'm_late', text: '网关上线', event_start_ms: DAY(22) }),
    r({ id: 'm_early', text: '网关立项', event_start_ms: DAY(19) }),
    r({ id: 'm_other', text: '看板配色', event_start_ms: DAY(20), topics: [], entities: [] }),
  ]
  const res = timeline(records, { topic: '网关', tz: TZ })
  assert.equal(res.status, 'ok')
  assert.deepEqual(res.items.map((i) => i.id), ['m_early', 'm_late'])
  assert.equal(timeline(records, { topic: '不存在主题' }).status, 'no_match')
})
