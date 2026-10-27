/**
 * dsh-temporal-memory — host half of the plugin.
 *
 * Capture: subscribes to `session/event` and, at `turn/end`, turns the
 * completed or interrupted turn into L1 records that carry both event time
 * and recorded time.
 * Recall: `agent/pre-step` (first step only) injects records when the user's
 * wording contains a time reference, a known topic, or a status question,
 * subject to cooldown and a token budget.
 * Restore: `agent/request-error` re-appends the last injection block after a
 * compaction replaced the context.
 *
 * The plugin never patches DSH core and never touches legacy plugin
 * directories. Every write lands under `$DSH_HOME/memory/temporal/`.
 */
import { audit } from './lib/audit.js'
import { classifyTurn, textOf } from './lib/classify.js'
import { listConcepts } from './lib/concepts.js'
import { createConfigHandler } from './lib/config-ui.js'
import { resolveConfig } from './lib/config.js'
import { formatBlock, isMemoryMessage, lastUserText, memoryMessage, profileMessage, shouldRecall } from './lib/inject.js'
import { journalCovers, listJournalEntries } from './lib/journal.js'
import { formatProfileBlock, growMonthly, readPersonality } from './lib/profile.js'
import { runtime } from './lib/runtime.js'
import { searchRecords } from './lib/search.js'
import { Store } from './lib/store.js'
import { DAY_MS, dateKey, normalizeTz } from './lib/time.js'
import * as toolsPlugin from './tools.js'

export const name = 'memory-temporal'

export function apply(ctx, rawConfig = {}) {
  // The tools half receives the already-resolved config so both halves agree
  // on root, time zone, namespace and limits. `runtime` guards against a
  // second registration if the host re-applies the plugin.
  const config = resolveConfig(rawConfig)
  const root = config.root
  runtime.hostRoot = root
  if (typeof ctx.plugin === 'function') ctx.plugin(toolsPlugin, { resolved: config })
  const store = new Store(root)
  const log = ctx.logger(name)
  const sessions = new WeakMap()
  let turnCounter = 0

  for (const problem of config.configErrors) log.warn('config: %s', problem)

  // `webServer` is a Cordis service: it becomes available only after the
  // asynchronous `[Service.init]` listen completes, so `ctx.get('webServer')`
  // is always undefined during `apply`. Optional injection plus `ctx.effect`
  // registers the route when the service is ready.
  // It is deliberately not `export const inject = ['webServer']`: that is a
  // hard dependency and would stop the whole plugin from applying in tui and
  // headless hosts where no web server exists.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (webCtx) => {
      const dispatch = createConfigHandler({ rawConfig, localOnly: false, servePage: false })
      webCtx.effect(() => webCtx.webServer.register({
        kind: 'prefix',
        path: '/memory-ui',
        handler: (req, res) => {
          const url = req.url || '/'
          if (url === '/memory-ui' || url.startsWith('/memory-ui/')) {
            req.url = url.slice('/memory-ui'.length) || '/'
          }
          return dispatch(req, res)
        },
      }), 'memory-temporal: /memory-ui route')
    })
  }

  /**
   * Per-session turn buffer. A WeakMap keyed by the session object means an
   * abandoned session is collected without any cleanup bookkeeping.
   */
  const stateOf = (session) => {
    let state = sessions.get(session)
    if (!state) {
      state = {
        turn: 0,
        userMessages: [],
        assistantText: '',
        assistantSeq: undefined,
        toolCalls: new Map(),
        toolResults: [],
        turnStatus: 'completed',
        turnStartSeq: undefined,
        lastInjection: null,
        tz: config.timeZone,
      }
      sessions.set(session, state)
    }
    return state
  }

  /** Start a new turn: the previous one is either flushed or already lost. */
  const resetTurn = (state, turn) => {
    state.turn = turn
    state.userMessages = []
    state.assistantText = ''
    state.assistantSeq = undefined
    state.toolCalls = new Map()
    state.toolResults = []
    state.turnStatus = 'completed'
    state.turnStartSeq = undefined
  }

  /**
   * Snapshot the in-flight turn so a crash or hard interrupt can still yield
   * an L1 record on the next session start. Cheap enough to run on every
   * message; skipped entirely when capture is off.
   */
  const persistPending = (session, state) => {
    if (config.capture.enabled === false) return
    if (state.userMessages.length === 0 && state.toolResults.length === 0) return
    try {
      store.savePending(String(session.id), {
        turn: state.turn,
        userMessages: state.userMessages,
        assistantText: state.assistantText,
        assistantSeq: state.assistantSeq,
        toolResults: state.toolResults,
        turnStartSeq: state.turnStartSeq,
        tz: state.tz,
      })
    } catch (err) {
      log.warn('pending snapshot failed: %s', msg(err))
    }
  }

  // Pending snapshots are recovered at most once per session object. The
  // original turn never saw `turn/end`, so it is recorded as status "error";
  // content-derived record ids make a repeated recovery harmless.
  const recovered = new WeakSet()
  const recoverPending = (session) => {
    if (recovered.has(session) || config.capture.enabled === false) return
    recovered.add(session)
    const pending = store.takePending(String(session.id))
    if (!pending || !Array.isArray(pending.userMessages)) return
    try {
      const seqTo = Math.max(
        pending.turnStartSeq || 0,
        pending.assistantSeq || 0,
        ...pending.userMessages.map((m) => m.seq || 0),
        ...(pending.toolResults || []).map((t) => t.seq || 0),
      )
      const { records, redactedCount } = classifyTurn({
        sessionId: String(session.id),
        turn: pending.turn,
        userMessages: pending.userMessages,
        assistantText: pending.assistantText,
        assistantSeq: pending.assistantSeq,
        toolResults: pending.toolResults || [],
        turnStatus: 'error',
        recordedAt: Date.now(),
        seqFrom: pending.turnStartSeq || pending.userMessages[0]?.seq || seqTo,
        seqTo,
        config: { ...config, maxRecordsPerTurn: config.capture.maxRecordsPerTurn },
      })
      const written = store.append(records.map((r) => ({ ...r, namespace: config.namespace })))
      audit(root, {
        type: 'recover',
        session: String(session.id),
        turn: pending.turn,
        records: written,
        redacted: redactedCount,
      })
    } catch (err) {
      log.warn('pending recovery failed: %s', msg(err))
    }
  }

  let maintenanceRunning = false
  let maintenanceDay = null

  /**
   * Daily maintenance, at most once per process-day, triggered by
   * `agent/created`. It does not write a journal — that belongs to the Agent
   * and the host's scheduled task — it only prunes expired L1 records.
   */
  const runDailyMaintenance = () => {
    if (maintenanceRunning) return
    const nowMs = Date.now()
    const today = dateKey(nowMs, config.timeZone)
    if (maintenanceDay === today) return
    if (config.retentionDays <= 0) return
    maintenanceRunning = true
    maintenanceDay = today
    void (async () => {
      try {
        const pruned = store.prune(config.retentionDays, {
          nowMs,
          tz: config.timeZone,
          namespace: config.namespace,
          journalCoverage: (record, day) => journalCovers(root, day, {
            namespace: config.namespace,
            latestRecordedAt: record.recorded_at || 0,
          }),
        })
        audit(root, {
          type: 'maintenance',
          l1_pruned: pruned?.removed ?? 0,
          l1_uncovered: pruned?.retained_uncovered ?? 0,
        })
      } catch (err) {
        maintenanceDay = null
        log.warn('retention maintenance failed: %s', msg(err))
      } finally {
        maintenanceRunning = false
      }
    })()
  }

  let growthRunning = false

  /**
   * Monthly growth catch-up, same pattern as journal catch-up: check at
   * startup instead of keeping a timer alive. It really runs once per month
   * (`profile/_state.json` records the month) and is a no-op when the switch
   * is off.
   */
  const runMonthlyGrowth = () => {
    if (config.growth?.enabled !== true || growthRunning) return
    growthRunning = true
    void (async () => {
      try {
        const growth = growMonthly({
          root,
          records: store.readAll(),
          tz: config.timeZone,
          nowMs: Date.now(),
          enabled: true,
          journals: listJournalEntries(root, config.namespace),
          concepts: listConcepts(root, { namespace: config.namespace }),
          namespace: config.namespace,
        })
        if (growth.status === 'ok') {
          audit(root, { type: 'growth', status: growth.status, month: growth.month, records: growth.signals?.records ?? 0, evidence: growth.evidence ?? 0 })
          log.info('L4 profile updated for %s', growth.month)
        } else if (growth.status === 'human_edited') {
          audit(root, { type: 'growth', status: growth.status, month: growth.month, note: '画像被人工编辑，已跳过覆盖' })
          log.warn('L4 profile is human-edited; skipped %s', growth.month)
        }
      } catch (err) {
        log.warn('monthly growth failed: %s', msg(err))
      } finally {
        growthRunning = false
      }
    })()
  }

  /**
   * L4 profile injection: once per session per profile version, re-injected
   * after compaction or a new session. Without this, personality.md would be
   * written but never actually influence the Agent.
   */
  const profileBlockFor = (session, state) => {
    if (config.growth?.enabled !== true) return ''
    let current
    try {
      current = readPersonality(root)
    } catch {
      return ''
    }
    if (!current.available) return ''
    const version = current.month || 'unknown'
    if (state.profileInjected === version) return ''
    const block = formatProfileBlock(current)
    if (!block) return ''
    state.profileInjected = version
    runtime.growthApplied = {
      applied: true,
      session: String(session?.id || ''),
      month: version,
      at: Date.now(),
    }
    audit(root, { type: 'profile-inject', session: String(session?.id || ''), version, human_edited: current.humanEdited })
    return block
  }

  /**
   * Event-sourced capture. Only events needed to reconstruct a turn are
   * tracked; everything else is ignored. A failure here must never break the
   * session, so the whole body is guarded.
   */
  ctx.on('session/event', (session, event) => {
    try {
      const state = stateOf(session)
      switch (event.type) {
        case 'turn/start':
          resetTurn(state, event.data?.turn ?? state.turn + 1)
          state.turnStartSeq = event.seq
          turnCounter++
          return
        case 'user/message': {
          const source = event.data?.source
          if (!source || source.kind !== 'user') return
          const text = textOf(event.data?.content)
          if (!text) return
          // The client may live in a different zone than the host; its zone is
          // the better basis for interpreting "yesterday" in that message.
          state.userMessages.push({
            text,
            time: event.time,
            seq: event.seq,
            tz: normalizeTz(source.clientTimeZone || config.timeZone),
          })
          if (source.clientTimeZone) state.tz = normalizeTz(source.clientTimeZone)
          persistPending(session, state)
          return
        }
        case 'assistant/message': {
          const content = event.data?.message?.content
          const text = textOf(content)
          if (text) {
            state.assistantText += (state.assistantText ? '\n' : '') + text
          }
          state.assistantSeq = event.seq
          for (const block of Array.isArray(content) ? content : []) {
            // Providers spell tool calls three ways; accept all of them.
            if (block?.type !== 'tool-call' && block?.type !== 'tool_call' && block?.type !== 'tool_use') continue
            const callId = block.callId || block.id || block.toolCallId
            const toolName = block.name || block.toolName
            if (callId && toolName) state.toolCalls.set(callId, toolName)
          }
          persistPending(session, state)
          return
        }
        case 'tool/call': {
          if (event.data?.callId) state.toolCalls.set(event.data.callId, event.data.name)
          return
        }
        case 'tool/result': {
          const callId = event.data?.message?.toolCallId
          const toolName = state.toolCalls.get(callId) || event.data?.message?.name || event.data?.name || 'tool'
          const ok = !event.data?.message?.isError
          state.toolResults.push({
            name: toolName,
            ok,
            summary: textOf(event.data?.message?.content).slice(0, 300),
            time: event.time,
            seq: event.seq,
            error: event.data?.error?.reason,
          })
          persistPending(session, state)
          return
        }
        case 'turn/end': {
          const reason = event.data?.reason?.kind
          state.turnStatus = reason === 'completed' ? 'completed' : reason === 'aborted' ? 'aborted' : 'error'
          flush(session, state, event)
          return
        }
        default:
          return
      }
    } catch (err) {
      log.warn('capture failed: %s', msg(err))
    }
  })

  /**
   * Turn close: classify the buffered turn, resolve corrections, persist L1,
   * persist supersession, and advance the session cursor. A Q&A-only turn
   * writes no record but still registers the session so L2 coverage can see it.
   */
  function flush(session, state, event) {
    if (config.capture.enabled === false) return
    // Even a pure Q&A turn has no L1 record but must still be registered, or
    // L2 journal coverage would wrongly claim to cover that day.
    store.registerSession(String(session.id), {
      namespace: config.namespace,
      atMs: event.time,
      tz: state.tz || config.timeZone,
    })
    if (state.userMessages.length === 0 && state.toolResults.length === 0) return
    const seqFrom = state.userMessages[0]?.seq ?? state.turnStartSeq ?? event.seq
    const { records, redactedCount } = classifyTurn({
      sessionId: String(session.id),
      turn: state.turn,
      userMessages: state.userMessages,
      assistantText: state.assistantText,
      assistantSeq: state.assistantSeq,
      toolResults: state.toolResults,
      turnStatus: state.turnStatus,
      recordedAt: event.time,
      seqFrom,
      seqTo: event.seq,
      config: { ...config, maxRecordsPerTurn: config.capture.maxRecordsPerTurn },
    })
    const withNamespace = records.map((r) => ({ ...r, namespace: config.namespace }))
    // A correction without an explicit target is matched against recent
    // records by topic/entity; the match is persisted as a supersedes link.
    for (const record of withNamespace) {
      if (record.kind !== 'correction' || record.supersedes?.length) continue
      const target = store.findSupersedeTarget(record)
      if (target) record.supersedes = [target.id]
    }
    const written = store.append(withNamespace)
    for (const record of withNamespace) {
      for (const targetId of record.supersedes || []) {
        store.supersede(targetId, record.id, record.event_start_ms || event.time)
      }
    }
    store.takePending(String(session.id))
    if (written > 0) {
      store.setCursor(String(session.id), event.seq)
      audit(root, {
        type: 'capture',
        session: String(session.id),
        turn: state.turn,
        records: written,
        redacted: redactedCount,
        status: state.turnStatus,
      })
    }
  }

  /**
   * First-step recall. Running only on step 1 keeps the hot path cheap and
   * avoids re-injecting the same context across tool iterations.
   *
   * Order matters: the L4 profile block goes first because it constrains how
   * the Agent speaks, then recalled facts answer what it speaks about.
   * `prepend: true` makes this run before other pre-step listeners.
   */
  ctx.on('agent/pre-step', async ({ agent, step, signal }, next) => {
    const decision = await next()
    if (signal?.aborted || decision.kind === 'reject') return decision
    if (step !== 1) return decision
    try {
      const messages = decision.messages || []
      if (messages.some(isMemoryMessage)) return decision
      const text = lastUserText(messages)
      if (!text) return decision
      const state = stateOf(agent.session)
      // L4 profile precedes recall: it shapes delivery, not content.
      const profileBlock = profileBlockFor(agent.session, state)
      const extra = profileBlock ? [profileMessage(profileBlock)] : []
      const anchorMs = state.userMessages.at(-1)?.time || Date.now()
      const tz = state.tz || config.timeZone
      const records = store.readAll()
      const recall = shouldRecall({
        text,
        anchorMs,
        tz,
        concepts: listConcepts(root, { namespace: config.namespace }),
        config,
        lastInjection: state.lastInjection,
        turn: state.turn || turnCounter,
      })

      let result = null
      let label = ''
      if (recall) {
        result = searchRecords(records, {
          query: recall.query,
          fromMs: recall.fromMs,
          toMs: recall.toMs,
          status: 'active',
          namespace: config.namespace,
          limit: config.inject.maxItems,
          tz,
          retentionDays: config.retentionDays,
        })
        label = recall.trigger
        if (result.status !== 'ok' || result.items.length === 0) {
          audit(root, {
            type: 'recall-miss',
            session: String(agent.session.id),
            trigger: recall.trigger,
            status: result.status,
          })
          result = null
        }
      }

      // Cold start is suppressed for greetings and for questions whose answer
      // is the current time — injecting old memories there is pure noise.
      const coldAllowed = state.coldStart
        && config.inject.enabled !== false
        && config.inject.coldStartDays > 0
        && !/^(你好|hi|hello|在吗)[。！!？?]*$/i.test(text)
        && !/(几点|现在时间|当前时间|今天几号|星期几)/.test(text)
      if (!result && coldAllowed) {
        result = searchRecords(records, {
          fromMs: Date.now() - config.inject.coldStartDays * DAY_MS,
          status: 'active',
          namespace: config.namespace,
          limit: config.inject.coldStartItems,
          tz,
          retentionDays: config.retentionDays,
        })
        label = 'cold-start'
        if (result.status !== 'ok' || result.items.length === 0) result = null
      }
      state.coldStart = false
      if (!result) {
        return extra.length ? { ...decision, messages: [...messages, ...extra] } : decision
      }

      const block = formatBlock(result.items, {
        tz,
        coverage: result.coverage,
        label,
        truncated: result.truncated,
        remaining: Math.max(0, result.total - result.returned),
        maxTokens: config.inject.maxTokens,
        maxChars: config.inject.maxChars ?? null,
      })
      const message = memoryMessage(block)
      // Kept in memory only: after a compaction the same block is re-appended,
      // so the user does not have to restate the context.
      state.lastInjection = {
        turn: state.turn || turnCounter,
        topic: recall?.topic || 'cold-start',
        at: Date.now(),
        generation: agent.session.surface?.replaceGeneration,
        text: block,
      }
      audit(root, {
        type: 'inject',
        session: String(agent.session.id),
        trigger: label,
        ids: result.items.map((i) => i.id),
        returned: result.returned,
        total: result.total,
      })
      return { ...decision, messages: [...messages, ...extra, message] }
    } catch (err) {
      log.warn('recall failed: %s', msg(err))
    }
    return decision
  }, { prepend: true })

  /**
   * Compaction recovery. The retry only matters when the failure is a context
   * overflow and the host really replaced the surface (generation advanced);
   * any other error is left to the host.
   */
  ctx.on('agent/request-error', async ({ agent, failure, signal }, next) => {
    const generation = agent.session?.surface?.replaceGeneration
    const action = await next()
    if (signal?.aborted || action?.kind !== 'retry'
      || failure.code !== 'CONTEXT_WINDOW_EXCEEDED'
      || !(agent.session.surface.replaceGeneration > generation)) return action
    try {
      const state = stateOf(agent.session)
      if (state.lastInjection?.text) {
        agent.session.append('user/message', memoryMessage(state.lastInjection.text), { surfaceOp: 'append' })
        audit(root, { type: 'restore', session: String(agent.session.id) })
      }
    } catch (err) {
      log.warn('restore failed: %s', msg(err))
    }
    return action
  }, { prepend: true })

  /**
   * Session lifecycle. The `source` kind decides whether this is a cold start
   * and whether cached injection/profile state must be reset; recovery and the
   * two periodic jobs are also kicked off here, not on a timer.
   */
  ctx.on('agent/created', ({ agent, source }) => {
    try {
      const state = stateOf(agent.session)
      const kind = String(source || '')
      if (['startup', 'fresh', 'resume', 'clear', 'compact', 'compaction'].includes(kind)) {
        state.coldStart = true
      }
      if (['startup', 'fresh', 'clear', 'compact', 'compaction'].includes(kind)) {
        state.lastInjection = null
        // A compaction or new session rewrites the context, so the profile
        // must be injected again to actually take effect.
        state.profileInjected = null
      }
      recoverPending(agent.session)
      runDailyMaintenance()
      runMonthlyGrowth()
    } catch {
      // Failing to reset ephemeral state must not block the session.
    }
  })

  log.info('temporal memory ready at %s (tz=%s)', root, config.timeZone)
}

function msg(err) {
  return err && err.message ? err.message : String(err)
}

export { resolveConfig, textOf }
