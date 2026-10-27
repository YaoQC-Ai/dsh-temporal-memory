/**
 * L3 concept-page retrieval.
 *
 * Given a query, score every concept page by token hits in title, aliases,
 * core content, and body, then return the best matches. It reuses the
 * dependency-free tokenizer from `lib/search.js` (Chinese bigrams + ASCII
 * terms).
 *
 * Design trade-offs:
 *   - lexical, not semantic: predictable, offline, and debuggable;
 *   - title and alias hits weigh more than body hits, because a page's title is
 *     its strongest statement of what it is about;
 *   - every result carries a `hit` explanation, so a user can see *why* a page
 *     was recalled instead of trusting an opaque score.
 */
import fs from 'node:fs'
import path from 'node:path'
import { conceptDir } from './concepts.js'
import { DEFAULT_NAMESPACE } from './namespace.js'
import { tokenize } from './search.js'

const WEIGHT = {
  title: 3.0,
  alias: 2.5,
  body: 1.0,
  core: 1.6,
}

/** Extract the body of one `## section` from a Markdown page. */
function section(text, name) {
  const m = new RegExp(`^## ${name}\\s*$`, 'm').exec(text)
  if (!m) return ''
  const rest = text.slice(m.index + m[0].length)
  const next = /^## /m.exec(rest)
  return (next ? rest.slice(0, next.index) : rest).trim()
}

/** Read a frontmatter list of `  - value` lines. */
function readList(text, key) {
  const lines = text.split('\n')
  const start = lines.findIndex((l) => l.startsWith(`${key}:`))
  if (start < 0) return []
  const out = []
  for (let i = start + 1; i < lines.length; i++) {
    if (!/^\s+-\s+/.test(lines[i])) break
    const v = lines[i].replace(/^\s+-\s+/, '').trim()
    if (v && v !== '-') out.push(v.replace(/^"|"$/g, ''))
  }
  return out
}

/** Read and parse all concept pages in a namespace into searchable docs. */
export function loadConceptDocs(root, namespace = DEFAULT_NAMESPACE) {
  const dir = conceptDir(root, namespace)
  let names
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  const docs = []
  for (const name of names) {
    if (!name.endsWith('.md') || name.startsWith('_')) continue
    let text
    try {
      text = fs.readFileSync(path.join(dir, name), 'utf8')
    } catch {
      continue
    }
    const slug = name.slice(0, -3)
    const title = (/^标题:\s*(.+)$/m.exec(text)?.[1] || slug).replace(/^"|"$/g, '').trim()
    const aliases = readList(text, '别名')
    const status = /^状态:\s*(.+)$/m.exec(text)?.[1]?.trim() || 'active'
    const updated = /^更新日期:\s*(.+)$/m.exec(text)?.[1]?.trim() || ''
    const domain = /^领域:\s*(.+)$/m.exec(text)?.[1]?.trim() || 'knowledge'
    const core = section(text, '核心内容')
    const conflicts = section(text, '矛盾')
    docs.push({ slug, title, aliases, status, updated, domain, core, conflicts, text, path: path.join(dir, name) })
  }
  return docs
}

/**
 * Search concept pages.
 *
 * With an empty query the result is a reverse-chronological listing, which is
 * what "show me what I have" needs. With a query, pages are scored by weighted
 * token hits and normalized by query coverage so a long page cannot win merely
 * by containing many tokens.
 *
 * `status: 'active'` hides `needs-update` pages, but if such a page is relevant
 * the message names it — a user must not conclude the memory does not exist.
 *
 * @returns {{status:string,items:Array<object>,total:number,returned:number,truncated:boolean,next_cursor:string|null,coverage:string,message:string,route:'l3'}}
 */
export function searchConcepts(root, options = {}) {
  const {
    query = '',
    status = 'active',
    domain,
    namespace = DEFAULT_NAMESPACE,
    limit = 20,
    cursor,
  } = options

  const docs = loadConceptDocs(root, namespace)
  if (docs.length === 0) {
    return {
      status: 'no_data', items: [], total: 0, returned: 0, truncated: false,
      next_cursor: null, coverage: '概念页（L3）', route: 'l3', message: 'L3 还没有任何概念页',
    }
  }

  const universe = docs.filter((d) => {
    // `history` includes inactive pages; `all` is equivalent because concept
    // pages have no separate archived state.
    if (status === 'active' && d.status !== 'active') return false
    if (domain && d.domain !== domain) return false
    return true
  })

  // needs-update pages are hidden by default, but they still hold the old
  // position awaiting confirmation. If a query touches one, say so, so the
  // user does not think the memory is gone.
  const pending = status === 'active'
    ? docs.filter((d) => d.status !== 'active')
    : []
  const pendingHint = (tokens) => {
    if (!pending.length || !tokens || !tokens.length) return ''
    // Relevance must be judged by tokens: the pending page is not in the result
    // set, so there is no slug to compare against.
    const touched = pending.filter((d) => {
      const pool = new Set([
        ...tokenize(d.title),
        ...d.aliases.flatMap((a) => tokenize(a)),
        ...tokenize(d.core),
      ])
      return tokens.some((t) => pool.has(t))
    })
    if (!touched.length) return ''
    return ` 另有 ${touched.length} 个待确认页（${touched.map((d) => d.slug).join('、')}）被默认过滤，它们与本次查询相关；需要时用 status=all 查看。`
  }

  const tokens = tokenize(query)
  // No keywords: list by update time, newest first, for browsing.
  if (!tokens.length) {
    const sorted = [...universe].sort((a, b) => b.updated.localeCompare(a.updated))
    const page = sorted.slice(0, limit)
    return {
      status: page.length ? 'ok' : 'no_data',
      items: page.map((d) => toConceptItem(d, 0, [])),
      total: sorted.length,
      returned: page.length,
      truncated: sorted.length > page.length,
      next_cursor: sorted.length > page.length ? String(page.length) : null,
      coverage: '概念页（L3）· 无关键词，按更新时间倒序',
      route: 'l3',
      message: page.length ? '' : '没有符合条件的概念页',
    }
  }

  const scored = []
  for (const doc of universe) {
    const titleT = new Set(tokenize(doc.title))
    const aliasT = new Set(doc.aliases.flatMap((a) => tokenize(a)))
    const coreT = new Set(tokenize(doc.core))
    const bodyT = new Set(tokenize(doc.text))
    let score = 0
    const hit = { title: [], alias: [], core: [] }
    for (const t of tokens) {
      if (titleT.has(t)) { score += WEIGHT.title; hit.title.push(t) }
      else if (aliasT.has(t)) { score += WEIGHT.alias; hit.alias.push(t) }
      else if (coreT.has(t)) { score += WEIGHT.core; hit.core.push(t) }
      else if (bodyT.has(t)) score += WEIGHT.body
    }
    if (score === 0) continue
    // Normalize by query coverage: a long page must not outrank a precise title
    // hit simply by containing more tokens.
    const coverage = (hit.title.length + hit.alias.length + hit.core.length) / tokens.length
    score = score * (0.5 + 0.5 * coverage)
    // A full-phrase hit is a strong signal and gets a flat bonus.
    if (doc.text.includes(query.trim())) score += 4
    scored.push({ doc, score, hit })
  }

  if (scored.length === 0) {
    return {
      status: 'no_match', items: [], total: 0, returned: 0, truncated: false,
      next_cursor: null, coverage: '概念页（L3）', route: 'l3',
      message: `${universe.length} 个概念页中没有匹配项；可用空 query 浏览全部`,
    }
  }

  scored.sort((a, b) => (b.score !== a.score ? b.score - a.score : b.doc.updated.localeCompare(a.doc.updated)))
  let start = 0
  if (cursor && Number.isFinite(Number(cursor))) start = Math.max(0, Math.trunc(Number(cursor)))
  const page = scored.slice(start, start + limit)
  const next = start + page.length < scored.length ? String(start + page.length) : null
  const items = page.map(({ doc, score, hit }) => toConceptItem(doc, score, hit))

  return {
    status: 'ok',
    items,
    total: scored.length,
    returned: page.length,
    truncated: next !== null,
    next_cursor: next,
    coverage: '概念页（L3）',
    route: 'l3',
    message: `${next ? `另有 ${scored.length - start - page.length} 个概念页未展示，可用 cursor 继续读取。` : ''}${pendingHint(tokens)}`.trim(),
  }
}

/** Public projection of a concept match, including why it matched. */
function toConceptItem(doc, score, hit) {
  return {
    slug: doc.slug,
    title: doc.title,
    domain: doc.domain,
    status: doc.status,
    updated: doc.updated,
    score: Math.round(score * 1000) / 1000,
    hit,
    excerpt: doc.core.length > 240 ? `${doc.core.slice(0, 240)}…` : doc.core,
    path: doc.path,
  }
}
