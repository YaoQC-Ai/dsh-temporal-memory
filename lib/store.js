/**
 * L1 event store.
 *
 * L1 is an append-only JSONL log sharded by recorded month. A record is never
 * updated in place for normal operation; two operations do rewrite a shard
 * atomically:
 *
 *   - deletion: the target line becomes a tombstone, so the body is physically
 *     gone while line positions and other records stay untouched;
 *   - supersession: the target line gets `status: superseded` plus validity
 *     bounds, so a correction is durable rather than a read-time illusion.
 *
 * Identity is content-derived (`recordId`), which makes re-ingesting the same
 * turn idempotent. `applySupersedes` is also applied at read time so a log that
 * was written by an older version still resolves correctly.
 *
 * Retention is journal-gated: an expired record is only removed when an Agent
 * journal entry for its event day exists and is at least as new as the record.
 * A missing, partial, stale, or legacy journal keeps the record. L1 is the
 * source of truth; a lossy summary must never be the reason it disappears.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  appendLine,
  listMonthFiles,
  monthFile,
  monthKey,
  readJson,
  resolveRoot,
  writeJsonAtomic,
  writeTextAtomic,
} from './paths.js'
import { redact } from './classify.js'
import { DEFAULT_NAMESPACE, inNamespace, namespaceOf } from './namespace.js'
import { appendSession, readSessionEntries } from './sessions.js'
import { DAY_MS, dateKey } from './time.js'

const SCHEMA_VERSION = 1
const SUPERSEDE_WINDOW_MS = 30 * 86_400_000

/**
 * Stable content id. Built from source pointers, kind, and normalized text, so
 * replaying the same turn produces the same id and `append` is idempotent.
 * 16 hex chars (64 bits) is ample for a local memory store; collisions would
 * only cause a skipped duplicate, never a wrong lookup.
 */
export function recordId(record) {
  const key = [
    record.source?.session || '',
    record.source?.seq_from ?? '',
    record.kind || '',
    String(record.text || '').replace(/\s+/g, ' ').trim(),
  ].join('\u0000')
  return 'm_' + createHash('sha256').update(key).digest('hex').slice(0, 16)
}

/** Hash of a record's sentence, used to erase exactly that sentence from L2. */
function deletionHash(text) {
  const normalized = String(text || '')
    .replace(/^\s*(?:[-*•]\s*|\d{1,2}[.)、]\s+)/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[。；;！!？?]$/, '')
  return normalized ? createHash('sha256').update(normalized).digest('hex').slice(0, 32) : ''
}

export class Store {
  constructor(root = resolveRoot()) {
    this.root = root
    this.ids = null
  }

  get cursorPath() {
    return path.join(this.root, 'state', 'cursor.json')
  }

  /** Lazily load the id set once per process; append/delete keep it in sync. */
  ensureIds() {
    if (this.ids) return this.ids
    this.ids = new Set(this.readAll().map((r) => r.id))
    return this.ids
  }

  /**
   * Append records, redacting once more at the storage boundary.
   *
   * This is the last line of defence: even if a caller forgot to redact, or a
   * future tool path writes directly, credentials cannot reach disk. Records
   * explicitly marked `secret` are dropped entirely.
   *
   * @returns {number} number of records actually written
   */
  append(records) {
    if (!Array.isArray(records) || records.length === 0) return 0
    const ids = this.ensureIds()
    const now = Date.now()
    let written = 0
    for (const record of records) {
      const candidate = {
        ...record,
        schema_version: SCHEMA_VERSION,
        ingested_at: now,
      }
      // Storage-boundary redaction: callers may already have redacted, but this
      // pass guarantees credentials never reach disk.
      const safeText = redact(candidate.text)
      if (safeText.redacted) {
        candidate.text = safeText.text
        candidate.sensitivity = candidate.sensitivity === 'secret' ? 'secret' : 'private'
      }
      if (candidate.source?.quote) {
        const safeQuote = redact(candidate.source.quote)
        if (safeQuote.redacted) {
          candidate.source = { ...candidate.source, quote: safeQuote.text }
          candidate.sensitivity = candidate.sensitivity === 'secret' ? 'secret' : 'private'
        }
      }
      candidate.id = record.id || recordId(candidate)
      if (ids.has(candidate.id)) continue
      if (candidate.sensitivity === 'secret') continue
      const line = JSON.stringify(candidate)
      appendLine(monthFile(this.root, candidate.recorded_at || candidate.ingested_at), line)
      ids.add(candidate.id)
      written++
    }
    return written
  }

  /**
   * Read every live record across all month shards.
   *
   * Tombstones are skipped, duplicate ids keep the first copy, and supersede
   * edges are applied before returning. Malformed lines are skipped rather
   * than failing the whole read, so one corrupt byte cannot lock the user out
   * of their memory.
   */
  readAll() {
    const records = []
    const seen = new Set()
    for (const file of listMonthFiles(this.root)) {
      let text
      try {
        text = fs.readFileSync(file, 'utf8')
      } catch {
        continue
      }
      for (const line of text.split('\n')) {
        if (!line.trim()) continue
        let value
        try {
          value = JSON.parse(line)
        } catch {
          continue
        }
        if (!value || typeof value !== 'object') continue
        if (value._type === 'tombstone') continue
        if (!value.id || seen.has(value.id)) continue
        seen.add(value.id)
        records.push(value)
      }
    }
    applySupersedes(records)
    return records
  }

  get(id) {
    return this.readAll().find((r) => r.id === id) || null
  }

  /**
   * Conservatively link a natural-language correction to the fact it replaces.
   *
   * The candidate must be active, non-correction, in the same namespace, no
   * newer than the correction, within 30 days, and share a topic or entity.
   * Only a *unique* candidate is linked. When the evidence is ambiguous it is
   * better to keep two facts than to silently invalidate the wrong one.
   */
  findSupersedeTarget(record) {
    if (!record || record.kind !== 'correction') return null
    const keys = new Set([...(record.topics || []), ...(record.entities || [])].filter(Boolean))
    if (keys.size === 0) return null
    const at = record.event_start_ms ?? record.recorded_at ?? Date.now()
    const candidates = this.readAll().filter((r) => {
      if (r.status !== 'active' || r.kind === 'correction') return false
      if (namespaceOf(r) !== namespaceOf(record)) return false
      if (!Number.isFinite(r.event_start_ms) || r.event_start_ms > at) return false
      if (at - r.event_start_ms > SUPERSEDE_WINDOW_MS) return false
      return [...keys].some((k) => (r.topics || []).includes(k) || (r.entities || []).includes(k))
    })
    return candidates.length === 1 ? candidates[0] : null
  }

  /** Delete one record by replacing its line with a tombstone. */
  delete(id, reason = 'user-request') {
    return this.deleteMany([id], reason) > 0
  }

  /**
   * Delete several records. Each affected shard is rewritten once, so batch
   * deletion is O(files) rather than O(records × files).
   */
  deleteMany(ids, reason = 'user-request') {
    const targets = new Set([...ids].filter(Boolean))
    if (targets.size === 0) return 0
    let removed = 0
    for (const file of listMonthFiles(this.root)) {
      let text
      try {
        text = fs.readFileSync(file, 'utf8')
      } catch {
        continue
      }
      let found = false
      const next = text.split('\n').map((line) => {
        if (!line.trim()) return line
        let value
        try {
          value = JSON.parse(line)
        } catch {
          return line
        }
        if (value._type === 'tombstone' || !targets.has(value.id)) return line
        found = true
        removed++
        return JSON.stringify({ _type: 'tombstone', id: value.id, deleted_at: Date.now(), reason })
      })
      if (!found) continue
      writeTextAtomic(file, next.join('\n'))
    }
    if (removed > 0 && this.ids) {
      for (const id of targets) this.ids.delete(id)
    }
    return removed
  }

  get deletedPath() {
    return path.join(this.root, 'state', 'deleted.json')
  }

  /**
   * Persist the location of a deleted record so L2 can be scrubbed too.
   *
   * A record-level deletion stores the sentence hash, allowing a journal
   * rebuild to remove only that sentence. Older entries without hashes retain
   * their whole-range filter, so pre-existing deletion requests still work
   * after an upgrade.
   */
  recordDeletedRange(record) {
    const session = record?.source?.session
    if (!session) return
    const seqFrom = record.source?.seq_from
    const seqTo = record.source?.seq_to ?? seqFrom
    if (!Number.isFinite(seqFrom) || !Number.isFinite(seqTo)) return
    const hash = deletionHash(record?.text)
    if (!hash) return
    const data = readJson(this.deletedPath, { version: 1, ranges: [] })
    const ranges = Array.isArray(data.ranges) ? data.ranges : []
    const same = ranges.find((r) => r.scope === 'record'
      && r.session === session && r.seq_from === seqFrom && r.seq_to === seqTo)
    if (same) {
      same.hashes = [...new Set([...(same.hashes || []), hash])]
      same.at = Date.now()
    } else {
      ranges.push({
        session,
        seq_from: seqFrom,
        seq_to: seqTo,
        scope: 'record',
        hashes: [hash],
        recorded_at: record.recorded_at || Date.now(),
        at: Date.now(),
      })
    }
    writeJsonAtomic(this.deletedPath, { version: 1, ranges })
  }

  deletedRanges() {
    const data = readJson(this.deletedPath, { version: 1, ranges: [] })
    return Array.isArray(data.ranges) ? data.ranges : []
  }

  /**
   * Prune expired L1 records, but only where L2 can cover the loss.
   *
   * Expiry is measured from `recorded_at`, so a backdated record still gets a
   * full retention period. A record is removed only when `journalCoverage`
   * says its event day has an `ok` journal entry that is not older than the
   * record. Partial, stale, or legacy journals retain the record. The result
   * reports why records were kept, which is what `memory_health` surfaces.
   */
  prune(retentionDays, {
    nowMs = Date.now(),
    tz = 'UTC',
    namespace,
    journalCoverage,
    hasJournal,
  } = {}) {
    const coverage = journalCoverage
      || (hasJournal
        ? (_record, day) => ({ covered: Boolean(hasJournal(day)), reason: 'journal_missing' })
        : () => ({ covered: false, reason: 'journal_missing' }))
    const cutoff = nowMs - retentionDays * DAY_MS
    const all = this.readAll().filter((r) => r.status !== 'deleted' && inNamespace(r, namespace))
    const removable = []
    const retained = []
    for (const record of all) {
      const time = Number.isFinite(record.recorded_at) ? record.recorded_at : record.event_start_ms
      if (!Number.isFinite(time) || time >= cutoff) continue
      const day = dateKey(Number.isFinite(record.event_start_ms) ? record.event_start_ms : time, tz)
      const result = coverage(record, day) || { covered: false, reason: 'journal_missing' }
      if (result.covered) removable.push(record)
      else retained.push({ id: record.id, day, reason: result.reason || 'journal_missing' })
    }
    const removed = this.deleteMany(removable.map((r) => r.id), 'retention')
    const reasons = {}
    for (const item of retained) reasons[item.reason] = (reasons[item.reason] || 0) + 1
    return {
      retentionDays,
      cutoff,
      cutoff_day: dateKey(cutoff, tz),
      removed,
      retained_uncovered: retained.length,
      retained_reasons: reasons,
      retained: retained.slice(0, 50),
    }
  }

  /**
   * Register that a session existed on a day, without storing any content.
   * This lets L2 notice pure Q&A sessions (which produce no L1 records) and
   * lets a journal be rebuilt after cleanup. The key is session+day+namespace,
   * so repeated turns on the same day write only once.
   */
  registerSession(sessionId, { namespace = DEFAULT_NAMESPACE, atMs = Date.now(), tz = 'UTC' } = {}) {
    if (!sessionId || !Number.isFinite(atMs)) return false
    const day = dateKey(atMs, tz)
    const key = `${sessionId}\u0000${day}\u0000${namespace || DEFAULT_NAMESPACE}`
    const marks = this.ensureSessionMarks()
    if (marks.has(key)) return false
    appendSession(this.root, { session: sessionId, namespace, atMs, tz })
    marks.add(key)
    return true
  }

  ensureSessionMarks() {
    if (this.sessionMarks) return this.sessionMarks
    this.sessionMarks = new Set(readSessionEntries(this.root)
      .map((entry) => `${entry.session}\u0000${entry.day}\u0000${entry.namespace}`))
    return this.sessionMarks
  }

  /**
   * Persist a supersede edge on the target line so the relationship survives
   * independently of the correction record and is visible to external readers.
   */
  supersede(targetId, byId, atMs) {
    for (const file of listMonthFiles(this.root)) {
      let text
      try {
        text = fs.readFileSync(file, 'utf8')
      } catch {
        continue
      }
      let found = false
      const next = text.split('\n').map((line) => {
        if (!line.trim()) return line
        let value
        try {
          value = JSON.parse(line)
        } catch {
          return line
        }
        if (value._type === 'tombstone' || value.id !== targetId) return line
        found = true
        value.status = 'superseded'
        value.superseded_by = byId
        value.valid_to = value.valid_to || atMs || Date.now()
        value.valid_from = value.valid_from || value.event_start_ms || value.recorded_at
        return JSON.stringify(value)
      })
      if (!found) continue
      writeTextAtomic(file, next.join('\n'))
      return true
    }
    return false
  }

  getCursor(sessionId) {
    const data = readJson(this.cursorPath, { version: 1, sessions: {} })
    return data.sessions?.[sessionId]?.seq
  }

  setCursor(sessionId, seq) {
    const data = readJson(this.cursorPath, { version: 1, sessions: {} })
    data.version = 1
    data.sessions = data.sessions || {}
    data.sessions[sessionId] = { seq, updated_at: Date.now() }
    writeJsonAtomic(this.cursorPath, data)
  }

  pendingPath(sessionId) {
    const name = createHash('sha256').update(String(sessionId)).digest('hex').slice(0, 16)
    return path.join(this.root, 'state', 'pending', `${name}.json`)
  }

  /**
   * Snapshot an in-flight turn. If the process dies before turn/end, the next
   * `agent/created` recovers this snapshot and records the turn as an error
   * instead of losing what the user said.
   */
  savePending(sessionId, payload) {
    writeJsonAtomic(this.pendingPath(sessionId), payload)
  }

  /** Read and consume a pending snapshot (at most one recovery per turn). */
  takePending(sessionId) {
    const file = this.pendingPath(sessionId)
    const value = readJson(file, null)
    if (value) {
      try {
        fs.unlinkSync(file)
      } catch {
        // Best-effort cleanup. If another process won the race, content-derived
        // record ids still make a repeated recovery harmless.
      }
    }
    return value
  }

  /**
   * Summarize store state for `memory_health`.
   * `lightweight` skips the full malformed-line scan, which keeps the health
   * check cheap on a large store.
   */
  health({ namespace, lightweight = false } = {}) {
    const files = listMonthFiles(this.root)
    const records = this.readAll().filter((r) => inNamespace(r, namespace))
    let malformed = 0
    if (!lightweight) {
      for (const file of files) {
        try {
          const text = fs.readFileSync(file, 'utf8')
          for (const line of text.split('\n')) {
            if (!line.trim()) continue
            try {
              JSON.parse(line)
            } catch {
              malformed++
            }
          }
        } catch {
          malformed++
        }
      }
    }
    const times = records.map((r) => r.recorded_at).filter(Number.isFinite)
    const cursor = readJson(this.cursorPath, { version: 1, sessions: {} })
    const sessions = Object.entries(cursor.sessions || {})
    return {
      status: 'ok',
      root: this.root,
      files: files.length,
      ...(lightweight ? {} : { months: files.map((f) => path.basename(f, '.jsonl')), malformed }),
      records: records.length,
      active: records.filter((r) => r.status === 'active').length,
      superseded: records.filter((r) => r.status === 'superseded').length,
      disputed: records.filter((r) => r.status === 'disputed').length,
      last_recorded_at: times.length ? Math.max(...times) : null,
      current_month: monthKey(Date.now()),
      cursor_sessions: sessions.length,
      last_cursor_at: sessions.length ? Math.max(...sessions.map(([, v]) => v.updated_at || 0)) : null,
    }
  }
}

/**
 * Apply `supersedes` edges in memory. This makes older logs (written before
 * supersession was persisted on the target line) resolve correctly, and keeps
 * read behavior consistent with newly written shards.
 */
export function applySupersedes(records) {
  const byId = new Map(records.map((r) => [r.id, r]))
  for (const record of records) {
    if (!Array.isArray(record.supersedes)) continue
    for (const targetId of record.supersedes) {
      const target = byId.get(targetId)
      if (!target) continue
      target.status = 'superseded'
      target.superseded_by = record.id
      target.valid_to = target.valid_to || record.event_start_ms || record.recorded_at
      target.valid_from = target.valid_from || target.event_start_ms || target.recorded_at
    }
  }
  return records
}
