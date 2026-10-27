import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  countJournalFiles,
  getJournalEntry,
  journalCovers,
  journalPath,
  journalRecall,
  listJournalEntries,
  readJournalMarkdown,
  rebuildJournalDays,
} from '../lib/journal.js'
import { zonedTimeToUtc } from '../lib/time.js'

const TZ = 'Asia/Shanghai'
const AT = (h = 10) => zonedTimeToUtc(2026, 10, 20, h, 0, 0, TZ)
const KEY = '2026-10-20'

function tmpRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tmem-j-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** 日记由 Agent 写：测试里直接落文件，并按需要设定 mtime。 */
function writeJournal(root, key, body, mtimeMs) {
  const file = journalPath(root, key)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, body)
  if (mtimeMs) {
    const secs = mtimeMs / 1000
    fs.utimesSync(file, secs, secs)
  }
  return file
}

function recordAt(ms, overrides = {}) {
  return {
    id: `m_${ms}`,
    kind: 'event',
    text: '那天记下的事',
    status: 'active',
    event_start_ms: ms,
    event_end_ms: ms + 60_000,
    recorded_at: ms + 30_000,
    source: { session: 'sess_1', seq_from: 1, seq_to: 1 },
    namespace: 'default',
    entities: [],
    topics: [],
    ...overrides,
  }
}

test('getJournalEntry：元数据全部来自文件本身，没有 sidecar', (t) => {
  const root = tmpRoot(t)
  assert.equal(getJournalEntry(root, KEY), null)
  const file = writeJournal(root, KEY, `# ${KEY}\n\n今天把日记交给了 Agent。\n`, AT(23))
  const entry = getJournalEntry(root, KEY)
  assert.equal(entry.path, file)
  assert.equal(entry.author, 'agent')
  assert.equal(entry.authored_at, AT(23))
  assert.equal(entry.bytes, fs.statSync(file).size)
})

test('journalCovers：缺文件与写得更早都不算覆盖', (t) => {
  const root = tmpRoot(t)
  assert.deepEqual(journalCovers(root, KEY), { covered: false, reason: 'journal_missing' })

  writeJournal(root, KEY, '# 早版\n', AT(9))
  assert.deepEqual(
    journalCovers(root, KEY, { latestRecordedAt: AT(22) }),
    { covered: false, reason: 'journal_stale' },
  )
  assert.deepEqual(journalCovers(root, KEY, { latestRecordedAt: AT(8) }), { covered: true, reason: 'ok' })
  assert.deepEqual(journalCovers(root, KEY), { covered: true, reason: 'ok' })
})

test('listJournalEntries：只列日文件，日期倒序，忽略其他文件', (t) => {
  const root = tmpRoot(t)
  writeJournal(root, '2026-10-18', '# 18\n')
  writeJournal(root, '2026-10-20', '# 20\n')
  writeJournal(root, '2026-10-19', '# 19\n')
  fs.writeFileSync(path.join(root, 'journal', 'README.txt'), '不是日记')
  fs.writeFileSync(path.join(root, 'journal', 'by-recorded.md'), '不是日记')
  assert.deepEqual(listJournalEntries(root).map((e) => e.key), ['2026-10-20', '2026-10-19', '2026-10-18'])
  assert.equal(countJournalFiles(root), 3)
  assert.equal(readJournalMarkdown(root, '2026-10-19'), '# 19\n')
})

test('journalRecall：有日记就返回正文摘录与派生元数据', (t) => {
  const root = tmpRoot(t)
  const body = `# ${KEY}\n\n今天把日记的所有权交回给 Agent，插件不再生成。\n`
  writeJournal(root, KEY, body, AT(23))

  const recall = journalRecall({
    root,
    records: [recordAt(AT(20))],
    fromMs: AT(0),
    toMs: AT(24),
    tz: TZ,
  })
  assert.equal(recall.status, 'ok')
  assert.equal(recall.total, 1)
  assert.equal(recall.items[0].date, KEY)
  assert.equal(recall.items[0].authored_at, AT(23))
  assert.equal(recall.items[0].bytes, Buffer.byteLength(body))
  assert.equal(recall.items[0].excerpt, body)
})

test('journalRecall：缺日记或日记写过之后又有新记录时回退 L1', (t) => {
  const root = tmpRoot(t)
  const records = [recordAt(AT(20))]

  const missing = journalRecall({ root, records, fromMs: AT(0), toMs: AT(24), tz: TZ })
  assert.equal(missing.status, 'no_data')
  assert.deepEqual(missing.missing, [KEY])
  assert.equal(missing.fallback, 'l1')
  assert.equal(missing.fallback_reason, 'journal_missing')

  writeJournal(root, KEY, '# 早版\n', AT(12))
  const stale = journalRecall({ root, records, fromMs: AT(0), toMs: AT(24), tz: TZ })
  assert.equal(stale.status, 'partial')
  assert.deepEqual(stale.stale, [KEY])
  assert.equal(stale.fallback_reason, 'journal_stale')
  assert.match(stale.message, /没覆盖后半段/)
})

test('journalRecall：既没日记也没 L1 时如实说不知道', (t) => {
  const root = tmpRoot(t)
  const recall = journalRecall({ root, fromMs: AT(0), toMs: AT(24), tz: TZ })
  assert.equal(recall.status, 'no_data')
  assert.match(recall.message, /不能据此判断/)
  assert.equal(journalRecall({ root }).status, 'no_data')
})

test('rebuildJournalDays：按整行清洗，没有命中就一个字都不改', (t) => {
  const root = tmpRoot(t)
  const body = `# ${KEY}\n\n第一段：示例网关的 token 是 abc123。\n\n第二段：和用户聊了日记的归属。\n`
  const file = writeJournal(root, KEY, body, AT(23))

  assert.deepEqual(rebuildJournalDays({ root, keys: [KEY], scrubTexts: ['abc123'] }), [{ key: KEY, scrubbed: true }])
  const after = fs.readFileSync(file, 'utf8')
  assert.ok(!after.includes('abc123'))
  assert.ok(after.includes('日记的归属'))

  const untouched = fs.readFileSync(file, 'utf8')
  assert.deepEqual(rebuildJournalDays({ root, keys: [KEY], scrubTexts: ['不存在的句子'] }), [])
  assert.equal(fs.readFileSync(file, 'utf8'), untouched)
  assert.deepEqual(rebuildJournalDays({ root, keys: ['2026-10-01'], scrubTexts: ['abc123'] }), [])
})
