import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { apply } from '../tools.js'
import { listConcepts, readConcept, saveConcept } from '../lib/concepts.js'
import { growMonthly } from '../lib/profile.js'
import { dateKey, dayRange } from '../lib/time.js'
import { Store } from '../lib/store.js'

const TZ = 'Asia/Shanghai'
const NOW = Date.now()
const TODAY = dateKey(NOW, TZ)
const YESTERDAY = dateKey(NOW - 86_400_000, TZ)
const Y_START = dayRange(YESTERDAY, TZ).startMs

function tmpRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tmem-t-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
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

function setup(t, extra = {}, ctxExtra = {}) {
  const root = tmpRoot(t)
  const ctx = makeCtx(ctxExtra)
  apply(ctx, { dir: root, timeZone: TZ, ...extra })
  return { root, ctx, tools: ctx.map }
}

function setupWithL0(t, snapshots, extra = {}) {
  const root = tmpRoot(t)
  const ctx = makeCtx({ sessionQuery: l0Of(snapshots) })
  apply(ctx, { dir: root, timeZone: TZ, ...extra })
  return { root, tools: ctx.map }
}

function seed(root, records) {
  new Store(dataRoot(root)).append(records)
}

function rec(over = {}) {
  const start = over.event_start_ms ?? Y_START + 10 * 3_600_000
  return {
    kind: 'event',
    text: '例行部署完成',
    status: 'active',
    event_start_ms: start,
    event_end_ms: start + 60_000,
    time_precision: 'minute',
    time_basis: 'stated',
    recorded_at: start + 1000,
    topics: [],
    entities: [],
    source: { session: 'sess_a', seq_from: 1, seq_to: 2 },
    ...over,
  }
}

const DEC = rec({ id: 'm_dec', kind: 'decision', text: '确定了示例网关就用 8080 端口', topics: ['示例网关'], entities: ['8080'] })
const EVT = rec({ id: 'm_evt', event_start_ms: Y_START + 11 * 3_600_000 })
const UNK = rec({ id: 'm_unk', kind: 'fact', text: '端口 8080', event_start_ms: null, event_end_ms: null, time_precision: 'unknown' })

const exec = { agent: { id: 'sess_x', session: { seq: 12 } } }

function l0Event(seq, time, type, data) {
  return { type, seq, time, data }
}

function userEvent(seq, time, text) {
  return l0Event(seq, time, 'user/message', { content: [{ type: 'text', text }], source: { kind: 'user' } })
}

function assistantEvent(seq, time, text) {
  return l0Event(seq, time, 'assistant/message', { message: { content: [{ type: 'text', text }] } })
}

function summaryEvent(seq, time, text) {
  return l0Event(seq, time, 'compaction/summary', { summary: text })
}

function snapshot(id, title, events) {
  return { session: { id, title }, inheritedEventCount: 0, events }
}

function l0Of(map) {
  return {
    async readSession(id) {
      if (!map[id]) throw new Error(`missing session ${id}`)
      return map[id]
    },
  }
}

function daySnapshots() {
  return {
    sess_a: snapshot('sess_a', '示例网关', [
      userEvent(1, Y_START + 10 * 3_600_000, '确定示例网关用 8080'),
      assistantEvent(2, Y_START + 10 * 3_600_000 + 300_000, '好的'),
      summaryEvent(3, Y_START + 10 * 3_600_000 + 600_000, '讨论并确认示例网关端口与证书'),
    ]),
    sess_b: snapshot('sess_b', '示例系统', [
      userEvent(1, Y_START + 9 * 3_600_000, '把示例系统整理一下'),
      assistantEvent(2, Y_START + 9 * 3_600_000 + 300_000, '已整理完成'),
    ]),
  }
}

test('注册 9 个模型工具', (t) => {
  const { tools } = setup(t)
  assert.deepEqual([...tools.keys()].sort(), [
    'memory_correct', 'memory_day', 'memory_forget', 'memory_get',
    'memory_health', 'memory_journal', 'memory_save', 'memory_search',
    'memory_timeline',
  ])
})

test('memory_search 按日期与关键词检索，返回双时间与状态', async (t) => {
  const { root, tools } = setup(t)
  seed(root, [DEC, EVT, UNK])
  const res = await tools.get('memory_search').execute({ query: '示例网关', date_from: YESTERDAY, date_to: YESTERDAY })
  assert.equal(res.status, 'ok')
  assert.equal(res.total, 1)
  const item = res.items[0]
  assert.equal(item.id, 'm_dec')
  assert.match(item.time_label, new RegExp(YESTERDAY))
  assert.equal(item.time_precision, 'minute')
  assert.equal(item.source.session, 'sess_a')
})

test('memory_search summary 模式只留短字段', async (t) => {
  const { root, tools } = setup(t)
  seed(root, [DEC, EVT])
  const res = await tools.get('memory_search').execute({ date_from: YESTERDAY, date_to: YESTERDAY, mode: 'summary' })
  assert.equal(res.returned, 2)
  assert.deepEqual(Object.keys(res.items[0]).sort(), ['id', 'kind', 'status', 'text', 'time_label'])
  assert.equal(res.mode, 'summary')
})

test('memory_search 分页 cursor', async (t) => {
  const { root, tools } = setup(t)
  seed(root, [DEC, EVT])
  const first = await tools.get('memory_search').execute({ date_from: YESTERDAY, date_to: YESTERDAY, limit: 1 })
  assert.equal(first.returned, 1)
  assert.equal(first.truncated, true)
  const second = await tools.get('memory_search').execute({ date_from: YESTERDAY, date_to: YESTERDAY, limit: 1, cursor: first.next_cursor })
  assert.notEqual(second.items[0].id, first.items[0].id)
})

test('memory_search 非法日期抛错', async (t) => {
  const { tools } = setup(t)
  await assert.rejects(() => tools.get('memory_search').execute({ date_from: '10/20' }), /YYYY-MM-DD/)
  await assert.rejects(() => tools.get('memory_search').execute({ date_from: TODAY, date_to: YESTERDAY }), /晚于/)
})

test('memory_day 分组且不写 L2 日记', async (t) => {
  const { root, tools } = setup(t)
  seed(root, [DEC, EVT, UNK])
  const res = await tools.get('memory_day').execute({ date: YESTERDAY })
  assert.equal(res.status, 'ok')
  assert.deepEqual(res.items.map((g) => g.section), ['happened', 'decisions', 'pending'])
  assert.equal(res.layer, 'L1')
  assert.equal(res.journal_path, undefined)
  assert.equal(fs.existsSync(path.join(dataRoot(root), 'journal')), false)
})

test('memory_day 永远只读，不产生任何日记文件', async (t) => {
  const { root, tools } = setup(t)
  seed(root, [DEC])
  const res = await tools.get('memory_day').execute({ date: YESTERDAY })
  assert.equal(res.status, 'ok')
  assert.equal(res.journal_path, undefined)
  assert.equal(fs.existsSync(path.join(dataRoot(root), 'journal')), false)
})

test('memory_day 支持 recorded 视图与时区参数', async (t) => {
  const { root, tools } = setup(t)
  seed(root, [rec({ id: 'm_r', recorded_at: Y_START + 12 * 3_600_000 })])
  const res = await tools.get('memory_day').execute({ date: YESTERDAY, view: 'recorded', tz: 'UTC' })
  assert.equal(res.status, 'ok')
  assert.match(res.coverage, /按记录日归档/)
})

test('memory_journal 只读：传 date 读回正文与文件派生元数据', async (t) => {
  const { root, tools } = setup(t)
  seed(root, [DEC])
  const file = path.join(dataRoot(root), 'journal', `${YESTERDAY}.md`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const body = `# ${YESTERDAY}\n\n今天把写日记这件事交回给 Agent。\n`
  fs.writeFileSync(file, body)

  const res = await tools.get('memory_journal').execute({ date: YESTERDAY })
  assert.equal(res.status, 'ok')
  assert.equal(res.route, 'journal')
  assert.equal(res.path, file)
  assert.equal(res.bytes, Buffer.byteLength(body))
  assert.equal(res.excerpt, body)
  assert.ok(res.authored_at > 0)
})

test('memory_journal 不传 date 时只列已有日期，绝不写文件', async (t) => {
  const { root, tools } = setupWithL0(t, daySnapshots())
  seed(root, [DEC])
  const empty = await tools.get('memory_journal').execute({})
  assert.equal(empty.status, 'no_data')
  assert.equal(fs.existsSync(path.join(dataRoot(root), 'journal')), false)

  const file = path.join(dataRoot(root), 'journal', `${YESTERDAY}.md`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '# 手写日记\n\n原样保留。\n')
  const res = await tools.get('memory_journal').execute({})
  assert.equal(res.status, 'ok')
  assert.deepEqual(res.items.map((entry) => entry.key), [YESTERDAY])
  assert.equal(fs.readFileSync(file, 'utf8'), '# 手写日记\n\n原样保留。\n')
})

test('memory_journal 那天没写就如实返回 no_data', async (t) => {
  const { root, tools } = setup(t)
  seed(root, [DEC])
  const res = await tools.get('memory_journal').execute({ date: YESTERDAY })
  assert.equal(res.status, 'no_data')
  assert.match(res.message, /尚未撰写/)
  assert.equal(fs.existsSync(path.join(dataRoot(root), 'journal')), false)
})

test('模糊时间先读 L2，缺失时回退 L1 且说明原因', async (t) => {
  const { root, tools } = setup(t)
  seed(root, [DEC])
  const file = path.join(dataRoot(root), 'journal', `${YESTERDAY}.md`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `# ${YESTERDAY}\n\n示例网关确认走 8080。\n`)
  const hit = await tools.get('memory_search').execute({ query: '昨天发生了什么' })
  assert.equal(hit.route, 'journal')
  assert.equal(hit.status, 'ok')
  assert.equal(hit.items[0].date, YESTERDAY)
  assert.match(hit.items[0].excerpt, /8080/)

  const fallback = setup(t)
  seed(fallback.root, [DEC])
  const miss = await fallback.tools.get('memory_search').execute({ query: '昨天发生了什么' })
  assert.equal(miss.route, 'l1-fallback')
  assert.equal(miss.fallback_reason, 'journal_missing')
  assert.equal(miss.fallback_mode, 'time_only')
  assert.equal(miss.total, 1)
  assert.equal(miss.items[0].id, 'm_dec')
  assert.match(miss.message, /没有日记/)
})

test('memory_forget 从日记里按整行删除被删句子', async (t) => {
  const { root, tools } = setup(t)
  seed(root, [
    { ...DEC, text: '确定示例网关用 8080', source: { session: 'sess_a', seq_from: 1, seq_to: 1 } },
    rec({ id: 'm_b', kind: 'event', text: '整理了示例系统', event_start_ms: Y_START + 9 * 3_600_000, source: { session: 'sess_b', seq_from: 1, seq_to: 2 } }),
  ])
  const file = path.join(dataRoot(root), 'journal', `${YESTERDAY}.md`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `# ${YESTERDAY}\n\n上午：确定示例网关用 8080。\n\n下午：整理了示例系统。\n`)

  const res = await tools.get('memory_forget').execute({ id: 'm_dec' }, exec)
  assert.equal(res.status, 'ok')
  assert.deepEqual(res.journal_days, [{ key: YESTERDAY, scrubbed: true }])
  const md = fs.readFileSync(file, 'utf8')
  assert.doesNotMatch(md, /8080/)
  assert.match(md, /整理了示例系统/)
  const deleted = JSON.parse(fs.readFileSync(path.join(dataRoot(root), 'state', 'deleted.json'), 'utf8'))
  assert.equal(deleted.ranges[0].session, 'sess_a')
  assert.equal(deleted.ranges[0].scope, 'record')
  assert.equal(deleted.ranges[0].hashes.length, 1)
})

test('memory_correct 不碰日记：历史照旧写在那里', async (t) => {
  const { root, tools } = setup(t)
  seed(root, [
    DEC,
    rec({ id: 'm_b', kind: 'event', text: '整理了示例系统', event_start_ms: Y_START + 9 * 3_600_000, source: { session: 'sess_b', seq_from: 1, seq_to: 2 } }),
  ])
  const file = path.join(dataRoot(root), 'journal', `${YESTERDAY}.md`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const body = `# ${YESTERDAY}\n\n示例网关确定用 8080。\n`
  fs.writeFileSync(file, body)

  const res = await tools.get('memory_correct').execute({
    target_id: 'm_dec',
    text: '示例网关改用 8081 端口',
    event_time: YESTERDAY,
  }, exec)
  assert.equal(res.status, 'ok')
  assert.equal(res.journal_days, undefined)
  assert.equal(fs.readFileSync(file, 'utf8'), body)
})

test('memory_health 报告 L0–L4 分层与画像状态', async (t) => {
  const { root, tools } = setupWithL0(t, daySnapshots())
  seed(root, [DEC])
  const res = await tools.get('memory_health').execute()
  assert.equal(res.status, 'ok')
  assert.equal(res.layers.L0.status, 'available')
  assert.equal(res.layers.L1.retention_days, 365)
  assert.equal(res.layers.L2.status, 'agent-written')
  assert.equal(res.layers.L3.status, 'active')
  // L4 不再硬编码：开关默认关闭时就是 disabled，但仍标 implemented
  assert.equal(res.layers.L4.status, 'disabled')
  assert.equal(res.layers.L4.implemented, true)
  assert.equal(res.growth.enabled, false)
  assert.equal(res.growth.implemented, true)
  assert.equal(res.privacy.enhanced, false)
  assert.equal(res.retention.rule, 'journal_file_newer_than_record')
})

test('memory_health 在画像生成后报 active 与版本号', async (t) => {
  const { root, tools } = setup(t, { growth: { enabled: true } })
  const data = dataRoot(root)
  const base = Date.UTC(2026, 8, 3, 2, 0, 0)
  growMonthly({
    root: data,
    records: Array.from({ length: 8 }, (_, i) => ({
      kind: 'decision',
      text: `第 ${i} 项决定`,
      status: 'active',
      event_start_ms: base + i * 3_600_000,
      recorded_at: base + i * 3_600_000,
      topics: ['示例网关'],
      entities: ['示例网关'],
      namespace: 'default',
    })),
    tz: 'UTC',
    month: '2026-09',
    enabled: true,
  })

  const res = await tools.get('memory_health').execute()
  assert.equal(res.layers.L4.status, 'active')
  assert.equal(res.layers.L4.version, '2026-09')
  assert.equal(res.growth.enabled, true)
  assert.equal(res.growth.personality_version, '2026-09')
  assert.equal(typeof res.growth.applied, 'boolean')
})

test('memory_get 命中与未命中', async (t) => {
  const { root, tools } = setup(t)
  seed(root, [DEC])
  const hit = await tools.get('memory_get').execute({ id: 'm_dec' })
  assert.equal(hit.status, 'ok')
  assert.equal(hit.items[0].id, 'm_dec')
  const miss = await tools.get('memory_get').execute({ id: 'm_none' })
  assert.equal(miss.status, 'no_match')
})

test('memory_save 写概念页并记录来源', async (t) => {
  const { root, tools } = toolsAndRoot(t)
  const res = await tools.get('memory_save').execute({
    title: '示例网关端口',
    content: '示例网关监听 8080，使用自签证书。',
    domain: 'execution',
    aliases: ['gateway'],
    event_time: '2026-10-12',
  }, exec)
  assert.equal(res.status, 'ok')
  assert.equal(res.created, true)
  const md = readConcept(dataRoot(root), '示例网关端口')
  assert.match(md, /领域: execution/)
  assert.match(md, /来源:\n  - session\/sess_x seq 12/)
  assert.match(md, /事件时间: "2026-10-11T16:00:00.000Z"/)
  assert.equal(listConcepts(dataRoot(root)).length, 1)
})

function toolsAndRoot(t, extra = {}) {
  const { root, tools } = setup(t, extra)
  return { root, tools }
}

test('memory_save 参数缺失由 store 拒绝', async (t) => {
  const { tools } = setup(t)
  await assert.rejects(() => tools.get('memory_save').execute({ title: '只有标题' }, exec), /content/)
})

test('memory_correct 取代旧记录且旧记录仍可查', async (t) => {
  const { root, tools } = setup(t)
  seed(root, [DEC])
  const res = await tools.get('memory_correct').execute({ target_id: 'm_dec', text: '示例网关改用 8081 端口' }, exec)
  assert.equal(res.status, 'ok')
  assert.equal(res.superseded, 'm_dec')
  const old = await tools.get('memory_get').execute({ id: 'm_dec' })
  assert.equal(old.items[0].status, 'superseded')
  assert.equal(old.items[0].superseded_by, res.id)
  const hist = await tools.get('memory_search').execute({ query: '示例网关', status: 'history' })
  assert.equal(hist.total, 2)
  const active = await tools.get('memory_search').execute({ query: '示例网关' })
  assert.equal(active.total, 1)
  assert.equal(active.items[0].kind, 'correction')
})

test('memory_correct 未知目标与空文本', async (t) => {
  const { root, tools } = setup(t)
  seed(root, [DEC])
  const miss = await tools.get('memory_correct').execute({ target_id: 'm_none', text: 'x' })
  assert.equal(miss.status, 'no_match')
  await assert.rejects(() => tools.get('memory_correct').execute({ target_id: 'm_dec', text: '  ' }), /text/)
})

test('memory_forget 删除并写墓碑', async (t) => {
  const { root, tools } = setup(t)
  seed(root, [DEC])
  const res = await tools.get('memory_forget').execute({ id: 'm_dec' }, exec)
  assert.equal(res.status, 'ok')
  assert.equal(res.deleted, true)
  const again = await tools.get('memory_forget').execute({ id: 'm_dec' }, exec)
  assert.equal(again.status, 'no_match')
  const files = fs.readdirSync(path.join(dataRoot(root), 'events'))
  const raw = files.map((f) => fs.readFileSync(path.join(dataRoot(root), 'events', f), 'utf8')).join('')
  assert.match(raw, /"_type":"tombstone"/)
})

test('memory_timeline 按主题与时间范围', async (t) => {
  const { root, tools } = setup(t)
  seed(root, [
    rec({ id: 'm_1', kind: 'decision', text: '示例网关立项', topics: ['示例网关'], event_start_ms: Y_START + 9 * 3_600_000 }),
    rec({ id: 'm_2', kind: 'outcome', text: '示例网关上线', topics: ['示例网关'], event_start_ms: Y_START + 12 * 3_600_000 }),
  ])
  const res = await tools.get('memory_timeline').execute({ topic: '示例网关' })
  assert.deepEqual(res.items.map((i) => i.id), ['m_1', 'm_2'])
  await assert.rejects(() => tools.get('memory_timeline').execute({ topic: 'x', from: 'bad' }), /YYYY-MM-DD/)
})

test('memory_health 汇总记录、分片与概念页', async (t) => {
  const { root, tools } = setup(t)
  seed(root, [DEC, EVT])
  await tools.get('memory_save').execute({ title: '健康页', content: '内容' }, exec)
  const res = await tools.get('memory_health').execute()
  assert.equal(res.status, 'ok')
  assert.equal(res.records, 3)
  assert.equal(res.active, 3)
  assert.equal(res.concepts, 1)
  assert.equal(res.namespace, 'default')
  assert.equal(res.timeZone, TZ)
  assert.equal(res.inject.maxTokens, 1200)
  assert.equal(res.configFile.endsWith('config.json'), true)
})

test('memory_save 写入前脱敏', async (t) => {
  const { root, tools } = toolsAndRoot(t)
  const res = await tools.get('memory_save').execute({
    title: '凭据页',
    content: '部署 token = ghp_abcdefghijklmnop123456',
  }, exec)
  assert.equal(res.redacted, true)
  const md = readConcept(dataRoot(root), '凭据页')
  assert.doesNotMatch(md, /ghp_/)
  assert.match(md, /已脱敏/)
})

test('memory_correct 脱敏且不降低隐私级别', async (t) => {
  const { root, tools } = setup(t)
  seed(root, [rec({ id: 'm_priv', text: '密码是 hunter2hunter2', sensitivity: 'private' })])
  const res = await tools.get('memory_correct').execute({
    target_id: 'm_priv',
    text: '新的密码是 hunter2hunter3',
  }, exec)
  assert.equal(res.redacted, true)
  const fixed = await tools.get('memory_get').execute({ id: res.id })
  assert.equal(fixed.items[0].sensitivity, 'private')
  assert.doesNotMatch(fixed.items[0].text, /hunter2/)
})

test('memory_forget 传播到引用该记录的概念页', async (t) => {
  const { root, tools } = setup(t)
  seed(root, [DEC])
  saveConcept(dataRoot(root), {
    title: '网关约定',
    content: '端口 8080',
    sourceIds: ['m_dec'],
  })
  const res = await tools.get('memory_forget').execute({ id: 'm_dec' }, exec)
  assert.equal(res.status, 'ok')
  assert.equal(res.concepts_marked, 1)
  const md = readConcept(dataRoot(root), '网关约定')
  assert.match(md, /状态: needs-update/)
  assert.doesNotMatch(md, /来源记录:\n  - m_dec/)
})
