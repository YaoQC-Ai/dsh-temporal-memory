/**
 * dsh-temporal-memory — model-facing tools.
 *
 * Read:  memory_search / memory_day / memory_journal / memory_get / memory_timeline
 * Write: memory_save / memory_correct / memory_forget
 * Ops:   memory_health
 *
 * Zero dependencies. L1 queries read working memory directly. L2 is
 * Agent-authored, so it is read from disk; only explicit raw verification
 * (scope=l0) needs the host's sessionQuery resolver.
 *
 * `apply` is safe from both the host bundle and a standalone Loader row:
 * duplicate registration is detected and skipped.
 */
import { join as joinPath } from 'node:path'
import { audit } from './lib/audit.js'
import { redact } from './lib/classify.js'
import { listConcepts, conceptDir, markConceptSourcesCorrected, markConceptSourcesDeleted, readConcept, saveConcept } from './lib/concepts.js'
import { searchConcepts } from './lib/concept-search.js'
import { compileAll } from './compile.js'
import { resolveConfig } from './lib/config.js'
import {
  buildDayView,
  countJournalFiles,
  getJournalEntry,
  journalPath,
  journalRecall,
  listJournalEntries,
  readJournalMarkdown,
  rebuildJournalDays,
} from './lib/journal.js'
import { createL0Reader, searchL0 } from './lib/l0.js'
import { inNamespace } from './lib/namespace.js'
import { growthStatus } from './lib/profile.js'
import { runtime } from './lib/runtime.js'
import { searchRecords, timeline, toItem } from './lib/search.js'
import { listSessions } from './lib/sessions.js'
import { Store, recordId } from './lib/store.js'
import { dateKey, dayRange, normalizeTz, parseTime } from './lib/time.js'
import fs from 'node:fs'

export const name = 'memory-tools'
export const inject = ['tools']

// Deictic time words. They route a query to L2 first (a journal answers
// "yesterday" faster than scanning L1) and are stripped before keyword search.
const FUZZY_TIME = /(今天|今日|昨天|昨日|前天|明天|后天|大后天|上周|这周|本周|下周|星期|礼拜|上个月|上月|本月|这个月|最近|前几天|前阵子|这几天|这段时间|近期|\d+\s*(?:天|日|周|星期|个月|月)\s*(?:以)?前)/
const FUZZY_TIME_ALL = new RegExp(FUZZY_TIME.source, 'g')

/** Remove time words and punctuation, leaving the topical part of a query. */
function stripFuzzyTime(query) {
  return String(query || '')
    .replace(FUZZY_TIME_ALL, ' ')
    .replace(/[？?。！!，,、；;：:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// Every tool returns at least `status`; individual tools add whatever fields
// they need. The host only validates that the output is lossless JSON.
const RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    status: { type: 'string' },
    message: { type: 'string' },
  },
  required: ['status'],
}

function render(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

function ok(fields) {
  return { status: 'ok', ...fields }
}

/** Extract "## 核心内容"; fall back to the whole page when the section is absent. */
function coreContentOf(markdown) {
  const m = /^## 核心内容\s*$/m.exec(markdown)
  if (!m) return String(markdown).trim()
  const rest = markdown.slice(m.index + m[0].length)
  const next = /^## /m.exec(rest)
  return (next ? rest.slice(0, next.index) : rest).trim()
}

/** Parse a local-day range; `date_to` is inclusive through its last millisecond. */
function parseRange(dateFrom, dateTo, tz) {
  let fromMs
  let toMs
  if (dateFrom) {
    const r = dayRange(dateFrom, tz)
    if (!r) throw new Error('date_from 必须是 YYYY-MM-DD')
    fromMs = r.startMs
  }
  if (dateTo) {
    const r = dayRange(dateTo, tz)
    if (!r) throw new Error('date_to 必须是 YYYY-MM-DD')
    toMs = r.endMs
  }
  if (fromMs !== undefined && toMs !== undefined && toMs <= fromMs) {
    throw new Error('date_to 必须晚于 date_from')
  }
  return { fromMs, toMs }
}

/**
 * Register the tool set once.
 *
 * The host plugin passes its already-resolved config (`rawConfig.resolved`);
 * a legacy Loader row would resolve its own. `runtime` tracks both cases so a
 * stale Loader row cannot register a second copy of the same tools.
 */
export function apply(ctx, rawConfig = {}) {
  const embedded = Boolean(rawConfig.resolved)
  // A legacy profile may still keep the memory-tools Loader row; when the host
  // bundle has already registered the tools, skip the duplicate.
  if (!embedded && runtime.embeddedTools) {
    ctx.logger(name).warn('memory-tools 已由宿主插件注册，跳过重复的 Loader 行')
    return
  }
  if (embedded && runtime.toolsRegistered) return
  const config = rawConfig.resolved || resolveConfig(rawConfig)
  const root = config.root
  runtime.toolsRoot = root
  runtime.embeddedTools = runtime.embeddedTools || embedded
  const store = new Store(root)
  const log = ctx.logger(name)
  const l0 = createL0Reader(ctx)
  for (const problem of config.configErrors) log.warn('config: %s', problem)

  /**
   * The host validates tool output as lossless JSON: a single `undefined`
   * makes the whole tool fail with `value is not lossless JSON`. L1 records
   * routinely omit `supersedes`, `superseded_by` and `valid_to`, so a raw
   * record would break even memory_search. Strip `undefined` and functions
   * once at the registration boundary instead of leaking the concern into
   * every tool.
   */
  const dropUndefined = (value) => {
    if (Array.isArray(value)) return value.map(dropUndefined)
    if (value && typeof value === 'object' && !(value instanceof Date)) {
      const out = {}
      for (const [key, item] of Object.entries(value)) {
        if (item === undefined || typeof item === 'function') continue
        out[key] = dropUndefined(item)
      }
      return out
    }
    return value
  }

  /** Wrap every `execute` with the lossless-JSON cleanup. */
  const register = (definition) => {
    const execute = definition.execute
    if (typeof execute !== 'function') return ctx.tools.register(definition)
    return ctx.tools.register({
      ...definition,
      async execute(...args) {
        return dropUndefined(await execute.apply(definition, args))
      },
    })
  }

  /** Both the event day and the recorded day, so forgetting refreshes every journal that could quote the record. */
  const journalDaysOf = (record) => {
    const days = new Set()
    if (record?.event_start_ms) days.add(dateKey(record.event_start_ms, config.timeZone))
    if (record?.recorded_at) days.add(dateKey(record.recorded_at, config.timeZone))
    return [...days]
  }

  /** Re-derive touched journals and scrub deleted sentences from them. */
  const refreshJournals = (keys, scrubTexts = []) => rebuildJournalDays({
    root,
    keys,
    scrubTexts,
    namespace: config.namespace,
  })

  // Retrieval router: fuzzy time tries L2 first, then falls back to L1; an
  // explicit scope selects L0/L3 or a merged view.
  register({
    name: 'memory_search',
    description: '检索记忆。模糊时间（昨天/上周/上个月等）默认先读 L2 日记；日记缺失时明确回退 L1 并说明。日期范围/关键词检索 L1 工作记忆；scope=l0 或 exact=true 时回 L0 原文核对。返回 status（ok/no_data/no_match/out_of_retention/l0_unavailable 等）与 route，不要把一个状态当成“没有发生”。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词或主题；留空表示按时间/类型浏览。' },
        date_from: { type: 'string', description: '起始日期 YYYY-MM-DD（含）。' },
        date_to: { type: 'string', description: '结束日期 YYYY-MM-DD（含）。' },
        kind: { type: 'string', description: 'event|decision|preference|fact|plan|outcome|claim|correction，逗号分隔可多选。' },
        status: { type: 'string', enum: ['active', 'history', 'all'], description: '默认 active；history 含已失效；all 含全部。' },
        scope: { type: 'string', enum: ['auto', 'journal', 'l1', 'l0', 'l3', 'all'], description: 'auto=模糊时间先日记；journal=只读 L2；l1=只读工作记忆；l0=显式原文核对；l3=只读概念页（长期结论）；all=L1+L3 合并。' },
        exact: { type: 'boolean', description: 'true 等价于 scope=l0，用于精确引用/单号/原文核对。' },
        limit: { type: 'number', description: '返回条数，1–50，默认 20。' },
        cursor: { type: 'string', description: '上一页返回的 next_cursor。' },
        mode: { type: 'string', enum: ['full', 'summary'], description: 'summary 只返回时间与短文本。' },
      },
      additionalProperties: false,
    },
    output: { schema: RESULT_SCHEMA, render },
    async execute(args = {}) {
      const tz = config.timeZone
      const { fromMs, toMs } = parseRange(args.date_from, args.date_to, tz)
      const limit = clampInt(args.limit, 20, 1, 50)
      const kinds = args.kind ? String(args.kind).split(',').map((s) => s.trim()).filter(Boolean) : undefined
      const scope = args.exact === true ? 'l0' : (args.scope || 'auto')
      const query = String(args.query || '')
      const records = store.readAll()

      const fuzzy = !fromMs && !toMs && FUZZY_TIME.test(query) ? parseTime(query, Date.now(), tz) : null
      if (scope === 'auto' && fuzzy) {
        const recall = journalRecall({
          root, records, fromMs: fuzzy.startMs, toMs: fuzzy.endMs, tz, namespace: config.namespace,
        })
        if (recall.status === 'ok') {
          return {
            ...recall,
            route: 'journal',
            items: recall.items.slice(0, limit),
            returned: Math.min(recall.items.length, limit),
            truncated: recall.items.length > limit,
          }
        }
        // Journal coverage is insufficient: fall through to L1 and say why.
        // Never present L1 results as if a journal had covered the day.
        const fallbackQuery = stripFuzzyTime(query)
        const baseSearch = {
          fromMs: fuzzy.startMs,
          toMs: fuzzy.endMs,
          kind: kinds,
          status: args.status || 'active',
          namespace: config.namespace,
          limit,
          cursor: args.cursor,
          tz,
          retentionDays: config.retentionDays,
          nowMs: Date.now(),
        }
        let fallback = searchRecords(records, { ...baseSearch, query: fallbackQuery })
        let fallbackMode = 'filtered'
        // If stripping the time words leaves only filler ("what happened"),
        // browsing by time is more reliable than forcing a keyword match.
        if (fallback.status === 'no_match' && fallbackQuery) {
          fallback = searchRecords(records, { ...baseSearch, query: '' })
          fallbackMode = 'time_only'
        }
        const searchNote = fallbackMode === 'time_only' && fallback.status === 'ok' ? '已按时间浏览 L1（关键词未命中，未过滤）。' : ''
        return {
          ...fallback,
          route: fallback.status === 'ok' ? 'l1-fallback' : 'l1',
          fallback_reason: recall.fallback_reason || 'journal_no_data',
          fallback_mode: fallbackMode,
          query_used: fallbackQuery,
          missing_journals: recall.missing || [],
          stale_journals: recall.stale || [],
          journal_items: recall.items || [],
          message: `${recall.message || ''}${searchNote ? ` ${searchNote}` : ''}${fallback.message ? ` ${fallback.message}` : ''}${fallback.status === 'out_of_retention' ? ' 精确原文请用 scope=l0 回 L0。' : ''}`.trim(),
        }
      }

      if (scope === 'journal') {
        const journalRange = fromMs && toMs
          ? { fromMs, toMs }
          : fuzzy
            ? { fromMs: fuzzy.startMs, toMs: fuzzy.endMs }
            : { fromMs: Date.now() - 7 * 86_400_000, toMs: Date.now() }
        const recall = journalRecall({ root, records, ...journalRange, tz, namespace: config.namespace })
        return {
          ...recall,
          items: (recall.items || []).slice(0, limit),
          returned: Math.min((recall.items || []).length, limit),
          truncated: (recall.items || []).length > limit,
        }
      }

      // L3 concept pages hold durable conclusions (preferences, identity,
      // agreements, lessons) and complement L1's recent events. Without an
      // explicit scope, the model could only reach L1 and pages would be
      // stored but never retrieved.
      if (scope === 'l3') {
        return searchConcepts(root, {
          query,
          status: args.status || 'active',
          namespace: config.namespace,
          limit,
          cursor: args.cursor,
        })
      }

      if (scope === 'all') {
        const l3 = searchConcepts(root, {
          query,
          status: args.status || 'active',
          namespace: config.namespace,
          limit,
          cursor: args.cursor,
        })
        const l1 = searchRecords(records, {
          query,
          fromMs,
          toMs,
          kind: kinds,
          status: args.status || 'active',
          namespace: config.namespace,
          limit,
          tz,
          retentionDays: config.retentionDays,
          nowMs: Date.now(),
        })
        const hasItems = l3.items.length > 0 || l1.items.length > 0
        return {
          status: hasItems ? 'ok' : (l3.status === 'no_data' && l1.status === 'no_data' ? 'no_data' : 'no_match'),
          route: 'l1+l3',
          l3: { status: l3.status, total: l3.total, items: l3.items },
          l1: { status: l1.status, total: l1.total, items: l1.items },
          items: [...l3.items, ...l1.items],
          total: l3.total + l1.total,
          returned: l3.items.length + l1.items.length,
          truncated: Boolean(l3.truncated || l1.truncated),
          next_cursor: l3.next_cursor || l1.next_cursor || null,
          coverage: 'L3 概念页 + L1 工作记忆',
          message: `L3 命中 ${l3.total} 个概念页，L1 命中 ${l1.total} 条记录。`,
        }
      }

      if (scope === 'l0') {
        // L1 may have been pruned; the session directory still lets us
        // enumerate sessions for L0 verification after cleanup.
        const sessionIds = new Set(records
          .filter((r) => inNamespace(r, config.namespace))
          .filter((r) => !fromMs || !Number.isFinite(r.event_start_ms) || (r.event_end_ms || r.event_start_ms) >= fromMs)
          .filter((r) => !toMs || !Number.isFinite(r.event_start_ms) || r.event_start_ms < toMs)
          .map((r) => r.source?.session)
          .filter(Boolean))
        for (const entry of listSessions(root, {
          namespace: config.namespace,
          fromMs,
          toMs,
          tz,
        })) {
          if (entry.session) sessionIds.add(entry.session)
        }
        return searchL0({
          reader: l0,
          sessionIds: [...sessionIds],
          query,
          fromMs,
          toMs,
          tz,
          limit,
        })
      }

      const result = searchRecords(records, {
        query,
        fromMs,
        toMs,
        kind: kinds,
        status: args.status || 'active',
        namespace: config.namespace,
        limit,
        cursor: args.cursor,
        tz,
        retentionDays: config.retentionDays,
        nowMs: Date.now(),
      })
      result.route = 'l1'
      // L1 is only recent working memory; stable facts (names, preferences,
      // agreements) live in L3. If L1 misses, try concepts before reporting
      // no_match, or those questions can never be answered.
      if (result.status !== 'ok' && query.trim()) {
        const l3 = searchConcepts(root, {
          query,
          status: args.status || 'active',
          namespace: config.namespace,
          limit,
          cursor: args.cursor,
        })
        if (l3.status === 'ok') {
          return {
            ...l3,
            route: 'l3-fallback',
            fallback_reason: 'l1_no_match',
            message: `L1 未命中（${result.message || '无匹配'}），已转到 L3 概念页：${l3.message || `命中 ${l3.total} 个`}`,
          }
        }
        return { ...result, l3_status: l3.status, l3_message: l3.message || '' }
      }
      if (args.mode === 'summary') {
        result.items = result.items.map((i) => ({ id: i.id, kind: i.kind, time_label: i.time_label, status: i.status, text: String(i.text).slice(0, 80) }))
        result.mode = 'summary'
      }
      return result
    },
  })

  // A day view of L1, either by event time or by recorded time.
  register({
    name: 'memory_day',
    description: '按天看 L1 工作记忆（发生/决定/计划/待确认）；这是工作记忆视图，不是 L2 日记。需要按天经历或模糊时间回顾时用 memory_journal 或 memory_search。',
    parameters: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD。' },
        view: { type: 'string', enum: ['event', 'recorded'], description: 'event=事件发生日（默认）；recorded=当天记录了什么。' },
        tz: { type: 'string', description: '可选 IANA 时区，默认配置时区。' },
      },
      required: ['date'],
      additionalProperties: false,
    },
    output: { schema: RESULT_SCHEMA, render },
    async execute(args = {}) {
      const tz = normalizeTz(args.tz || config.timeZone)
      const view = args.view === 'recorded' ? 'recorded' : 'event'
      const result = buildDayView(store.readAll(), args.date, tz, {
        view,
        retentionDays: config.retentionDays,
        nowMs: Date.now(),
        namespace: config.namespace,
      })
      result.layer = 'L1'
      const entry = view === 'event' ? getJournalEntry(root, args.date, config.namespace) : null
      if (entry) {
        result.journal_path = entry.path
        result.journal_authored_at = entry.authored_at
      }
      return result
    },
  })

  // Read-only access to Agent-authored L2 journals.
  register({
    name: 'memory_journal',
    description: '读某一天的日记（L2）。日记由宿主定时任务在当天结束时撰写，本工具只读不写。传 date 返回该日正文；不传则列出已有日期。那天没写就是 no_data，可回退 memory_day 看当天 L1，或 scope=l0 核对原文。',
    parameters: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD；留空则只列出已有日记的日期。' },
      },
      additionalProperties: false,
    },
    output: { schema: RESULT_SCHEMA, render },
    async execute(args = {}) {
      if (args.date) {
        const key = String(args.date)
        if (!dayRange(key, config.timeZone)) return { status: 'error', message: 'date 必须是真实存在的 YYYY-MM-DD' }
        const entry = getJournalEntry(root, key, config.namespace)
        if (!entry) {
          return {
            status: 'no_data',
            route: 'journal',
            date: key,
            message: '该日日记尚未撰写。可用 memory_day 看当天的 L1 工作记忆，精确引用用 scope=l0。',
          }
        }
        const markdown = readJournalMarkdown(root, key, config.namespace) || ''
        audit(root, { type: 'journal-read', date: key, bytes: entry.bytes })
        return {
          status: 'ok',
          route: 'journal',
          date: key,
          path: entry.path,
          authored_at: entry.authored_at,
          bytes: entry.bytes,
          excerpt: markdown.slice(0, 4000),
        }
      }
      const index = listJournalEntries(root, config.namespace)
      return {
        status: index.length ? 'ok' : 'no_data',
        route: 'journal',
        items: index.slice(0, 30),
        total: index.length,
        message: index.length
          ? '已写过的日记（日期倒序）；传 date 读正文。'
          : '还没有任何日记。日记由宿主定时任务在当天结束时撰写。',
      }
    },
  })

  // One L1 record by id, or one L3 page by title/slug.
  register({
    name: 'memory_get',
    description: '按 id 读取一条记忆及其来源、时间、状态；也可直接传概念页标题或 slug 读取 L3 概念页全文。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '记忆 id（m_ 开头），或概念页标题 / slug。' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    output: { schema: RESULT_SCHEMA, render },
    async execute(args = {}) {
      const key = String(args.id || '').trim()
      const record = store.get(key)
      if (record && inNamespace(record, config.namespace)) {
        return ok({ layer: 'L1', items: [toItem(record, 1, config.timeZone)] })
      }
      // Not an L1 id → try L3 by title or slug; the user usually has only a title.
      const text = readConcept(root, key, config.namespace)
      if (text) {
        return ok({
          layer: 'L3',
          concept: {
            slug: key,
            title: (/^标题:\s*(.+)$/m.exec(text)?.[1] || key).replace(/^"|"$/g, '').trim(),
            domain: /^领域:\s*(.+)$/m.exec(text)?.[1]?.trim() || 'knowledge',
            status: /^状态:\s*(.+)$/m.exec(text)?.[1]?.trim() || 'active',
            created: /^创建日期:\s*(.+)$/m.exec(text)?.[1]?.trim() || '',
            updated: /^更新日期:\s*(.+)$/m.exec(text)?.[1]?.trim() || '',
            content: coreContentOf(text),
            path: joinPath(conceptDir(root, config.namespace), `${key}.md`),
          },
          items: [],
        })
      }
      return { status: 'no_match', items: [], message: `未找到该 id 或概念页：${key}` }
    },
  })

  // Topic evolution in ascending event time, with supersession shown.
  register({
    name: 'memory_timeline',
    description: '按主题/实体回溯演变：按事件时间升序返回相关记忆，并标出取代关系。适合回答“这个方案为什么变了”。',
    parameters: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: '主题、项目名、实体或关键词。' },
        from: { type: 'string', description: '起始日期 YYYY-MM-DD。' },
        to: { type: 'string', description: '结束日期 YYYY-MM-DD。' },
        limit: { type: 'number', description: '默认 50，最大 100。' },
        cursor: { type: 'string', description: '上一页返回的 next_cursor。' },
      },
      required: ['topic'],
      additionalProperties: false,
    },
    output: { schema: RESULT_SCHEMA, render },
    async execute(args = {}) {
      const tz = config.timeZone
      const { fromMs, toMs } = parseRange(args.from, args.to, tz)
      return timeline(store.readAll(), {
        topic: String(args.topic || ''),
        fromMs,
        toMs,
        limit: clampInt(args.limit, 50, 1, 100),
        cursor: args.cursor,
        tz,
        namespace: config.namespace,
      })
    },
  })

  // Explicit "remember this": create an L1 anchor plus an L3 concept page.
  register({
    name: 'memory_save',
    description: '把一条稳定结论保存为概念页。用于用户明确要求“记住”或产出值得长期复用的结论；日常事件会自动捕获，不需要调用。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '概念名，简洁且可作文件名。' },
        content: { type: 'string', description: '自足、可独立理解的结论正文。' },
        domain: { type: 'string', enum: ['persona', 'execution', 'knowledge'], description: '领域标签。' },
        aliases: { type: 'array', items: { type: 'string' }, description: '可选别名。' },
        event_time: { type: 'string', description: '可选；该结论开始有效的时间，如 2026-10-12。' },
      },
      required: ['title', 'content'],
      additionalProperties: false,
    },
    output: { schema: RESULT_SCHEMA, render },
    async execute(args = {}, exec) {
      const agent = exec?.agent
      const sessionId = agent?.id !== undefined ? String(agent.id) : 'unknown'
      const seq = typeof agent?.session?.seq === 'number' ? agent.session.seq : undefined
      const now = Date.now()
      const parsed = args.event_time ? parseTime(String(args.event_time), now, config.timeZone) : null
      const safeTitle = redact(String(args.title || '')).text
      const safeContent = redact(String(args.content || ''))
      if (!safeContent.text.trim()) throw new Error('content 必须是非空字符串')
      // A concept page needs an L1 anchor that memory_correct/forget can
      // locate; otherwise corrections cannot propagate to L3.
      const record = {
        id: recordId({ kind: 'fact', text: safeContent.text + '\u0000' + safeTitle, source: { session: sessionId, seq_from: seq ?? 0 } }),
        kind: 'fact',
        text: safeContent.text,
        event_start_ms: parsed ? parsed.startMs : now,
        event_end_ms: parsed ? parsed.endMs : now + 60_000,
        time_precision: parsed ? parsed.precision : 'minute',
        time_basis: parsed ? parsed.time_basis : 'recorded',
        time_confidence: parsed ? parsed.time_confidence : 0.9,
        time_text: parsed ? parsed.time_text : null,
        tz: config.timeZone,
        recorded_at: now,
        status: 'active',
        source: {
          session: sessionId,
          seq_from: seq ?? 0,
          seq_to: seq ?? 0,
          role: 'user',
          quote: safeContent.text.slice(0, 120),
        },
        entities: [],
        topics: [safeTitle],
        confidence: 0.9,
        sensitivity: safeContent.redacted ? 'private' : 'normal',
        namespace: config.namespace,
      }
      store.append([record])
      const result = saveConcept(root, {
        title: safeTitle,
        content: safeContent.text,
        domain: args.domain || 'knowledge',
        aliases: args.aliases,
        sources: [`session/${sessionId}${seq !== undefined ? ` seq ${seq}` : ''}`],
        sourceIds: [record.id],
        eventTime: parsed ? new Date(parsed.startMs).toISOString() : '',
        memoryType: 'experience',
        namespace: config.namespace,
      }, { tz: config.timeZone, namespace: config.namespace })
      audit(root, { type: 'save', session: sessionId, id: record.id, slug: result.slug, redacted: safeContent.redacted })
      return ok({
        id: record.id,
        path: result.path,
        title: result.title,
        created: result.created,
        slug: result.slug,
        redacted: safeContent.redacted,
      })
    },
  })

  // Append-only correction: supersede the target, never delete it.
  register({
    name: 'memory_correct',
    description: '更正一条旧记忆：新建 correction 记录并取代目标；旧记录保留但标记失效，不会被删除。',
    parameters: {
      type: 'object',
      properties: {
        target_id: { type: 'string', description: '被更正的记忆 id。' },
        text: { type: 'string', description: '更正后的正确陈述。' },
        event_time: { type: 'string', description: '可选；更正生效的事件时间，如 2026-10-20。缺省为当前时刻。' },
      },
      required: ['target_id', 'text'],
      additionalProperties: false,
    },
    output: { schema: RESULT_SCHEMA, render },
    async execute(args = {}, exec) {
      const target = store.get(String(args.target_id || ''))
      if (!target || !inNamespace(target, config.namespace)) {
        return { status: 'no_match', items: [], message: '未找到 target_id' }
      }
      const safeText = redact(String(args.text || '').trim())
      const text = safeText.text
      if (!text) throw new Error('text 必须是非空字符串')
      const tz = config.timeZone
      const parsed = args.event_time ? parseTime(String(args.event_time), Date.now(), tz) : null
      const now = Date.now()
      const sessionId = exec?.agent?.id !== undefined ? String(exec.agent.id) : 'unknown'
      const seq = typeof exec?.agent?.session?.seq === 'number' ? exec.agent.session.seq : undefined
      const record = {
        id: recordId({ kind: 'correction', text: text + '\u0000' + target.id, source: { session: sessionId, seq_from: seq ?? 0 } }),
        kind: 'correction',
        text,
        event_start_ms: parsed ? parsed.startMs : now,
        event_end_ms: parsed ? parsed.endMs : now + 60_000,
        time_precision: parsed ? parsed.precision : 'minute',
        time_basis: parsed ? parsed.time_basis : 'recorded',
        time_confidence: parsed ? parsed.time_confidence : 0.9,
        time_text: parsed ? parsed.time_text : null,
        tz,
        recorded_at: now,
        status: 'active',
        supersedes: [target.id],
        source: { session: sessionId, seq_from: seq ?? 0, seq_to: seq ?? 0, role: 'user', quote: text.slice(0, 120) },
        entities: target.entities || [],
        topics: target.topics || [],
        confidence: 0.95,
        // A correction must not reduce privacy: keep `private` if either the
        // target was private or this text triggered redaction.
        sensitivity: target.sensitivity === 'private' || safeText.redacted ? 'private' : (target.sensitivity || 'normal'),
        namespace: config.namespace,
      }
      store.append([record])
      store.supersede(target.id, record.id, record.event_start_ms)
      const concepts = markConceptSourcesCorrected(root, target, record, { namespace: config.namespace })
      const compiled = compileAll(store, root, {
        timeZone: config.timeZone,
        minRecords: config.compile.minRecords,
        maxTopics: config.compile.maxTopics,
        namespace: config.namespace,
      })
      audit(root, { type: 'correct', session: sessionId, target: target.id, id: record.id, redacted: safeText.redacted, concepts })
      return ok({
        id: record.id,
        superseded: target.id,
        redacted: safeText.redacted,
        concepts_corrected: concepts,
        compile_updated: compiled.updated.length,
        note: '旧记录已失效但保留；日记是当时写下的东西，不随更正回溯改写。',
      })
    },
  })

  // Deletion: remove L1 text, tombstone the id, and propagate to L3 and L2.
  register({
    name: 'memory_forget',
    description: '删除一条记忆：正文从 L1 物理移除并写墓碑；审计只保留“发生过删除”的事实，不含正文。',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: '要删除的记忆 id。' } },
      required: ['id'],
      additionalProperties: false,
    },
    output: { schema: RESULT_SCHEMA, render },
    async execute(args = {}, exec) {
      const id = String(args.id || '')
      const found = store.get(id)
      if (found && !inNamespace(found, config.namespace)) {
        return { status: 'no_match', items: [], message: '未找到该 id' }
      }
      const days = journalDaysOf(found)
      const removed = store.delete(id, 'user-request')
      if (removed && found) {
        store.recordDeletedRange(found)
      }
      const concepts = removed && found
        ? markConceptSourcesDeleted(root, found, { namespace: config.namespace })
        : 0
      let compiled = { updated: [] }
      let journals = []
      if (removed && found) {
        compiled = compileAll(store, root, {
          timeZone: config.timeZone,
          minRecords: config.compile.minRecords,
          maxTopics: config.compile.maxTopics,
          namespace: config.namespace,
        })
        journals = await refreshJournals(days, [found.text, found.source?.quote].filter(Boolean))
      }
      audit(root, {
        type: 'forget',
        session: exec?.agent?.id !== undefined ? String(exec.agent.id) : 'unknown',
        id,
        found: !!found,
        concepts,
        journals: journals.map((j) => j.key),
      })
      if (!removed) return { status: 'no_match', items: [], message: '未找到该 id' }
      return ok({
        id,
        deleted: true,
        concepts_marked: concepts,
        compile_updated: compiled.updated.length,
        journal_days: journals,
        note: '正文已从 L1 移除；引用该记录的概念页自动块/人工正文已移除该事实并标记 needs-update；日记中命中该句的整行已删除（仅此一种改写）；审计仅记录删除事实（不含正文）',
      })
    },
  })

  // Layered health snapshot. Lightweight by default; deep=true also scans
  // shards and returns the full effective configuration.
  register({
    name: 'memory_health',
    description: '检查记忆库状态：L0–L4 分层可用性、L1 记录与清理窗口、L2 日记条目、L3 概念页、L4 画像与成长开关；数据目录不可写时返回 permission_denied。默认轻量摘要，传 deep=true 返回坏行、分片、日记明细与完整配置。',
    parameters: {
      type: 'object',
      properties: {
        deep: { type: 'boolean', description: '深度检查：扫描坏行、列出分片、统计日记状态并返回完整配置，耗时更长。' },
      },
      additionalProperties: false,
    },
    output: { schema: RESULT_SCHEMA, render },
    async execute(args = {}) {
      const deep = args.deep === true
      const timings = {}
      let started = performance.now()
      const health = store.health({ namespace: config.namespace, lightweight: !deep })
      timings.store = Math.round(performance.now() - started)

      started = performance.now()
      const journalFiles = countJournalFiles(root, config.namespace)
      const journals = deep ? listJournalEntries(root, config.namespace) : null
      timings.journals = Math.round(performance.now() - started)

      started = performance.now()
      const concepts = deep
        ? listConcepts(root, { namespace: config.namespace }).length
        : countConceptFiles(root, config.namespace)
      timings.concepts = Math.round(performance.now() - started)

      let writable = true
      try {
        if (fs.existsSync(root)) fs.accessSync(root, fs.constants.W_OK)
      } catch {
        writable = false
      }
      const rootMismatch = runtime.hostRoot && runtime.hostRoot !== root
        ? `工具插件数据根 ${root} 与宿主插件 ${runtime.hostRoot} 不一致；请只保留一个 dir 配置，或删除旧的 memory-tools Loader 行。`
        : null
      const configErrors = rootMismatch ? [...config.configErrors, rootMismatch] : config.configErrors
      // L4 is not hard-coded here: state, version and whether injection has
      // actually happened all come from the profile files and runtime.
      const growth = growthStatus(root, {
        enabled: config.growth?.enabled === true,
        nowMs: Date.now(),
        tz: config.timeZone,
      })
      const l4Status = growth.state === 'ok'
        ? 'active'
        : growth.state === 'human_edited'
          ? 'human_edited'
          : growth.enabled ? 'pending' : 'disabled'
      timings.total = Math.round(Object.values(timings).reduce((sum, n) => sum + n, 0))
      return ok({
        ...health,
        status: writable ? 'ok' : 'permission_denied',
        writable,
        namespace: config.namespace,
        timeZone: config.timeZone,
        retentionDays: config.retentionDays,
        retention: {
          days: config.retentionDays,
          rule: 'journal_file_newer_than_record',
          notice: `L1 默认保留 ${config.retentionDays} 天；过期记录仅在该事件日的日记文件存在、且写于这条记录之后时自动清理。`,
          note: '日记由 Agent 写（宿主定时任务），插件不生成；没有日记或日记写得更早，一律保留 L1 并报告。',
        },
        layers: {
          L0: { status: l0.available ? 'available' : 'unavailable', source: 'host sessionQuery' },
          L1: { status: 'active', records: health.records, active: health.active, retention_days: config.retentionDays },
          L2: deep
            ? { status: 'agent-written', entries: journals.length, latest: journals[0]?.key || null }
            : { status: 'agent-written', entries: journalFiles },
          L3: { status: 'active', concepts },
          L4: {
            status: l4Status,
            implemented: true,
            version: growth.personality_version,
            evidence: growth.evidence,
            applied: runtime.growthApplied.applied,
          },
        },
        journal: deep
          ? {
            authored_by: 'agent',
            entries: journals.length,
            latest: journals[0]?.key || null,
            newest_at: journals[0]?.authored_at || null,
          }
          : { authored_by: 'agent', entries: journalFiles },
        configFile: config.configFile,
        configRootSource: config.rootSource,
        configSources: config.configSources,
        configErrors,
        configWarnings: config.configWarnings,
        firstRun: !fs.existsSync(config.configFile),
        inject: config.inject,
        privacy: config.privacy,
        growth: {
          ...growth,
          applied: runtime.growthApplied.applied,
          applied_session: runtime.growthApplied.session,
          applied_at: runtime.growthApplied.at ? new Date(runtime.growthApplied.at).toISOString() : null,
          note: 'L4 由上月 L1/L2/L3 规则归纳，不调模型；人工编辑画像后停止自动覆盖。',
        },
        concepts,
        timings,
        ...(deep ? {
          capture: config.capture,
          compile: config.compile,
          ui: config.ui,
          digest: {
            by_kind: countBy(store.readAll().filter((r) => inNamespace(r, config.namespace)), 'kind'),
          },
        } : {}),
      })
    },
  })

  runtime.toolsRegistered = true
  log.info('temporal memory tools ready at %s', root)
}

function countConceptFiles(root, namespace) {
  try {
    return fs.readdirSync(conceptDir(root, namespace))
      .filter((name) => name.endsWith('.md') && !name.startsWith('_')).length
  } catch {
    return 0
  }
}

function countBy(items, key) {
  const out = {}
  for (const item of items) {
    const value = item[key] || 'unknown'
    out[value] = (out[value] || 0) + 1
  }
  return out
}

function clampInt(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(n)))
}

