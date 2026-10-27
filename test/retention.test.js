import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { apply } from '../index.js'
import { journalPath } from '../lib/journal.js'
import { Store } from '../lib/store.js'
import { DAY_MS, dateKey } from '../lib/time.js'

const TZ = 'Asia/Shanghai'

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tmem-retention-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

async function waitFor(read, timeoutMs = 2000) {
  const start = Date.now()
  for (;;) {
    const value = read()
    if (value) return value
    if (Date.now() - start > timeoutMs) throw new Error('等待维护审计超时')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

function setup(t, journalMtime) {
  const home = tmpDir(t)
  const dataRoot = path.join(home, 'memory', 'temporal')
  const now = Date.now()
  const old = now - 200 * DAY_MS
  const key = dateKey(old, TZ)
  const store = new Store(dataRoot)
  store.append([{
    id: 'm_old_retention',
    kind: 'event',
    text: '两百天前的旧记录',
    status: 'active',
    event_start_ms: old,
    event_end_ms: old + 60_000,
    time_precision: 'minute',
    time_basis: 'stated',
    recorded_at: old,
    source: { session: 'sess_old', seq_from: 1, seq_to: 1 },
    namespace: 'default',
    entities: [],
    topics: [],
  }])

  const file = journalPath(dataRoot, key)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  if (journalMtime) {
    fs.writeFileSync(file, `# ${key}\n\n两百天前那天写下的日记。\n`)
    const secs = journalMtime / 1000
    fs.utimesSync(file, secs, secs)
  }

  const handlers = new Map()
  apply({
    on: (type, fn) => handlers.set(type, fn),
    logger: () => ({ info() {}, warn() {} }),
    get: () => undefined,
  }, { dir: home, timeZone: TZ, retentionDays: 90 })

  return { dataRoot, store, handlers }
}

async function maintenanceEvent(dataRoot) {
  const auditFile = path.join(dataRoot, 'audit', `${new Date().toISOString().slice(0, 10)}.jsonl`)
  const line = await waitFor(() => {
    if (!fs.existsSync(auditFile)) return null
    return fs.readFileSync(auditFile, 'utf8').split('\n').find((row) => /"type":"maintenance"/.test(row)) || null
  })
  return JSON.parse(line)
}

test('维护任务：日记写于记录之后时清理 L1，并把删除条数写进 audit', async (t) => {
  const { dataRoot, store, handlers } = setup(t, Date.now())
  handlers.get('agent/created')({ agent: { session: { id: 'sess_new' } }, source: 'startup' })
  const event = await maintenanceEvent(dataRoot)
  assert.equal(event.l1_pruned, 1)
  assert.equal(event.l1_uncovered, 0)
  assert.deepEqual(store.readAll(), [])
})

test('维护任务：日记写于记录之前（没覆盖当天后半段）时不清理', async (t) => {
  const { dataRoot, store, handlers } = setup(t, Date.now() - 300 * DAY_MS)
  handlers.get('agent/created')({ agent: { session: { id: 'sess_new' } }, source: 'startup' })
  const event = await maintenanceEvent(dataRoot)
  assert.equal(event.l1_pruned, 0)
  assert.equal(event.l1_uncovered, 1)
  assert.equal(store.readAll().length, 1)
})
