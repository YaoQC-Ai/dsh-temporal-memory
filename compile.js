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
/** Max evidence length inside the auto block. An L1 record occasionally stores a
 *  whole page body; embedding it verbatim makes the candidate block a full copy
 *  (measured: 《我的改写史》 grew ×4.30). */
const EVIDENCE_CLIP = 400

/** Cap for the whole candidate block. A human page only needs to know a
 *  candidate exists — it does not need a second copy of its own body. */
const CANDIDATE_CLIP = 6000

/** Compress one record into a single evidence line.
 *
 *  Uses line overlap rather than a prefix probe: sometimes the L1 record IS the
 *  page body but starts with an intro line the page does not have. Counting
 *  lines is safer — if half of the record's substantive lines already appear in
 *  the human prose, keep a pointer instead of a copy.
 */
function evidenceText(record, pageText) {
  const raw = String(record.text || '').trim()
  const full = raw.replace(/\s+/g, ' ')
  const pointer = `〔本页正文已含此段，原文见来源记录 ${record.id || '—'}〕`
  if (pageText && raw.length >= 8 && pageText.includes(raw)) return pointer
  if (pageText && raw.length > EVIDENCE_CLIP) {
    const lines = raw.split('\n').map((l) => l.trim()).filter((l) => l.length >= 8)
    if (lines.length >= 4) {
      const hit = lines.filter((l) => pageText.includes(l)).length
      if (hit / lines.length >= 0.5) return pointer
    }
  }
  if (full.length <= EVIDENCE_CLIP) return full
  return `${full.slice(0, EVIDENCE_CLIP)}…〔已截断，全文见来源记录 ${record.id || '—'}〕`
}

function autoBlock(sorted, timeZone, pageText = '') {
  const lines = [AUTO_BEGIN, '## 当前结论', '']
  const active = sorted.filter((r) => r.status === 'active' && !r.superseded_by)
  const current = (active.length ? active : sorted).slice(-3)
  for (const record of current) {
    lines.push(`- ${dateKey(record.event_start_ms, timeZone)}：${evidenceText(record, pageText)}（来源 ${sourceOf(record)}；${stateOf(record)}）`)
  }
  lines.push('', '## 演变', '')
  for (const record of sorted) {
    const state = stateOf(record)
    const note = state === '有效' ? '' : `（${state}）`
    lines.push(`- ${dateKey(record.event_start_ms, timeZone)}：${evidenceText(record, pageText)}${note}（来源 ${sourceOf(record)}）`)
  }
  const conflicts = sorted.filter((r) => r.status === 'disputed' || r.superseded_by)
  lines.push('', '## 冲突与待确认', '')
  if (conflicts.length) {
    for (const record of conflicts) {
      lines.push(`- ${dateKey(record.event_start_ms, timeZone)}：${evidenceText(record, pageText)}（${stateOf(record)}）`)
    }
  } else {
    lines.push('- （无）')
  }
  lines.push(AUTO_END)
  return lines.join('\n')
}

function frontmatter({ title, slug, aliases, sources, sourceIds, links, created, today, eventTime, status, namespace }) {
  return [
    '---',
    `标题: ${yamlStr(title)}`,
    '别名:',
    ...[...new Set([title, ...(aliases || [])])].map((alias) => `  - ${yamlStr(alias)}`),
    '来源:',
    ...(sources.length ? sources.map((s) => `  - ${yamlStr(s)}`) : ['  - -']),
    '关联:',
    ...(links.length ? links.map((l) => `  - ${yamlStr(l)}`) : []),
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
function writeCompiled(root, { slug, title, aliases = [], sorted, timeZone, today, namespace = DEFAULT_NAMESPACE }) {
  const file = conceptPath(root, slug, namespace)
  const sources = [...new Set(sorted.map(sourceOf))]
  const sourceIds = [...new Set(sorted.map((r) => r.id).filter(Boolean))]
  const links = [...new Set(sorted.flatMap((r) => r.entities || []))].filter((x) => x !== title).slice(0, 5)
    .map((l) => `[[${l}]]`)
  const hasConflict = sorted.some((r) => r.status === 'disputed')
  const status = hasConflict ? 'needs-update' : 'active'
  const eventTime = sorted.length
    ? `${dateKey(sorted[0].event_start_ms, timeZone)} ~ ${dateKey(sorted.at(-1).event_start_ms, timeZone)}`
    : ''
  let text = ''
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    // ENOENT: no existing page, so the create branch below applies.
  }
  // Probe only against human prose: strip the auto and candidate blocks first,
  // otherwise text written by the previous run flips the decision and the
  // compiler oscillates between two forms instead of converging.
  const humanText = (() => {
    let out = text
    for (const [b, e] of [[CANDIDATE_BEGIN, CANDIDATE_END], [AUTO_BEGIN, AUTO_END]]) {
      const r = replaceBetween(out, b, e, '')
      if (r !== null) out = r
    }
    return out
  })()
  const block = autoBlock(sorted, timeZone, humanText)

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
      ...(links.length ? links.map((l) => `- ${l}`) : []),
      '',
    ].join('\n')
    writeTextAtomic(file, frontmatter({
      title, slug, aliases, sources, sourceIds, links, created: today, today, eventTime, status, namespace,
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
    const sourceIdLines = sourceIds.map((id) => `  - ${yamlStr(id)}`)
    next = next.replace(new RegExp('^来源记录:\\n(?: {2}- .*\\n)*', 'm'), ['来源记录:', ...sourceIdLines, ''].join('\n'))
    const aliasLines = [...new Set([title, ...aliases])].map((alias) => `  - ${yamlStr(alias)}`)
    next = next.replace(new RegExp('^别名:\\n(?: {2}- .*\\n)*', 'm'), ['别名:', ...aliasLines, ''].join('\n'))
    if (block !== oldAuto) next = appendChangeLog(next, `自动编译更新：${sorted.length} 条证据，状态 ${status}`)
    if (next === text) return { created: false, updated: false, status, needsReview: false }
    writeTextAtomic(file, next)
    updateConceptIndex(root, { slug, title, domain: 'knowledge', status, today }, namespace)
    return { created: false, updated: true, status, needsReview: false }
  }

  // Human-owned page: proposal only, never a rewrite.
  const rawCandidate = block.replace(AUTO_BEGIN, '').replace(AUTO_END, '').trim()
  const candidateBody = rawCandidate.length > CANDIDATE_CLIP
    ? `${rawCandidate.slice(0, CANDIDATE_CLIP)}\n\n〔候选块超长，已截断；完整证据见来源记录。〕`
    : rawCandidate
  const candidate = [
    CANDIDATE_BEGIN,
    '## 自动编译候选（待人工确认）',
    '',
    candidateBody,
    '',
    CANDIDATE_END,
  ].join('\n')
  const existingCandidate = replaceBetween(text, CANDIDATE_BEGIN, CANDIDATE_END, candidate)
  const candidateChanged = existingCandidate === null || existingCandidate !== text
  let next = existingCandidate !== null
    ? existingCandidate
    : text.replace(/\s*$/, '\n') + '\n' + candidate + '\n'
  // Review is resolved explicitly by setting the page active. An unchanged
  // candidate must not mark it again; new evidence reopens the review.
  const nextStatus = oldStatus === 'needs-update' ? 'needs-update' : candidateChanged ? 'needs-review' : oldStatus
  next = next.replace(/^更新日期: .+$/m, `更新日期: ${today}`)
  next = next.replace(/^状态: .+$/m, `状态: ${nextStatus}`)
  if (next === text) return { created: false, updated: false, status: nextStatus, needsReview: nextStatus === 'needs-review' }
  writeTextAtomic(file, next)
  updateConceptIndex(root, { slug, title, domain: 'knowledge', status: nextStatus, today }, namespace)
  return { created: false, updated: true, status: nextStatus, needsReview: nextStatus === 'needs-review', oldStatus }
}

/**
 * Compile every eligible topic, bounded by `maxTopics`.
 *
 * A record joins a group through each of its topics and entities, so one
 * record can feed several pages. Only records with a session source are used:
 * a conclusion must be traceable back to what was actually said.
 *
 * @returns {{pages: object[], updated: object[], skipped: object[], needsReview: object[], scanned: number, topics: number, truncated: number}}
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
    const keys = [...new Set([...(record.topics || []), ...(record.entities || [])])]
    for (const key of keys) {
      if (!key || (topic && !key.includes(topic))) continue
      // Short ASCII names extracted only as topics are usually tokenizer
      // fragments. A quoted/configured entity remains eligible (Redis, RAG…).
      if (/^[\x20-\x7e]{1,12}$/.test(key) && !(record.entities || []).includes(key)) continue
      // Case-only variants share one portable filename and therefore one
      // concept. Merge their evidence instead of overwriting or dropping one.
      const groupKey = key.toLowerCase()
      if (!groups.has(groupKey)) groups.set(groupKey, { title: key, aliases: new Set(), records: [], ids: new Set() })
      const group = groups.get(groupKey)
      group.aliases.add(key)
      if (group.ids.has(record.id)) continue
      group.ids.add(record.id)
      group.records.push(record)
    }
  }

  const eligible = []
  for (const group of groups.values()) {
    if (group.records.length < minRecords) continue
    try {
      group.slug = slugify(group.title)
      eligible.push(group)
    } catch {
      // Invalid titles stay in L1, matching the previous behavior.
    }
  }
  eligible.sort((a, b) => b.records.length - a.records.length || a.slug.localeCompare(b.slug))
  const selected = eligible.slice(0, Math.max(0, maxTopics))
  const pages = []
  const updated = []
  const skipped = []
  const needsReview = []
  for (const group of selected) {
    const { slug, title } = group
    const sorted = [...group.records].sort((a, b) => a.event_start_ms - b.event_start_ms || String(a.id).localeCompare(String(b.id)))
    const result = writeCompiled(root, {
      slug,
      title,
      aliases: [...group.aliases],
      sorted,
      timeZone,
      today: dateKey(Date.now(), timeZone),
      namespace,
    })
    if (result.needsReview) needsReview.push({ topic: title, slug, path: conceptPath(root, slug, namespace) })
    if (result.created) pages.push({ topic: title, slug, path: conceptPath(root, slug, namespace) })
    else if (result.updated) updated.push({ topic: title, slug, path: conceptPath(root, slug, namespace), status: result.status })
    else skipped.push({ topic: title, slug, reason: 'unchanged' })
  }
  return { pages, updated, skipped, needsReview, scanned: records.length, topics: groups.size, truncated: eligible.length - selected.length }
}

export { readConcept }
