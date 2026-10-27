/**
 * L4 user and Agent profiles, with optional monthly growth.
 *
 * L4 is not a retrieval index and not an alias for L3. It produces exactly two
 * artifacts:
 *
 *   1. a readable soft profile (expression style, initiative, reminder style)
 *      injected once at the first step of a session;
 *   2. a month version, a line diff, and evidence references, so a change can
 *      be reviewed and rolled back.
 *
 * Growth is opt-in and rule-based. It counts the previous month's L1 records,
 * L2 journal files, and L3 pages, plus the top topics/entities. It does not read
 * raw session transcripts and does not call a model. With too little evidence it
 * leaves the profile alone.
 *
 * Human ownership is absolute: if `personality.md` no longer matches the hash
 * recorded when the plugin last wrote it, the file was edited by a human. The
 * plugin then stops automatic revision until the state is reset. It never
 * overwrites human writing — the same boundary as L3 concept pages.
 *
 * The user profile stores only explicit preference sentences (redacted), never
 * inferred facts. Evidence files store counts and references, not raw text.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { redact } from './classify.js'
import { inNamespace } from './namespace.js'
import { appendLine, ensureDir, readJson, writeJsonAtomic, writeTextAtomic } from './paths.js'
import { localParts } from './time.js'

/** Minimum L1 records in a month before growth runs; below this, keep the profile. */
export const MIN_RECORDS = 5
const STATE_VERSION = 1
const MAX_ENTITIES = 5
const MAX_PREFERENCES = 8
const MAX_PREF_CHARS = 160
const MAX_EVIDENCE = 200
const HEADER_MARK = '月份：'

// Path helpers. The layout is documented in profile/README.md; keeping them in
// one place makes backup and migration predictable.
export function profileRoot(root) {
  return path.join(root, 'profile')
}

export function personalityPath(root) {
  return path.join(profileRoot(root), 'agent', 'personality.md')
}

export function userProfilePath(root) {
  return path.join(profileRoot(root), 'user', 'profile.md')
}

export function historyPath(root, month) {
  return path.join(profileRoot(root), 'agent', 'history', `${month}.md`)
}

export function historyDiffPath(root, month) {
  return path.join(profileRoot(root), 'agent', 'history', `${month}.diff`)
}

export function evidencePath(root, month) {
  return path.join(profileRoot(root), 'evidence', `${month}.jsonl`)
}

export function profileIndexPath(root) {
  return path.join(profileRoot(root), '_index.md')
}

export function profileStatePath(root) {
  return path.join(profileRoot(root), '_state.json')
}

function hashText(text) {
  return createHash('sha256').update(String(text || '')).digest('hex').slice(0, 16)
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

/** Local month key, aligned with the journal's local-day split. */
export function monthOf(ms, tz = 'UTC') {
  const p = localParts(ms, tz)
  return `${p.year}-${String(p.month).padStart(2, '0')}`
}

/** The month that just ended: running in October profiles September. */
export function previousMonth(nowMs, tz = 'UTC') {
  const p = localParts(nowMs, tz)
  const month = p.month === 1 ? 12 : p.month - 1
  const year = p.month === 1 ? p.year - 1 : p.year
  return `${year}-${String(month).padStart(2, '0')}`
}

/**
 * Read `_state.json` with defaults. This file is plugin-owned; the UI shows
 * `human_edited` but never asks the user to edit the state by hand.
 */
export function readState(root) {
  const value = readJson(profileStatePath(root), {})
  return {
    version: STATE_VERSION,
    month: value.month || null,
    generated_at: value.generated_at || null,
    status: value.status || null,
    personality_hash: value.personality_hash || null,
    user_hash: value.user_hash || null,
    evidence: Number.isFinite(value.evidence) ? value.evidence : 0,
    traits: value.traits && typeof value.traits === 'object' ? value.traits : {},
    last_run: value.last_run || null,
    human_edited: value.human_edited === true,
    pending_month: value.pending_month || null,
  }
}

function writeState(root, value) {
  writeJsonAtomic(profileStatePath(root), { version: STATE_VERSION, ...value })
}

/**
 * Read the active personality.
 *
 * `humanEdited` is true when the file's content hash differs from the hash
 * recorded at the last plugin write. That is the signal to stop automatic
 * revision; it is not an error.
 */
export function readPersonality(root) {
  const text = readText(personalityPath(root))
  const state = readState(root)
  if (!text) {
    return { available: false, text: '', month: null, hash: null, humanEdited: false, state }
  }
  const mark = text.indexOf(HEADER_MARK)
  const month = mark >= 0 ? (text.slice(mark + HEADER_MARK.length, mark + HEADER_MARK.length + 7) || null) : null
  const hash = hashText(text)
  const humanEdited = Boolean(state.personality_hash) && state.personality_hash !== hash
  return {
    available: true,
    text,
    month: month && /^\d{4}-\d{2}$/.test(month) ? month : state.month,
    hash,
    humanEdited,
    state,
  }
}

function topCounts(values, limit = MAX_ENTITIES) {
  const counts = new Map()
  for (const value of values) {
    const name = String(value || '').trim()
    if (name.length < 2) continue
    counts.set(name, (counts.get(name) || 0) + 1)
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, limit)
}

/**
 * Collect counts for one month. This is evidence gathering only: no
 * interpretation happens here, and no raw text leaves the records.
 */
export function gatherSignals({ records = [], tz = 'UTC', month, journals = [], concepts = [], namespace } = {}) {
  const monthRecords = records.filter((record) => record
    && record.status !== 'deleted'
    && Number.isFinite(record.event_start_ms)
    && inNamespace(record, namespace)
    && monthOf(record.event_start_ms, tz) === month)

  const byKind = {}
  let chars = 0
  for (const record of monthRecords) {
    const kind = record.kind || 'unknown'
    byKind[kind] = (byKind[kind] || 0) + 1
    chars += String(record.text || '').length
  }

  // Journal entries carry only file-derived metadata (no summary or status),
  // so the evidence line records "this day was written by the Agent".
  const entries = (journals || [])
    .filter((entry) => String(entry?.key || '').startsWith(month))
    .map((entry) => ({ key: entry.key, status: 'agent', summary: `${entry.bytes || 0} 字节` }))

  return {
    month,
    records: monthRecords.length,
    byKind,
    avgChars: monthRecords.length ? Math.round(chars / monthRecords.length) : 0,
    topics: topCounts(monthRecords.flatMap((record) => record.topics || [])),
    entities: topCounts(monthRecords.flatMap((record) => record.entities || [])),
    journals: entries,
    concepts: Array.isArray(concepts) ? concepts.length : 0,
    monthRecords,
  }
}

/**
 * Derive soft traits from counts.
 *
 * Every output is a rule over aggregate signals, never an inference from a
 * single conversation. This keeps the profile stable and auditable; the model
 * does not decide who the Agent is.
 */
export function deriveTraits(signals) {
  const kinds = signals.byKind || {}
  const decided = (kinds.decision || 0) + (kinds.plan || 0)
  return {
    表达风格: signals.avgChars < 60
      ? '回答简短，先给出结论，再按需补充细节'
      : signals.avgChars < 140
        ? '先给结论，再分条展开关键依据'
        : '保留完整上下文，重要结论逐条展开并标注来源',
    主动性: decided >= 8
      ? '目标明确时主动给出下一步与时间点；越权动作先问再做'
      : '以回答当前问题为主，需要时再扩展方案',
    提醒方式: (kinds.correction || 0) > 0
      ? '涉及已更正的事项时先说清「旧结论 → 新结论」，再给依据'
      : '按时间与主题点名相关旧记忆，不整段复述',
    能力边界: '不确定的事实先说明不确定，不编造细节；跨会话的判断以记忆块里的证据为准',
  }
}

/**
 * Render the human-readable personality page. The `> 月份：` header line is the
 * machine-readable version marker; the rest is prose for the Agent and user.
 */
export function renderPersonality({ month, generatedAt, traits, signals }) {
  const lines = [
    '# Agent 软画像（L4）',
    '',
    `> ${HEADER_MARK}${month} ｜ 生成：${new Date(generatedAt).toISOString()}`,
    `> 证据：L1 记录 ${signals.records} 条 ｜ L2 日记 ${signals.journals.length} 篇 ｜ L3 概念页 ${signals.concepts} 页`,
    '> 插件维护的软画像：只影响表达风格、主动性与提醒方式，不修改角色设定、安全策略、权限与记忆写入规则。',
    '> 人工编辑此文件后，插件不再自动覆盖（见 profile/_index.md）。',
    '',
  ]
  for (const [trait, statement] of Object.entries(traits)) {
    lines.push(`## ${trait}`, '', `- ${statement}`, '')
  }
  if (signals.entities.length) {
    lines.push('## 关注面', '', `- ${signals.entities.map((item) => `${item.name}（${item.count} 次）`).join('、')}`, '')
  }
  return lines.join('\n')
}

/**
 * Collect explicit preference sentences, newest first, redacted and capped.
 * No rewriting or merging: the user's own words are the evidence.
 */
function collectPreferences(signals) {
  const seen = new Set()
  const out = []
  for (const record of [...signals.monthRecords].sort((a, b) => (b.recorded_at || 0) - (a.recorded_at || 0))) {
    if (record.kind !== 'preference') continue
    const text = redact(String(record.text || '')).text.trim()
    if (!text || seen.has(text)) continue
    seen.add(text)
    out.push(text.length > MAX_PREF_CHARS ? `${text.slice(0, MAX_PREF_CHARS - 1)}…` : text)
    if (out.length >= MAX_PREFERENCES) break
  }
  return out
}

/** Render the user profile from explicit preferences only. Empty => no file. */
export function renderUserProfile({ month, preferences }) {
  if (!preferences.length) return ''
  const lines = [
    '# 用户画像（L4）',
    '',
    `> ${HEADER_MARK}${month}`,
    '> 只摘录用户明确说过的偏好原文，不改写、不推测、不合并矛盾。',
    '',
    '## 明确表达的偏好',
    '',
  ]
  for (const text of preferences) lines.push(`- ${text}`)
  return lines.join('\n') + '\n'
}

/**
 * Line diff via LCS. Used only so a human can see what a month changed and
 * decide whether to roll back; it is not a patch format.
 */
export function lineDiff(before, after) {
  const a = String(before || '').split('\n')
  const b = String(after || '').split('\n')
  const n = a.length
  const m = b.length
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const out = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push(` ${a[i]}`)
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push(`-${a[i]}`)
      i++
    } else {
      out.push(`+${b[j]}`)
      j++
    }
  }
  while (i < n) out.push(`-${a[i++]}`)
  while (j < m) out.push(`+${b[j++]}`)
  return out.join('\n')
}

/**
 * Rewrite the month's evidence file. Evidence lines contain only references and
 * counts — no journal text, no record text. A failed cleanup does not stop the
 * profile write; evidence is supporting material, not the profile itself.
 */
function writeEvidence(root, month, signals, nowMs) {
  const file = evidencePath(root, month)
  try {
    fs.rmSync(file, { force: true })
  } catch { /* Evidence is regenerable; failure does not affect the profile. */ }
  const lines = []
  for (const entry of signals.journals.slice(0, MAX_EVIDENCE)) {
    lines.push(JSON.stringify({
      month,
      at: nowMs,
      layer: 'L2',
      ref: `journal/${entry.key}`,
      status: entry.status,
      note: entry.summary,
    }))
  }
  for (const item of signals.entities) {
    lines.push(JSON.stringify({
      month,
      at: nowMs,
      layer: 'L3',
      ref: `entity/${item.name}`,
      count: item.count,
      note: '来自 L1 记录的实体计数，不含原文',
    }))
  }
  lines.push(JSON.stringify({
    month,
    at: nowMs,
    layer: 'L1',
    ref: `month/${month}`,
    count: signals.records,
    kinds: signals.byKind,
    note: '只保存计数与分类，不保存原文',
  }))
  for (const line of lines) appendLine(file, line)
  return lines.length
}

/** Month snapshots, newest first. */
function listHistory(root) {
  try {
    return fs.readdirSync(path.join(profileRoot(root), 'agent', 'history'))
      .filter((name) => /^\d{4}-\d{2}\.md$/.test(name))
      .map((name) => name.slice(0, -3))
      .sort()
      .reverse()
  } catch {
    return []
  }
}

/** Render `_index.md`: the current version, history, and human-takeover state. */
export function renderProfileIndex({ state, humanEdited, months }) {
  const lines = [
    '# L4 画像索引',
    '',
    '> 当前生效版本与历史月份；每月一份快照（`agent/history/YYYY-MM.md`）与 diff（`.diff`）。',
    '> 人工编辑 `agent/personality.md` 后，状态变为 human_edited，插件停止自动覆盖。',
    '',
    '| 月份 | 状态 | 证据条数 | 生成时间 |',
    '|---|---|---|---|',
  ]
  for (const month of months) {
    const current = month === state.month
    const at = current && state.generated_at ? new Date(state.generated_at).toISOString() : ''
    const status = current ? (humanEdited ? 'human_edited（人工接管）' : (state.status || 'ok')) : 'archived'
    lines.push(`| ${month} | ${status} | ${current ? state.evidence : ''} | ${at} |`)
  }
  if (!months.length) lines.push('| — | 尚未生成 | 0 | |')
  return lines.join('\n') + '\n'
}

function writeProfileIndex(root, state, humanEdited) {
  writeTextAtomic(profileIndexPath(root), renderProfileIndex({ state, humanEdited, months: listHistory(root) }))
}

/**
 * Run one month's growth.
 *
 * Idempotent per month: if `_state.json` already records a successful run for
 * the target month, nothing is regenerated.
 *
 * Status values:
 *   disabled              growth switch is off
 *   up_to_date            target month already generated
 *   insufficient_evidence fewer than MIN_RECORDS L1 records
 *   human_edited          personality.md was edited by a human; no overwrite
 *   ok                    profile, history, diff, and evidence written
 *   error                 unexpected failure
 */
export function growMonthly({
  root,
  records = [],
  tz = 'UTC',
  month,
  nowMs = Date.now(),
  enabled = false,
  journals = [],
  concepts = [],
  namespace,
} = {}) {
  const target = month || previousMonth(nowMs, tz)
  if (!enabled) return { status: 'disabled', month: target }
  const state = readState(root)
  if (state.month === target && state.status === 'ok') {
    return { status: 'up_to_date', month: target, traits: state.traits }
  }

  const signals = gatherSignals({ records, tz, month: target, journals, concepts, namespace })
  if (signals.records < MIN_RECORDS) {
    writeState(root, {
      ...state,
      pending_month: target,
      last_run: { at: nowMs, month: target, status: 'insufficient_evidence', records: signals.records },
    })
    return { status: 'insufficient_evidence', month: target, signals, minRecords: MIN_RECORDS }
  }

  const current = readPersonality(root)
  if (current.available && current.humanEdited) {
    writeState(root, {
      ...state,
      human_edited: true,
      pending_month: target,
      last_run: { at: nowMs, month: target, status: 'human_edited' },
    })
    writeProfileIndex(root, readState(root), true)
    return { status: 'human_edited', month: target, signals }
  }

  const traits = deriveTraits(signals)
  const text = renderPersonality({ month: target, generatedAt: nowMs, traits, signals })
  const preferences = collectPreferences(signals)
  const userText = renderUserProfile({ month: target, preferences })
  const userCurrent = readText(userProfilePath(root))
  // The user profile has the same human-edit lock as the Agent profile. A
  // missing file is not a lock; a changed file is.
  const userLocked = Boolean(state.user_hash) && Boolean(userCurrent) && hashText(userCurrent) !== state.user_hash
  const diff = lineDiff(current.text, text)

  writeTextAtomic(historyPath(root, target), text)
  writeTextAtomic(historyDiffPath(root, target), `--- ${target} (previous)\n+++ ${target} (generated ${new Date(nowMs).toISOString()})\n${diff}\n`)
  writeTextAtomic(personalityPath(root), text)
  if (userText && !userLocked) writeTextAtomic(userProfilePath(root), userText)
  const evidence = writeEvidence(root, target, signals, nowMs)

  const next = {
    ...state,
    month: target,
    generated_at: nowMs,
    status: 'ok',
    personality_hash: hashText(text),
    user_hash: userText && !userLocked ? hashText(userText) : state.user_hash,
    evidence,
    traits,
    human_edited: false,
    pending_month: null,
    last_run: { at: nowMs, month: target, status: 'ok', records: signals.records },
  }
  writeState(root, next)
  writeProfileIndex(root, next, false)

  return {
    status: 'ok',
    month: target,
    traits,
    signals: { records: signals.records, journals: signals.journals.length, concepts: signals.concepts, entities: signals.entities },
    diff,
    evidence,
    userProfile: Boolean(userText && !userLocked),
    userLocked,
  }
}

/** Read-only summary for `memory_health`; never triggers generation. */
export function growthStatus(root, { enabled = false, nowMs = Date.now(), tz = 'UTC' } = {}) {
  const state = readState(root)
  const current = readPersonality(root)
  const target = previousMonth(nowMs, tz)
  return {
    enabled: enabled === true,
    implemented: true,
    state: current.available ? (current.humanEdited ? 'human_edited' : 'ok') : 'not_generated',
    personality_version: current.month,
    personality_file: personalityPath(root),
    generated_at: state.generated_at ? new Date(state.generated_at).toISOString() : null,
    last_run: state.last_run,
    pending_month: state.month === target ? null : target,
    human_edited: current.humanEdited,
    evidence: state.evidence,
    traits: state.traits,
  }
}

/**
 * Build the injected profile block.
 *
 * The file's title and `>` metadata lines are stripped (they are for humans
 * reading the file, not for the prompt), and the result is explicitly framed as
 * guidance rather than an override of system policy.
 */
export function formatProfileBlock(personality) {
  if (!personality || !personality.available) return ''
  const body = String(personality.text || '')
    .split('\n')
    .filter((line) => !line.startsWith('# ') && !line.startsWith('> '))
    .join('\n')
    .trim()
  if (!body) return ''
  const version = personality.month || '未知'
  return [
    `## Agent 软画像（L4，${version}）`,
    '',
    '> 以下是长期交互中归纳出的表达与提醒偏好，只作参考；不覆盖系统角色、安全策略与权限。',
    '',
    body,
  ].join('\n')
}
