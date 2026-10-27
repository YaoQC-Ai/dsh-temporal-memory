/**
 * L3 concept pages.
 *
 * A concept page is a plain Markdown file with a small frontmatter block. It
 * exists to hold a conclusion across days, not to mirror L1. Pages are
 * human-editable; the plugin therefore treats them as a shared document rather
 * than a cache it may freely overwrite.
 *
 * The frontmatter keys and section headings are part of the on-disk format
 * (Chinese by design, matching the primary audience) and are read with
 * line-oriented parsing, not a YAML dependency.
 *
 * Automatic content, when present, is fenced by HTML comments
 * (`<!-- auto:begin -->` / `<!-- auto:end -->`). Human text outside those
 * markers is preserved. Deletion and correction update the page and mark it
 * `needs-update`; they do not silently keep a stale conclusion.
 *
 * Namespace pages live in hashed subdirectories for the same reason as
 * journals: a namespace string must not become a path.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_NAMESPACE, inNamespace } from './namespace.js'
import { ensureDir, readJson, writeTextAtomic } from './paths.js'
import { dateKey } from './time.js'

const DOMAINS = new Set(['persona', 'execution', 'knowledge'])

/**
 * Validate a title and use it as the filename.
 *
 * Rejects path separators, Windows-reserved characters and device names,
 * control characters, trailing dots/spaces, reserved index/log names, and
 * overlong titles. This is both a correctness check (the file must be
 * addressable) and a path-traversal defence.
 */
export function slugify(title) {
  if (typeof title !== 'string' || !title.trim()) throw new Error('title 必须是非空字符串')
  const s = title.trim()
  if (s.length > 80 || /[\\/:*?"<>|#\[\]^`\x00-\x1f\x7f]/.test(s) || /[. ]$/.test(s)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s)
    || /^_(index|log)(?:\.|$)/i.test(s)) {
    throw new Error('title 含非法字符、过长、尾随点/空格或保留名')
  }
  return s
}

/**
 * Quote a scalar only when the line-oriented reader could misparse it.
 * This is a tiny YAML subset, not a general serializer.
 */
export function yamlStr(value) {
  const s = String(value)
  if (/[:#\[\]{}&*!|>'"%@`,\\\x00-\x1f\x7f]|^\s|\s$/.test(s)
    || /^(?:null|true|false|yes|no|on|off|~|[-+]?\d.*)$/i.test(s)) return JSON.stringify(s)
  return s
}

function namespaceSegment(namespace) {
  return createHash('sha256').update(String(namespace)).digest('hex').slice(0, 16)
}

/** Directory holding one namespace's concept pages. */
export function conceptDir(root, namespace = DEFAULT_NAMESPACE) {
  return !namespace || namespace === DEFAULT_NAMESPACE
    ? path.join(root, 'knowledge')
    : path.join(root, 'knowledge', 'namespaces', namespaceSegment(namespace))
}

/** Absolute path of a concept page. `slug` is already validated by slugify(). */
export function conceptPath(root, slug, namespace = DEFAULT_NAMESPACE) {
  return path.join(conceptDir(root, namespace), `${slug}.md`)
}

/**
 * Create or replace a concept page.
 *
 * On an existing page, frontmatter lists (`来源`, `关联`, `来源记录`) are merged
 * with the new values and the original creation date is kept. The body is
 * replaced by `content`; this function is the "save a conclusion" path, while
 * `compile.js` is the incremental merge path.
 *
 * @returns {{path:string, title:string, created:boolean, slug:string, namespace:string}}
 */
export function saveConcept(root, input, meta = {}) {
  const namespace = input.namespace || meta.namespace || DEFAULT_NAMESPACE
  const title = String(input.title || '').trim()
  const slug = slugify(title)
  const domain = DOMAINS.has(input.domain) ? input.domain : 'knowledge'
  const today = dateKey(meta.now || Date.now(), meta.tz || 'UTC')
  const file = conceptPath(root, slug, namespace)
  let created = /^\d{4}-\d{2}-\d{2}$/.test(String(input.created || '')) ? input.created : today
  let old = null
  try {
    old = fs.readFileSync(file, 'utf8')
    const m = /^创建日期:\s*(.+)$/m.exec(old)
    if (m) created = m[1].trim()
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }

  const aliases = Array.isArray(input.aliases) && input.aliases.length ? input.aliases : [title]
  const sources = dedupe([
    ...readList(old, '来源'),
    ...(Array.isArray(input.sources) ? input.sources : input.sources ? [input.sources] : []),
  ])
  const links = dedupe([
    ...readList(old, '关联'),
    ...(Array.isArray(input.links) ? input.links : input.links ? [input.links] : []),
  ]).map((l) => (String(l).startsWith('[[') ? String(l) : `[[${l}]]`))
  const sourceIds = dedupe([
    ...readList(old, '来源记录'),
    ...(Array.isArray(input.sourceIds) ? input.sourceIds : input.sourceIds ? [input.sourceIds] : []),
  ])

  const memoryType = input.memoryType || 'experience'
  const validity = input.validity || 'long-term'
  const status = input.status || 'active'
  const eventTime = input.eventTime || ''
  const content = String(input.content || '').trim()
  if (!content) throw new Error('content 必须是非空字符串')

  const fm = [
    '---',
    `标题: ${yamlStr(title)}`,
    '别名:',
    ...aliases.map((a) => `  - ${yamlStr(a)}`),
    '来源:',
    ...(sources.length ? sources.map((s) => `  - ${yamlStr(s)}`) : ['  - -']),
    '关联:',
    ...(links.length ? links.map((l) => `  - ${yamlStr(l)}`) : ['  - -']),
    `命名空间: ${yamlStr(namespace)}`,
    `创建日期: ${created}`,
    `更新日期: ${today}`,
    `记忆类型: ${memoryType}`,
    `时效性: ${validity}`,
    `状态: ${status}`,
    ...(eventTime ? [`事件时间: ${yamlStr(eventTime)}`] : []),
    ...(sourceIds.length ? ['来源记录:', ...sourceIds.map((id) => `  - ${yamlStr(id)}`)] : []),
    `领域: ${domain}`,
    '---',
  ].join('\n')

  const body = [
    '',
    `# ${title}`,
    '',
    '## 核心内容',
    '',
    content,
    '',
    '## 来源内容',
    '',
    ...(sources.length ? sources.map((s) => `- ${s}`) : ['- 待补来源']),
    '',
    '## 关联',
    '',
    ...(links.length ? links.map((l) => `- ${l}`) : ['- -']),
    '',
    '## 回链',
    '',
    '（由引用页面维护）',
    '',
    '## 矛盾',
    '',
    '（无）',
    '',
  ].join('\n')

  writeTextAtomic(file, fm + '\n' + body)
  updateIndex(root, { slug, title, domain, status, today }, namespace)
  return { path: file, title, created: !old, slug, namespace }
}

/** Read a `key:` frontmatter list of `  - value` lines. */
function readList(markdown, key) {
  if (!markdown) return []
  const lines = markdown.split('\n')
  const start = lines.findIndex((l) => l.startsWith(`${key}:`))
  if (start < 0) return []
  const out = []
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    if (!/^\s+-\s+/.test(line)) break
    const value = line.replace(/^\s+-\s+/, '').trim()
    if (value && value !== '-') out.push(value.replace(/^"|"$/g, ''))
  }
  return out
}

/** Replace a frontmatter list block, or remove it when `values` is empty. */
function replaceListField(markdown, key, values) {
  const block = values.length
    ? `${key}:\n${values.map((v) => `  - ${yamlStr(v)}`).join('\n')}\n`
    : ''
  const re = new RegExp(`^${key}:\\n(?: {2}- .*\\n)*`, 'm')
  if (re.test(markdown)) return markdown.replace(re, block)
  return markdown
}

/** Set the page status in frontmatter (active / needs-update / disputed). */
function setStatus(markdown, status) {
  return markdown.replace(/^状态: .+$/m, `状态: ${status}`)
}

/** Append a dated note to the "contradictions" section, creating it if needed. */
function appendNote(markdown, note) {
  const line = `- ${new Date().toISOString()} ${note}\n`
  if (/## 矛盾\s*\n\n（无）\n?/.test(markdown)) {
    return markdown.replace(/## 矛盾\s*\n\n（无）\n?/, `## 矛盾\n\n${line}`)
  }
  return markdown.replace(/\s*$/, '\n') + line
}

function dedupe(list) {
  return [...new Set(list.map((x) => String(x).trim()).filter(Boolean))]
}

/**
 * Remove lines containing any needle, but only inside auto-generated blocks.
 * Human prose outside the markers is never touched by this pass.
 */
function stripBlockLines(markdown, needles) {
  const clean = needles.map((x) => String(x || '').trim()).filter((x) => x.length >= 2)
  if (!clean.length) return markdown
  let inBlock = false
  const out = []
  for (const line of markdown.split('\n')) {
    if (/<!--\s*auto(?::candidate)?:begin\s*-->/.test(line)) {
      inBlock = true
      out.push(line)
      continue
    }
    if (/<!--\s*auto(?::candidate)?:end\s*-->/.test(line)) {
      inBlock = false
      out.push(line)
      continue
    }
    if (inBlock && clean.some((needle) => line.includes(needle))) continue
    out.push(line)
  }
  return out.join('\n')
}

/**
 * Replace a deleted fact with a placeholder outside auto blocks. It cannot
 * remove a whole human paragraph safely, so it removes the text and leaves the
 * surrounding sentence structure for a human to review.
 */
function scrubFactOutsideBlocks(markdown, fact) {
  const needle = String(fact || '').trim()
  if (needle.length < 2) return markdown
  let inBlock = false
  return markdown.split('\n').map((line) => {
    if (/<!--\s*auto(?::candidate)?:begin\s*-->/.test(line)) {
      inBlock = true
      return line
    }
    if (/<!--\s*auto(?::candidate)?:end\s*-->/.test(line)) {
      inBlock = false
      return line
    }
    return inBlock ? line : line.split(needle).join('（已删除）')
  }).join('\n')
}

/** Replace a whole `## section` body, preserving the following section. */
function replaceSectionBody(markdown, section, body) {
  const lines = markdown.split('\n')
  const start = lines.findIndex((line) => line.trim() === `## ${section}`)
  if (start < 0) return markdown
  let stop = start + 1
  while (stop < lines.length && !/^## /.test(lines[stop])) stop++
  return [...lines.slice(0, start + 1), '', ...String(body).split('\n'), '', ...lines.slice(stop)]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
}

/**
 * Replace occurrences of a fact with new text inside one section, keeping the
 * original list marker and indentation. Used when a correction must take effect
 * immediately, even in a human-written section.
 */
function replaceFactInSection(markdown, section, fact, replacement) {
  const needle = String(fact || '').trim()
  if (needle.length < 2) return markdown
  const lines = markdown.split('\n')
  let inSection = false
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === `## ${section}`) {
      inSection = true
      continue
    }
    if (inSection && /^## /.test(lines[i])) break
    if (!inSection || !lines[i].includes(needle)) continue
    const prefix = /^(\s*(?:[-*]\s+)?)/.exec(lines[i])?.[1] || ''
    lines[i] = `${prefix}${replacement}`
  }
  return lines.join('\n')
}

/**
 * Update the human-readable `_index.md` table. The index is a convenience, not
 * a source of truth: `listConcepts` reads the pages themselves.
 */
function updateIndex(root, { slug, title, domain, status, today }, namespace = DEFAULT_NAMESPACE) {
  const file = path.join(conceptDir(root, namespace), '_index.md')
  const HEADER = ['# 记忆概念页索引', '', '| 概念 | 领域 | 状态 | 更新时间 |', '|---|---|---|---|']
  let lines = HEADER
  try {
    lines = fs.readFileSync(file, 'utf8').split('\n')
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }
  const sep = lines.findIndex((l) => l.trim().startsWith('|---'))
  const head = sep >= 0 ? lines.slice(0, sep + 1) : [...HEADER]
  const rows = (sep >= 0 ? lines.slice(sep + 1) : [])
    .filter((l) => l.trim())
    .filter((l) => !l.includes(`[[${slug}]]`))
  rows.push(`| [[${slug}]] | ${domain} | ${status} | ${today} |`)
  writeTextAtomic(file, [...head, ...rows].join('\n') + '\n')
}

export { updateIndex as updateConceptIndex }

/** Raw Markdown of a concept page, or null when absent. */
export function readConcept(root, slug, namespace = DEFAULT_NAMESPACE) {
  try {
    return fs.readFileSync(conceptPath(root, slug, namespace), 'utf8')
  } catch {
    return null
  }
}

/**
 * List concept pages in a namespace. Metadata is parsed from each page; a page
 * whose frontmatter has no namespace is treated as `default`, so old pages are
 * not hidden after namespaces were introduced.
 */
export function listConcepts(root, { namespace = DEFAULT_NAMESPACE } = {}) {
  const dir = conceptDir(root, namespace)
  let names
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  const out = []
  for (const name of names) {
    if (!name.endsWith('.md') || name.startsWith('_')) continue
    const text = fs.readFileSync(path.join(dir, name), 'utf8')
    const title = /^标题:\s*(.+)$/m.exec(text)?.[1]?.replace(/^"|"$/g, '') || name.slice(0, -3)
    const aliases = readList(text, '别名')
    const status = /^状态:\s*(.+)$/m.exec(text)?.[1]?.trim() || 'active'
    const updated = /^更新日期:\s*(.+)$/m.exec(text)?.[1]?.trim() || ''
    const sourceIds = readList(text, '来源记录')
    const pageNamespace = /^命名空间:\s*(.+)$/m.exec(text)?.[1]?.replace(/^"|"$/g, '').trim() || DEFAULT_NAMESPACE
    if (!inNamespace({ namespace: pageNamespace }, namespace)) continue
    out.push({ slug: name.slice(0, -3), title, aliases, status, updated, sourceIds, namespace: pageNamespace })
  }
  return out
}

/**
 * Mark a concept page as no longer current: status becomes `needs-update` and
 * a dated note is appended. The page is not deleted, because the history of a
 * conclusion is itself useful.
 */
export function markSuperseded(root, slug, note, namespace = DEFAULT_NAMESPACE) {
  const file = conceptPath(root, slug, namespace)
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return false
  }
  const next = setStatus(appendNote(text, `已失效：${note}`), 'needs-update')
  writeTextAtomic(file, next.replace(/^更新日期: .+$/m, `更新日期: ${dateKey(Date.now(), 'UTC')}`))
  return true
}

/** Human-readable L1 source pointer stored in a concept page's 来源 list. */
function sourceTokenOf(record) {
  return record?.source?.session
    ? `session/${record.source.session} seq ${record.source.seq_from}-${record.source.seq_to}`
    : ''
}

/**
 * Remove every trace of a deleted L1 record from concept pages.
 *
 * Matching is by source id or source pointer. The page is marked
 * `needs-update` because a human must review what remains. For a page created
 * by `memory_save` from a single source, the core content is replaced
 * outright; a multi-source page has only the affected line/block removed.
 *
 * @returns {number} pages changed
 */
export function markConceptSourcesDeleted(root, input, { namespace = DEFAULT_NAMESPACE } = {}) {
  const record = typeof input === 'string' ? { id: input } : (input || {})
  const id = String(record.id || '').trim()
  if (!id) return 0
  const token = sourceTokenOf(record)
  const fact = String(record.text || '').trim()
  const dir = conceptDir(root, namespace)
  let names
  try {
    names = fs.readdirSync(dir)
  } catch {
    return 0
  }
  let count = 0
  for (const name of names) {
    if (!name.endsWith('.md') || name.startsWith('_')) continue
    const file = path.join(dir, name)
    let text
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const ids = readList(text, '来源记录')
    const sources = readList(text, '来源')
    if (!ids.includes(id) && !(token && sources.includes(token))) continue
    let next = replaceListField(text, '来源记录', ids.filter((x) => x !== id))
    if (token && sources.includes(token)) {
      next = replaceListField(next, '来源', sources.filter((x) => x !== token))
    }
    next = stripBlockLines(next, [token, fact])
    // A human page cannot be safely rewritten as a whole; replace only the line
    // containing the deleted fact and mark the page for review.
    next = replaceFactInSection(next, '核心内容', fact, '（来源记录已删除，原结论已移除）')
    // A page created by memory_save has one source. When the text cannot be
    // located, clear the core content instead of leaving the old fact behind.
    if (ids.length === 1 && ids[0] === id) {
      next = replaceSectionBody(next, '核心内容', '（来源记录已删除，原结论已移除）')
    }
    // Human notes (e.g. a contradiction entry) may quote the fact too; scrub it
    // there as well, because deletion means deletion.
    next = scrubFactOutsideBlocks(next, fact)
    next = setStatus(next, 'needs-update')
    next = appendNote(next, `来源记录 ${id} 已删除；自动块已移除该来源，人工正文请复核`)
    writeTextAtomic(file, next)
    count++
  }
  return count
}

/**
 * Propagate a correction into concept pages that cite the corrected record.
 *
 * Source ids/pointers are rewritten to the correction, and the old conclusion
 * is replaced in the core content immediately rather than waiting for a human.
 * The page is still marked `needs-update` because other prose may reference the
 * old value.
 *
 * @returns {number} pages changed
 */
export function markConceptSourcesCorrected(root, target, correction, { namespace = DEFAULT_NAMESPACE } = {}) {
  const targetId = String(target?.id || '').trim()
  const correctionId = String(correction?.id || '').trim()
  if (!targetId || !correctionId) return 0
  const targetToken = sourceTokenOf(target)
  const correctionToken = sourceTokenOf(correction)
  const dir = conceptDir(root, namespace)
  let names
  try {
    names = fs.readdirSync(dir)
  } catch {
    return 0
  }
  let count = 0
  for (const name of names) {
    if (!name.endsWith('.md') || name.startsWith('_')) continue
    const file = path.join(dir, name)
    let text
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const ids = readList(text, '来源记录')
    const sources = readList(text, '来源')
    if (!ids.includes(targetId) && !(targetToken && sources.includes(targetToken))) continue
    const nextIds = dedupe(ids.map((x) => (x === targetId ? correctionId : x)))
    const nextSources = dedupe([
      ...sources.map((x) => (targetToken && x === targetToken ? correctionToken : x)),
      correctionToken,
    ])
    let next = replaceListField(text, '来源记录', nextIds)
    if (correctionToken) next = replaceListField(next, '来源', nextSources)
    // A human-saved page keeps its conclusion in 核心内容. The old conclusion
    // must be replaced now, not left for a later review.
    next = replaceFactInSection(next, '核心内容', target.text, String(correction.text || '').trim())
    if (ids.length === 1 && ids[0] === targetId) {
      next = replaceSectionBody(next, '核心内容', String(correction.text || '').trim())
    }
    next = setStatus(next, 'needs-update')
    next = appendNote(next, `来源记录 ${targetId} 已更正为 ${correctionId}：${String(correction.text || '').slice(0, 80)}`)
    writeTextAtomic(file, next)
    count++
  }
  return count
}

export { ensureDir, readJson }
