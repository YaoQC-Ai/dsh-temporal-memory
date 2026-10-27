/**
 * Session directory.
 *
 * This is metadata only: which session appeared on which local day, in which
 * namespace. No message text is ever written here.
 *
 * Two jobs:
 *   - L2 coverage: a pure Q&A session may produce no L1 records at all, but the
 *     day still had a conversation and the journal should be able to account
 *     for it;
 *   - rebuild: after retention prunes L1, the directory still points at L0
 *     sessions, so a journal can be re-derived from raw events if needed.
 */
import fs from 'node:fs'
import path from 'node:path'
import { appendLine } from './paths.js'
import { dateKey } from './time.js'
import { DEFAULT_NAMESPACE, inNamespace } from './namespace.js'

/** Path of the append-only session directory. */
export function sessionsPath(root) {
  return path.join(root, 'state', 'sessions.jsonl')
}

/** Append one (session, day, namespace) mark. Callers de-duplicate by key. */
export function appendSession(root, { session, namespace = DEFAULT_NAMESPACE, atMs, tz = 'UTC' }) {
  if (!session || !Number.isFinite(atMs)) return
  appendLine(sessionsPath(root), JSON.stringify({
    session: String(session),
    namespace: namespace || DEFAULT_NAMESPACE,
    day: dateKey(atMs, tz),
    at: atMs,
  }))
}

/** Read all valid marks; malformed lines are skipped. */
export function readSessionEntries(root) {
  let text
  try {
    text = fs.readFileSync(sessionsPath(root), 'utf8')
  } catch {
    return []
  }
  const out = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let value
    try {
      value = JSON.parse(line)
    } catch {
      continue
    }
    if (!value?.session || !value.day) continue
    out.push({
      session: String(value.session),
      namespace: value.namespace || DEFAULT_NAMESPACE,
      day: value.day,
      at: Number.isFinite(value.at) ? value.at : 0,
    })
  }
  return out
}

/**
 * List sessions matching an optional day, namespace, and [fromMs, toMs) window.
 * Multiple marks for the same session collapse into one entry with first/last
 * activity, which is what the day view displays.
 */
export function listSessions(root, { day, namespace, fromMs, toMs } = {}) {
  const bySession = new Map()
  for (const entry of readSessionEntries(root)) {
    if (day && entry.day !== day) continue
    if (namespace && !inNamespace(entry, namespace)) continue
    if (fromMs !== undefined && entry.at < fromMs) continue
    if (toMs !== undefined && entry.at >= toMs) continue
    const prev = bySession.get(entry.session)
    if (!prev) {
      bySession.set(entry.session, { session: entry.session, namespace: entry.namespace, day: entry.day, first_at: entry.at, last_at: entry.at })
    } else {
      prev.first_at = Math.min(prev.first_at, entry.at)
      prev.last_at = Math.max(prev.last_at, entry.at)
    }
  }
  return [...bySession.values()]
}
