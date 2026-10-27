import assert from 'node:assert/strict'
import test from 'node:test'
import {
  dateKey,
  dayRange,
  formatEvent,
  localParts,
  normalizeTz,
  parseTime,
  zonedTimeToUtc,
  addLocalDays,
} from '../lib/time.js'

const TZ = 'Asia/Shanghai'
const ANCHOR = zonedTimeToUtc(2026, 10, 25, 10, 0, 0, TZ)

test('绝对日期按本地日解释', () => {
  const r = parseTime('10月12日我们确定了方案', ANCHOR, TZ)
  assert.equal(r.precision, 'day')
  assert.equal(dateKey(r.startMs, TZ), '2026-10-12')
  assert.equal(new Date(r.startMs).toISOString(), '2026-10-11T16:00:00.000Z')
  assert.equal(r.time_basis, 'inferred')
})

test('完整日期时间保留分钟精度', () => {
  const r = parseTime('2026-10-12 15:30 部署完成', ANCHOR, TZ)
  assert.equal(r.precision, 'minute')
  assert.equal(new Date(r.startMs).toISOString(), '2026-10-12T07:30:00.000Z')
})

test('相对日以消息时间为锚', () => {
  const r = parseTime('昨天我们定了方案B', ANCHOR, TZ)
  assert.equal(dateKey(r.startMs, TZ), '2026-10-24')
  assert.equal(r.time_basis, 'stated')
})

test('上周三与本周三', () => {
  const last = parseTime('上周三做的事', ANCHOR, TZ)
  assert.equal(dateKey(last.startMs, TZ), '2026-10-14')
  const thisWeek = parseTime('这周三做的事', ANCHOR, TZ)
  assert.equal(dateKey(thisWeek.startMs, TZ), '2026-10-21')
})

test('上周是周一到周日的范围', () => {
  const r = parseTime('上周做了迁移', ANCHOR, TZ)
  assert.equal(r.precision, 'range')
  assert.equal(dateKey(r.startMs, TZ), '2026-10-12')
  assert.equal(dateKey(r.endMs - 1, TZ), '2026-10-18')
})

test('显式范围包含首尾两天', () => {
  const r = parseTime('10月12日到10月14日灰度发布', ANCHOR, TZ)
  assert.equal(r.precision, 'range')
  assert.equal(dateKey(r.startMs, TZ), '2026-10-12')
  assert.equal(dateKey(r.endMs - 1, TZ), '2026-10-14')
})

test('N 天前', () => {
  const r = parseTime('3天前改过配置', ANCHOR, TZ)
  assert.equal(dateKey(r.startMs, TZ), '2026-10-22')
})

test('上个月是完整自然月', () => {
  const r = parseTime('上个月的情况', ANCHOR, TZ)
  assert.equal(dateKey(r.startMs, TZ), '2026-09-01')
  assert.equal(dateKey(r.endMs - 1, TZ), '2026-09-30')
})

test('模糊范围标记为推断', () => {
  const r = parseTime('最近系统有点慢', ANCHOR, TZ)
  assert.equal(r.precision, 'range')
  assert.equal(r.time_basis, 'inferred')
  assert.ok(r.time_confidence <= 0.6)
})

test('无时间返回 null', () => {
  assert.equal(parseTime('把文件改一下', ANCHOR, TZ), null)
})

test('仅有日期不伪造时刻', () => {
  const r = parseTime('2026-10-12', ANCHOR, TZ)
  assert.equal(localParts(r.startMs, TZ).hour, 0)
  assert.equal(r.precision, 'day')
})

test('dayRange 跨夏令时长度正确（纽约 2026-03-08 为 23 小时）', () => {
  const r = dayRange('2026-03-08', 'America/New_York')
  assert.equal(r.endMs - r.startMs, 23 * 3600_000)
})

test('非法规时区回退 UTC', () => {
  assert.equal(normalizeTz('Not/AZone'), 'UTC')
})

test('格式正确但日历非法的日期不被归一化', () => {
  assert.equal(dayRange('2026-02-31', TZ), null)
  assert.equal(dayRange('2025-02-29', TZ), null)
  assert.ok(dayRange('2024-02-29', TZ))
  assert.equal(parseTime('2026-02-31 部署完成', ANCHOR, TZ), null)
})

test('formatEvent 明确未知与推断', () => {
  assert.match(formatEvent({ time_precision: 'unknown', recorded_at: ANCHOR }, TZ), /事件时间未知/)
  const inferred = parseTime('最近', ANCHOR, TZ)
  const text = formatEvent({ ...inferred, event_start_ms: inferred.startMs, event_end_ms: inferred.endMs, time_precision: 'range' }, TZ)
  assert.match(text, /^约 /)
})

test('addLocalDays 保持本地墙钟时间', () => {
  const next = addLocalDays(ANCHOR, 1, TZ)
  const p = localParts(next, TZ)
  assert.equal(p.hour, 10)
  assert.equal(dateKey(next, TZ), '2026-10-26')
})
