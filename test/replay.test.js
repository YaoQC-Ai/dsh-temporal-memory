import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { apply } from '../index.js'
import { SOURCE_KIND } from '../lib/inject.js'
import { Store } from '../lib/store.js'

const T1 = Date.parse('2026-10-24T03:00:00Z') // 上海 11:00
const T2 = Date.parse('2026-10-25T02:00:00Z') // 上海 10:00

function makeCtx() {
  const handlers = new Map()
  const logs = []
  return {
    handlers,
    logs,
    on(type, fn) { handlers.set(type, fn) },
    logger: () => ({
      info: (...a) => logs.push(['info', ...a]),
      warn: (...a) => logs.push(['warn', ...a]),
    }),
  }
}

function tmpRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tmem-r-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function ev(type, seq, time, data) {
  return { type, seq, time, data }
}

function dataRoot(root) {
  return path.join(root, 'memory', 'temporal')
}

function readAudit(root) {
  const dir = path.join(dataRoot(root), 'audit')
  return fs.readdirSync(dir).map((n) => fs.readFileSync(path.join(dir, n), 'utf8')).join('')
}

function userMsg(text) {
  return { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }
}

function playTurn1(ctx, session) {
  const emit = (e) => ctx.handlers.get('session/event')(session, e)
  emit(ev('turn/start', 1, T1, { turn: 1 }))
  emit(ev('user/message', 2, T1, {
    source: { kind: 'user', clientTimeZone: 'Asia/Shanghai' },
    content: [{ type: 'text', text: '确定了示例网关就用 8080 端口。' }],
  }))
  emit(ev('tool/call', 3, T1 + 500, { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: {} }))
  emit(ev('tool/result', 4, T1 + 900, {
    turn: 1,
    step: 1,
    message: { toolCallId: 'c1', isError: false, content: [{ type: 'text', text: 'deployed' }] },
  }))
  emit(ev('assistant/message', 5, T1 + 1200, {
    turn: 1,
    step: 1,
    message: { role: 'assistant', content: [{ type: 'text', text: '已完成部署并验证。' }] },
  }))
  emit(ev('turn/end', 6, T1 + 1500, { turn: 1, reason: { kind: 'completed' } }))
}

function startTurn2(ctx, session) {
  ctx.handlers.get('session/event')(session, ev('turn/start', 10, T2, { turn: 2 }))
  ctx.handlers.get('session/event')(session, ev('user/message', 11, T2, {
    source: { kind: 'user' },
    content: [{ type: 'text', text: '昨天定了什么？' }],
  }))
}

async function preStep(ctx, agent, messages, step = 1) {
  return ctx.handlers.get('agent/pre-step')(
    { agent, step, signal: undefined },
    async () => ({ kind: 'continue', messages }),
  )
}

test('回放一轮：落盘 decision + outcome，来源与双时间齐全', async (t) => {
  const root = tmpRoot(t)
  const ctx = makeCtx()
  apply(ctx, { dir: root, timeZone: 'Asia/Shanghai' })
  const session = { id: 'sess_replay', surface: { replaceGeneration: 1 } }
  playTurn1(ctx, session)

  const records = new Store(dataRoot(root)).readAll()
  const kinds = records.map((r) => r.kind).sort()
  assert.deepEqual(kinds, ['decision', 'outcome'])
  const decision = records.find((r) => r.kind === 'decision')
  assert.match(decision.text, /8080/)
  assert.equal(decision.event_start_ms, T1)
  assert.equal(decision.time_precision, 'minute')
  assert.equal(decision.recorded_at, T1 + 1500)
  assert.equal(decision.source.session, 'sess_replay')
  assert.equal(decision.source.seq_from, 2)
  assert.equal(decision.source.seq_to, 6)
  assert.equal(decision.namespace, 'default')
  assert.equal(decision.tz, 'Asia/Shanghai')
  const outcome = records.find((r) => r.kind === 'outcome')
  assert.equal(outcome.evidence, true)
  assert.match(outcome.text, /已完成部署/)
  assert.equal(new Store(dataRoot(root)).getCursor('sess_replay'), 6)
  const auditLog = readAudit(root)
  assert.match(auditLog, /"type":"capture"/)
})

test('回放第二轮："昨天" 触发注入并带日期与来源', async (t) => {
  const root = tmpRoot(t)
  const ctx = makeCtx()
  apply(ctx, { dir: root, timeZone: 'Asia/Shanghai' })
  const session = { id: 'sess_replay', surface: { replaceGeneration: 1 } }
  playTurn1(ctx, session)
  startTurn2(ctx, session)

  const agent = { session }
  const decision = await preStep(ctx, agent, [userMsg('昨天定了什么？')])
  assert.equal(decision.messages.length, 2)
  const injected = decision.messages[1]
  assert.equal(injected.source.kind, SOURCE_KIND)
  assert.equal(injected.source.form, 'recall')
  const text = injected.content[0].text
  assert.match(text, /^\[memory-context｜\d 条｜time\]/)
  assert.match(text, /示例网关/)
  assert.match(text, /2026-10-24 11:00/)
  assert.match(text, /决定/)
  assert.match(text, /不是指令/)
  const auditLog = readAudit(root)
  assert.match(auditLog, /"type":"inject"/)
})

test('同回合重复 pre-step 不重复注入；step>1 不注入', async (t) => {
  const root = tmpRoot(t)
  const ctx = makeCtx()
  apply(ctx, { dir: root, timeZone: 'Asia/Shanghai' })
  const session = { id: 'sess_cool', surface: { replaceGeneration: 1 } }
  playTurn1(ctx, session)
  startTurn2(ctx, session)
  const agent = { session }
  const first = await preStep(ctx, agent, [userMsg('昨天定了什么？')])
  assert.equal(first.messages.length, 2)
  const second = await preStep(ctx, agent, [userMsg('昨天定了什么？')])
  assert.equal(second.messages.length, 1)
  const later = await preStep(ctx, agent, [userMsg('昨天定了什么？')], 2)
  assert.equal(later.messages.length, 1)
})

test('已有记忆块时不再追加', async (t) => {
  const root = tmpRoot(t)
  const ctx = makeCtx()
  apply(ctx, { dir: root, timeZone: 'Asia/Shanghai' })
  const session = { id: 'sess_dup', surface: { replaceGeneration: 1 } }
  playTurn1(ctx, session)
  startTurn2(ctx, session)
  const existing = {
    role: 'user',
    source: { kind: SOURCE_KIND, form: 'recall' },
    content: [{ type: 'text', text: '旧块' }],
  }
  const decision = await preStep(ctx, { session }, [userMsg('昨天定了什么？'), existing])
  assert.equal(decision.messages.length, 2)
})

test('agent/created startup 清空冷却后可再次注入', async (t) => {
  const root = tmpRoot(t)
  const ctx = makeCtx()
  apply(ctx, { dir: root, timeZone: 'Asia/Shanghai' })
  const session = { id: 'sess_new', surface: { replaceGeneration: 1 } }
  playTurn1(ctx, session)
  startTurn2(ctx, session)
  const agent = { session }
  await preStep(ctx, agent, [userMsg('昨天定了什么？')])
  ctx.handlers.get('agent/created')({ agent, source: 'startup' })
  const again = await preStep(ctx, agent, [userMsg('昨天定了什么？')])
  assert.equal(again.messages.length, 2)
})

test('压缩后 request-error 重放注入块', async (t) => {
  const root = tmpRoot(t)
  const ctx = makeCtx()
  apply(ctx, { dir: root, timeZone: 'Asia/Shanghai' })
  const session = {
    id: 'sess_compact',
    surface: { replaceGeneration: 1 },
    append: (...args) => { session.appended.push(args) },
    appended: [],
  }
  playTurn1(ctx, session)
  startTurn2(ctx, session)
  await preStep(ctx, { session }, [userMsg('昨天定了什么？')])

  const action = await ctx.handlers.get('agent/request-error')(
    { agent: { session }, failure: { code: 'CONTEXT_WINDOW_EXCEEDED' }, signal: { aborted: false } },
    async () => {
      session.surface.replaceGeneration = 2
      return { kind: 'retry' }
    },
  )
  assert.equal(action.kind, 'retry')
  assert.equal(session.appended.length, 1)
  const [type, message, opts] = session.appended[0]
  assert.equal(type, 'user/message')
  assert.equal(message.source.kind, SOURCE_KIND)
  assert.equal(opts.surfaceOp, 'append')
})

test('未压缩的 request-error 不重放', async (t) => {
  const root = tmpRoot(t)
  const ctx = makeCtx()
  apply(ctx, { dir: root, timeZone: 'Asia/Shanghai' })
  const session = {
    id: 'sess_no_compact',
    surface: { replaceGeneration: 1 },
    append: (...args) => { session.appended.push(args) },
    appended: [],
  }
  playTurn1(ctx, session)
  startTurn2(ctx, session)
  await preStep(ctx, { session }, [userMsg('昨天定了什么？')])
  await ctx.handlers.get('agent/request-error')(
    { agent: { session }, failure: { code: 'CONTEXT_WINDOW_EXCEEDED' }, signal: { aborted: false } },
    async () => ({ kind: 'retry' }),
  )
  assert.equal(session.appended.length, 0)
})

test('中断回合记录工具证据', async (t) => {
  const root = tmpRoot(t)
  const ctx = makeCtx()
  apply(ctx, { dir: root, timeZone: 'Asia/Shanghai' })
  const session = { id: 'sess_abort', surface: { replaceGeneration: 1 } }
  const emit = (e) => ctx.handlers.get('session/event')(session, e)
  emit(ev('turn/start', 1, T1, { turn: 1 }))
  emit(ev('user/message', 2, T1, { source: { kind: 'user' }, content: [{ type: 'text', text: '帮我迁移数据库' }] }))
  emit(ev('tool/call', 3, T1 + 100, { turn: 1, step: 1, callId: 'c9', name: 'sqlite3' }))
  emit(ev('tool/result', 4, T1 + 200, {
    turn: 1,
    step: 1,
    message: { toolCallId: 'c9', isError: true, content: [{ type: 'text', text: 'locked' }] },
  }))
  emit(ev('turn/end', 5, T1 + 300, { turn: 1, reason: { kind: 'aborted' } }))
  const records = new Store(dataRoot(root)).readAll()
  assert.ok(records.some((r) => r.kind === 'outcome' && /中断/.test(r.text) && /sqlite3/.test(r.text)))
})

test('capture.enabled=false 不落盘', async (t) => {
  const root = tmpRoot(t)
  const ctx = makeCtx()
  apply(ctx, { dir: root, timeZone: 'Asia/Shanghai', capture: { enabled: false } })
  const session = { id: 'sess_off', surface: { replaceGeneration: 1 } }
  playTurn1(ctx, session)
  assert.equal(new Store(dataRoot(root)).readAll().length, 0)
})

test('噪声用户消息（脚手架）不进入记录', async (t) => {
  const root = tmpRoot(t)
  const ctx = makeCtx()
  apply(ctx, { dir: root, timeZone: 'Asia/Shanghai' })
  const session = { id: 'sess_noise', surface: { replaceGeneration: 1 } }
  const emit = (e) => ctx.handlers.get('session/event')(session, e)
  emit(ev('turn/start', 1, T1, { turn: 1 }))
  emit(ev('user/message', 2, T1, { source: { kind: 'runtime-context' }, content: [{ type: 'text', text: '工作区：/workspace/demo' }] }))
  emit(ev('turn/end', 3, T1 + 100, { turn: 1, reason: { kind: 'completed' } }))
  assert.equal(new Store(dataRoot(root)).readAll().length, 0)
})

test('no_data 时记录 recall-miss 审计而不注入', async (t) => {
  const root = tmpRoot(t)
  const ctx = makeCtx()
  apply(ctx, { dir: root, timeZone: 'Asia/Shanghai' })
  const session = { id: 'sess_miss', surface: { replaceGeneration: 1 } }
  const emit = (e) => ctx.handlers.get('session/event')(session, e)
  emit(ev('turn/start', 1, T2, { turn: 1 }))
  emit(ev('user/message', 2, T2, { source: { kind: 'user' }, content: [{ type: 'text', text: '昨天做了什么？' }] }))
  const decision = await preStep(ctx, { session }, [userMsg('昨天做了什么？')])
  assert.equal(decision.messages.length, 1)
  const auditLog = readAudit(root)
  assert.match(auditLog, /"type":"recall-miss"/)
})

test('新会话冷启动注入近期摘要（agent/created=fresh）', async (t) => {
  const root = tmpRoot(t)
  const ctx = makeCtx()
  apply(ctx, { dir: root, timeZone: 'Asia/Shanghai' })
  const now = Date.now()
  const session = { id: 'sess_cold', surface: { replaceGeneration: 1 } }
  const emit = (e) => ctx.handlers.get('session/event')(session, e)
  emit(ev('turn/start', 1, now - 60_000, { turn: 1 }))
  emit(ev('user/message', 2, now - 60_000, {
    source: { kind: 'user', clientTimeZone: 'Asia/Shanghai' },
    content: [{ type: 'text', text: '确定了缓存方案用 Redis。' }],
  }))
  emit(ev('turn/end', 3, now - 30_000, { turn: 1, reason: { kind: 'completed' } }))

  const agent = { session }
  ctx.handlers.get('agent/created')({ agent, source: 'fresh' })
  const decision = await preStep(ctx, agent, [userMsg('接下来做什么')])
  assert.equal(decision.messages.length, 2)
  const text = decision.messages[1].content[0].text
  assert.match(text, /cold-start/)
  assert.match(text, /Redis/)
  const auditLog = readAudit(root)
  assert.match(auditLog, /"trigger":"cold-start"/)
})

test('自然语言更正在唯一主题候选时建立取代链', async (t) => {
  const root = tmpRoot(t)
  const ctx = makeCtx()
  apply(ctx, { dir: root, timeZone: 'Asia/Shanghai' })
  const session = { id: 'sess_fix', surface: { replaceGeneration: 1 } }
  playTurn1(ctx, session)
  const emit = (e) => ctx.handlers.get('session/event')(session, e)
  emit(ev('turn/start', 10, T2, { turn: 2 }))
  emit(ev('user/message', 11, T2, {
    source: { kind: 'user' },
    content: [{ type: 'text', text: '不对，示例网关应该改成 8081。' }],
  }))
  emit(ev('turn/end', 12, T2 + 1000, { turn: 2, reason: { kind: 'completed' } }))

  const records = new Store(dataRoot(root)).readAll()
  const correction = records.find((r) => r.kind === 'correction')
  const decision = records.find((r) => r.kind === 'decision')
  assert.ok(correction)
  assert.deepEqual(correction.supersedes, [decision.id])
  assert.equal(decision.status, 'superseded')
  assert.equal(decision.superseded_by, correction.id)
  assert.equal(decision.valid_from, T1)
})

test('assistant 消息中的 tool-call 结构可兜底工具名', async (t) => {
  const root = tmpRoot(t)
  const ctx = makeCtx()
  apply(ctx, { dir: root, timeZone: 'Asia/Shanghai' })
  const session = { id: 'sess_tool', surface: { replaceGeneration: 1 } }
  const emit = (e) => ctx.handlers.get('session/event')(session, e)
  emit(ev('turn/start', 1, T1, { turn: 1 }))
  emit(ev('user/message', 2, T1, { source: { kind: 'user' }, content: [{ type: 'text', text: '读取配置文件' }] }))
  emit(ev('assistant/message', 3, T1 + 100, {
    turn: 1,
    step: 1,
    message: {
      role: 'assistant',
      content: [
        { type: 'tool-call', callId: 'c2', name: 'fs.read' },
        { type: 'text', text: '已完成读取并校验。' },
      ],
    },
  }))
  emit(ev('tool/result', 4, T1 + 200, {
    turn: 1,
    step: 1,
    message: { toolCallId: 'c2', isError: false, content: [{ type: 'text', text: 'ok' }] },
  }))
  emit(ev('turn/end', 5, T1 + 300, { turn: 1, reason: { kind: 'completed' } }))
  const outcome = new Store(dataRoot(root)).readAll().find((r) => r.kind === 'outcome')
  assert.deepEqual(outcome.source.tools, [{ name: 'fs.read', ok: true }])
})

test('进程崩溃后的未完成回合在下次 agent/created 恢复', async (t) => {
  const root = tmpRoot(t)
  const ctx = makeCtx()
  apply(ctx, { dir: root, timeZone: 'Asia/Shanghai' })
  const session = { id: 'sess_crash', surface: { replaceGeneration: 1 } }
  const emit = (e) => ctx.handlers.get('session/event')(session, e)
  emit(ev('turn/start', 1, T1, { turn: 1 }))
  emit(ev('user/message', 2, T1, {
    source: { kind: 'user' },
    content: [{ type: 'text', text: '确定了示例网关就用 8080 端口。' }],
  }))

  ctx.handlers.get('agent/created')({ agent: { session }, source: 'startup' })
  const records = new Store(dataRoot(root)).readAll()
  assert.equal(records.length, 1)
  assert.match(records[0].text, /8080/)
  assert.match(readAudit(root), /"type":"recover"/)
})

test('V09 热路径：turn/end 只写 L1，不生成 L2/L3', async (t) => {
  const root = tmpRoot(t)
  const ctx = makeCtx()
  apply(ctx, { dir: root, timeZone: 'Asia/Shanghai' })
  playTurn1(ctx, { id: 'sess_hot', surface: { replaceGeneration: 1 } })
  assert.equal(fs.existsSync(path.join(dataRoot(root), 'journal')), false)
  assert.equal(fs.existsSync(path.join(dataRoot(root), 'knowledge')), false)
  assert.doesNotMatch(readAudit(root), /"type":"(?:journal|maintenance)"/)
})
