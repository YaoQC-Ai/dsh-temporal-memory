/**
 * Retrieval over L1 records.
 *
 * There is no embedding model and no external index. Scoring is a small,
 * explainable combination of lexical relevance, time-window fit, status, and
 * provenance. That is deliberate: memory must work offline, on the hot path,
 * with zero dependencies, and every result must be defensible to the user.
 *
 * Status is a public contract. A caller must be able to distinguish:
 *   - no_data: the store is empty for this filter;
 *   - no_match: data exists but the query matched none;
 *   - out_of_retention: the requested window is older than L1 retention;
 *   - partial: only part of the requested scope could be served.
 * "Nothing found" must never mask "we deleted it" or "we cannot see it".
 *
 * Pagination uses a value cursor (score + id, or timestamp + id), not an
 * offset, so inserting a new record between pages cannot duplicate or skip
 * results.
 */
import { inNamespace } from './namespace.js'
import { DAY_MS, coverageText, dateKey, dayRange, formatEvent } from './time.js'

// Function words that carry no retrieval value in Chinese questions.
const STOP = new Set(['我们', '你们', '他们', '这个', '那个', '就是', '可以', '然后', '因为', '所以', '但是', '已经', '一个', '什么', '怎么', '还是', '没有', '现在', '今天'])

// Every status this module can return. Tool schemas and the UI both validate
// against this list, so adding a new status requires adding it here.
export const STATUSES = Object.freeze([
  'ok',
  'partial',
  'no_data',
  'no_match',
  'out_of_retention',
  'l0_unavailable',
  'no_l0_sessions',
  'invalid_query',
  'permission_denied',
  'error',
])

/**
 * Tokenize into ASCII terms and Chinese bigrams, dropping stop words.
 *
 * Bigrams are a cheap, dependency-free approximation of Chinese word
 * segmentation. They over-generate but work well for short queries, and the
 * cap of 40 keeps scoring bounded.
 */
export function tokenize(text) {
  const out = new Set()
  const s = String(text || '').toLowerCase()
  for (const m of s.matchAll(/[a-z0-9_][a-z0-9_.-]*/g)) {
    if (m[0].length >= 2 && !STOP.has(m[0])) out.add(m[0])
  }
  for (const m of s.matchAll(/[\u4e00-\u9fa5]+/g)) {
    const run = m[0]
    if (run.length === 1) {
      out.add(run)
      continue
    }
    for (let i = 0; i < run.length - 1; i++) {
      const bg = run.slice(i, i + 2)
      if (!STOP.has(bg)) out.add(bg)
    }
    if (run.length <= 8 && !STOP.has(run)) out.add(run)
  }
  return [...out].slice(0, 40)
}

/**
 * How well a record's event interval fits the requested window.
 * A record fully inside the window scores near 1; one outside scores 0.
 * When no window is requested every record gets a neutral 0.5.
 */
function timeFit(record, fromMs, toMs) {
  if (!fromMs && !toMs) return 0.5
  const rs = record.event_start_ms
  if (!Number.isFinite(rs)) return 0
  const re = record.event_end_ms || rs + 1
  const a = fromMs ?? -Infinity
  const b = toMs ?? Infinity
  const overlap = Math.max(0, Math.min(re, b) - Math.max(rs, a))
  if (overlap <= 0) return 0
  const span = Number.isFinite(b - a) ? b - a : re - rs
  return Math.min(1, 0.7 + 0.3 * (overlap / Math.max(1, Math.min(re - rs || 1, span))))
}

/**
 * Lexical relevance.
 *
 * A term in the body is worth 1; a term in topics or entities is worth 2
 * because those fields are curated signals. A full-phrase hit adds a bonus.
 * The score is normalized to 0..1.
 */
function relevance(record, tokens, rawQuery) {
  if (!tokens.length) return 0
  const text = String(record.text || '').toLowerCase()
  const topics = (record.topics || []).join(' ').toLowerCase()
  const entities = (record.entities || []).join(' ').toLowerCase()
  let hits = 0
  let weighted = 0
  for (const t of tokens) {
    let w = 0
    if (text.includes(t)) w = 1
    if (topics.includes(t)) w = 2
    if (entities.includes(t)) w = 2
    if (w > 0) {
      hits++
      weighted += w
    }
  }
  let score = weighted / (tokens.length * 2)
  const phrase = String(rawQuery || '').trim().toLowerCase()
  if (phrase.length >= 2 && text.includes(phrase)) score += 0.3
  return Math.min(1, score)
}

/**
 * Status weight: current facts outrank disputed ones, which outrank superseded
 * history. History is still retrievable when explicitly requested.
 */
function validity(record) {
  if (record.status === 'active') return 1
  if (record.status === 'disputed') return 0.6
  if (record.status === 'superseded') return 0.3
  return 0
}

/** Provenance weight: a quoted source beats a session pointer beats nothing. */
function provenance(record) {
  if (record.source?.quote) return 1
  if (record.source?.session) return 0.6
  return 0.3
}

/** Interval-overlap test against a half-open window. */
function matchesTime(record, fromMs, toMs) {
  if (!fromMs && !toMs) return true
  const rs = record.event_start_ms
  if (!Number.isFinite(rs)) return false
  const re = record.event_end_ms || rs + 1
  return Math.min(re, toMs ?? Infinity) - Math.max(rs, fromMs ?? -Infinity) > 0
}

/** Status filter: single value, array, `all`, or `history` (everything live). */
function matchesStatus(record, status) {
  if (status === 'all') return true
  if (status === 'history') return record.status !== 'deleted'
  if (Array.isArray(status)) return status.includes(record.status)
  return record.status === status
}

/**
 * Search L1 records.
 *
 * @param {Array<object>} records all live records (from `Store.readAll`)
 * @param {object} options
 * @param {string} [options.query] free text
 * @param {number} [options.fromMs] inclusive window start
 * @param {number} [options.toMs] exclusive window end
 * @param {string|string[]} [options.kind] record kind filter
 * @param {string|string[]} [options.status='active'] status filter
 * @param {string} [options.namespace] namespace filter
 * @param {number} [options.limit=20]
 * @param {number} [options.offset=0]
 * @param {string} [options.cursor] value cursor from a previous page
 * @param {number} [options.nowMs] reference time for retention
 * @param {number} [options.retentionDays]
 * @param {string} [options.tz]
 * @returns {{status:string, items:Array<object>, total:number, returned:number, truncated:boolean, next_cursor:string|null, coverage:string, message:string}}
 */
export function searchRecords(records, options = {}) {
  const {
    query = '',
    fromMs,
    toMs,
    kind,
    status = 'active',
    namespace,
    limit = 20,
    offset = 0,
    cursor,
    nowMs = Date.now(),
    retentionDays = 365,
    tz = 'UTC',
  } = options

  const kindSet = kind ? new Set(Array.isArray(kind) ? kind : [kind]) : null
  const cutoff = nowMs - retentionDays * DAY_MS
  // After retention pruning, an old window must report `out_of_retention`.
  // Returning `no_match` would claim the event never happened.
  if (fromMs !== undefined && toMs !== undefined && toMs <= cutoff) {
    return buildResult({
      status: 'out_of_retention',
      items: [],
      total: 0,
      returned: 0,
      truncated: false,
      next_cursor: null,
      coverage: coverageText(fromMs, toMs, tz, retentionDays),
      message: `该时间早于 L1 保留范围（保留 ${retentionDays} 天）；可用 L2 日记或 L0 原文核对。`,
    })
  }
  const universe = records.filter((r) => {
    if (!matchesStatus(r, status)) return false
    if (!inNamespace(r, namespace)) return false
    if (kindSet && !kindSet.has(r.kind)) return false
    return true
  })

  if (universe.length === 0) {
    return buildResult({
      status: 'no_data',
      items: [],
      total: 0,
      returned: 0,
      truncated: false,
      next_cursor: null,
      coverage: coverageText(fromMs, toMs, tz, retentionDays),
      message: '没有已记录的记忆',
    })
  }

  const timeUniverse = universe.filter((r) => matchesTime(r, fromMs, toMs))
  const tokens = tokenize(query)
  const scored = []
  for (const record of timeUniverse) {
    const rel = relevance(record, tokens, query)
    if (tokens.length && rel === 0) continue
    // Fixed weights keep ranking predictable. Text relevance dominates; the
    // other three factors break ties in a way a user can understand.
    const score = 0.45 * rel + 0.30 * timeFit(record, fromMs, toMs) + 0.15 * validity(record) + 0.10 * provenance(record)
    scored.push({ record, score })
  }

  if (scored.length === 0) {
    return buildResult({
      status: 'no_match',
      items: [],
      total: 0,
      returned: 0,
      truncated: false,
      next_cursor: null,
      coverage: coverageText(fromMs, toMs, tz, retentionDays),
      message: `${universe.length} 条记录中没有匹配项`,
    })
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    const at = a.record.event_start_ms ?? -Infinity
    const bt = b.record.event_start_ms ?? -Infinity
    if (bt !== at) return bt - at
    return String(a.record.id).localeCompare(String(b.record.id))
  })

  const total = scored.length
  // Value cursor: resume after the last (score, id) pair. A plain offset would
  // shift when a record is added between pages; an id-based cursor cannot.
  let start = Math.max(0, Number.isFinite(Number(offset)) ? Math.trunc(Number(offset)) : 0)
  if (cursor) {
    const stable = /^s:([\d.]+):(.+)$/.exec(String(cursor))
    if (stable) {
      const idx = scored.findIndex((x) => x.score.toFixed(6) === stable[1] && x.record.id === stable[2])
      if (idx >= 0) start = idx + 1
    } else if (Number.isFinite(Number(cursor))) {
      start = Math.max(0, Math.trunc(Number(cursor)))
    }
  }
  const page = scored.slice(start, start + limit)
  const last = page.at(-1)
  const next = last && start + page.length < total ? `s:${last.score.toFixed(6)}:${last.record.id}` : null

  return buildResult({
    status: 'ok',
    items: page.map(({ record, score }) => toItem(record, score, tz)),
    total,
    returned: page.length,
    truncated: next !== null,
    next_cursor: next,
    coverage: coverageText(fromMs, toMs, tz, retentionDays),
    message: next ? `另有 ${total - start - page.length} 条未展示，可用 next_cursor 继续读取` : '',
  })
}

/** Normalize every result to the same shape so callers never need to guess. */
function buildResult(fields) {
  return {
    status: fields.status,
    items: fields.items,
    total: fields.total,
    returned: fields.returned,
    truncated: fields.truncated,
    next_cursor: fields.next_cursor,
    coverage: fields.coverage,
    message: fields.message || '',
  }
}

/**
 * Public projection of a record. Keeps provenance and validity fields, which
 * the Agent needs to judge trust, but omits internal capture bookkeeping.
 */
export function toItem(record, score, tz) {
  return {
    id: record.id,
    kind: record.kind,
    text: record.text,
    event_time: record.event_start_ms ? new Date(record.event_start_ms).toISOString() : null,
    event_time_end: record.event_end_ms ? new Date(record.event_end_ms).toISOString() : null,
    time_label: formatEvent(record, tz),
    time_precision: record.time_precision,
    time_basis: record.time_basis,
    recorded_at: record.recorded_at,
    status: record.status,
    sensitivity: record.sensitivity,
    supersedes: record.supersedes || undefined,
    superseded_by: record.superseded_by || undefined,
    valid_to: record.valid_to ? new Date(record.valid_to).toISOString() : undefined,
    source: record.source,
    score: Math.round(score * 1000) / 1000,
  }
}

const SECTIONS = {
  happened: new Set(['event', 'outcome', 'claim']),
  decisions: new Set(['decision', 'correction', 'preference', 'fact']),
  plans: new Set(['plan']),
}

/**
 * Day view: everything that happened (or was recorded) on one local date,
 * grouped into happened / decisions / plans / pending for human reading.
 *
 * `view: 'event'` uses event time and falls back to recorded time for records
 * with no event time. `view: 'recorded'` uses the write time, which is what
 * "what did we talk about today" means even for a backdated note.
 */
export function searchDay(records, key, tz = 'UTC', options = {}) {
  const range = dayRange(key, tz)
  if (!range) {
    return buildResult({
      status: 'error',
      items: [],
      total: 0,
      returned: 0,
      truncated: false,
      next_cursor: null,
      coverage: '',
      message: '日期必须是真实存在的 YYYY-MM-DD（例如 2026-02-31 无效）',
    })
  }
  const { view = 'event', nowMs = Date.now(), retentionDays = 365, limit = 100, namespace } = options
  const inDay = records.filter((r) => {
    if (r.status === 'deleted') return false
    if (!inNamespace(r, namespace)) return false
    if (view === 'recorded') {
      return r.recorded_at >= range.startMs && r.recorded_at < range.endMs
    }
    if (!Number.isFinite(r.event_start_ms)) {
      return r.recorded_at >= range.startMs && r.recorded_at < range.endMs
    }
    const re = r.event_end_ms || r.event_start_ms + 1
    return Math.min(re, range.endMs) - Math.max(r.event_start_ms, range.startMs) > 0
  })

  if (inDay.length === 0) {
    const out = range.endMs <= nowMs - retentionDays * DAY_MS
    return buildResult({
      status: out ? 'out_of_retention' : 'no_data',
      items: [],
      total: 0,
      returned: 0,
      truncated: false,
      next_cursor: null,
      coverage: coverageText(range.startMs, range.endMs, tz, retentionDays),
      message: out ? `该日期早于保留范围（保留 ${retentionDays} 天）` : '该日期没有已记录的记忆',
    })
  }

  const groups = { happened: [], decisions: [], plans: [], pending: [] }
  for (const r of inDay) {
    if (r.status === 'disputed' || !Number.isFinite(r.event_start_ms)) {
      groups.pending.push(r)
      continue
    }
    const section = Object.entries(SECTIONS).find(([, kinds]) => kinds.has(r.kind))?.[0] || 'happened'
    groups[section].push(r)
  }
  for (const list of Object.values(groups)) {
    list.sort((a, b) => (a.event_start_ms ?? a.recorded_at) - (b.event_start_ms ?? b.recorded_at))
  }
  const items = Object.entries(groups)
    .filter(([, list]) => list.length)
    .map(([section, list]) => ({
      section,
      items: list.slice(0, limit).map((r) => toItem(r, 1, tz)),
      total: list.length,
    }))

  const total = inDay.length
  const truncated = total > items.reduce((n, g) => n + g.items.length, 0)
  return buildResult({
    status: 'ok',
    items,
    total,
    returned: items.reduce((n, g) => n + g.items.length, 0),
    truncated,
    next_cursor: null,
    coverage: `${coverageText(range.startMs, range.endMs, tz, retentionDays)}；按${view === 'recorded' ? '记录日' : '事件日'}归档`,
    message: truncated ? '结果已截断，请缩小范围或使用 memory_search' : '',
  })
}

/**
 * Chronological evolution of a topic. Unlike `searchRecords`, results are
 * ordered by time rather than relevance, because the question being answered
 * is "how did this change", not "what is most relevant".
 */
export function timeline(records, options = {}) {
  const { topic = '', fromMs, toMs, tz = 'UTC', limit = 50, cursor, namespace } = options
  const tokens = tokenize(topic)
  const keyOf = (r) => r.event_start_ms ?? r.recorded_at ?? 0
  const all = records
    .filter((r) => r.status !== 'deleted')
    .filter((r) => inNamespace(r, namespace))
    .filter((r) => matchesTime(r, fromMs, toMs))
    .filter((r) => {
      if (!tokens.length) return true
      const hay = `${r.text || ''} ${(r.topics || []).join(' ')} ${(r.entities || []).join(' ')}`.toLowerCase()
      return tokens.some((t) => hay.includes(t))
    })
    .sort((a, b) => keyOf(a) - keyOf(b) || String(a.id).localeCompare(String(b.id)))

  if (all.length === 0) {
    return buildResult({
      status: 'no_match',
      items: [],
      total: 0,
      returned: 0,
      truncated: false,
      next_cursor: null,
      coverage: '',
      message: '没有匹配的主题演变记录',
    })
  }

  let start = 0
  if (cursor) {
    const stable = /^ts:(-?\d+):(.+)$/.exec(String(cursor))
    if (stable) {
      const idx = all.findIndex((r) => keyOf(r) === Number(stable[1]) && r.id === stable[2])
      if (idx >= 0) start = idx + 1
    }
  }
  const page = all.slice(start, start + Math.max(1, limit))
  const last = page.at(-1)
  const next = last && start + page.length < all.length ? `ts:${keyOf(last)}:${last.id}` : null
  return buildResult({
    status: 'ok',
    items: page.map((r) => toItem(r, 1, tz)),
    total: all.length,
    returned: page.length,
    truncated: next !== null,
    next_cursor: next,
    coverage: '',
    message: next ? `另有 ${all.length - start - page.length} 条未展示，可用 next_cursor 继续读取` : '',
  })
}

export { dateKey }
