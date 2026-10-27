import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { listConcepts, readConcept } from '../lib/concepts.js'

const SCRIPT = fileURLToPath(new URL('../scripts/import-legacy.mjs', import.meta.url))

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tmem-import-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function run(args) {
  return execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' })
}

function page(fields, body) {
  return `---\n${fields.join('\n')}\n---\n\n# 标题\n\n${body}\n`
}

test('--concepts 默认 dry-run：统计页数与跳过原因，不写目标目录', (t) => {
  const src = tmpDir(t)
  const target = path.join(tmpDir(t), 'data')
  fs.writeFileSync(path.join(src, 'A.md'), page([
    '标题: 甲页面',
    '别名:',
    '  - 甲',
    '来源:',
    '  - session/s1 seq 1',
    '关联:',
    '  - -',
    '命名空间: default',
    '创建日期: 2024-01-02',
    '更新日期: 2024-01-02',
    '记忆类型: experience',
    '时效性: long-term',
    '状态: needs-review',
    '领域: execution',
  ], '## 核心内容\n\n甲的核心结论。\n\n## 迁移附录\n\n旧正文。'))
  fs.writeFileSync(path.join(src, 'B.md'), page(['标题: 乙页面', '领域: knowledge'], '## 核心内容\n\n乙的核心结论。'))
  fs.writeFileSync(path.join(src, 'no-title.md'), page(['领域: knowledge'], '## 核心内容\n\n无标题。'))
  fs.writeFileSync(path.join(src, 'no-frontmatter.md'), '# 裸页面\n\n## 核心内容\n\n没有 frontmatter。\n')
  fs.writeFileSync(path.join(src, '_index.md'), '# OLD-INDEX-SENTINEL\n')

  const output = run(['--concepts', src, '--root', target])
  assert.match(output, /将导入 2 页，跳过 3 页/)
  assert.match(output, /跳过 1 页：插件维护的索引，不导入/)
  assert.match(output, /跳过 1 页：缺少标题/)
  assert.match(output, /跳过 1 页：缺少 frontmatter/)
  assert.match(output, /来源记录缺失：2 页/)
  assert.match(output, /dry-run：未写入/)
  assert.equal(fs.existsSync(path.join(target, 'knowledge')), false)
})

test('--concepts --yes 走 saveConcept 建页与索引，保留创建日期和状态', (t) => {
  const src = tmpDir(t)
  const target = path.join(tmpDir(t), 'data')
  fs.writeFileSync(path.join(src, 'A.md'), page([
    '标题: 甲页面',
    '别名:',
    '  - 甲',
    '来源:',
    '  - session/s1 seq 1',
    '关联:',
    '  - 乙页面',
    '命名空间: default',
    '创建日期: 2024-01-02',
    '更新日期: 2024-01-02',
    '记忆类型: experience',
    '时效性: long-term',
    '状态: needs-review',
    '领域: execution',
  ], '## 核心内容\n\n甲的核心结论。\n\n## 迁移附录\n\n旧正文。'))
  fs.writeFileSync(path.join(src, 'B.md'), page([
    '标题: 乙页面',
    '来源记录:',
    '  - m_missing',
    '领域: knowledge',
  ], '## 核心内容\n\n乙的核心结论。'))
  fs.writeFileSync(path.join(src, '_index.md'), page(['标题: 旧索引'], '# OLD-INDEX-SENTINEL\n'))

  const output = run(['--concepts', src, '--root', target, '--yes'])
  assert.match(output, /已导入 2 页/)
  assert.match(output, /来源记录未命中：1 页/)

  const a = readConcept(target, '甲页面')
  assert.match(a, /创建日期: 2024-01-02/)
  assert.match(a, /状态: needs-review/)
  assert.match(a, /领域: execution/)
  assert.match(a, /- session\/s1 seq 1/)
  assert.match(a, /- \[\[乙页面\]\]/)
  assert.match(a, /甲的核心结论/)
  assert.doesNotMatch(a, /迁移附录/)

  const index = fs.readFileSync(path.join(target, 'knowledge', '_index.md'), 'utf8')
  assert.match(index, /\| \[\[甲页面\]\] \| execution \| needs-review \|/)
  assert.match(index, /\| \[\[乙页面\]\] \| knowledge \| active \|/)
  assert.doesNotMatch(index, /OLD-INDEX-SENTINEL/)
  assert.equal(listConcepts(target).length, 2)

  const again = run(['--concepts', src, '--root', target])
  assert.match(again, /新建 0 页，合并 2 页/)
})
