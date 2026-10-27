/**
 * L2 daily journal.
 *
 * The journal belongs to the Agent. Its text is written by the host's scheduled
 * task following `journal-prompt.md`; this module never generates prose.
 *
 * Metadata is derived from the file itself — filename for the date, mtime for
 * "when this version was written", size for the excerpt — with no sidecar and
 * no index. That keeps the journal a plain Markdown file a human can edit, and
 * it makes staleness detectable: if a journal's mtime predates the newest L1
 * record for that day, the journal may not cover the end of the day.
 *
 * If a day has no journal, the API says so. It never dresses an L1 summary up
 * as a journal entry.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_NAMESPACE, inNamespace } from './namespace.js'
import { writeTextAtomic } from './paths.js'
import { searchDay } from './search.js'
import { addLocalDays, dateKey, startOfLocalDay } from './time.js'

const MAX_EXCERPT = 1600

/** Day view built from L1 records; the journal is a separate source. */
export function buildDayView(records, key, tz = 'UTC', options = {}) {
  return searchDay(records, key, tz, options)
}

/**
 * Directory for a namespace's journals. The default namespace uses
 * `journal/`; other namespaces get a hash subdirectory so a namespace name can
 * never escape the memory root or collide with a date filename.
 */
export function journalDir(root, namespace = DEFAULT_NAMESPACE) {
  if (!namespace || namespace === DEFAULT_NAMESPACE) return path.join(root, 'journal')
  const hash = createHash('sha256').update(String(namespace)).digest('hex').slice(0, 16)
  return path.join(root, 'journal', 'namespaces', hash)
}

/** Absolute path of one day's journal file. `key` must be YYYY-MM-DD. */
export function journalPath(root, key, namespace = DEFAULT_NAMESPACE) {
  return path.join(journalDir(root, namespace), `${key}.md`)
}

/**
 * Stat the journal file. mtime is the authoritative "authored at" value:
 * journaling happens after the day it describes, so it is naturally later than
 * that day's L1 records.
 */
function journalStat(root, key, namespace) {
  try {
    const stat = fs.statSync(journalPath(root, key, namespace))
    return stat.isFile() ? { mtimeMs: stat.mtimeMs, bytes: stat.size } : null
  } catch {
    return null
  }
}

/**
 * Derived journal metadata. Returns null when the file does not exist; there is
 * no cached or indexed alternative that could disagree with the filesystem.
 */
export function getJournalEntry(root, key, namespace = DEFAULT_NAMESPACE) {
  const stat = journalStat(root, key, namespace)
  if (!stat) return null
  return {
    key,
    namespace,
    author: 'agent',
    authored_at: stat.mtimeMs,
    bytes: stat.bytes,
    path: journalPath(root, key, namespace),
  }
}

/**
 * Whether a journal can be trusted to cover that day's L1 records.
 *
 * Covered requires the file to exist and to have been written after the newest
 * record for that day. An earlier mtime means the journal was written before
 * the day ended, so the later part may be missing. Retention uses this gate:
 * a stale journal must not authorize deleting uncovered L1 records.
 */
export function journalCovers(root, key, { namespace = DEFAULT_NAMESPACE, latestRecordedAt = 0 } = {}) {
  const stat = journalStat(root, key, namespace)
  if (!stat) return { covered: false, reason: 'journal_missing' }
  if (latestRecordedAt && stat.mtimeMs < latestRecordedAt) return { covered: false, reason: 'journal_stale' }
  return { covered: true, reason: 'ok' }
}

/** Raw Markdown of a journal, or null when absent/unreadable. */
export function readJournalMarkdown(root, key, namespace = DEFAULT_NAMESPACE) {
  try {
    return fs.readFileSync(journalPath(root, key, namespace), 'utf8')
  } catch {
    return null
  }
}

/**
 * Journal dates, newest first. Reverse chronological order is deliberate: a
 * reader asking about "recently" should see the most recent days first, and
 * only the first few are usually needed.
 */
export function listJournalKeys(root, namespace = DEFAULT_NAMESPACE) {
  let names
  try {
    names = fs.readdirSync(journalDir(root, namespace))
  } catch {
    return []
  }
  return names
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name))
    .map((name) => name.slice(0, -3))
    .sort()
    .reverse()
}

/** Number of journal day-files. */
export function countJournalFiles(root, namespace = DEFAULT_NAMESPACE) {
  return listJournalKeys(root, namespace).length
}

/** Metadata for every journal, newest first. */
export function listJournalEntries(root, namespace = DEFAULT_NAMESPACE) {
  return listJournalKeys(root, namespace)
    .map((key) => getJournalEntry(root, key, namespace))
    .filter(Boolean)
}

/** Enumerate local date keys in [fromMs, toMs), capped to stay bounded. */
function dayKeysBetween(fromMs, toMs, tz, max = 31) {
  const start = startOfLocalDay(fromMs, tz)
  const end = toMs ?? addLocalDays(start, 1, tz)
  const keys = []
  for (let ms = start; ms < end && keys.length < max; ms = addLocalDays(ms, 1, tz)) {
    keys.push(dateKey(ms, tz))
  }
  return keys
}

/**
 * Fuzzy-time recall, routed to L2 first.
 *
 * Human time references are usually coarse ("yesterday", "last week"), and a
 * day journal answers those far more cheaply than scanning L1. This function
 * returns the journals in the window and explicitly reports gaps:
 *
 *   - missing: a day had L1 records but no journal;
 *   - stale: a journal was written before the day's last record;
 *   - fallback: 'l1', telling the caller to widen the search if needed.
 *
 * A day with no journal and no records is reported as `no_data` with a warning
 * that absence of evidence is not evidence of absence.
 */
export function journalRecall({
  root,
  records = [],
  fromMs,
  toMs,
  tz = 'UTC',
  nowMs = Date.now(),
  maxDays = 31,
  namespace = DEFAULT_NAMESPACE,
} = {}) {
  if (!fromMs && !toMs) {
    return { status: 'no_data', route: 'journal', items: [], message: '没有可用的模糊时间范围。' }
  }
  const start = fromMs ?? startOfLocalDay(nowMs, tz)
  const end = toMs ?? addLocalDays(start, 1, tz)
  const keys = dayKeysBetween(start, end, tz, maxDays)
  const daySet = new Set(keys)
  const latestByDay = new Map()
  const daysWithRecords = new Set()
  for (const record of records) {
    if (record.status === 'deleted' || !Number.isFinite(record.event_start_ms)) continue
    if (!inNamespace(record, namespace)) continue
    const key = dateKey(record.event_start_ms, tz)
    if (!daySet.has(key)) continue
    daysWithRecords.add(key)
    latestByDay.set(key, Math.max(latestByDay.get(key) || 0, record.recorded_at || 0))
  }

  const items = []
  const missing = []
  const stale = []
  for (const key of keys) {
    const entry = getJournalEntry(root, key, namespace)
    if (!entry) {
      if (daysWithRecords.has(key)) missing.push(key)
      continue
    }
    const latest = latestByDay.get(key) || 0
    if (latest && entry.authored_at < latest) stale.push(key)
    const markdown = readJournalMarkdown(root, key, namespace)
    items.push({
      date: key,
      path: entry.path,
      authored_at: entry.authored_at,
      bytes: entry.bytes,
      excerpt: markdown ? markdown.slice(0, MAX_EXCERPT) : '',
    })
  }

  const total = items.length
  if (missing.length || stale.length) {
    return {
      status: total ? 'partial' : 'no_data',
      route: 'journal',
      items,
      total,
      date_from: keys[0],
      date_to: keys.at(-1),
      missing,
      stale,
      fallback: 'l1',
      fallback_reason: missing.length ? 'journal_missing' : 'journal_stale',
      message: `${missing.length ? `这些天没有日记：${missing.join('、')}；` : ''}${stale.length ? `这些天的日记写于当天最后一条记录之前，可能没覆盖后半段：${stale.join('、')}；` : ''}可回退 L1 工作记忆；精确引用请回 L0 核对。`,
    }
  }
  if (total === 0) {
    return {
      status: 'no_data',
      route: 'journal',
      items: [],
      total: 0,
      date_from: keys[0],
      date_to: keys.at(-1),
      message: '该时间范围没有日记，也没有对应的 L1 记录；不能据此判断“没有发生”。',
    }
  }
  return {
    status: 'ok',
    route: 'journal',
    items,
    total,
    date_from: keys[0],
    date_to: keys.at(-1),
    message: '已从日记回答；需要逐句原文时回 L0 核对。',
  }
}

/**
 * Scrub deleted content from affected journals, line by line.
 *
 * Only deletion calls this. A correction intentionally does not rewrite
 * history: the journal records what was believed at the time, not a ledger
 * that is silently edited later. Deletion is different — the user asked for
 * the content to be gone.
 */
export function rebuildJournalDays({
  root,
  keys = [],
  scrubTexts = [],
  namespace = DEFAULT_NAMESPACE,
} = {}) {
  const needles = scrubTexts.map((s) => String(s || '').trim()).filter((s) => s.length >= 2)
  const results = []
  if (!needles.length) return results
  for (const key of [...new Set(keys)].filter(Boolean)) {
    const file = journalPath(root, key, namespace)
    let before
    try {
      before = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const after = before
      .split('\n')
      .filter((line) => !needles.some((needle) => line.includes(needle)))
      .join('\n')
    if (after === before) continue
    writeTextAtomic(file, after.replace(/\n{3,}/g, '\n\n'))
    results.push({ key, scrubbed: true })
  }
  return results
}
