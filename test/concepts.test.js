import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  conceptPath,
  listConcepts,
  markConceptSourcesDeleted,
  markSuperseded,
  readConcept,
  saveConcept,
  slugify,
  yamlStr,
} from '../lib/concepts.js'

function tmpRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tmem-c-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

const OCT20 = new Date(2026, 9, 20, 12).getTime()
const OCT25 = new Date(2026, 9, 25, 12).getTime()

test('saveConcept 生成中文 Frontmatter 并登记索引', (t) => {
  const root = tmpRoot(t)
  const res = saveConcept(root, {
    title: '示例网关',
    content: '网关部署在 8080，使用自签证书。',
    domain: 'execution',
    aliases: ['gateway', '8080'],
    sources: ['sess_a#1-2'],
  }, { now: OCT20 })
  assert.equal(res.created, true)
  const text = readConcept(root, '示例网关')
  assert.match(text, /^---\n标题: 示例网关/)
  assert.match(text, /创建日期: 2026-10-20/)
  assert.match(text, /领域: execution/)
  assert.match(text, /## 核心内容\n\n网关部署在 8080/)
  const index = fs.readFileSync(path.join(root, 'knowledge', '_index.md'), 'utf8')
  assert.match(index, /\| \[\[示例网关\]\] \| execution \| active \| 2026-10-20 \|/)
})

test('二次保存保留创建日期、合并来源、索引不重复', (t) => {
  const root = tmpRoot(t)
  saveConcept(root, { title: '示例看板', content: '第一版', domain: 'knowledge', sources: ['s1'] }, { now: OCT20 })
  const res = saveConcept(root, { title: '示例看板', content: '第二版', domain: 'knowledge', sources: ['s2'] }, { now: OCT25 })
  assert.equal(res.created, false)
  const text = readConcept(root, '示例看板')
  assert.match(text, /创建日期: 2026-10-20/)
  assert.match(text, /更新日期: 2026-10-25/)
  assert.match(text, /- s1/)
  assert.match(text, /- s2/)
  assert.match(text, /第二版/)
  const index = fs.readFileSync(path.join(root, 'knowledge', '_index.md'), 'utf8')
  assert.equal(index.match(/\[\[示例看板\]\]/g).length, 1)
  assert.match(index, /2026-10-25/)
})

test('slugify 拒绝非法与保留名', () => {
  assert.equal(slugify(' 示例网关 '), '示例网关')
  assert.throws(() => slugify(''), /title/)
  assert.throws(() => slugify('a/b'), /非法字符/)
  assert.throws(() => slugify('con'), /保留名/)
  assert.throws(() => slugify('_index'), /保留名/)
  assert.throws(() => slugify('x. '), /尾随/)
})

test('yamlStr 给危险标量加引号', () => {
  assert.equal(yamlStr('示例网关'), '示例网关')
  assert.equal(yamlStr('a: b'), '"a: b"')
  assert.equal(yamlStr('true'), '"true"')
  assert.equal(yamlStr('123'), '"123"')
})

test('content 为空时抛错且不落盘', (t) => {
  const root = tmpRoot(t)
  assert.throws(() => saveConcept(root, { title: '空页', content: '  ' }), /content/)
  assert.equal(fs.existsSync(conceptPath(root, '空页')), false)
})

test('listConcepts 读取标题、别名与状态', (t) => {
  const root = tmpRoot(t)
  saveConcept(root, { title: '示例网关', content: '内容', aliases: ['gateway'] })
  saveConcept(root, { title: '旧约定', content: '内容', status: 'needs-update' })
  const list = listConcepts(root).sort((a, b) => a.slug.localeCompare(b.slug))
  assert.equal(list.length, 2)
  const gw = list.find((c) => c.slug === '示例网关')
  assert.deepEqual(gw.aliases, ['gateway'])
  assert.equal(gw.title, '示例网关')
  assert.equal(list.find((c) => c.slug === '旧约定').status, 'needs-update')
})

test('listConcepts 无目录返回空数组', (t) => {
  assert.deepEqual(listConcepts(tmpRoot(t)), [])
})

test('markSuperseded 标记 needs-update 并写入矛盾', (t) => {
  const root = tmpRoot(t)
  saveConcept(root, { title: '端口约定', content: '端口 8080' })
  assert.equal(markSuperseded(root, '端口约定', '改为 8081'), true)
  const text = readConcept(root, '端口约定')
  assert.match(text, /状态: needs-update/)
  assert.match(text, /## 矛盾\n\n- .* 已失效：改为 8081/)
  assert.equal(markSuperseded(root, '不存在页', 'x'), false)
})

test('来源记录随概念页保存，删除来源后标记 needs-update', (t) => {
  const root = tmpRoot(t)
  saveConcept(root, {
    title: '部署约定',
    content: '端口 8080',
    sourceIds: ['m_a', 'm_b'],
  })
  const text = readConcept(root, '部署约定')
  assert.match(text, /来源记录:\n  - m_a\n  - m_b/)
  assert.equal(markConceptSourcesDeleted(root, 'm_a'), 1)
  const after = readConcept(root, '部署约定')
  assert.doesNotMatch(after, /来源记录:\n  - m_a/)
  assert.match(after, /来源记录:\n  - m_b/)
  assert.match(after, /状态: needs-update/)
  assert.match(after, /来源记录 m_a 已删除/)
  assert.equal(markConceptSourcesDeleted(root, 'm_missing'), 0)
})

test('概念页日期使用配置时区', (t) => {
  const root = tmpRoot(t)
  saveConcept(root, { title: '时区页', content: '内容' }, {
    now: Date.UTC(2026, 9, 25, 16, 30),
    tz: 'Asia/Shanghai',
  })
  assert.match(readConcept(root, '时区页'), /创建日期: 2026-10-26/)
})
