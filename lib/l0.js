/**
 * L0 adapter.
 *
 * L0 is the host's session log — the authoritative raw record. This plugin
 * never owns or rewrites it. It reads L0 only when:
 *   - a user explicitly asks to verify a memory against the original;
 *   - a deletion/correction needs to locate the source;
 *   - a journal rebuild needs raw events.
 *
 * The hot path (`turn/end` capture) does not touch L0. If the host's
 * `sessionQuery` service is unavailable, this module reports
 * `l0_unavailable`; it never fabricates raw text.
 *
 * Every L0 hit is redacted again before being returned, because the original
 * session may contain a credential that was written before this plugin existed.
 */
import { redact } from './classify.js'
import { tokenize } from './search.js'
import { dateKey, localParts } from './time.js'

const MAX_EVENT_TEXT = 800

/**
 * Locate the host's read-only session query service.
 *
 * Three lookups, in order, because Cordis exposes services differently
 * depending on whether the plugin declared a hard inject. `ctx.get()` is
 * reflective and safe before the service is ready; direct property access can
 * throw when `inject` was not declared, so it must not run first.
 */
function sessionQueryOf(ctx) {
  if (!ctx) return null
  const pick = (value) => (value && typeof value.readSession === 'function' ? value : null)
  // Reflective lookup: returns undefined before the service is ready instead of
  // throwing. It must run first; direct property access can throw
  // "cannot get property sessionQuery without inject" and skip the fallbacks.
  if (typeof ctx.get === 'function') {
    const direct = pick(ctx.get('sessionQuery'))
    if (direct) return direct
  }
  try {
    const value = pick(ctx.sessionQuery)
    if (value) return value
  } catch { /* Cordis inject guard: undeclared access throws; treat as absent. */ }
  try {
    return pick(ctx.root?.sessionQuery)
  } catch {
    return null
  }
}

/**
 * Create a lazy L0 reader bound to a Cordis context.
 *
 * The service may appear after `apply`, so lookup is retried on first use.
 * `available` is a snapshot; a false value may become true later.
 */
export function createL0Reader(ctx) {
  let engine = sessionQueryOf(ctx)
  const resolve = () => {
    if (!engine) engine = sessionQueryOf(ctx)
    return engine
  }
  return {
    get available() {
      return Boolean(resolve())
    },
    get engine() {
      return resolve()
    },
    async read(sessionId) {
      const current = resolve()
      if (!current) throw new Error('L0 resolver（sessionQuery）不可用')
      return current.readSession(String(sessionId))
    },
  }
}

function contentText(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text.trim())
    .filter(Boolean)
    .join('\n')
    .trim()
}

function objectText(value) {
  if (!value) return ''
  if (typeof value === 'string') return value.trim()
  if (Array.isArray(value)) return contentText(value)
  if (typeof value === 'object') {
    if (Array.isArray(value.content)) return contentText(value.content)
    if (typeof value.text === 'string') return value.text.trim()
  }
  return ''
}

function summaryText(event) {
  const data = event?.data || {}
  for (const value of [data.summary, data.text, data.content, data.message, data.summary?.text]) {
    const text = objectText(value)
    if (text) return text
  }
  return ''
}

/**
 * Extract the human-readable text of a raw session event.
 * Only user messages, assistant messages, and compaction summaries are
 * searchable; tool output is intentionally excluded unless it was summarized.
 */
export function eventText(event) {
  if (!event || typeof event !== 'object') return ''
  if (event.type === 'user/message') {
    const kind = event.data?.source?.kind
    if (kind && kind !== 'user') return ''
    return objectText(event.data?.content) || objectText(event.data?.message?.content)
  }
  if (event.type === 'assistant/message') {
    return objectText(event.data?.message?.content)
  }
  if (event.type === 'compaction/summary') {
    return summaryText(event)
  }
  return ''
}

function timeLabel(ms, tz) {
  if (!Number.isFinite(ms)) return '时间未知'
  const p = localParts(ms, tz)
  return `${dateKey(ms, tz)} ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`
}

/**
 * Explicit raw-text verification.
 *
 * Only the sessions named by the caller are scanned — normally the
 * `source.session` pointers from L1 results. This is not a global search: it
 * cannot and should not scan the entire session history.
 *
 * Every token must appear in an event for it to match, which keeps results
 * precise. If every session read fails, the status is `l0_unavailable`; if some
 * fail, partial failures are reported alongside any hits.
 */
export async function searchL0({ reader, sessionIds = [], query = '', fromMs, toMs, tz = 'UTC', limit = 20 } = {}) {
  if (!reader?.available) {
    return {
      status: 'l0_unavailable',
      items: [],
      total: 0,
      message: 'L0 resolver（sessionQuery）不可用，无法做原文核对。',
    }
  }
  const tokens = tokenize(query)
  if (!tokens.length) {
    return { status: 'invalid_query', items: [], total: 0, message: 'L0 原文核对需要至少 2 个字符的关键词。' }
  }
  const ids = [...new Set(sessionIds.filter(Boolean))].slice(0, 50)
  if (ids.length === 0) {
    return {
      status: 'no_l0_sessions',
      items: [],
      total: 0,
      message: '没有可回读的会话来源；L1 可能已清理或该查询没有来源。',
    }
  }
  const hits = []
  const failures = []
  for (const sessionId of ids) {
    try {
      const snapshot = await reader.read(sessionId)
      const events = Array.isArray(snapshot?.events) ? snapshot.events : Array.isArray(snapshot) ? snapshot : []
      for (const event of events) {
        if (!Number.isFinite(event.time)) continue
        if (fromMs !== undefined && event.time < fromMs) continue
        if (toMs !== undefined && event.time >= toMs) continue
        const raw = eventText(event)
        if (!raw) continue
        const text = redact(raw).text
        const hay = text.toLowerCase()
        if (!tokens.every((token) => hay.includes(token))) continue
        hits.push({
          id: `l0:${sessionId}#${event.seq}`,
          kind: 'l0',
          text: text.length > MAX_EVENT_TEXT ? text.slice(0, MAX_EVENT_TEXT - 1) + '…' : text,
          time_label: timeLabel(event.time, tz),
          event_time: new Date(event.time).toISOString(),
          recorded_at: event.time,
          status: 'active',
          source: { session: sessionId, seq_from: event.seq, seq_to: event.seq, role: event.type === 'user/message' ? 'user' : 'assistant' },
          event_type: event.type,
        })
      }
    } catch (err) {
      failures.push({ session: sessionId, error: err?.message || String(err) })
    }
  }
  hits.sort((a, b) => (b.recorded_at || 0) - (a.recorded_at || 0))
  if (hits.length === 0) {
    return {
      status: failures.length === ids.length ? 'l0_unavailable' : 'no_match',
      items: [],
      total: 0,
      failures,
      message: failures.length ? '部分或全部会话读取失败；未命中可核对原文。' : 'L0 原文中没有匹配项。',
    }
  }
  return {
    status: 'ok',
    route: 'l0',
    items: hits.slice(0, limit),
    total: hits.length,
    returned: Math.min(hits.length, limit),
    truncated: hits.length > limit,
    failures,
    coverage: `L0 原文；扫描 ${ids.length} 个会话`,
    message: '结果直接来自 L0 原文，已重新做凭据脱敏。',
  }
}
