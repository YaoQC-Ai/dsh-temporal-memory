import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { apply as applyIndex } from '../index.js'
import { compileAll } from '../compile.js'
import { apply as applyTools } from '../tools.js'
import { classifyTurn } from '../lib/classify.js'
import { listConcepts, readConcept } from '../lib/concepts.js'
import {
  getJournalEntry,
  journalCovers,
  journalPath,
  journalRecall,
  listJournalEntries,
  readJournalMarkdown,
  rebuildJournalDays,
} from '../lib/journal.js'
import { Store } from '../lib/store.js'
import { dateKey, dayRange, zonedTimeToUtc } from '../lib/time.js'

const TZ = 'Asia/Shanghai'
const AT = (h = 10) => zonedTimeToUtc(2026, 10, 20, h, 0, 0, TZ)
const KEY = '2026-10-20'

function tmpRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tmem-int-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** 日记由 Agent 写：测试里直接落文件，mtime 可选。 */
function writeJournal(root, key, namespace, body, mtimeMs) {
  const file = journalPath(root, key, namespace)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, body)
  if (mtimeMs) {
    const secs = mtimeMs / 1000
    fs.utimesSync(file, secs, secs)
  }
  return file
}

function dataRoot(root) {
  return path.join(root, 'memory', 'temporal')
}

function makeCtx(extra = {}) {
  const map = new Map()
  return {
    map,
    tools: { register: (def) => map.set(def.name, def) },
    logger: () => ({ info() {}, warn() {} }),
    ...extra,
  }
}

function snap(id, title, events) {
  return { session: { id, title }, inheritedEventCount: 0, events }
}

function userEvent(seq, time, text) {
  return { type: 'user/message', seq, time, data: { content: [{ type: 'text', text }], source: { kind: 'user' } } }
}

function rec(over = {}) {
  return {
    id: over.id || `m_${Math.random().toString(36).slice(2)}`,
    kind: 'event',
    text: '部署示例网关',
    status: 'active',
    event_start_ms: AT(),
    event_end_ms: AT() + 60_000,
    time_precision: 'minute',
    time_basis: 'stated',
    recorded_at: AT() + 1000,
    source: { session: 'sess_a', seq_from: 1, seq_to: 1 },
    ...over,
  }
}

function toolsWith(ctxExtra = {}) {
  return (root, config = {}) => {
    const ctx = makeCtx(ctxExtra)
    applyTools(ctx, { dir: root, timeZone: TZ, ...config })
    return { ctx, tools: ctx.map }
  }
}

test('namespace A/B：L2、索引、工具、概念、注入互不可见', async (t) => {
  const root = tmpRoot(t)
  const snapshot = {
    sess_a: snap('sess_a', 'A 会话', [userEvent(1, AT(), '工作区A部署示例网关')]),
    sess_b: snap('sess_b', 'B 会话', [userEvent(1, AT(), '工作区B部署示例系统')]),
  }
  const ctxA = makeCtx({ sessionQuery: { async readSession(id) { return snapshot[id] } } })
  const ctxB = makeCtx({ sessionQuery: { async readSession(id) { return snapshot[id] } } })
  applyTools(ctxA, { dir: root, timeZone: TZ, namespace: 'A' })
  applyTools(ctxB, { dir: root, timeZone: TZ, namespace: 'B' })
  const store = new Store(dataRoot(root))
  store.append([
    rec({ id: 'm_a', text: '工作区A的决定：示例网关', namespace: 'A', source: { session: 'sess_a', seq_from: 1, seq_to: 1 } }),
    rec({ id: 'm_b', text: '工作区B的决定：示例系统', namespace: 'B', source: { session: 'sess_b', seq_from: 1, seq_to: 1 } }),
  ])

  writeJournal(dataRoot(root), KEY, 'A', `# ${KEY}\n\n工作区A部署示例网关\n`)
  writeJournal(dataRoot(root), KEY, 'B', `# ${KEY}\n\n工作区B部署示例系统\n`)

  const aJournal = await ctxA.map.get('memory_journal').execute({ date: KEY })
  assert.equal(aJournal.status, 'ok')
  assert.match(aJournal.excerpt, /工作区A部署示例网关/)
  assert.doesNotMatch(aJournal.excerpt, /工作区B部署示例系统/)
  assert.equal(aJournal.path, journalPath(dataRoot(root), KEY, 'A'))

  const bJournal = await ctxB.map.get('memory_journal').execute({ date: KEY })
  assert.equal(bJournal.status, 'ok')
  assert.match(bJournal.excerpt, /工作区B部署示例系统/)
  assert.doesNotMatch(bJournal.excerpt, /工作区A部署示例网关/)
  assert.equal(listJournalEntries(dataRoot(root), 'A').length, 1)
  assert.equal(listJournalEntries(dataRoot(root), 'B').length, 1)

  const day = await ctxA.map.get('memory_day').execute({ date: KEY })
  assert.deepEqual(day.items.flatMap((g) => g.items).map((i) => i.id), ['m_a'])
  const search = await ctxA.map.get('memory_search').execute({ query: '决定', date_from: KEY, date_to: KEY })
  assert.deepEqual(search.items.map((i) => i.id), ['m_a'])
  const timeline = await ctxA.map.get('memory_timeline').execute({ topic: '决定' })
  assert.deepEqual(timeline.items.map((i) => i.id), ['m_a'])
  assert.equal((await ctxA.map.get('memory_get').execute({ id: 'm_b' })).status, 'no_match')
  assert.equal((await ctxA.map.get('memory_correct').execute({ target_id: 'm_b', text: '越权更正' }, { agent: { session: { seq: 1 } } })).status, 'no_match')
  assert.equal((await ctxA.map.get('memory_forget').execute({ id: 'm_b' }, { agent: { session: { seq: 1 } } })).status, 'no_match')

  await ctxA.map.get('memory_save').execute({ title: 'A 概念', content: '工作区A的结论' }, { agent: { session: { seq: 1 } } })
  await ctxB.map.get('memory_save').execute({ title: 'B 概念', content: '工作区B的结论' }, { agent: { session: { seq: 1 } } })
  assert.ok(readConcept(dataRoot(root), 'A 概念', 'A'))
  assert.equal(readConcept(dataRoot(root), 'A 概念', 'B'), null)
  assert.ok(readConcept(dataRoot(root), 'B 概念', 'B'))
  assert.equal(readConcept(dataRoot(root), 'B 概念', 'A'), null)
  assert.deepEqual(listConcepts(dataRoot(root), { namespace: 'A' }).map((c) => c.slug), ['A 概念'])

  // 注入走 index.js：同样的时间问句，只能拿到本空间的记录。
  const todayStart = dayRange(dateKey(Date.now(), TZ), TZ).startMs
  const yesterdayStart = todayStart - 86_400_000
  store.append([
    rec({ id: 'm_inj_a', text: '工作区A机密：示例网关九点部署', namespace: 'A', event_start_ms: yesterdayStart + 3_600_000, event_end_ms: yesterdayStart + 3_660_000, recorded_at: yesterdayStart + 3_600_000 }),
    rec({ id: 'm_inj_b', text: '工作区B机密：示例系统十点部署', namespace: 'B', event_start_ms: yesterdayStart + 4_600_000, event_end_ms: yesterdayStart + 4_660_000, recorded_at: yesterdayStart + 4_600_000 }),
  ])
  const makeIndexCtx = () => {
    const handlers = new Map()
    return {
      handlers,
      on: (type, fn) => handlers.set(type, fn),
      logger: () => ({ info() {}, warn() {} }),
    }
  }
  const runInjection = async (namespace, sessionId) => {
    const ictx = makeIndexCtx()
    applyIndex(ictx, { dir: root, timeZone: TZ, namespace })
    const agent = { session: { id: sessionId, surface: { replaceGeneration: 1 } } }
    const decision = await ictx.handlers.get('agent/pre-step')(
      { agent, step: 1, signal: undefined },
      async () => ({ kind: 'continue', messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '昨天定了什么？' }] }] }),
    )
    assert.equal(decision.messages.length, 2)
    return decision.messages[1].content[0].text
  }
  const blockA = await runInjection('A', 'sess_inj_a')
  assert.match(blockA, /工作区A机密/)
  assert.doesNotMatch(blockA, /工作区B机密/)
  const blockB = await runInjection('B', 'sess_inj_b')
  assert.match(blockB, /工作区B机密/)
  assert.doesNotMatch(blockB, /工作区A机密/)
})

test('L3 更正/删除传播：当前结论与正文不再保留旧事实', async (t) => {
  const root = tmpRoot(t)
  const ctx = makeCtx()
  applyTools(ctx, { dir: root, timeZone: TZ })
  const exec = { agent: { id: 'sess_x', session: { seq: 12 } } }
  const saved = await ctx.map.get('memory_save').execute({
    title: '网关端口',
    content: '示例网关端口是 8080，使用自签证书。',
    domain: 'execution',
  }, exec)
  assert.ok(saved.id)
  let md = readConcept(dataRoot(root), '网关端口')
  assert.match(md, /8080/)

  const fixed = await ctx.map.get('memory_correct').execute({
    target_id: saved.id,
    text: '示例网关端口改为 8081。',
  }, exec)
  assert.equal(fixed.status, 'ok')
  assert.ok(fixed.concepts_corrected >= 1)
  md = readConcept(dataRoot(root), '网关端口')
  assert.match(md, /状态: needs-update/)
  const core = (md.split('## 核心内容')[1] || '').split('## ')[0]
  assert.match(core, /8081/)
  assert.doesNotMatch(core, /8080/)
  assert.doesNotMatch(md, /来源记录:\n(?: {2}- .*\n)* {2}- ".?m_/, '旧来源 id 应被替换')
  assert.match(md, new RegExp(fixed.id))

  await ctx.map.get('memory_forget').execute({ id: fixed.id }, exec)
  md = readConcept(dataRoot(root), '网关端口')
  assert.match(md, /状态: needs-update/)
  assert.doesNotMatch(md, /8081/)
  assert.match(md, /来源记录已删除，原结论已移除/)
})

test('同轮两条事实只删被删的那条，日记只掉命中行', async (t) => {
  const root = tmpRoot(t)
  const store = new Store(dataRoot(root))
  const text = '端口改成 8080。我还喜欢美式咖啡。'
  const { records } = classifyTurn({
    sessionId: 'sess_split',
    turn: 1,
    userMessages: [{ text, time: AT(), seq: 1, tz: TZ }],
    assistantText: '',
    toolResults: [],
    turnStatus: 'completed',
    recordedAt: AT() + 1000,
    seqFrom: 1,
    seqTo: 1,
    config: { timeZone: TZ, maxRecordsPerTurn: 8 },
  })
  assert.equal(records.length, 2)
  store.append(records)
  const stored = store.readAll()
  const target = stored.find((r) => r.text.includes('美式'))
  const keep = stored.find((r) => r.text.includes('8080'))
  writeJournal(dataRoot(root), KEY, 'default', `# ${KEY}\n\n端口改成 8080。\n\n我还喜欢美式咖啡。\n`)
  let md = readJournalMarkdown(dataRoot(root), KEY)
  assert.match(md, /8080/)
  assert.match(md, /美式咖啡/)

  store.delete(target.id, 'user-request')
  store.recordDeletedRange(target)
  rebuildJournalDays({ root: dataRoot(root), keys: [KEY], scrubTexts: [target.text] })
  md = readJournalMarkdown(dataRoot(root), KEY)
  assert.match(md, /8080/)
  assert.doesNotMatch(md, /美式咖啡/)
  assert.deepEqual(store.readAll().map((r) => r.id), [keep.id])
})

test('清理覆盖：partial/stale 不删，补记至少保留一个周期', async (t) => {
  const root = dataRoot(tmpRoot(t))
  const store = new Store(root)
  const old = Date.now() - 40 * 86_400_000
  store.append([
    rec({ id: 'm_old', recorded_at: old, event_start_ms: old, event_end_ms: old + 60_000 }),
    rec({ id: 'm_stale', recorded_at: old + 1000, event_start_ms: old + 86_400_000, event_end_ms: old + 86_400_000 + 60_000 }),
    rec({ id: 'm_back', recorded_at: Date.now(), event_start_ms: old - 5 * 86_400_000, event_end_ms: old - 5 * 86_400_000 + 60_000 }),
  ])
  const partial = store.prune(5, {
    tz: TZ,
    journalCoverage: (record) => ({ covered: false, reason: record.id === 'm_old' ? 'journal_partial' : 'journal_stale' }),
  })
  assert.equal(partial.removed, 0)
  assert.equal(partial.retained_reasons.journal_partial, 1)
  assert.equal(partial.retained_reasons.journal_stale, 1)

  const pruned = store.prune(5, {
    tz: TZ,
    journalCoverage: () => ({ covered: true }),
  })
  assert.equal(pruned.removed, 2)
  assert.deepEqual(store.readAll().map((r) => r.id), ['m_back'])
})

test('日记比最后一条记录旧就算 stale，不把旧日记说成 ok', async (t) => {
  const root = dataRoot(tmpRoot(t))
  const store = new Store(root)
  const first = rec({ id: 'm_first', text: '部署示例网关', recorded_at: AT() + 1000 })
  store.append([first])
  writeJournal(root, KEY, 'default', `# ${KEY}\n\n部署示例网关\n`, AT() + 10_000)
  assert.equal(journalCovers(root, KEY, { namespace: 'default', latestRecordedAt: first.recorded_at }).covered, true)

  const later = rec({ id: 'm_later', text: '又改了一次', recorded_at: AT() + 30_000, source: { session: 'sess_a', seq_from: 2, seq_to: 2 } })
  store.append([later])
  const recall = journalRecall({ root, records: store.readAll(), fromMs: AT(), toMs: AT() + 86_400_000, tz: TZ, nowMs: AT() + 40_000 })
  assert.equal(recall.status, 'partial')
  assert.ok(recall.stale.includes(KEY))
  assert.equal(journalCovers(root, KEY, { namespace: 'default', latestRecordedAt: later.recorded_at }).covered, false)
})

test('手写日记不需要 sidecar 也算正常日记', async (t) => {
  const root = dataRoot(tmpRoot(t))
  writeJournal(root, KEY, 'default', `# ${KEY}\n\n手写日记\n`)
  const entry = getJournalEntry(root, KEY)
  assert.equal(entry.author, 'agent')
  assert.ok(entry.authored_at > 0)
  const recall = journalRecall({ root, records: [], fromMs: AT(), toMs: AT() + 86_400_000, tz: TZ })
  assert.equal(recall.status, 'ok')
  assert.equal(recall.items[0].excerpt, `# ${KEY}\n\n手写日记\n`)
})

test('L1 清理后 memory_journal 仍能读到日记', async (t) => {
  const root = tmpRoot(t)
  const ctx = makeCtx()
  applyTools(ctx, { dir: root, timeZone: TZ })
  const store = new Store(dataRoot(root))
  store.append([rec({ id: 'm_gone', text: '部署示例网关' })])
  writeJournal(dataRoot(root), KEY, 'default', `# ${KEY}\n\n部署示例网关\n`)
  store.delete('m_gone', 'retention')
  const read = await ctx.map.get('memory_journal').execute({ date: KEY })
  assert.equal(read.status, 'ok')
  assert.match(read.excerpt, /部署示例网关/)
  assert.ok(read.authored_at > 0)
})

test('L1 清理后 scope=l0 仍能用会话目录找到 L0', async (t) => {
  const root = tmpRoot(t)
  const ctx = makeCtx({ sessionQuery: { async readSession(id) {
    return snap(id, '示例网关', [userEvent(1, AT(), '部署示例网关')])
  } } })
  applyTools(ctx, { dir: root, timeZone: TZ })
  const store = new Store(dataRoot(root))
  store.append([rec({ id: 'm_gone', text: '部署示例网关' })])
  store.registerSession('sess_a', { atMs: AT(), tz: TZ })
  store.delete('m_gone', 'retention')
  const res = await ctx.map.get('memory_search').execute({ scope: 'l0', query: '示例网关' })
  assert.notEqual(res.status, 'no_l0_sessions')
  assert.equal(res.status, 'ok')
  assert.ok(res.items.length >= 1)
})

test('同轮凭据不连坐普通偏好', () => {
  const { records } = classifyTurn({
    sessionId: 'sess_p',
    turn: 1,
    userMessages: [{ text: '我喜欢美式咖啡。我的 api_key = sk-abcdefghijklmnop1234567890。', time: AT(), seq: 1, tz: TZ }],
    assistantText: '',
    toolResults: [],
    turnStatus: 'completed',
    recordedAt: AT() + 1000,
    seqFrom: 1,
    seqTo: 1,
    config: { timeZone: TZ, maxRecordsPerTurn: 8 },
  })
  const pref = records.find((r) => r.text.includes('美式'))
  assert.ok(pref)
  assert.equal(pref.sensitivity, 'normal')
  assert.doesNotMatch(pref.text, /sk-abcdef/)
})

test('supersede 触发 needs-update 且冲突块非空', async (t) => {
  const root = dataRoot(tmpRoot(t))
  const store = new Store(root)
  store.append([
    rec({ id: 'm_old', kind: 'fact', text: '端口是 8080', topics: ['示例网关'], event_start_ms: AT(9), status: 'superseded', superseded_by: 'm_new' }),
    rec({ id: 'm_new', kind: 'correction', text: '端口是 8081', topics: ['示例网关'], event_start_ms: AT(10) }),
  ])
  const res = compileAll(store, root, { timeZone: TZ })
  assert.equal(res.pages.length, 1)
  const md = readConcept(root, '示例网关')
  assert.match(md, /状态: needs-update/)
  assert.match(md, /## 冲突与待确认\n\n- .*8080/)
  assert.doesNotMatch(md, /## 冲突与待确认\n\n- （无）/)
})
