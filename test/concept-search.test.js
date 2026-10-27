import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { loadConceptDocs, searchConcepts } from '../lib/concept-search.js'
import { saveConcept } from '../lib/concepts.js'

function withRoot(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cs-'))
  try {
    return fn(root)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

test('searchConcepts：标题命中（此前只查 L1 时的缺口）', () => withRoot((root) => {
  saveConcept(root, {
    title: 'BLE RSSI 正确用法：滑窗中位数分两档',
    content: '单次阈值不可用，要用滑动窗中位数。',
    domain: 'knowledge',
    aliases: ['RSSI 中位数判定'],
  })
  // 此前这句话查不到任何东西：memory_search 只查 L1，注入层又要求完整标题。
  const r = searchConcepts(root, { query: 'BLE RSSI 阈值应该怎么定' })
  assert.equal(r.status, 'ok')
  assert.equal(r.route, 'l3')
  assert.equal(r.items[0].title, 'BLE RSSI 正确用法：滑窗中位数分两档')
  assert.ok(r.items[0].hit.title.length >= 1, 'hit 字段要说明为什么召回')
}))

test('searchConcepts：别名命中', () => withRoot((root) => {
  saveConcept(root, { title: '毫米波模块', content: '两颗雷达都买了。', domain: 'knowledge', aliases: ['雷达型号'] })
  const r = searchConcepts(root, { query: '雷达型号是哪个' })
  assert.equal(r.status, 'ok')
  assert.equal(r.items[0].title, '毫米波模块')
  assert.ok(r.items[0].hit.alias.length >= 1)
}))

test('searchConcepts：仅正文命中排在后', () => withRoot((root) => {
  saveConcept(root, { title: '完全无关的标题', content: '正文里提到了 zebra 这个词。', domain: 'knowledge' })
  const r = searchConcepts(root, { query: 'zebra' })
  assert.equal(r.status, 'ok')
  assert.equal(r.items[0].title, '完全无关的标题')
  assert.deepEqual(r.items[0].hit.core, ['zebra'])
}))

test('searchConcepts：status 默认只给 active', () => withRoot((root) => {
  saveConcept(root, { title: '有效页', content: '甲', domain: 'knowledge' })
  saveConcept(root, { title: '待确认页', content: '乙', domain: 'knowledge', status: 'needs-review' })
  assert.equal(searchConcepts(root, { query: '' }).total, 1)
  assert.equal(searchConcepts(root, { query: '', status: 'all' }).total, 2)
}))

test('searchConcepts：待确认页被过滤时给出提示，不让记忆看起来不存在', () => withRoot((root) => {
  saveConcept(root, { title: '毫米波雷达型号：两颗都有', content: '甲', domain: 'knowledge' })
  saveConcept(root, { title: '毫米波雷达型号：协议不同', content: '乙', domain: 'knowledge', status: 'needs-review' })
  const r = searchConcepts(root, { query: '毫米波雷达型号', status: 'active' })
  assert.equal(r.items.length, 1)
  assert.match(r.message, /待确认页/)
  assert.match(r.message, /协议不同/)
}))

test('searchConcepts：无关查询不误提示待确认页', () => withRoot((root) => {
  saveConcept(root, { title: '甲页', content: '关于 alpha 的结论', domain: 'knowledge' })
  saveConcept(root, { title: '乙页', content: '关于 beta 的结论', domain: 'knowledge', status: 'needs-review' })
  const r = searchConcepts(root, { query: 'alpha', status: 'active' })
  assert.doesNotMatch(r.message, /待确认页/)
}))

test('searchConcepts：domain 过滤', () => withRoot((root) => {
  saveConcept(root, { title: '知识页', content: '甲', domain: 'knowledge' })
  saveConcept(root, { title: '人格页', content: '乙', domain: 'persona' })
  assert.equal(searchConcepts(root, { query: '', domain: 'persona' }).total, 1)
}))

test('searchConcepts：无匹配返回 no_match 而不是 ok', () => withRoot((root) => {
  saveConcept(root, { title: '甲页', content: '关于 alpha', domain: 'knowledge' })
  const r = searchConcepts(root, { query: '完全不存在的词zzz' })
  assert.equal(r.status, 'no_match')
  assert.deepEqual(r.items, [])
}))

test('searchConcepts：空目录返回 no_data', () => withRoot((root) => {
  const r = searchConcepts(path.join(root, 'not-exist'), { query: 'x' })
  assert.equal(r.status, 'no_data')
}))

test('searchConcepts：空 query 按更新时间倒序浏览', () => withRoot((root) => {
  saveConcept(root, { title: '甲页', content: '甲', domain: 'knowledge' })
  saveConcept(root, { title: '乙页', content: '乙', domain: 'knowledge' })
  const r = searchConcepts(root, { query: '' })
  assert.equal(r.total, 2)
  assert.equal(r.status, 'ok')
}))

test('searchConcepts：分页游标', () => withRoot((root) => {
  for (let i = 0; i < 5; i++) {
    saveConcept(root, { title: `页${i}`, content: `共同词 ${i}`, domain: 'knowledge' })
  }
  const first = searchConcepts(root, { query: '共同词', limit: 2 })
  assert.equal(first.items.length, 2)
  assert.equal(first.truncated, true)
  assert.ok(first.next_cursor)
  const second = searchConcepts(root, { query: '共同词', limit: 2, cursor: first.next_cursor })
  assert.equal(second.items.length, 2)
  // 分页不能重复返回同一页
  const firstSlugs = first.items.map((i) => i.slug)
  assert.ok(second.items.every((i) => !firstSlugs.includes(i.slug)))
}))

test('loadConceptDocs：跳过 _index.md 等下划线文件', () => withRoot((root) => {
  saveConcept(root, { title: '正常页', content: '甲', domain: 'knowledge' })
  // saveConcept 会写 _index.md
  const docs = loadConceptDocs(root)
  assert.equal(docs.length, 1)
  assert.equal(docs[0].slug, '正常页')
}))

test('searchConcepts：namespace 隔离', () => withRoot((root) => {
  saveConcept(root, { title: '默认空间页', content: '甲', domain: 'knowledge' })
  saveConcept(root, { title: '私有空间页', content: '乙', domain: 'knowledge', namespace: 'other' })
  assert.equal(searchConcepts(root, { query: '' }).total, 1)
  assert.equal(searchConcepts(root, { query: '', namespace: 'other' }).total, 1)
  assert.equal(searchConcepts(root, { query: '', namespace: 'other' }).items[0].title, '私有空间页')
}))

test('searchConcepts：返回项含 excerpt 且不为空', () => withRoot((root) => {
  saveConcept(root, { title: '甲页', content: '这是一段足够长的核心内容用于摘要。', domain: 'knowledge' })
  const r = searchConcepts(root, { query: '甲页' })
  assert.ok(r.items[0].excerpt.length > 0)
  assert.ok(r.items[0].path.endsWith('.md'))
}))

test('searchConcepts：长正文摘要截断到 240 字', () => withRoot((root) => {
  saveConcept(root, { title: '长页', content: '很长的内容'.repeat(100), domain: 'knowledge' })
  const r = searchConcepts(root, { query: '长页' })
  assert.ok(r.items[0].excerpt.length <= 241)
  assert.match(r.items[0].excerpt, /…$/)
}))
