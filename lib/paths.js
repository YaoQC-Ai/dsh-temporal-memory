/**
 * Filesystem primitives shared by every layer.
 *
 * Layout under the memory root:
 *
 *   events/YYYY-MM.jsonl   L1 records, append-only, sharded by recorded time
 *   sessions/              per-session capture cursors
 *   pending/               snapshots of turns that never reached turn/end
 *   journal/YYYY-MM-DD.md  L2, authored by the Agent (never written here)
 *   concepts/              L3 concept pages plus an index
 *   profile/               L4 user and Agent profiles
 *   audit/YYYY-MM-DD.jsonl append-only audit trail
 *   config.json            settings written by the UI
 *
 * All writes are either append-with-fsync (event and audit logs) or
 * write-temp-then-rename (pages, indexes, config). A crash therefore leaves
 * either the old file or the new file intact, never a truncated one.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Resolve the memory root.
 *
 * `root` wins when explicitly configured; otherwise the root is
 * `<dir|$DSH_HOME|~/.dsh>/memory/temporal`. Keeping the plugin under its own
 * `temporal/` directory means it can coexist with other memory plugins without
 * reading or overwriting their files.
 */
export function resolveRoot(config = {}) {
  if (config.root) return config.root
  const home = config.dir || process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'memory', 'temporal')
}

/**
 * Month shard key in UTC, derived from the *recorded* timestamp, not the event
 * timestamp. A backdated record therefore lands in the current shard and never
 * rewrites an old month file. This keeps the log strictly append-only.
 */
export function monthKey(ms) {
  const d = new Date(ms)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

export function monthFile(root, ms) {
  return path.join(root, 'events', `${monthKey(ms)}.jsonl`)
}

export function listMonthFiles(root) {
  const dir = path.join(root, 'events')
  let names
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  return names
    .filter((n) => /^\d{4}-\d{2}\.jsonl$/.test(n))
    .sort()
    .map((n) => path.join(dir, n))
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

/** Read a JSON object; any failure yields `fallback` rather than throwing. */
export function readJson(file, fallback) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'))
    return value && typeof value === 'object' ? value : fallback
  } catch {
    return fallback
  }
}

/**
 * Replace a JSON file atomically: write a sibling temp file, then rename.
 * Rename is atomic on the same filesystem, so readers see old or new content.
 * The temp name includes the pid so two processes cannot collide.
 */
export function writeJsonAtomic(file, value) {
  ensureDir(path.dirname(file))
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n')
  fs.renameSync(tmp, file)
}

/** Atomic text replacement. A failure before rename leaves the old file intact. */
export function writeTextAtomic(file, text) {
  ensureDir(path.dirname(file))
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, text)
  fs.renameSync(tmp, file)
}

/**
 * Append one newline-terminated line and fsync it before returning.
 * The caller must pass a single-line string (JSON.stringify never emits raw
 * newlines). fsync is deliberate: a captured memory must survive a crash even
 * if the OS loses its page cache.
 */
export function appendLine(file, line) {
  ensureDir(path.dirname(file))
  const fd = fs.openSync(file, 'a')
  try {
    fs.writeSync(fd, line + '\n')
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}
