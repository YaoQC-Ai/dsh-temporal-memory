import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { apply, compileAll } from '../compile.js'
import { conceptDir, listConcepts, readConcept, saveConcept } from '../lib/concepts.js'
import { Store } from '../lib/store.js'
import { zonedTimeToUtc } from '../lib/time.js'

const TZ = 'Asia/Shanghai'
const AT = (d, h = 10) => zonedTimeToUtc(2026, 10, d, h, 0, 0, TZ)

function tmpRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tmem-p-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function seed(root, records) {
  const store = new Store(root)
  store.append(records)
  return store
}

function rec(over = {}) {
  const start = over.event_start_ms ?? AT(20)
  return {
    id: over.id,
    kind: 'decision',
    text: '示例网关使用 8080',
    status: 'active',
    event_start_ms: start,
    event_end_ms: start + 60_000,
    time_precision: 'minute',
    time_basis: 'stated',
    recorded_at: start,
    topics: ['示例网关'],
    entities: [],
    source: { session: 'sess_a', seq_from: 1, seq_to: 2 },
    ...over,
  }
}

test('compileAll 聚合同主题并生成时间线条目', (t) => {
  const root = tmpRoot(t)
  const store = seed(root, [
    rec({ id: 'm_1', text: '示例网关使用 8080', event_start_ms: AT(18) }),
    rec({ id: 'm_2', text: '示例网关加上自签证书', event_start_ms: AT(20) }),
    rec({ id: 'm_3', kind: 'event', text: '顺带修了个错字', topics: ['其他'] }),
  ])
  const res = compileAll(store, root, { timeZone: TZ, minRecords: 2 })
  assert.equal(res.pages.length, 1)
  assert.equal(res.pages[0].slug, '示例网关')
  const md = readConcept(root, '示例网关')
  assert.match(md, /- 2026-10-18：示例网关使用 8080（来源 session\/sess_a seq 1-2；有效）/)
  assert.match(md, /- 2026-10-20：示例网关加上自签证书（来源 session\/sess_a seq 1-2；有效）/)
  assert.match(md, /事件时间: "2026-10-18 ~ 2026-10-20"/)
  assert.match(md, /来源:\n  - session\/sess_a seq 1-2/)
  assert.match(md, /状态: active/)
})

test('人工概念页不被覆盖，只追加自动候选', (t) => {
  const root = tmpRoot(t)
  const store = seed(root, [
    rec({ id: 'm_1', event_start_ms: AT(18) }),
    rec({ id: 'm_2', event_start_ms: AT(20) }),
  ])
  saveConcept(root, { title: '示例网关', content: '人工维护内容' })
  const res = compileAll(store, root, { timeZone: TZ })
  assert.equal(res.pages.length, 0)
  assert.equal(res.updated.length, 1)
  assert.equal(res.needsReview.length, 1)
  const md = readConcept(root, '示例网关')
  assert.match(md, /人工维护内容/)
  assert.match(md, /## 自动编译候选（待人工确认）/)
  assert.match(md, /状态: needs-review/)
  const forced = compileAll(store, root, { timeZone: TZ, force: true })
  assert.equal(forced.pages.length, 0)
  assert.match(readConcept(root, '示例网关'), /人工维护内容/)
  assert.match(readConcept(root, '示例网关'), /自动编译候选/)
})

test('低于 minRecords 不成页；无主题数为 0', (t) => {
  const root = tmpRoot(t)
  const store = seed(root, [rec({ id: 'm_solo', event_start_ms: AT(20) })])
  assert.equal(compileAll(store, root, { timeZone: TZ, minRecords: 2 }).pages.length, 0)
  const none = compileAll(new Store(tmpRoot(t)), tmpRoot(t), { timeZone: TZ })
  assert.equal(none.topics, 0)
  assert.equal(none.pages.length, 0)
})

test('topic 过滤与 maxTopics 上限', (t) => {
  const root = tmpRoot(t)
  const store = seed(root, [
    rec({ id: 'm_a1', topics: ['甲系统'], event_start_ms: AT(18) }),
    rec({ id: 'm_a2', topics: ['甲系统'], event_start_ms: AT(19) }),
    rec({ id: 'm_b1', topics: ['乙系统'], event_start_ms: AT(20) }),
    rec({ id: 'm_b2', topics: ['乙系统'], event_start_ms: AT(21) }),
  ])
  const only = compileAll(store, root, { timeZone: TZ, topic: '甲' })
  assert.deepEqual(only.pages.map((p) => p.slug), ['甲系统'])
  const cappedRoot = tmpRoot(t)
  const cappedStore = seed(cappedRoot, [
    rec({ id: 'm_c1', topics: ['甲系统'], event_start_ms: AT(18) }),
    rec({ id: 'm_c2', topics: ['甲系统'], event_start_ms: AT(19) }),
    rec({ id: 'm_d1', topics: ['乙系统'], event_start_ms: AT(20) }),
    rec({ id: 'm_d2', topics: ['乙系统'], event_start_ms: AT(21) }),
  ])
  const capped = compileAll(cappedStore, cappedRoot, { timeZone: TZ, maxTopics: 1 })
  assert.equal(capped.pages.length, 1)
  assert.equal(capped.truncated, 1)
  const disabled = compileAll(cappedStore, cappedRoot, { timeZone: TZ, maxTopics: 0 })
  assert.equal(disabled.pages.length, 0)
  assert.equal(disabled.updated.length, 0)
  assert.equal(disabled.truncated, 2)
})

test('冲突主题生成 needs-update 页', (t) => {
  const root = tmpRoot(t)
  const store = seed(root, [
    rec({ id: 'm_1', status: 'disputed', event_start_ms: AT(18) }),
    rec({ id: 'm_2', event_start_ms: AT(20) }),
  ])
  compileAll(store, root, { timeZone: TZ })
  const md = readConcept(root, '示例网关')
  assert.match(md, /状态: needs-update/)
  assert.match(md, /（有冲突）/)
})

test('未知事件时间与过期状态不参与编译', (t) => {
  const root = tmpRoot(t)
  const store = seed(root, [
    rec({ id: 'm_unk', event_start_ms: null, topics: ['示例网关'] }),
    rec({ id: 'm_old', status: 'superseded', event_start_ms: AT(19), topics: ['示例网关'], text: '已失效的旧决定' }),
  ])
  const res = compileAll(store, root, { timeZone: TZ, minRecords: 1 })
  assert.equal(res.pages.length, 1)
  const md = readConcept(root, '示例网关')
  assert.match(md, /已失效的旧决定（已失效）/)
  assert.doesNotMatch(md, /未知/)
})

test('memory_compile 工具注册并返回 no_data', async (t) => {
  const root = tmpRoot(t)
  const map = new Map()
  apply({ tools: { register: (d) => map.set(d.name, d) }, logger: () => ({ info() {} }) }, { dir: root })
  const tool = map.get('memory_compile')
  assert.ok(tool)
  const res = await tool.execute({})
  assert.equal(res.status, 'no_data')
  assert.deepEqual(res.pages, [])
  assert.ok(listConcepts(path.join(root, 'memory', 'temporal')).length === 0)
})

test('无会话来源的记录不成页', (t) => {
  const root = tmpRoot(t)
  const store = seed(root, [
    rec({ id: 'm_1', source: undefined }),
    rec({ id: 'm_2', source: { session: '', seq_from: 1, seq_to: 2 } }),
  ])
  const res = compileAll(store, root, { timeZone: TZ, minRecords: 1 })
  assert.equal(res.pages.length, 0)
  assert.equal(res.scanned, 0)
  assert.equal(listConcepts(root).length, 0)
})

test('新页面的索引写入所属 namespace', (t) => {
  const root = tmpRoot(t)
  const store = seed(root, [
    rec({ id: 'm_a1', namespace: 'A', event_start_ms: AT(18) }),
    rec({ id: 'm_a2', namespace: 'A', event_start_ms: AT(20) }),
  ])
  const res = compileAll(store, root, { timeZone: TZ, minRecords: 2, namespace: 'A' })
  assert.equal(res.pages.length, 1)
  const nsIndex = path.join(conceptDir(root, 'A'), '_index.md')
  assert.match(fs.readFileSync(nsIndex, 'utf8'), /示例网关/)
  assert.match(readConcept(root, '示例网关', 'A'), /命名空间: A/)
  assert.equal(listConcepts(root, { namespace: 'A' }).length, 1)
  assert.equal(fs.existsSync(path.join(conceptDir(root), '_index.md')), false)
})

test('重复 topic/entity 不让单条记录凑够门槛，来源 id 也不重复', (t) => {
  const root = tmpRoot(t)
  const store = seed(root, [rec({ id: 'm_dup', topics: ['主人'], entities: ['主人'] })])
  assert.equal(compileAll(store, root, { timeZone: TZ, minRecords: 2 }).pages.length, 0)
  store.append([rec({ id: 'm_dup_2', topics: ['主人'], entities: ['主人'], event_start_ms: AT(21) })])
  assert.equal(compileAll(store, root, { timeZone: TZ, minRecords: 2 }).pages.length, 1)
  const md = readConcept(root, '主人')
  assert.equal(md.match(/^  - m_dup$/gm).length, 1)
  assert.doesNotMatch(md, /命名空间: undefined/)
})

test('短 ASCII 词只有作为明确 entity 时才自动成页', (t) => {
  const noiseRoot = tmpRoot(t)
  const noise = seed(noiseRoot, [
    rec({ id: 'm_llm_1', topics: ['LLM'] }),
    rec({ id: 'm_llm_2', topics: ['LLM'], event_start_ms: AT(21) }),
  ])
  assert.equal(compileAll(noise, noiseRoot, { timeZone: TZ }).pages.length, 0)
  const redisRoot = tmpRoot(t)
  const redis = seed(redisRoot, [
    rec({ id: 'm_redis_1', topics: ['Redis'], entities: ['Redis'] }),
    rec({ id: 'm_redis_2', topics: ['Redis'], entities: ['Redis'], event_start_ms: AT(21) }),
  ])
  assert.equal(compileAll(redis, redisRoot, { timeZone: TZ }).pages.length, 1)
  assert.ok(readConcept(redisRoot, 'Redis'))
})

test('大小写变体合并为一个概念，证据和别名都保留', (t) => {
  const root = tmpRoot(t)
  const store = seed(root, [
    rec({ id: 'm_agent_1', topics: ['Agent'], entities: ['Agent'], event_start_ms: AT(18) }),
    rec({ id: 'm_agent_2', topics: ['Agent'], entities: ['Agent'], event_start_ms: AT(19) }),
    rec({ id: 'm_agent_3', topics: ['AGENT'], entities: ['AGENT'], event_start_ms: AT(20) }),
    rec({ id: 'm_agent_4', topics: ['AGENT'], entities: ['AGENT'], event_start_ms: AT(21) }),
  ])
  const res = compileAll(store, root, { timeZone: TZ })
  assert.equal(res.pages.length, 1)
  assert.equal(res.topics, 1)
  const md = readConcept(root, 'Agent')
  assert.match(md, /别名:\n  - Agent\n  - AGENT/)
  for (const id of ['m_agent_1', 'm_agent_2', 'm_agent_3', 'm_agent_4']) assert.match(md, new RegExp(id))
  assert.equal(fs.readdirSync(conceptDir(root)).filter((name) => name.toLowerCase() === 'agent.md').length, 1)
})

test('长文证据被压成单行摘要，连续编译幂等', (t) => {
  const root = tmpRoot(t)
  const longText = Array.from({ length: 60 }, (_, i) => `## 重复标题 ${i}\n这是第 ${i} 段用于验证长文截断的人工结论内容。`).join('\n')
  const store = seed(root, [
    rec({ id: 'm_long_1', text: longText, event_start_ms: AT(18) }),
    rec({ id: 'm_long_2', text: longText, event_start_ms: AT(20) }),
  ])
  compileAll(store, root, { timeZone: TZ })
  const file = path.join(conceptDir(root), '示例网关.md')
  const first = fs.readFileSync(file, 'utf8')
  assert.ok(first.length < longText.length * 2)
  assert.doesNotMatch(first, /^## 重复标题/m)
  assert.match(first, /已截断，全文见来源记录/)
  const second = compileAll(store, root, { timeZone: TZ })
  const third = compileAll(store, root, { timeZone: TZ })
  assert.equal(second.updated.length, 0)
  assert.equal(third.updated.length, 0)
  assert.equal(fs.readFileSync(file, 'utf8'), first)
})

test('人工确认后状态保持 active，新证据才重新要求审核', (t) => {
  const root = tmpRoot(t)
  const store = seed(root, [
    rec({ id: 'm_review_1', event_start_ms: AT(18) }),
    rec({ id: 'm_review_2', event_start_ms: AT(20) }),
  ])
  saveConcept(root, { title: '示例网关', content: '人工维护内容' })
  compileAll(store, root, { timeZone: TZ })
  const file = path.join(conceptDir(root), '示例网关.md')
  assert.match(fs.readFileSync(file, 'utf8'), /状态: needs-review/)
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('状态: needs-review', '状态: active'))
  compileAll(store, root, { timeZone: TZ })
  assert.match(fs.readFileSync(file, 'utf8'), /状态: active/)
  store.append([rec({ id: 'm_review_3', text: '新的部署结论', event_start_ms: AT(21) })])
  compileAll(store, root, { timeZone: TZ })
  assert.match(fs.readFileSync(file, 'utf8'), /状态: needs-review/)
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('状态: needs-review', '状态: needs-update'))
  compileAll(store, root, { timeZone: TZ })
  assert.match(fs.readFileSync(file, 'utf8'), /状态: needs-update/)
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('状态: needs-update', '状态: active'))
  compileAll(store, root, { timeZone: TZ })
  assert.match(fs.readFileSync(file, 'utf8'), /状态: active/)
})

test('已闭合的取代链是历史，不让自动页永久 needs-update', (t) => {
  const root = tmpRoot(t)
  const store = seed(root, [
    rec({ id: 'm_old', status: 'superseded', superseded_by: 'm_new', event_start_ms: AT(18) }),
    rec({ id: 'm_new', kind: 'correction', text: '示例网关改用 8081', event_start_ms: AT(20) }),
  ])
  compileAll(store, root, { timeZone: TZ })
  assert.match(readConcept(root, '示例网关'), /状态: active/)
})
