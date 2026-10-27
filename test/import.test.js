import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Store } from '../lib/store.js'

const SCRIPT = path.resolve('scripts/import-legacy.mjs')

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tmem-import-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const from = path.join(home, 'memory', 'shortterm')
  fs.mkdirSync(from, { recursive: true })
  fs.writeFileSync(path.join(from, 'sess_legacy.md'), [
    '# 旧会话',
    '',
    '## 2026-10-20T01:02:03Z',
    '[user] 昨天定了方案B',
    '[user] api_key = sk-abcdefghijklmnop1234567890',
    '[assistant] 已记录',
    '',
    '## 2026-10-21T02:03:04Z',
    '[user] 订单号 1234567890123456 已出库',
    '',
  ].join('\n'))
  return { home, from }
}

function run(home, from, extra = []) {
  return execFileSync(process.execPath, [SCRIPT, '--from', from, '--home', home, ...extra], {
    encoding: 'utf8',
  })
}

test('import-legacy 默认 dry-run，不写数据', (t) => {
  const { home, from } = fixture(t)
  const out = run(home, from)
  assert.match(out, /dry-run/)
  assert.equal(fs.existsSync(path.join(home, 'memory', 'temporal', 'events')), false)
})

test('import-legacy 只导入 [user]、跳过凭据且保留业务单号', (t) => {
  const { home, from } = fixture(t)
  run(home, from, ['--yes'])
  const records = new Store(path.join(home, 'memory', 'temporal')).readAll()
  assert.equal(records.length, 2)
  assert.ok(records.some((r) => /方案B/.test(r.text)))
  assert.ok(records.some((r) => /1234567890123456/.test(r.text)))
  assert.equal(records.some((r) => /sk-abcdef/.test(r.text)), false)
  assert.equal(records.every((r) => r.namespace === 'default'), true)
})

test('import-legacy 重复运行按 id 幂等', (t) => {
  const { home, from } = fixture(t)
  run(home, from, ['--yes'])
  const out = run(home, from, ['--yes'])
  assert.match(out, /已写入 0 条/)
  assert.equal(new Store(path.join(home, 'memory', 'temporal')).readAll().length, 2)
})
