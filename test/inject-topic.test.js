import assert from 'node:assert/strict'
import test from 'node:test'
import { conceptMatches, shouldRecall } from '../lib/inject.js'
import { zonedTimeToUtc } from '../lib/time.js'

const TZ = 'Asia/Shanghai'
const ANCHOR = zonedTimeToUtc(2026, 10, 25, 10, 0, 0, TZ)

/** 真实缺陷样本：标题很长、用户问法不同，旧逻辑永远触发不了。 */
const BLE = { slug: 'ble', title: 'BLE RSSI 正确用法：滑窗中位数分两档', aliases: ['RSSI 中位数判定'] }

test('conceptMatches：完整标题包含仍然最强（保持原有行为）', () => {
  const m = conceptMatches('我在想 BLE RSSI 正确用法：滑窗中位数分两档 这件事', BLE)
  assert.equal(m.hit, true)
  assert.equal(m.exact, true)
})

test('conceptMatches：问法与标题不同也能命中（问法差异的核心缺陷）', () => {
  // 此前这里返回 null：原话不含完整标题。
  const m = conceptMatches('BLE RSSI 阈值应该怎么定？', BLE)
  assert.equal(m.hit, true)
  assert.equal(m.exact, false)
  assert.ok(m.matched.includes('ble'))
  assert.ok(m.matched.includes('rssi'))
})

test('conceptMatches：别名参与命中', () => {
  const m = conceptMatches('RSSI 中位数判定怎么做的', BLE)
  assert.equal(m.hit, true)
})

test('conceptMatches：单个泛词命中不算', () => {
  const generic = { slug: 'g', title: '我的名字叫小助手', aliases: [] }
  assert.equal(conceptMatches('这个东西是什么', generic).hit, false)
})

test('conceptMatches：空标题不命中', () => {
  assert.equal(conceptMatches('随便说点什么', { title: '' }).hit, false)
  assert.equal(conceptMatches('随便说点什么', null).hit, false)
})

test('conceptMatches：短标题退回完整包含，不被 token 门槛放过', () => {
  const short = { slug: 's', title: '网关', aliases: [] }
  assert.equal(conceptMatches('网关那套还好吗', short).hit, true)
  // 只有单 token 的标题不参与 token 匹配
  assert.equal(conceptMatches('网络关系', short).hit, false)
})

test('conceptMatches：ASCII 专有名词加权，不被中文功能词稀释', () => {
  // 「应该/怎么/么定」等中文 bigram 会稀释覆盖率，ASCII 专名 2 倍权重抵消这一点。
  const m = conceptMatches('CH343 串口怎么探测', { slug: 'c', title: 'CH343 串口探测记录 2026-10-21 晚轮', aliases: [] })
  assert.equal(m.hit, true)
})

test('shouldRecall：主题触发走 token 阈值', () => {
  const hit = shouldRecall({ text: 'BLE RSSI 阈值应该怎么定？', anchorMs: ANCHOR, tz: TZ, concepts: [BLE] })
  assert.equal(hit.trigger, 'topic')
  assert.equal(hit.query, BLE.title)
  assert.equal(hit.topic, BLE.slug)
})

test('shouldRecall：多个概念命中时选覆盖率最高的', () => {
  const broad = { slug: 'broad', title: 'ESP32 相关结论', aliases: [] }
  const narrow = { slug: 'narrow', title: 'ESP32-S3 反复重启的判据：BOD 欠压', aliases: [] }
  const hit = shouldRecall({ text: 'ESP32-S3 为什么反复重启', anchorMs: ANCHOR, tz: TZ, concepts: [broad, narrow] })
  assert.equal(hit.trigger, 'topic')
  assert.equal(hit.topic, 'narrow')
})

test('shouldRecall：日常闲聊不误触发主题召回', () => {
  const concepts = [BLE]
  for (const text of ['写个排序算法', '帮我重构这段代码', '这个函数为什么报错', '安装依赖失败了']) {
    const hit = shouldRecall({ text, anchorMs: ANCHOR, tz: TZ, concepts })
    assert.notEqual(hit?.trigger, 'topic', `「${text}」不应触发主题召回`)
  }
})

test('shouldRecall：topic 仍受冷却约束', () => {
  const args = { text: 'BLE RSSI 阈值应该怎么定？', anchorMs: ANCHOR, tz: TZ, concepts: [BLE] }
  const first = shouldRecall({ ...args, turn: 5, lastInjection: { turn: 3, topic: BLE.slug } })
  assert.equal(first, null)
  const second = shouldRecall({ ...args, turn: 9, lastInjection: { turn: 3, topic: BLE.slug } })
  assert.ok(second)
})

test('shouldRecall：时间触发优先级高于主题', () => {
  const hit = shouldRecall({ text: '昨天 BLE RSSI 阈值定成多少了', anchorMs: ANCHOR, tz: TZ, concepts: [BLE] })
  assert.equal(hit.trigger, 'time')
})

test('shouldRecall：inject.enabled=false 时主题整条关闭', () => {
  const hit = shouldRecall({
    text: 'BLE RSSI 阈值应该怎么定？',
    anchorMs: ANCHOR,
    tz: TZ,
    concepts: [BLE],
    config: { inject: { enabled: false } },
  })
  assert.equal(hit, null)
})
