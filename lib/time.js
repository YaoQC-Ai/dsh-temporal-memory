/**
 * Time-zone-safe date arithmetic and fuzzy time parsing.
 *
 * Two rules drive this module:
 *
 * 1. A calendar day is a local-day concept, not a 24-hour UTC window. Every
 *    conversion goes through the configured IANA zone, so DST transitions and
 *    non-hour offsets do not shift "yesterday" into the wrong day.
 * 2. A remembered event has an interval, a precision, and a basis. The parser
 *    returns all three instead of pretending every phrase is an exact instant:
 *      - precision: minute | day | range | unknown
 *      - basis:     stated (the user said it) | inferred (resolved from context)
 *      - confidence: 0..1, consumed by ranking and display
 *
 * The phrase grammar is Chinese, matching the primary audience. Unrecognized
 * text yields `null`; callers must treat that as "time unknown", never as now.
 */
const DAY_MS = 86_400_000
const formatterCache = new Map()
const tzValidity = new Map()

/** Validate an IANA zone once and cache the result (Intl throws on bad zones). */
export function isValidTz(tz) {
  if (typeof tz !== 'string' || !tz) return false
  if (tzValidity.has(tz)) return tzValidity.get(tz)
  let ok = true
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(0)
  } catch {
    ok = false
  }
  tzValidity.set(tz, ok)
  return ok
}

/** Invalid or missing zones fall back to UTC instead of throwing mid-turn. */
export function normalizeTz(tz) {
  return isValidTz(tz) ? tz : 'UTC'
}

/** True only for a real calendar date (rejects 2026-02-30). */
export function validYmd(year, month, day) {
  if (!Number.isInteger(year) || year < 1000 || year > 9999) return false
  if (!Number.isInteger(month) || month < 1 || month > 12) return false
  if (!Number.isInteger(day) || day < 1 || day > 31) return false
  const d = new Date(Date.UTC(year, month - 1, day))
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day
}

function formatter(tz) {
  let f = formatterCache.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    })
    formatterCache.set(tz, f)
  }
  return f
}

/** Break an instant into wall-clock parts in `tz` (month is 1-based). */
export function localParts(ms, tz = 'UTC') {
  const parts = formatter(normalizeTz(tz)).formatToParts(new Date(ms))
  const out = {}
  for (const p of parts) {
    if (p.type !== 'literal') out[p.type] = p.value
  }
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour: Number(out.hour) % 24,
    minute: Number(out.minute),
    second: Number(out.second),
  }
}

/**
 * Convert a wall-clock reading in `tz` to a UTC epoch.
 *
 * There is no built-in inverse for Intl, so start with the naive UTC instant
 * and correct by the observed offset. Iterating handles DST boundaries where a
 * single correction would land on the other side of the transition.
 */
export function zonedTimeToUtc(year, month, day, hour = 0, minute = 0, second = 0, tz = 'UTC') {
  tz = normalizeTz(tz)
  const target = Date.UTC(year, month - 1, day, hour, minute, second, 0)
  let guess = target
  for (let i = 0; i < 3; i++) {
    const p = localParts(guess, tz)
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second, 0)
    const diff = target - asUtc
    if (diff === 0) break
    guess += diff
  }
  return guess
}

/** Add whole calendar days in local time, preserving the wall-clock time. */
export function addLocalDays(ms, n, tz = 'UTC') {
  const p = localParts(ms, tz)
  return zonedTimeToUtc(p.year, p.month, p.day + n, p.hour, p.minute, p.second, tz)
}

/** First instant of the local day containing `ms`. */
export function startOfLocalDay(ms, tz = 'UTC') {
  const p = localParts(ms, tz)
  return zonedTimeToUtc(p.year, p.month, p.day, 0, 0, 0, tz)
}

/** Local calendar key `YYYY-MM-DD`, also used as the journal filename. */
export function dateKey(ms, tz = 'UTC') {
  const p = localParts(ms, tz)
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`
}

/**
 * Half-open `[startMs, endMs)` bounds for a local `YYYY-MM-DD` key.
 * Returns null for malformed or impossible dates so callers can reject a query
 * instead of silently searching the wrong day.
 */
export function dayRange(key, tz = 'UTC') {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''))
  if (!m) return null
  const [year, month, day] = [+m[1], +m[2], +m[3]]
  if (!validYmd(year, month, day)) return null
  const startMs = zonedTimeToUtc(year, month, day, 0, 0, 0, tz)
  const p = localParts(startMs, tz)
  return { startMs, endMs: zonedTimeToUtc(p.year, p.month, p.day + 1, 0, 0, 0, tz) }
}

/** Half-open bounds for a calendar month; month is 1-based. */
export function monthRange(year, month, tz = 'UTC') {
  if (!Number.isInteger(year) || year < 1000 || year > 9999 || !Number.isInteger(month) || month < 1 || month > 12) {
    return null
  }
  const startMs = zonedTimeToUtc(year, month, 1, 0, 0, 0, tz)
  const endMs = zonedTimeToUtc(year, month + 1, 1, 0, 0, 0, tz)
  return { startMs, endMs }
}

/** ISO weekday: Monday=1 … Sunday=7. */
function isoWeekday(ms, tz) {
  const p = localParts(ms, tz)
  const dow = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay()
  return (dow + 6) % 7 + 1
}

function isoMonday(ms, tz) {
  return startOfLocalDay(addLocalDays(startOfLocalDay(ms, tz), -(isoWeekday(ms, tz) - 1), tz), tz)
}

// Chinese day periods shift a 12-hour clock into 24-hour time. Values are the
// number of hours to add when the written hour is below 12.
const PERIOD_HOUR = { 凌晨: 0, 上午: 0, 早上: 0, 中午: 12, 下午: 12, 傍晚: 12, 晚上: 12 }

/**
 * Extract a clock time from the phrase. Supports `14:30` and `下午3点20分`.
 * The result is intentionally "minute" precision even when only the hour was
 * stated; callers can widen it later using the original text if needed.
 */
function extractTimeOfDay(text) {
  let m = /(\d{1,2})[:：](\d{2})/.exec(text)
  if (m) {
    const hour = Number(m[1])
    const minute = Number(m[2])
    if (hour <= 23 && minute <= 59) return { hour, minute, precision: 'minute', text: m[0] }
  }
  m = /(凌晨|上午|早上|中午|下午|傍晚|晚上)?\s*(\d{1,2})\s*[点时](?:\s*(\d{1,2})\s*分?)?/.exec(text)
  if (m) {
    const period = m[1] || ''
    let hour = Number(m[2])
    const minute = m[3] === undefined ? 0 : Number(m[3])
    if (hour <= 23 && minute <= 59) {
      if (PERIOD_HOUR[period] !== undefined && hour < 12) {
        hour += PERIOD_HOUR[period]
      } else if (period === '中午' && hour === 12) {
        hour = 12
      }
      return { hour, minute, precision: 'minute', text: m[0] }
    }
  }
  return null
}

/**
 * Parse a full date or a month/day pair.
 * `yearGiven: false` means the year must be inferred relative to the anchor;
 * 2000 is used only to validate month/day combinations such as Feb 29.
 */
function parseDateToken(text) {
  let m = /(\d{4})\s*[-/年]\s*(\d{1,2})\s*[-/月]\s*(\d{1,2})\s*[日号]?/.exec(text)
  if (m) {
    const year = Number(m[1])
    const month = Number(m[2])
    const day = Number(m[3])
    if (!validYmd(year, month, day)) return null
    return { year, month, day, yearGiven: true, text: m[0], index: m.index }
  }
  m = /(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/.exec(text)
  if (m) {
    const month = Number(m[1])
    const day = Number(m[2])
    if (!validYmd(2000, month, day)) return null
    return { year: null, month, day, yearGiven: false, text: m[0], index: m.index }
  }
  return null
}

/**
 * Choose a year for a month/day phrase. A date more than six months in the
 * future is assumed to refer to last year ("12月" said in January).
 */
function resolveYear(month, day, anchorMs, tz) {
  const p = localParts(anchorMs, tz)
  let year = p.year
  const candidate = zonedTimeToUtc(year, month, day, 0, 0, 0, tz)
  if (candidate - anchorMs > 180 * DAY_MS) year -= 1
  return year
}

/**
 * Build one resolved point. With a clock time the interval is one minute;
 * otherwise it is the whole local day. `time_text` keeps the phrase that
 * produced the result so the UI can explain itself later.
 */
function buildPoint({ year, month, day, tod, anchorMs, tz, basis, confidence, text }) {
  let startMs
  let endMs
  let precision
  if (tod) {
    startMs = zonedTimeToUtc(year, month, day, tod.hour, tod.minute, 0, tz)
    endMs = startMs + 60_000
    precision = 'minute'
  } else {
    startMs = zonedTimeToUtc(year, month, day, 0, 0, 0, tz)
    const p = localParts(startMs, tz)
    endMs = zonedTimeToUtc(p.year, p.month, p.day + 1, 0, 0, 0, tz)
    precision = 'day'
  }
  return { startMs, endMs, precision, time_basis: basis, time_confidence: confidence, time_text: text }
}

/**
 * Parse a human time phrase relative to `anchorMs`.
 *
 * Rules are tried from most to least specific; the order matters because a
 * broad pattern ("7月") would otherwise consume the date part of a narrow one
 * ("7月3日"). Returns null when nothing matches — never "now".
 *
 * @param {string} text natural-language phrase, primarily Chinese
 * @param {number} anchorMs instant used to resolve relative expressions
 * @param {string} tz IANA zone used for local-day boundaries
 * @returns {{startMs:number,endMs:number,precision:string,time_basis:string,time_confidence:number,time_text:string}|null}
 */
export function parseTime(text, anchorMs, tz = 'UTC') {
  if (typeof text !== 'string' || !text.trim()) return null
  tz = normalizeTz(tz)
  const raw = text
  const tod = extractTimeOfDay(raw)
  const p = localParts(anchorMs, tz)

  // 1) Explicit range: 2026-10-12 ~ 2026-10-14 or 10月12日到10月14日.
  let m = /(\d{4}\s*[-/年]\s*\d{1,2}\s*[-/月]\s*\d{1,2}\s*[日号]?|\d{1,2}\s*月\s*\d{1,2}\s*[日号])\s*(?:~|～|至|到|—|–)\s*(\d{4}\s*[-/年]\s*\d{1,2}\s*[-/月]\s*\d{1,2}\s*[日号]?|\d{1,2}\s*月\s*\d{1,2}\s*[日号])/.exec(raw)
  if (m) {
    const a = parseDateToken(m[1])
    const b = parseDateToken(m[2])
    if (a && b) {
      const ay = a.yearGiven ? a.year : resolveYear(a.month, a.day, anchorMs, tz)
      const by = b.yearGiven ? b.year : resolveYear(b.month, b.day, anchorMs, tz)
      const startMs = tod
        ? zonedTimeToUtc(ay, a.month, a.day, tod.hour, tod.minute, 0, tz)
        : zonedTimeToUtc(ay, a.month, a.day, 0, 0, 0, tz)
      const lastStart = tod
        ? zonedTimeToUtc(by, b.month, b.day, tod.hour, tod.minute, 0, tz)
        : zonedTimeToUtc(by, b.month, b.day, 0, 0, 0, tz)
      const lastP = localParts(lastStart, tz)
      const endMs = zonedTimeToUtc(lastP.year, lastP.month, lastP.day + 1, 0, 0, 0, tz)
      return {
        startMs,
        endMs,
        precision: 'range',
        time_basis: a.yearGiven && b.yearGiven ? 'stated' : 'inferred',
        time_confidence: a.yearGiven && b.yearGiven ? 0.9 : 0.75,
        time_text: m[0].trim(),
      }
    }
  }

  // 2) Absolute date, optionally followed by a clock time.
  const token = parseDateToken(raw)
  if (token) {
    const year = token.yearGiven ? token.year : resolveYear(token.month, token.day, anchorMs, tz)
    return buildPoint({
      year,
      month: token.month,
      day: token.day,
      tod,
      anchorMs,
      tz,
      basis: token.yearGiven ? 'stated' : 'inferred',
      confidence: token.yearGiven ? 0.95 : 0.8,
      text: token.text + (tod ? ' ' + tod.text : ''),
    })
  }

  // 3) Relative day: 今天/昨天/前天/明天/后天/大后天.
  m = /(大后天|后天|明天|今天|今日|昨天|昨日|前天)/.exec(raw)
  if (m) {
    const offset = { 前天: -2, 昨天: -1, 昨日: -1, 今天: 0, 今日: 0, 明天: 1, 后天: 2, 大后天: 3 }[m[1]]
    const d = addLocalDays(anchorMs, offset, tz)
    const dp = localParts(d, tz)
    return buildPoint({
      year: dp.year,
      month: dp.month,
      day: dp.day,
      tod,
      anchorMs,
      tz,
      basis: 'stated',
      confidence: 0.95,
      text: m[1] + (tod ? ' ' + tod.text : ''),
    })
  }

  // 4) Week expression: 上周三, 这周, 下周. A bare week becomes a 7-day range.
  m = /(上|这|本|下)\s*(?:个)?\s*(?:周|星期|礼拜)\s*([一二三四五六日天])?/.exec(raw)
  if (m) {
    const which = m[1]
    const weekday = m[2]
    const monday = isoMonday(anchorMs, tz)
    const offsetWeeks = which === '上' ? -1 : which === '下' ? 1 : 0
    const baseMonday = addLocalDays(monday, offsetWeeks * 7, tz)
    if (weekday) {
      const idx = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 }[weekday]
      const d = addLocalDays(baseMonday, idx - 1, tz)
      const dp = localParts(d, tz)
      return buildPoint({
        year: dp.year,
        month: dp.month,
        day: dp.day,
        tod,
        anchorMs,
        tz,
        basis: 'stated',
        confidence: 0.9,
        text: m[0],
      })
    }
    return {
      startMs: baseMonday,
      endMs: addLocalDays(baseMonday, 7, tz),
      precision: 'range',
      time_basis: 'stated',
      time_confidence: 0.9,
      time_text: m[0],
    }
  }

  // 5) "N days/weeks/months ago". A month is approximated as 30 days and is
  // marked inferred with lower confidence; exact calendar months are a
  // different user intent ("上个月") and are handled below.
  m = /(\d{1,3})\s*(天|日|周|星期|个月|月)\s*(?:以)?前/.exec(raw)
  if (m) {
    const n = Number(m[1])
    const unit = m[2]
    let startMs
    let confidence = 0.85
    let basis = 'stated'
    if (unit === '天' || unit === '日') {
      startMs = startOfLocalDay(addLocalDays(anchorMs, -n, tz), tz)
    } else if (unit === '周' || unit === '星期') {
      startMs = startOfLocalDay(addLocalDays(anchorMs, -7 * n, tz), tz)
    } else {
      startMs = startOfLocalDay(addLocalDays(anchorMs, -30 * n, tz), tz)
      confidence = 0.5
      basis = 'inferred'
    }
    const p2 = localParts(startMs, tz)
    return buildPoint({
      year: p2.year,
      month: p2.month,
      day: p2.day,
      tod,
      anchorMs,
      tz,
      basis,
      confidence,
      text: m[0],
    })
  }

  // 6) Month expressions: 上个月/本月/2026年7月/7月.
  const monthWord = /(上个月|上月|本月|这个月)/.exec(raw)
  if (monthWord) {
    const p2 = localParts(anchorMs, tz)
    let y = p2.year
    let mo = p2.month
    if (monthWord[1] === '上个月' || monthWord[1] === '上月') {
      mo -= 1
      if (mo < 1) {
        mo = 12
        y -= 1
      }
    }
    const r = monthRange(y, mo, tz)
    if (r) return { ...r, precision: 'range', time_basis: 'stated', time_confidence: 0.9, time_text: monthWord[0] }
  }
  m = /(\d{4})\s*年\s*(\d{1,2})\s*月(?!\s*\d)/.exec(raw)
  if (m) {
    const r = monthRange(Number(m[1]), Number(m[2]), tz)
    if (r) return { ...r, precision: 'range', time_basis: 'stated', time_confidence: 0.9, time_text: m[0].trim() }
  }
  m = /(?<!\d)(\d{1,2})\s*月(?!\s*\d)/.exec(raw)
  if (m) {
    const p2 = localParts(anchorMs, tz)
    let y = p2.year
    const mo = Number(m[1])
    if (mo >= 1 && mo <= 12) {
      if (mo > p2.month + 1) y -= 1
      const r = monthRange(y, mo, tz)
      if (r) return { ...r, precision: 'range', time_basis: 'inferred', time_confidence: 0.75, time_text: m[0].trim() }
    }
  }

  // 7) Vague recent range. Keep this last so it cannot swallow a precise phrase.
  m = /(最近|前几天|前阵子|这几天|这段时间|近期)/.exec(raw)
  if (m) {
    const startMs = startOfLocalDay(addLocalDays(anchorMs, -7, tz), tz)
    const endMs = startOfLocalDay(addLocalDays(anchorMs, 1, tz), tz)
    return { startMs, endMs, precision: 'range', time_basis: 'inferred', time_confidence: 0.6, time_text: m[0] }
  }

  // 8) Clock time without a date: use the anchor's local day, but mark it
  // inferred because the day itself was not stated.
  if (tod) {
    return buildPoint({
      year: p.year,
      month: p.month,
      day: p.day,
      tod,
      anchorMs,
      tz,
      basis: 'inferred',
      confidence: 0.6,
      text: tod.text,
    })
  }

  return null
}

/**
 * Human-readable event-time label used in prompts and search results.
 * Unknown time is shown with its recorded date instead of being hidden; the
 * distinction is itself useful information.
 */
export function formatEvent(record, tz = 'UTC') {
  const start = record.event_start_ms
  const end = record.event_end_ms
  const precision = record.time_precision || 'unknown'
  if (!start || precision === 'unknown') {
    const rec = record.recorded_at ? dateKey(record.recorded_at, tz) : '未知'
    return `事件时间未知（记录于 ${rec}）`
  }
  const p = localParts(start, tz)
  const hhmm = `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`
  const day = dateKey(start, tz)
  const approx = record.time_basis === 'inferred' ? '约 ' : ''
  if (precision === 'range') {
    const endKey = dateKey(Math.max(start, (end || start) - 1), tz)
    return `${approx}${day}～${endKey}（跨日/范围）`
  }
  if (precision === 'minute') return `${approx}${day} ${hhmm}`
  return `${approx}${day}（仅日期）`
}

/**
 * Describe the time window a result actually covers, plus the retention
 * policy. Shown next to injected memories so the Agent can distinguish
 * "nothing happened" from "old data was pruned".
 */
export function coverageText(fromMs, toMs, tz, retentionDays) {
  const f = fromMs ? dateKey(fromMs, tz) : '最早'
  const t = toMs ? dateKey(Math.max(fromMs || 0, toMs - 1), tz) : '最新'
  const retention = retentionDays ? `保留期 ${retentionDays} 天` : '未设置保留期'
  return `${f}～${t} ${tz}；${retention}`
}

export { DAY_MS }
