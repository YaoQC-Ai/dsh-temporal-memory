/**
 * Deterministic turn extraction.
 *
 * This module converts one completed (or interrupted) turn into zero or more
 * L1 records without calling a model. It is deliberately rule-based: capture
 * runs on the hot path, must be explainable, and must produce the same output
 * for the same input.
 *
 * Three invariants:
 *
 * 1. Credentials are removed before anything is stored. This is unconditional:
 *    there is no setting that lets a private key, API key, password, bearer
 *    token, credentialed URL, ID number, or payment card number into memory.
 * 2. Time belongs to the sentence that stated it. A date phrase from one
 *    sentence must not move a neighbouring sentence to another day.
 * 3. A claim is not evidence. An assistant sentence saying "done" becomes an
 *    `outcome` only when a tool call in the same turn succeeded; otherwise it
 *    is stored as a low-confidence `claim`.
 *
 * Privacy beyond credentials is opt-in. Normal preferences and personal facts
 * stay local and are not discarded just because they might be sensitive.
 */
import { parseTime, normalizeTz } from './time.js'

// Credential patterns require a recognizable prefix or key/value context.
// Bare digits are deliberately not matched by length alone, which would turn
// order numbers and timestamps into false positives.
const SECRET_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, 'private-key'],
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, 'api-key'],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, 'api-key'],
  [/\bAKIA[A-Z0-9]{16}\b/g, 'api-key'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, 'api-key'],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi, 'bearer'],
  [/(?:api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password|passwd|pwd)\s*[:=]\s*["']?[^\s"',;]{6,}/gi, 'credential'],
  [/(?:密码|口令|密钥|私钥|令牌|凭据)(?:是|为|[:：=])\s*[A-Za-z0-9!@#$%^&*_\-+=.]{4,}/g, 'credential'],
  // A URL with embedded credentials is still a credential, even though it
  // looks like an ordinary URL.
  [/\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|rediss|amqp|mssql|ftp):\/\/[^\s:@/]+:[^\s@/]+@[^\s]+/gi, 'connection-string'],
]

const ID_CANDIDATE = /(?<![\dXx])(\d{17}[\dXx])(?![\dXx])/g
const CARD_CANDIDATE = /(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g
const ID_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2]
const ID_CHECK = '10X98765432'

/** Luhn checksum, used to avoid redacting arbitrary long digit strings. */
function luhnValid(digits) {
  if (!/^\d{13,19}$/.test(digits)) return false
  let sum = 0
  let doubled = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48
    if (doubled) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
    doubled = !doubled
  }
  return sum % 10 === 0
}

/** Chinese resident ID checksum (GB 11643-1999). */
function idCardValid(value) {
  let sum = 0
  for (let i = 0; i < 17; i++) sum += (value.charCodeAt(i) - 48) * ID_WEIGHTS[i]
  return ID_CHECK[sum % 11] === value.at(-1).toUpperCase()
}

/** Redact only digit runs that pass the Luhn check in a plausible card shape. */
function redactCards(text) {
  return text.replace(CARD_CANDIDATE, (match) => {
    // With separators, accept only the 4-4-4(-4) grouping used by cards, so
    // dates and times are not swallowed.
    if (/[ -]/.test(match) && !/^\d{4}([ -]\d{4}){2,3}([ -]\d{1,4})?$/.test(match)) return match
    return luhnValid(match.replace(/[ -]/g, '')) ? '[已脱敏]' : match
  })
}

/**
 * Remove credentials and validated identifier numbers from `text`.
 *
 * @returns {{text:string, redacted:boolean, kinds:string[]}}
 *   `kinds` names what was removed, for audit only; the original value is
 *   never retained.
 */
export function redact(text) {
  let out = String(text || '')
  const kinds = []
  for (const [re, kind] of SECRET_PATTERNS) {
    const before = out
    out = out.replace(re, '[已脱敏]')
    if (out !== before) kinds.push(kind)
  }
  const idBefore = out
  out = out.replace(ID_CANDIDATE, (match) => (idCardValid(match) ? '[已脱敏]' : match))
  if (out !== idBefore) kinds.push('id-number')
  const cardBefore = out
  out = redactCards(out)
  if (out !== cardBefore) kinds.push('card-number')
  return { text: out, redacted: kinds.length > 0, kinds }
}

/**
 * Split a message into candidate statements.
 *
 * Newlines and sentence punctuation are boundaries. Only list markers are
 * stripped: a leading date, port, or number is content, and removing it would
 * silently change the memory. Very short fragments and paragraph-sized runs
 * are dropped because neither classifies reliably.
 */
export function splitSentences(text) {
  const parts = String(text || '')
    .split(/\n+|(?<=[。；;！!？?])/)
    .map((s) => s.replace(/^\s*(?:[-*•]\s*|\d{1,2}[.)、]\s+)/, '').trim())
    .filter((s) => s.length >= 2 && s.length <= 300)
  return parts
}

/** A question is not a fact. Pure questions are skipped entirely. */

function isPureQuestion(s) {
  if (!/[?？]\s*$/.test(s)) return false
  return !hasDecision(s) && !hasPreference(s) && !hasCorrection(s)
}

// Signal vocabularies, ordered by precedence in classifyKind().
function hasCorrection(s) {
  return /(不对|说错|纠正|更正|其实是|不是.{0,12}(?:而是|是))/i.test(s)
}
function hasPreference(s) {
  return /(以后都|以后不要|今后|我喜欢|我习惯|我偏好|尽量|不要再|别用|不要用|记住我)/i.test(s)
}
function hasDecision(s) {
  return /(定了|决定|确定用|采用|就用|拍板|最终选|就这么)/i.test(s)
}

/**
 * Assign the record kind. Order is intentional: a correction outranks the
 * preference inside the corrected sentence, and a decision outranks a plan
 * that merely mentions it. Unknown statements default to `event`.
 */
export function classifyKind(s) {
  if (hasCorrection(s)) return 'correction'
  if (hasPreference(s)) return 'preference'
  if (hasDecision(s)) return 'decision'
  if (/(计划|打算|准备|下一步|接下来|待办|todo|明天.{0,12}(?:要|会|去)|下周.{0,12}(?:要|会|去))/i.test(s)) return 'plan'
  if (/(地址|端口|账号|版本|默认|规则|约定|名称|负责人|位于)/.test(s)) return 'fact'
  return 'event'
}

// Sentence-leading filler that should not become part of a topic name.
const TOPIC_LEAD = /^(?:我们|我|你|已经|已|确定|决定|采用|使用|改成|改为|选了|选择|就用|现在|以后|这个|那个|把|将|要|了|的|是|用)+/

// Mark a record private only when the user explicitly says so. Ordinary
// preferences, contracts, salary, and phone numbers are stored locally like any
// other memory; "might be sensitive" is not a reason to drop them.
const EXPLICIT_PRIVATE = /(?:这段|这个|以下|上述|刚才).{0,8}(?:是|属于)?隐私|(?:请|帮我|把它|将|把这段)(?:标记|设|当)(?:为|作)?隐私|不要(?:记录|保存|写入|记住)/
// With enhanced privacy on, common personal-information categories are marked
// private locally. They are still stored; the flag only affects display/export.
const PERSONAL_INFO = /(手机号|电话号码|身份证|住址|家庭住址|工资|薪资|合同|银行卡|病史|宗教|政治)/

/**
 * Heuristic topic extraction. Topics are short noun-like names such as
 * "billing service" or "admin dashboard"; they power concept compilation and
 * fuzzy day recall. At most five are kept to avoid turning a sentence into a
 * bag of tags.
 */
export function extractTopics(s) {
  const topics = new Set()
  for (const m of s.matchAll(/([\u4e00-\u9fa5A-Za-z0-9_-]{2,20})(项目|系统|方案|插件|模块|服务|看板|网关)/g)) {
    const name = (m[1] + m[2]).replace(TOPIC_LEAD, '')
    if (name.length >= 2) topics.add(name)
  }
  for (const m of s.matchAll(/[「“"]([^」”"]{2,30})[」”"]/g)) topics.add(m[1])
  for (const m of s.matchAll(/\b[A-Z][A-Za-z0-9_-]{2,}\b/g)) topics.add(m[0])
  return [...topics].slice(0, 5)
}

/**
 * Extract entities: user-configured known names that appear verbatim, plus
 * quoted proper nouns. Deliberately conservative — a missed entity is cheaper
 * than a wrong one polluting every future search.
 */
export function extractEntities(s, known = []) {
  const out = new Set()
  for (const name of known) {
    if (name && s.includes(name)) out.add(name)
  }
  for (const m of s.matchAll(/[「“"]([^」”"]{2,30})[」”"]/g)) out.add(m[1])
  return [...out].slice(0, 8)
}

function normalizeText(s) {
  return s.replace(/[ \t]+/g, ' ').replace(/[。；;！!？?]$/, '').trim()
}

// "Backfill yesterday's journal" / "show the record from October 24": the time
// phrase modifies the object, not the moment of the request. Such a sentence
// must not use its literal date as the event date.
const OBJECT_TIME = /(?:今天|今日|昨天|昨日|前天|明天|后天)[^，。；;！!？?\n]{0,10}的\s*(?:日记|记录|日志)/

/** Flatten a DSH content array into plain text blocks, preserving order. */
function textOf(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text.trim())
    .filter(Boolean)
    .join('\n')
    .trim()
}

/**
 * Extract candidate L1 records from one turn.
 *
 * User statements are processed sentence by sentence so each record gets its
 * own time, topics, entities, sensitivity, and kind. Assistant output produces
 * at most one outcome/claim record, and an interrupted turn with tool activity
 * produces one outcome record describing what happened.
 *
 * @param {object} input
 * @param {string} input.sessionId
 * @param {number} input.turn
 * @param {Array<{text:string,time:number,seq:number,tz?:string}>} input.userMessages
 * @param {string} input.assistantText
 * @param {number} [input.assistantSeq]
 * @param {Array<{name:string,ok:boolean,summary?:string,time?:number,seq?:number,error?:string}>} input.toolResults
 * @param {'completed'|'aborted'|'error'} input.turnStatus
 * @param {number} input.recordedAt
 * @param {number} input.seqFrom
 * @param {number} input.seqTo
 * @param {object} [input.config]
 * @returns {{records:Array<object>, redactedCount:number}}
 */
export function classifyTurn(input) {
  const {
    sessionId,
    turn,
    userMessages = [],
    assistantText = '',
    assistantSeq,
    toolResults = [],
    turnStatus = 'completed',
    recordedAt,
    seqFrom,
    seqTo,
    config = {},
  } = input || {}
  const tz = normalizeTz(userMessages[0]?.tz || config.timeZone || 'UTC')
  const anchorMs = userMessages[0]?.time || recordedAt || Date.now()
  const knownEntities = Array.isArray(config.entities) ? config.entities : []
  const maxRecords = Number.isInteger(config.maxRecordsPerTurn) ? config.maxRecordsPerTurn : 8
  const records = []
  let redactedCount = 0

  const userText = userMessages.map((m) => m.text).join('\n')
  const whole = redact(userText)
  if (whole.redacted) redactedCount++
  // Sensitivity is per sentence: a credential elsewhere in the turn must not
  // turn an ordinary preference into a private record.
  for (const rawSentence of splitSentences(userText)) {
    const sentenceSafe = redact(rawSentence)
    const sentence = sentenceSafe.text
    if (isPureQuestion(sentence)) continue
    const kind = classifyKind(sentence)
    // Only this sentence's own time phrase may set its date. Falling back to
    // the whole message lets one sentence's "yesterday" move its neighbours to
    // the wrong day, which then corrupts journals and retention.
    const time = OBJECT_TIME.test(sentence) ? null : parseTime(sentence, anchorMs, tz)
    const text = normalizeText(sentence)
    if (!text || text === '[已脱敏]') continue
    const enhanced = config.privacy?.enhanced === true
    const privateFlag = EXPLICIT_PRIVATE.test(sentence) || (enhanced && PERSONAL_INFO.test(sentence))
    // No time phrase: use the message arrival time as the best approximation,
    // with basis=recorded and low confidence. Leaving it unknown would make
    // "what happened yesterday" miss conversations that did happen that day.
    const anchored = !time && Number.isFinite(anchorMs)
    records.push({
      kind,
      text,
      event_start_ms: time ? time.startMs : anchored ? anchorMs : null,
      event_end_ms: time ? time.endMs : anchored ? anchorMs + 60_000 : null,
      time_precision: time ? time.precision : anchored ? 'minute' : 'unknown',
      time_basis: time ? time.time_basis : 'recorded',
      time_confidence: time ? time.time_confidence : anchored ? 0.5 : 0.4,
      time_text: time ? time.time_text : null,
      tz,
      recorded_at: recordedAt,
      status: 'active',
      source: {
        session: sessionId,
        seq_from: seqFrom,
        seq_to: seqTo,
        role: 'user',
        quote: whole.text.slice(0, 120),
      },
      entities: extractEntities(sentence, knownEntities),
      topics: extractTopics(sentence),
      confidence: time ? 0.85 : 0.7,
      sensitivity: sentenceSafe.redacted || privateFlag ? 'private' : 'normal',
      turn_status: turnStatus,
      turn,
    })
    if (records.length >= maxRecords) break
  }

  // The assistant's own "done" sentence is only a claim. It is promoted to an
  // outcome when at least one tool call in the same turn succeeded, because
  // the tool result is independent evidence that something actually ran.
  const claimRe = /(已完成|完成了|已部署|已修复|已更新|搞定了|迁移完成|全部通过|(?:^|[^未不])成功)/
  const okTools = toolResults.filter((t) => t.ok)
  const failedTools = toolResults.filter((t) => !t.ok)
  const assistantSafe = redact(assistantText || '')
  const claims = splitSentences(assistantSafe.text).filter((s) => claimRe.test(s)).slice(0, 1)

  if (claims.length && okTools.length) {
    records.push(makeOutcome({
      text: normalizeText(claims[0]),
      kind: 'outcome',
      timeMs: okTools.at(-1).time || recordedAt,
      tz,
      sessionId,
      turn,
      seqFrom,
      seqTo,
      assistantSeq,
      recordedAt,
      tools: okTools,
      confidence: 0.85,
      turnStatus,
      evidence: true,
      sensitivity: assistantSafe.redacted ? 'private' : 'normal',
    }))
  } else if (claims.length && !okTools.length) {
    // No successful tool call: keep the sentence, but label it a low-confidence
    // claim so later retrieval can weigh it accordingly.
    records.push(makeOutcome({
      text: normalizeText(claims[0]),
      kind: 'claim',
      timeMs: recordedAt,
      tz,
      sessionId,
      turn,
      seqFrom,
      seqTo,
      assistantSeq,
      recordedAt,
      tools: [],
      confidence: 0.35,
      turnStatus,
      evidence: false,
      sensitivity: assistantSafe.redacted ? 'private' : 'normal',
    }))
  }

  // An interrupted or failed turn still happened. Record the tool activity so
  // the next session does not repeat work under the illusion it never ran.
  if (turnStatus !== 'completed' && toolResults.length) {
    records.push(makeOutcome({
      text: turnStatus === 'aborted'
        ? `回合中断；已发生工具调用：${toolResults.map((t) => t.name).join('、')}`
        : `回合失败；工具调用：${toolResults.map((t) => t.name).join('、')}`,
      kind: 'outcome',
      timeMs: toolResults.at(-1).time || recordedAt,
      tz,
      sessionId,
      turn,
      seqFrom,
      seqTo,
      assistantSeq,
      recordedAt,
      tools: failedTools.length ? failedTools : toolResults,
      confidence: 0.75,
      turnStatus,
      evidence: true,
      sensitivity: assistantSafe.redacted ? 'private' : 'normal',
    }))
  }

  // De-duplicate within the turn: same kind + same text keeps the first entry.
  const seen = new Set()
  const unique = []
  for (const r of records) {
    const key = r.kind + '\u0000' + r.text
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(r)
  }

  // Outcomes and claims are kept first; user statements share what is left of
  // the per-turn budget. This guarantees the result never exceeds maxRecords.
  const tail = unique.filter((r) => r.kind === 'outcome' || r.kind === 'claim')
  const head = unique.filter((r) => r.kind !== 'outcome' && r.kind !== 'claim')
  const budget = Math.max(0, maxRecords - tail.length)
  return { records: [...head.slice(0, budget), ...tail], redactedCount }
}

/**
 * Build an assistant-side record. `evidence` records whether a tool result
 * supports the text; `source.seq_to` points at the assistant message so a
 * reader can replay the original turn.
 */
function makeOutcome({ text, kind, timeMs, tz, sessionId, turn, seqFrom, seqTo, assistantSeq, recordedAt, tools, confidence, turnStatus, evidence, sensitivity = 'normal' }) {
  const knownTime = kind !== 'claim' && Number.isFinite(timeMs)
  return {
    kind,
    text: text || '（无文本）',
    event_start_ms: knownTime ? timeMs : null,
    event_end_ms: knownTime ? timeMs + 60_000 : null,
    time_precision: knownTime ? 'minute' : 'unknown',
    time_basis: 'recorded',
    time_confidence: knownTime ? 0.9 : 0.3,
    time_text: null,
    tz,
    recorded_at: recordedAt,
    status: 'active',
    source: {
      session: sessionId,
      seq_from: seqFrom,
      seq_to: assistantSeq !== undefined ? assistantSeq : seqTo,
      role: 'assistant',
      quote: text.slice(0, 120),
      tools: tools.map((t) => ({ name: t.name, ok: !!t.ok })),
    },
    entities: [],
    topics: [],
    confidence,
    sensitivity,
    evidence,
    turn_status: turnStatus,
    turn,
  }
}

export { textOf }
