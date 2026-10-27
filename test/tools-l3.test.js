/**
 * 工具层回归：lossless JSON、L3 检索接线、memory_get 读概念页。
 *
 * 这一组测试针对的是真实宿主暴露的问题，用最小假 ctx 复现：
 *   1. 工具输出含 undefined 时宿主报 `value is not lossless JSON`；
 *   2. memory_search 从不查 L3，导致概念页存得进去查不出来；
 *   3. memory_get 只认 m_ 记录 id，拿标题读不到概念页。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { apply } from '../tools.js'
import { saveConcept } from '../lib/concepts.js'
import { runtime } from '../lib/runtime.js'
import { Store } from '../lib/store.js'

/** 最小可用 ctx：只提供 tools.register 与 logger，够 apply() 跑起来。 */
function makeCtx() {
  const registry = new Map()
  return {
    registry,
    tools: { register: (def) => registry.set(def.name, def) },
    logger: () => ({ warn() {}, info() {}, error() {}, debug() {} }),
    get: () => undefined,
    on: () => {},
    effect: () => {},
  }
}

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tools-'))
  fs.mkdirSync(path.join(root, 'events'), { recursive: true })
  return root
}

/** 递归找出对象里的 undefined 字段路径——宿主 lossless JSON 校验就是被它触发的。 */
function undefinedPaths(value, prefix = '') {
  const out = []
  if (Array.isArray(value)) {
    value.forEach((item, i) => out.push(...undefinedPaths(item, `${prefix}[${i}]`)))
    return out
  }
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) out.push(`${prefix}${prefix ? '.' : ''}${k}`)
      else out.push(...undefinedPaths(v, `${prefix}${prefix ? '.' : ''}${k}`))
    }
  }
  return out
}

function setup() {
  const root = makeRoot()
  const ctx = makeCtx()
  // runtime 是模块级单例：上一个用例把 embeddedTools/toolsRegistered 打开后，
  // 后续 apply() 会按“宿主已内嵌注册”提前返回，导致本用例拿不到工具。
  // 这是插件的防重复注册机制，测试里必须显式复位。
  runtime.embeddedTools = false
  runtime.toolsRegistered = false
  apply(ctx, { resolved: { root, timeZone: 'Asia/Shanghai', namespace: 'default', retentionDays: 365, journal: {}, inject: {}, compile: {}, configErrors: [] } })
  return { root, ctx }
}

test('lossless：L1 记录带 undefined 字段时，memory_search 输出仍是干净 JSON', () => {
  const { root, ctx } = setup()
  // 造一条和真实记录一样带 supersedes/superseded_by/valid_to 为 undefined 的记录。
  new Store(root).append([{
    id: 'm_test1',
    kind: 'fact',
    text: '测试事实 alpha',
    event_start_ms: Date.now(),
    event_end_ms: Date.now() + 60_000,
    time_precision: 'minute',
    time_basis: 'recorded',
    recorded_at: Date.now(),
    status: 'active',
    supersedes: undefined,
    superseded_by: undefined,
    valid_to: undefined,
    source: { session: 's1', seq_from: 1, seq_to: 1, role: 'user', quote: 'q' },
    namespace: 'default',
  }])

  return ctx.registry.get('memory_search').execute({ query: 'alpha' }).then((result) => {
    assert.deepEqual(undefinedPaths(result), [], '输出里不能有 undefined，否则宿主报 not lossless JSON')
    // 能被标准 JSON 完整还原
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(result)))
  })
})

test('lossless：memory_get 输出同样不带 undefined', async () => {
  const { root, ctx } = setup()
  new Store(root).append([{
    id: 'm_test2',
    kind: 'fact',
    text: '测试事实 beta',
    event_start_ms: Date.now(),
    recorded_at: Date.now(),
    status: 'active',
    supersedes: undefined,
    superseded_by: undefined,
    valid_to: undefined,
    source: { session: 's1', seq_from: 1, seq_to: 1 },
    namespace: 'default',
  }])
  const result = await ctx.registry.get('memory_get').execute({ id: 'm_test2' })
  assert.deepEqual(undefinedPaths(result), [])
})

test('memory_search：scope=l3 直接查概念页', async () => {
  const { root, ctx } = setup()
  saveConcept(root, {
    title: 'BLE RSSI 正确用法：滑窗中位数分两档',
    content: '单次阈值不可用。',
    domain: 'knowledge',
    aliases: ['RSSI 中位数判定'],
  })
  const result = await ctx.registry.get('memory_search').execute({ query: 'BLE RSSI 阈值怎么定', scope: 'l3' })
  assert.equal(result.status, 'ok')
  assert.equal(result.route, 'l3')
  assert.equal(result.items[0].title, 'BLE RSSI 正确用法：滑窗中位数分两档')
})

test('memory_search：L1 未命中时自动兜底到 L3', async () => {
  const { root, ctx } = setup()
  saveConcept(root, { title: '用户的偏好与宠物', content: '最喜欢深蓝色。', domain: 'persona' })
  // 默认 scope：L1 里没有概念页内容，此前这里返回 no_match。
  const result = await ctx.registry.get('memory_search').execute({ query: '用户喜欢什么颜色' })
  assert.equal(result.route, 'l3-fallback')
  assert.equal(result.status, 'ok')
  assert.equal(result.items[0].title, '用户的偏好与宠物')
})

test('memory_search：L1 命中时不被 L3 抢占', async () => {
  const { root, ctx } = setup()
  const now = Date.now()
  new Store(root).append([{
    id: 'm_l1hit', kind: 'event', text: '部署 gamma 服务完成',
    event_start_ms: now, recorded_at: now, status: 'active',
    source: { session: 's1', seq_from: 1, seq_to: 1 }, namespace: 'default',
  }])
  saveConcept(root, { title: 'gamma 部署手册', content: '部署 gamma 的步骤。', domain: 'knowledge' })
  const result = await ctx.registry.get('memory_search').execute({ query: 'gamma' })
  assert.equal(result.route, 'l1', 'L1 命中时应保持原有语义')
})

test('memory_search：scope=all 同时返回 L1 与 L3', async () => {
  const { root, ctx } = setup()
  const now = Date.now()
  new Store(root).append([{
    id: 'm_both', kind: 'event', text: 'delta 事件记录',
    event_start_ms: now, recorded_at: now, status: 'active',
    source: { session: 's1', seq_from: 1, seq_to: 1 }, namespace: 'default',
  }])
  saveConcept(root, { title: 'delta 概念页', content: 'delta 的稳定结论。', domain: 'knowledge' })
  const result = await ctx.registry.get('memory_search').execute({ query: 'delta', scope: 'all' })
  assert.equal(result.status, 'ok')
  assert.equal(result.route, 'l1+l3')
  assert.ok(result.l3.total >= 1)
  assert.ok(result.l1.total >= 1)
  assert.deepEqual(undefinedPaths(result), [])
})

test('memory_get：传概念页标题可读全文', async () => {
  const { root, ctx } = setup()
  saveConcept(root, { title: '我的名字叫小助手', content: '自己起的小名。', domain: 'persona' })
  const result = await ctx.registry.get('memory_get').execute({ id: '我的名字叫小助手' })
  assert.equal(result.status, 'ok')
  assert.equal(result.layer, 'L3')
  assert.equal(result.concept.title, '我的名字叫小助手')
  assert.match(result.concept.content, /自己起的小名/)
  assert.equal(result.concept.domain, 'persona')
})

test('memory_get：不存在的 id 返回 no_match', async () => {
  const { ctx } = setup()
  const result = await ctx.registry.get('memory_get').execute({ id: 'm_不存在' })
  assert.equal(result.status, 'no_match')
})

test('memory_get：L1 记录优先于同名概念页', async () => {
  const { root, ctx } = setup()
  const now = Date.now()
  new Store(root).append([{
    id: 'm_priority', kind: 'fact', text: '这是我',
    event_start_ms: now, recorded_at: now, status: 'active',
    source: { session: 's1', seq_from: 1, seq_to: 1 }, namespace: 'default',
  }])
  const result = await ctx.registry.get('memory_get').execute({ id: 'm_priority' })
  assert.equal(result.layer, 'L1')
  assert.equal(result.concept, undefined)
})
