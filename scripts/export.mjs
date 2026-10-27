#!/usr/bin/env node
/**
 * Export L1 records as JSONL (read-only).
 *
 *   node scripts/export.mjs [--home <DSH_HOME>] [--out backup.jsonl] [--summary]
 *
 * Defaults to stdout so the output can be redirected or piped. Tombstones are
 * excluded and no data is modified. `--summary` prints counts only, no text.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveRoot } from '../lib/paths.js'
import { Store } from '../lib/store.js'

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  if (i < 0) return fallback
  const value = process.argv[i + 1]
  return value && !value.startsWith('--') ? value : fallback
}

const home = arg('home', process.env.DSH_HOME || path.join(os.homedir(), '.dsh'))
const out = arg('out')
const root = resolveRoot({ dir: home })
const store = new Store(root)
const records = store.readAll()

// Summary mode never touches record text; it reports store health plus the
// number of exported live records.
if (process.argv.includes('--summary')) {
  const health = store.health()
  console.log(JSON.stringify({ ...health, exported: records.length }, null, 2))
  process.exit(0)
}

const body = records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : '')
if (out) {
  fs.writeFileSync(path.resolve(out), body)
  console.error(`导出 ${records.length} 条 -> ${path.resolve(out)}`)
} else {
  process.stdout.write(body)
}
