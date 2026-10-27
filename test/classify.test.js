import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyTurn, redact, splitSentences } from '../lib/classify.js'
import { zonedTimeToUtc } from '../lib/time.js'

const TZ = 'Asia/Shanghai'
const ANCHOR = zonedTimeToUtc(2026, 10, 25, 10, 0, 0, TZ)

function run(text, extra = {}) {
  return classifyTurn({
    sessionId: 'sess_test',
    turn: 1,
    userMessages: [{ text, time: ANCHOR, seq: 10, tz: TZ }],
    assistantText: '',
    toolResults: [],
    turnStatus: 'completed',
    recordedAt: ANCHOR + 60_000,
    seqFrom: 10,
    seqTo: 20,
    config: { timeZone: TZ, maxRecordsPerTurn: 8 },
    ...extra,
  })
}

test('决定 + 昨天 -> decision 且事件日为昨天', () => {
  const { records } = run('昨天我们定了方案B，部署成本低')
  assert.equal(records.length, 1)
  assert.equal(records[0].kind, 'decision')
  assert.equal(records[0].time_precision, 'day')
  assert.equal(records[0].event_start_ms, zonedTimeToUtc(2026, 10, 24, 0, 0, 0, TZ))
  assert.equal(records[0].source.session, 'sess_test')
})

test('纯问题不写入', () => {
  const { records } = run('昨天到底发生了什么？')
  assert.equal(records.length, 0)
})

test('偏好句', () => {
  const { records } = run('以后都尽量用短句回复')
  assert.equal(records[0].kind, 'preference')
})

test('计划句', () => {
  const { records } = run('明天我要去部署新版本')
  assert.equal(records[0].kind, 'plan')
})

test('更正句', () => {
  const { records } = run('不对，最终选了方案C')
  assert.equal(records[0].kind, 'correction')
})

test('密钥脱敏并标记 private', () => {
  const { records, redactedCount } = run('我的 api_key = sk-abcdefghijklmnop1234567890 请记住')
  assert.equal(redactedCount, 1)
  assert.match(records[0].text, /已脱敏/)
  assert.equal(records[0].sensitivity, 'private')
  assert.doesNotMatch(records[0].text, /sk-abcdef/)
})

test('有工具成功的“已完成”记为 outcome', () => {
  const { records } = run('部署好了', {
    assistantText: '已完成部署并通过校验',
    toolResults: [{ name: 'bash', ok: true, time: ANCHOR + 30_000, seq: 18, summary: 'ok' }],
  })
  const outcome = records.find((r) => r.kind === 'outcome')
  assert.ok(outcome)
  assert.equal(outcome.evidence, true)
  assert.equal(outcome.time_precision, 'minute')
})

test('无工具证据的“已完成”只记为 claim', () => {
  const { records } = run('做完了吗', { assistantText: '已完成' })
  const claim = records.find((r) => r.kind === 'claim')
  assert.ok(claim)
  assert.equal(claim.evidence, false)
  assert.ok(claim.confidence < 0.5)
  assert.equal(claim.time_precision, 'unknown')
})

test('中断回合保留工具证据', () => {
  const { records } = run('继续', {
    turnStatus: 'aborted',
    toolResults: [{ name: 'bash', ok: false, time: ANCHOR, seq: 12, error: 'sigterm' }],
  })
  const outcome = records.find((r) => r.kind === 'outcome' && /中断/.test(r.text))
  assert.ok(outcome)
  assert.match(outcome.text, /bash/)
})

test('splitSentences 去项目符号且保留句末标点', () => {
  assert.deepEqual(splitSentences('- 第一件事。\n2. 第二件事'), ['第一件事。', '第二件事'])
})

test('redact 不误伤普通数字', () => {
  const r = redact('端口是 8080，版本 1.2.3')
  assert.equal(r.redacted, false)
})

test('中文密码句式脱敏为 credential', () => {
  const r = redact('密码是 hunter2hunter2，别外传')
  assert.equal(r.redacted, true)
  assert.deepEqual(r.kinds, ['credential'])
  assert.equal(r.text.includes('hunter2'), false)
})

test('source.quote 不保留凭据', () => {
  const { records } = run('我的 api_key = sk-abcdefghijklmnop1234567890，订单号 1234567890123456')
  assert.doesNotMatch(records[0].source.quote, /sk-abcdef/)
  assert.match(records[0].source.quote, /已脱敏/)
})

test('16 位业务单号不被当成卡号', () => {
  const r = redact('订单号 1234567890123456 已出库')
  assert.equal(r.redacted, false)
  assert.match(r.text, /1234567890123456/)
})

test('只有 Luhn 卡号与校验位合法的身份证才脱敏', () => {
  assert.deepEqual(redact('卡号 4111 1111 1111 1111').kinds, ['card-number'])
  assert.deepEqual(redact('身份证 11010519491231002X').kinds, ['id-number'])
  assert.equal(redact('编号 110105194912310021').redacted, false)
  assert.equal(redact('流水 4111111111111112').redacted, false)
})

test('句首日期与端口属于正文', () => {
  assert.deepEqual(
    splitSentences('2026-10-12 部署完成。\n8080 端口已切换。'),
    ['2026-10-12 部署完成。', '8080 端口已切换。'],
  )
})

test('maxRecordsPerTurn 是硬上限且保留结果记录', () => {
  const text = Array.from({ length: 12 }, (_, i) => `事项${i + 1}已经处理。`).join('\n')
  const { records } = run(text, {
    assistantText: '已完成',
    toolResults: [{ name: 'bash', ok: true, time: ANCHOR }],
    config: { timeZone: TZ, maxRecordsPerTurn: 3 },
  })
  assert.ok(records.length <= 3)
  assert.ok(records.some((r) => r.kind === 'outcome'))
})

test('普通偏好默认不标 private', () => {
  const { records } = run('我喜欢美式咖啡')
  assert.equal(records[0].kind, 'preference')
  assert.equal(records[0].sensitivity, 'normal')
  assert.match(records[0].text, /美式/)
})

test('隐私开关只加严普通个人信息，不删除正文', () => {
  const plain = run('我的手机号是 13800138000').records[0]
  assert.equal(plain.sensitivity, 'normal')
  const enhanced = run('我的手机号是 13800138000', {
    config: { timeZone: TZ, maxRecordsPerTurn: 8, privacy: { enhanced: true } },
  }).records[0]
  assert.equal(enhanced.sensitivity, 'private')
  assert.match(enhanced.text, /13800138000/)
})

test('凭据脱敏不受隐私开关影响', () => {
  for (const enhanced of [false, true]) {
    const { records, redactedCount } = run('部署时密码是 hunter2hunter2，请记住', {
      config: { timeZone: TZ, maxRecordsPerTurn: 8, privacy: { enhanced } },
    })
    assert.equal(redactedCount, 1)
    assert.doesNotMatch(records[0].text, /hunter2/)
    assert.equal(records[0].sensitivity, 'private')
  }
})

test('数据库连接串按凭据脱敏', () => {
  const r = redact('postgres://user:secret@db.local:5432/app')
  assert.equal(r.redacted, true)
  assert.equal(r.text.includes('secret'), false)
})

// 回归：无时间词的句子不得沿用同轮其他句子的「昨天」当自己的事件日。
test('同轮无时间词的句子不继承别句的相对日', () => {
  const { records } = run('不对啊，我记得昨天你做值守的时候还能主动推送的啊。处理完这个事儿以后，再说下剩下两件事儿是啥')
  const plain = records.find((r) => r.text.startsWith('处理完这个事儿'))
  assert.ok(plain)
  assert.equal(plain.time_basis, 'recorded')
  assert.equal(plain.event_start_ms, ANCHOR)
})

// 回归：「补一下昨天和前天的日记」里的昨天是宾语，不是事件日。
test('时间词修饰宾语时不算事件时间', () => {
  const { records } = run('咱们再做几次测试，比如：你手动补一下昨天和前天的日记试试')
  assert.equal(records.length, 1)
  assert.equal(records[0].time_basis, 'recorded')
  assert.equal(records[0].event_start_ms, ANCHOR)
})

// 回归：换行是排版，不是语义边界；多行消息不能拆成多条记录。
test('换行不是句子边界，一条消息只落一条记录', () => {
  const { records } = run('要检查三件事\n1、上下文注入有没有重复\n2、时间戳对不对。')
  assert.equal(records.length, 1)
  assert.ok(records[0].text.includes('上下文注入有没有重复'))
  assert.ok(!records[0].text.includes('\n'))
})

// 回归：无标点的超长段必须降级切分，不能整段丢弃。
test('无标点的超长段不会被丢弃', () => {
  const { records } = run('啊'.repeat(400))
  assert.ok(records.length >= 2)
  assert.ok(records.every((r) => r.text.length <= 300))
})

// 回归：引号里的整句（带标点）不是名字，不能污染 topics/entities。
test('引号里的整句不当 topic/entity', () => {
  const { records } = run('他说「这个方案，明天再定」，先记一下')
  assert.ok(records.length)
  assert.ok(records.every((r) => !r.topics.includes('这个方案，明天再定')))
  assert.ok(records.every((r) => !r.entities.includes('这个方案，明天再定')))
})
