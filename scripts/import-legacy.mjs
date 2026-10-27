#!/usr/bin/env node
/**
 * Legacy plugin Markdown → this plugin (read-only import, dry-run by default).
 *
 *   L1: node scripts/import-legacy.mjs --from <shortterm dir> [--home <DSH_HOME>] [--namespace default] --yes
 *   L3: node scripts/import-legacy.mjs --concepts <pages dir> [--root <data dir>] [--namespace <override>] --yes
 *
 * L1 parses only `## <ISO timestamp>` blocks in the old `shortterm/*.md` files
 * and imports `[user]` lines as `time_basis=recorded` records. `[assistant]`
 * lines are derived summaries and are skipped, so a summary is never promoted
 * to a fact. Every line goes through `classify.js` redaction first: credential
 * hits are skipped entirely, other PII is kept but marked private.
 *
 * L3 parses the old pages' Chinese frontmatter and `## 核心内容` section and
 * calls `saveConcept()` page by page. `_index.md` is rebuilt by this plugin;
 * the old index is never copied. Missing or dangling source ids are reported.
 *
 * Source directories are never written. `compile_candidates.md` and
 * `_index.md` are not imported. L1 uses the runtime namespace; L3 keeps each
 * page's frontmatter namespace unless `--namespace` overrides it.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { classifyKind, redact } from '../lib/classify.js'
import { conceptDir, readConcept, saveConcept, slugify } from '../lib/concepts.js'
import { resolveRoot } from '../lib/paths.js'
import { Store } from '../lib/store.js'

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  if (i < 0) return fallback
  const value = process.argv[i + 1]
  return value && !value.startsWith('--') ? value : fallback
}

const yes = process.argv.includes('--yes')
const dryRun = !yes
const home = arg('home', process.env.DSH_HOME || path.join(os.homedir(), '.dsh'))
const rootArg = arg('root', null)
const namespaceArg = arg('namespace', null)
const conceptsDir = arg('concepts', null)

if (rootArg && !path.isAbsolute(rootArg)) {
  console.error(`--root 必须是绝对路径，收到：${rootArg}`)
  process.exit(1)
}
const root = rootArg || resolveRoot({ dir: home })

if (conceptsDir) {
  importConcepts(conceptsDir)
} else {
  importShortterm()
}

/**
 * Minimal frontmatter reader for the old format: scalar `key: value` pairs and
 * `- item` lists. It is not a general YAML parser and does not need to be.
 */
function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!match) return null
  const fields = {}
  let key = null
  for (const line of match[1].split(/\r?\n/)) {
    const item = /^\s+-\s+(.*)$/.exec(line)
    if (item && key) {
      fields[key].push(unquote(item[1]))
      continue
    }
    const pair = /^([^\s:][^:]*):\s*(.*)$/.exec(line)
    if (!pair) continue
    key = pair[1].trim()
    const value = pair[2].trim()
    fields[key] = value ? unquote(value) : []
  }
  return { fields, body: text.slice(match[0].length) }
}

/** Accept JSON-style double quotes and simple single quotes. */
function unquote(value) {
  const text = String(value).trim()
  if (text.startsWith('"')) {
    try {
      return JSON.parse(text)
    } catch {
      return text.replace(/^"|"$/g, '')
    }
  }
  if (text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1)
  return text
}

/** Normalize a frontmatter value to a clean list; `-` is the empty placeholder. */
function asList(value) {
  const items = Array.isArray(value) ? value : value ? [value] : []
  return items.map((item) => String(item).trim()).filter((item) => item && item !== '-')
}

/** First value when a scalar field was parsed as a list. */
function asScalar(value) {
  if (Array.isArray(value)) return value.length ? String(value[0]).trim() : ''
  return value === undefined || value === null ? '' : String(value).trim()
}

/**
 * Extract the old page's core section. Falling back to the body minus the
 * title preserves content for pages that never used section headings.
 */
function coreContentOf(body) {
  const head = /^##\s*核心内容\s*$/m.exec(body)
  if (head) {
    const rest = body.slice(head.index + head[0].length)
    const next = /^##\s+/m.exec(rest)
    return (next ? rest.slice(0, next.index) : rest).trim()
  }
  return body.replace(/^#\s+.*$/m, '').trim()
}

/**
 * Import old concept pages. Files are validated one by one; a bad page is
 * skipped with a reason instead of aborting the whole batch. Dry-run prints
 * the plan and exits before any write.
 */
function importConcepts(from) {
  let names
  try {
    names = fs.readdirSync(from).filter((name) => name.endsWith('.md'))
  } catch (err) {
    console.error(`无法读取旧概念页目录：${from}（${err.code || err.message}）`)
    process.exit(1)
  }
  if (names.length === 0) {
    console.error(`旧概念页目录没有 Markdown 文件：${from}`)
    process.exit(0)
  }

  const skipped = []
  const skipReasons = new Map()
  const candidates = []
  const seen = new Map()
  const missingSourceIds = []
  const brokenSourceIds = []
  const storeIds = new Set(new Store(root).readAll().map((record) => record.id))
  const skip = (name, reason) => {
    skipped.push(name)
    skipReasons.set(reason, (skipReasons.get(reason) || 0) + 1)
  }

  for (const name of names) {
    if (/^_(?:index|log)\.md$/i.test(name) || /^index\.md$/i.test(name)) {
      skip(name, '插件维护的索引，不导入')
      continue
    }
    const text = fs.readFileSync(path.join(from, name), 'utf8')
    const parsed = parseFrontmatter(text)
    if (!parsed) {
      skip(name, '缺少 frontmatter')
      continue
    }
    const { fields, body } = parsed
    const title = asScalar(fields['标题'])
    if (!title) {
      skip(name, '缺少标题')
      continue
    }
    let slug
    try {
      slug = slugify(title)
    } catch (err) {
      skip(name, `标题不可用：${err.message}`)
      continue
    }
    const domain = asScalar(fields['领域']) || 'knowledge'
    if (!['persona', 'execution', 'knowledge'].includes(domain)) {
      skip(name, `领域无效：${domain}`)
      continue
    }
    const content = coreContentOf(body)
    if (!content) {
      skip(name, '核心内容为空')
      continue
    }
    const namespace = namespaceArg || asScalar(fields['命名空间']) || 'default'
    const key = `${namespace}\u0000${slug}`
    if (seen.has(key)) {
      skip(name, `标题重复（与 ${seen.get(key)}）`)
      continue
    }
    seen.set(key, name)

    const sourceIds = asList(fields['来源记录'])
    if (sourceIds.length === 0) missingSourceIds.push(name)
    else if (sourceIds.some((id) => !storeIds.has(id))) brokenSourceIds.push(name)

    candidates.push({
      file: name,
      namespace,
      input: {
        title,
        aliases: asList(fields['别名']),
        sources: asList(fields['来源']),
        links: asList(fields['关联']),
        namespace,
        created: /^\d{4}-\d{2}-\d{2}$/.test(asScalar(fields['创建日期'])) ? asScalar(fields['创建日期']) : undefined,
        memoryType: asScalar(fields['记忆类型']) || 'experience',
        validity: asScalar(fields['时效性']) || 'long-term',
        status: asScalar(fields['状态']) || 'active',
        domain,
        sourceIds,
        content,
      },
      exists: Boolean(readConcept(root, slug, namespace)),
    })
  }

  console.log(`来源（只读）：${from}`)
  console.log(`目标：${root}${namespaceArg ? `（namespace=${namespaceArg} 覆盖页面值）` : '（命名空间按页面 frontmatter）'}`)
  console.log(`将导入 ${candidates.length} 页，跳过 ${skipped.length} 页。`)
  for (const [reason, count] of skipReasons) console.log(`  跳过 ${count} 页：${reason}`)
  if (candidates.length) {
    const creates = candidates.filter((item) => !item.exists).length
    console.log(`  新建 ${creates} 页，合并 ${candidates.length - creates} 页`)
  }
  if (missingSourceIds.length) {
    console.log(`来源记录缺失：${missingSourceIds.length} 页没有「来源记录」字段，导入后无法逐条回溯到 L1。`)
    for (const name of missingSourceIds.slice(0, 5)) console.log(`  - ${name}`)
    if (missingSourceIds.length > 5) console.log(`  …（其余 ${missingSourceIds.length - 5} 页略）`)
  }
  if (brokenSourceIds.length) {
    console.log(`来源记录未命中：${brokenSourceIds.length} 页引用了目标库中不存在的记录 id。`)
    for (const name of brokenSourceIds.slice(0, 5)) console.log(`  - ${name}`)
    if (brokenSourceIds.length > 5) console.log(`  …（其余 ${brokenSourceIds.length - 5} 页略）`)
  }

  if (candidates.length === 0) process.exit(0)
  if (dryRun) {
    console.log('dry-run：未写入。确认后加 --yes 落盘；_index.md 由 saveConcept 自动维护，不复制旧索引。')
    process.exit(0)
  }

  const namespaces = new Set(candidates.map((item) => item.namespace))
  let written = 0
  let failed = 0
  for (const item of candidates) {
    try {
      saveConcept(root, item.input)
      written++
    } catch (err) {
      failed++
      console.error(`  导入失败 ${item.file}：${err.message}`)
    }
  }
  console.log(`已导入 ${written} 页${failed ? `，失败 ${failed} 页` : ''}；_index.md 已由插件更新。`)
  for (const namespace of namespaces) console.log(`  索引：${path.join(conceptDir(root, namespace), '_index.md')}`)
  if (failed) process.exitCode = 1
}

/**
 * Import `[user]` lines from old shortterm session summaries. Record ids are
 * content-derived, so rerunning with --yes is idempotent and never duplicates.
 */
function importShortterm() {
  const from = arg('from', path.join(home, 'memory', 'shortterm'))
  const namespace = namespaceArg || 'default'
  let names
  try {
    names = fs.readdirSync(from).filter((n) => n.endsWith('.md') && n !== 'compile_candidates.md')
  } catch (err) {
    console.error(`无法读取旧记忆目录：${from}（${err.code || err.message}）`)
    process.exit(1)
  }
  if (names.length === 0) {
    console.error(`旧记忆目录没有会话文件：${from}`)
    process.exit(0)
  }

  const HEAD = /^## (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s*$/
  const candidates = []
  const perFile = {}
  let skippedSecret = 0

  for (const name of names) {
    const session = name.slice(0, -3)
    const text = fs.readFileSync(path.join(from, name), 'utf8')
    let block = null
    const blocks = []
    for (const line of text.split('\n')) {
      const head = HEAD.exec(line)
      if (head) {
        if (block) blocks.push(block)
        block = { at: Date.parse(head[1]), lines: [] }
      } else if (block) {
        block.lines.push(line)
      }
    }
    if (block) blocks.push(block)

    blocks.forEach((b, idx) => {
      if (!Number.isFinite(b.at)) return
      for (const line of b.lines) {
        if (!line.startsWith('[user] ')) continue
        const raw = line.slice('[user] '.length).trim()
        if (raw.length < 2) continue
        const cleaned = redact(raw)
        // Credential hits are skipped entirely (a key never enters storage);
        // ID/card numbers are kept but marked private.
        if (!cleaned.text.trim() || cleaned.kinds.some((k) => k !== 'id-number' && k !== 'card-number')) {
          skippedSecret++
          continue
        }
        candidates.push({
          kind: classifyKind(cleaned.text),
          text: cleaned.text.slice(0, 300),
          event_start_ms: b.at,
          event_end_ms: b.at + 60_000,
          time_precision: 'minute',
          time_basis: 'recorded',
          time_confidence: 0.5,
          time_text: 'legacy 摘要时间戳',
          tz: 'UTC',
          recorded_at: b.at,
          status: 'active',
          source: {
            session,
            seq_from: idx + 1,
            seq_to: idx + 1,
            role: 'user',
            quote: cleaned.text.slice(0, 120),
            legacy: path.join(from, name),
          },
          entities: [],
          topics: [],
          confidence: 0.7,
          sensitivity: cleaned.redacted ? 'private' : 'normal',
          namespace,
          legacy: true,
        })
      }
      perFile[session] = (perFile[session] || 0) + 1
    })
  }

  console.log(`来源（只读）：${from}`)
  console.log(`目标：${root}（namespace=${namespace}）`)
  console.log(`候选记录：${candidates.length} 条，会话 ${Object.keys(perFile).length} 个${skippedSecret ? `，跳过全脱敏行 ${skippedSecret} 条` : ''}`)
  for (const [session, n] of Object.entries(perFile)) console.log(`  - ${session}: ${n} 块`)
  for (const sample of candidates.slice(0, 3)) {
    console.log(`  样例 [${sample.kind}] ${new Date(sample.event_start_ms).toISOString()} ${sample.text.slice(0, 60)}`)
  }

  if (candidates.length === 0) process.exit(0)
  if (dryRun) {
    console.log('dry-run：未写入。确认后加 --yes 落盘（重复运行按 id 幂等，不会重复导入）。')
    process.exit(0)
  }

  const written = new Store(root).append(candidates)
  console.log(`已写入 ${written} 条；去重跳过 ${candidates.length - written} 条。`)
}
