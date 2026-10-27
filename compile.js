/**
 * dsh-temporal-memory — optional L3 rule-based compiler.
 *
 * Groups stable records about the same topic into a concept page. No LLM is
 * involved. Compilation is an incremental merge:
 *   - a page created by the compiler has an auto block that may be rewritten;
 *   - human prose outside that block is never touched;
 *   - a human-authored page is never overwritten — the compiler only appends
 *     an "auto-compiled candidate (needs human confirmation)" block.
 */
import fs from 'node:fs'
import path from 'node:path'
import { readConcept, slugify, updateConceptIndex, yamlStr, conceptPath } from './lib/concepts.js'
import { resolveConfig } from './lib/config.js'
import { DEFAULT_NAMESPACE, inNamespace } from './lib/namespace.js'
import { writeTextAtomic } from './lib/paths.js'
import { Store } from './lib/store.js'
import { dateKey } from './lib/time.js'

export const name = 'memory-compile'
export const inject = ['tools']

/** Record kinds worth compiling; chat/plan/noise stay in L1. */
const COMPILABLE = new Set(['decision', 'preference', 'fact', 'outcome', 'correction'])
// Markers are part of the on-disk contract: human edits must survive, so the
// compiler only rewrites text between begin/end and nowhere else.
const AUTO_BEGIN = '<!-- auto:begin -->'
const AUTO_END = '<!-- auto:end -->'
const CANDIDATE_BEGIN = '<!-- auto:candidate:begin -->'
const CANDIDATE_END = '<!-- auto:candidate:end -->'

/**
 * Optional plugin entry point. It registers a single tool; nothing runs on
 * the turn hot path, so compilation can be scheduled or triggered manually.
 */
export function apply(ctx, rawConfig = {}) {
  const config = resolveConfig(rawConfig)
  const root = config.root
  const store = new Store(root)
  const log = ctx.logger(name)
  for (const problem of config.configErrors) log.warn('config: %s', problem)

  ctx.tools.register({
    name: 'memory_compile',
    description: '把同一主题的多条稳定记忆增量合并成 L3 概念页（规则聚合，不调用模型）。已有自动页只更新自动块，人工内容保留；人工页只追加候选，不覆盖。',
    parameters: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: '只编译指定主题；留空则扫描全部主题。' },
        force: { type: 'boolean', description: '兼容旧参数；不会覆盖人工内容。' },
        limit: { type: 'number', description: '最多编译多少个主题，默认 20。' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: { status: { type: 'string' }, message: { type: 'string' } },
        required: ['status'],
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args = {}) {
      const result = compileAll(store, root, {
        timeZone: config.timeZone,
        minRecords: config.compile.minRecords,
        maxTopics: config.compile.maxTopics,
        namespace: config.namespace,
        topic: args.topic,
        limit: Number.isInteger(args.limit) ? Math.max(1, Math.min(50, args.limit)) : config.compile.maxTopics,
      })
      return { status: result.pages.length || result.updated.length || result.needsReview.length ? 'ok' : 'no_data', ...result }
    },
  })
}

/** Source pointer for the page: a session range when available, else the L1 id. */
function sourceOf(record) {
  return record.source?.session
    ? `session/${record.source.session} seq ${record.source.seq_from}-${record.source.seq_to}`
    : `memory/${record.id}`
}

/** Human-readable validity state; the page must not imply disputed data is settled. */
function stateOf(record) {
  if (record.status === 'superseded') return '已失效'
  if (record.status === 'disputed') return '有冲突'
  if (record.status === 'active' && record.superseded_by) return `已由 ${record.superseded_by} 取代`
  return '有效'
}

/**
 * Render the machine-owned block: current conclusions, evolution history, and
 * open conflicts. This block is replaced wholesale on every compile; anything
 * outside it belongs to the human.
 */
function autoBlock(sorted, timeZone) {
  const lines = [AUTO_BEGIN, '## 当前结论', '']
  const active = sorted.filter((r) => r.status === 'active' && !r.superseded_by)
  const current = (active.length ? active : sorted).slice(-3)
  for (const record of current) {
    lines.push(`- ${dateKey(record.event_start_ms, timeZone)}：${record.text}（来源 ${sourceOf(record)}；${stateOf(record)}）`)
  }
  lines.push('', '## 演变', '')
  for (const record of sorted) {
    const state = stateOf(record)
    const note = state === '有效' ? '' : `（${state}）`
    lines.push(`- ${dateKey(record.event_start_ms, timeZone)}：${record.text}${note}（来源 ${sourceOf(record)}）`)
  }
  const conflicts = sorted.filter((r) => r.status === 'disputed' || r.superseded_by)
  lines.push('', '## 冲突与待确认', '')
  if (conflicts.length) {
    for (const record of conflicts) {
      lines.push(`- ${dateKey(record.event_start_ms, timeZone)}：${record.text}（${stateOf(record)}）`)
    }
  } else {
    lines.push('- （无）')
  }
  lines.push(AUTO_END)
  return lines.join('\n')
}

function frontmatter({ title, slug, sources, sourceIds, links, created, today, eventTime, status, namespace }) {
  return [
    '---',
    `标题: ${yamlStr(title)}`,
    '别名:',
    `  - ${yamlStr(title)}`,
    '来源:',
    ...(sources.length ? sources.map((s) => `  - ${yamlStr(s)}`) : ['  - -']),
    '关联:',
    ...(links.length ? links.map((l) => `  - ${yamlStr(l)}`) : ['  - -']),
    `创建日期: ${created}`,
    `更新日期: ${today}`,
    '记忆类型: compiled',
    '时效性: long-term',
    `命名空间: ${yamlStr(namespace)}`,
    `状态: ${status}`,
    ...(eventTime ? [`事件时间: ${yamlStr(eventTime)}`] : []),
    '来源记录:',
    ...sourceIds.map((id) => `  - ${yamlStr(id)}`),
    '领域: knowledge',
    '编译: rule',
    '---',
  ].join('\n')
}

function replaceBetween(text, begin, end, body) {
  const start = text.indexOf(begin)
  if (start < 0) return null
  const stop = text.indexOf(end, start + begin.length)
  if (stop < 0) return null
  return text.slice(0, start) + body + text.slice(stop + end.length)
}

function appendChangeLog(text, note) {
  const line = `- ${new Date().toISOString()} ${note}`
  if (text.includes('## 变更记录')) return text.replace(/\s*$/, '\n') + line + '\n'
  return text.replace(/\s*$/, '\n') + '\n## 变更记录\n\n' + line + '\n'
}

/**
 * Create or update one compiled page.
 *
 * Three cases:
 *   1. no file → create it with a fresh auto block;
 *   2. compiler-owned page (auto markers present) → replace only the block,
 *      refresh metadata, and log the change;
 *   3. human-owned page → never rewrite prose; append/replace a candidate block
 *      and mark the page `needs-review` (or keep `needs-update` if a deletion
 *      or correction already flagged it).
 */
function writeCompiled(root, { slug, title, sorted, timeZone, today, namespace = DEFAULT_NAMESPACE }) {
  const file = conceptPath(root, slug, namespace)
  const sources = [...new Set(sorted.map(sourceOf))]
  const sourceIds = sorted.map((r) => r.id).filter(Boolean)
  const links = [...new Set(sorted.flatMap((r) => r.entities || []))].filter((x) => x !== title).slice(0, 5)
    .map((l) => `[[${l}]]`)
  const hasConflict = sorted.some((r) => r.status === 'disputed')
  const hasSupersede = sorted.some((r) => r.superseded_by)
  const status = hasConflict || hasSupersede ? 'needs-update' : 'active'
  const eventTime = sorted.length
    ? `${dateKey(sorted[0].event_start_ms, timeZone)} ~ ${dateKey(sorted.at(-1).event_start_ms, timeZone)}`
    : ''
  const block = autoBlock(sorted, timeZone)
  let text = ''
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    // ENOENT: no existing page, so the create branch below applies.
  }

  if (!text) {
    const body = [
      '',
      `# ${title}`,
      '',
      block,
      '',
      '## 人工补充',
      '',
      '（由用户维护；自动编译不会覆盖此节之外的人工内容。）',
      '',
      '## 来源内容',
      '',
      ...(sources.length ? sources.map((s) => `- ${s}`) : ['- 待补来源']),
      '',
      '## 关联',
      '',
      ...(links.length ? links.map((l) => `- ${l}`) : ['- -']),
      '',
    ].join('\n')
    writeTextAtomic(file, frontmatter({
      title, slug, sources, sourceIds, links, created: today, today, eventTime, status,
    }) + '\n' + body)
    updateConceptIndex(root, { slug, title, domain: 'knowledge', status, today }, namespace)
    return { created: true, updated: true, status, needsReview: false }
  }

  const oldStatus = /^状态:\s*(.+)$/m.exec(text)?.[1]?.trim() || 'active'
  const oldAuto = text.includes(AUTO_BEGIN) && text.includes(AUTO_END)
    ? text.slice(text.indexOf(AUTO_BEGIN), text.indexOf(AUTO_END) + AUTO_END.length)
    : ''
  const replaced = replaceBetween(text, AUTO_BEGIN, AUTO_END, block)
  if (replaced !== null) {
    let next = replaced
    next = next.replace(/^更新日期: .+$/m, `更新日期: ${today}`)
    next = next.replace(/^状态: .+$/m, `状态: ${status}`)
    next = next.replace(/^事件时间: .+$/m, `事件时间: ${yamlStr(eventTime)}`)
    next = next.replace(/^来源记录:\n(?: {2}- .*\n)*/m, `来源记录:\n${sourceIds.map((id) => `  - ${yamlStr(id)}`).join('\n')}\n`)
    if (block !== oldAuto) next = appendChangeLog(next, `自动编译更新：${sorted.length} 条证据，状态 ${status}`)
    if (next === text) return { created: false, updated: false, status, needsReview: false }
    writeTextAtomic(file, next)
    updateConceptIndex(root, { slug, title, domain: 'knowledge', status, today }, namespace)
    return { created: false, updated: true, status, needsReview: false }
  }

  // Human-owned page: proposal only, never a rewrite.
  const candidate = [
    CANDIDATE_BEGIN,
    '## 自动编译候选（待人工确认）',
    '',
    block.replace(AUTO_BEGIN, '').replace(AUTO_END, '').trim(),
    '',
    CANDIDATE_END,
  ].join('\n')
  const existingCandidate = replaceBetween(text, CANDIDATE_BEGIN, CANDIDATE_END, candidate)
  let next = existingCandidate !== null
    ? existingCandidate
    : text.replace(/\s*$/, '\n') + '\n' + candidate + '\n'
  // A correction or deletion already marked the page needs-update; recompiling
  // may add a candidate but must not downgrade that flag to plain review.
  const nextStatus = oldStatus === 'needs-update' ? 'needs-update' : 'needs-review'
  next = next.replace(/^更新日期: .+$/m, `更新日期: ${today}`)
  next = next.replace(/^状态: .+$/m, `状态: ${nextStatus}`)
  if (next === text) return { created: false, updated: false, status: nextStatus, needsReview: true }
  writeTextAtomic(file, next)
  updateConceptIndex(root, { slug, title, domain: 'knowledge', status: nextStatus, today }, namespace)
  return { created: false, updated: true, status: nextStatus, needsReview: true, oldStatus }
}

/**
 * Compile every eligible topic, bounded by `maxTopics`.
 *
 * A record joins a group through each of its topics and entities, so one
 * record can feed several pages. Only records with a session source are used:
 * a conclusion must be traceable back to what was actually said.
 *
 * @returns {{pages: object[], updated: object[], skipped: object[], needsReview: object[], scanned: number, topics: number}}
 */
export function compileAll(store, root, options = {}) {
  const { timeZone = 'Asia/Shanghai', minRecords = 2, maxTopics = 20, topic } = options
  const namespace = options.namespace || DEFAULT_NAMESPACE
  const records = store.readAll()
    .filter((r) => r.status !== 'deleted' && COMPILABLE.has(r.kind))
    // Every L3 conclusion must link back to a session source; an L1 id alone
    // is not enough to justify a page.
    .filter((r) => r.source?.session)
    .filter((r) => inNamespace(r, namespace))
  const groups = new Map()
  for (const record of records) {
    if (!Number.isFinite(record.event_start_ms)) continue
    const keys = [...(record.topics || []), ...(record.entities || [])]
    for (const key of keys) {
      if (!key) continue
      if (topic && !key.includes(topic)) continue
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(record)
    }
  }

  const pages = []
  const updated = []
  const skipped = []
  const needsReview = []
  let processed = 0
  for (const [key, list] of groups) {
    if (processed >= maxTopics) break
    if (list.length < minRecords) continue
    let slug
    try {
      slug = slugify(key)
    } catch {
      continue
    }
    const sorted = [...list].sort((a, b) => a.event_start_ms - b.event_start_ms || String(a.id).localeCompare(String(b.id)))
    const result = writeCompiled(root, {
      slug,
      title: key,
      sorted,
      timeZone,
      today: dateKey(Date.now(), timeZone),
      namespace,
    })
    if (result.needsReview) needsReview.push({ topic: key, slug, path: conceptPath(root, slug, namespace) })
    if (result.created) pages.push({ topic: key, slug, path: conceptPath(root, slug, namespace) })
    else if (result.updated) updated.push({ topic: key, slug, path: conceptPath(root, slug, namespace), status: result.status })
    else skipped.push({ topic: key, slug, reason: 'unchanged' })
    processed++
  }
  return { pages, updated, skipped, needsReview, scanned: records.length, topics: groups.size }
}

export { readConcept }
