/**
 * Append-only audit log.
 *
 * Each event is one JSON line in `audit/YYYY-MM-DD.jsonl`, keyed by UTC day.
 * Audit entries never contain memory text, only counts, ids, and decisions, so
 * the log is safe to inspect and cheap to keep.
 *
 * Auditing is best-effort: a full disk or read-only volume must not take down
 * capture or recall. A missing audit line is preferable to a failed turn.
 */
import path from 'node:path'
import { appendLine } from './paths.js'

export function audit(root, event) {
  try {
    const now = event.at || Date.now()
    const day = new Date(now).toISOString().slice(0, 10)
    const file = path.join(root, 'audit', `${day}.jsonl`)
    appendLine(file, JSON.stringify({ at: now, ...event }))
  } catch {
    // Best-effort by design: never block the caller.
  }
}
