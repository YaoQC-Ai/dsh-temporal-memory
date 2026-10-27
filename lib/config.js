/**
 * Configuration resolution shared by the host plugin (`index.js`) and the
 * tool plugin (`tools.js`).
 *
 * Precedence, highest first:
 *   1. `rawConfig` — the object passed to `apply(ctx, config)`, normally coming
 *      from the Cordis patch / host YAML.
 *   2. `config.json` — written by the settings UI and stored at the memory root.
 *   3. `DEFAULTS` below.
 *
 * Every leaf is validated independently. An invalid value falls back to the
 * lower-precedence value (ultimately the default), is reported in
 * `configErrors`, and is never silently accepted. `configSources` records which
 * layer actually won for each leaf so the settings UI can label fields as
 * "patch", "config.json", or "default".
 *
 * The resolved object is frozen by convention only; callers must treat it as
 * read-only and never persist it back to disk.
 */
import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_NAMESPACE } from './namespace.js'
import { resolveRoot } from './paths.js'
import { isValidTz } from './time.js'

/**
 * Defaults for every user-visible setting. Nested objects are intentionally
 * shallow: validation copies each branch before mutating it, so `DEFAULTS`
 * itself is never changed.
 */
export const DEFAULTS = Object.freeze({
  timeZone: 'Asia/Shanghai',
  // Days of L1 retention. Records whose day is covered by an agent journal are
  // pruned; uncovered records are retained so a lossy journal cannot erase the
  // only copy of an event.
  retentionDays: 365,
  namespace: DEFAULT_NAMESPACE,
  // Names the user expects to appear often. Used for fuzzy day recall and as a
  // hint for entity extraction; never uploaded anywhere.
  entities: [],
  capture: { enabled: true, maxRecordsPerTurn: 8 },
  inject: {
    enabled: true,
    maxItems: 6,
    maxTokens: 1200,
    coldStartDays: 3,
    coldStartItems: 5,
    cooldownTurns: 3,
  },
  compile: { minRecords: 2, maxTopics: 20 },
  // Enhanced privacy only tightens ordinary content checks.
  // Credential redaction is unconditional and cannot be disabled here.
  privacy: { enhanced: false },
  // L4 opt-in. When true, the Agent may revise its soft personality once a
  // month from the previous month's evidence. Off by default; a human edit to
  // personality.md stops automatic revision permanently until reset.
  growth: { enabled: false },
  // Compatibility field only: the host no longer opens a settings listener.
  // Standalone scripts/config-ui.mjs still reads this value. Old config.json
  // files keep their explicit port; this default only applies when unset.
  ui: { host: '127.0.0.1', port: 18790 },
})

/** Absolute path of the JSON file written by the settings UI. */
export function configPath(root) {
  return path.join(root, 'config.json')
}

function leafPaths(value, prefix = '') {
  const out = []
  for (const [key, item] of Object.entries(value)) {
    const pathKey = prefix ? `${prefix}.${key}` : key
    if (item && typeof item === 'object' && !Array.isArray(item)) out.push(...leafPaths(item, pathKey))
    else out.push(pathKey)
  }
  return out
}

const DEFAULT_LEAVES = leafPaths(DEFAULTS)

function readPath(object, key) {
  let node = object
  for (const part of key.split('.')) {
    if (!node || typeof node !== 'object' || !(part in node)) return undefined
    node = node[part]
  }
  return node
}

function hasPath(object, key) {
  let node = object
  for (const part of key.split('.')) {
    if (!node || typeof node !== 'object' || !(part in node)) return false
    node = node[part]
  }
  return true
}

function sameValue(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}

function rootSourceOf(rawConfig) {
  if (rawConfig.dir) return 'dir'
  return process.env.DSH_HOME ? 'DSH_HOME' : 'home-default'
}

/**
 * Best-effort read of `config.json`. A missing, malformed, or non-object file
 * is treated as "no file config" rather than an error: the plugin must still
 * start with defaults when a user hand-edits the file badly.
 */
export function readFileConfig(root) {
  try {
    const value = JSON.parse(fs.readFileSync(configPath(root), 'utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}

function integer(value, min, max, name, errors) {
  if (!Number.isInteger(value) || value < min || value > max) {
    errors.push(`${name} 必须是 ${min}–${max} 的整数`)
    return null
  }
  return value
}

function boolean(value, name, errors) {
  if (typeof value !== 'boolean') {
    errors.push(`${name} 必须是布尔值`)
    return null
  }
  return value
}

function withBoolean(base, patch, name, errors) {
  if (patch === undefined) return base
  const value = boolean(patch, name, errors)
  return value === null ? base : value
}

function withInteger(base, patch, min, max, name, errors) {
  if (patch === undefined) return base
  const value = integer(patch, min, max, name, errors)
  return value === null ? base : value
}

/**
 * Validate a merged configuration object.
 *
 * Returns `{ config, errors, warnings }`. `errors` explains each rejected
 * value; the corresponding field keeps the default. `warnings` is used for
 * unknown top-level keys (forward compatibility with newer versions).
 */
export function validateConfig(input = {}) {
  const errors = []
  const warnings = []
  const config = {
    ...DEFAULTS,
    capture: { ...DEFAULTS.capture },
    inject: { ...DEFAULTS.inject },
    compile: { ...DEFAULTS.compile },
    privacy: { ...DEFAULTS.privacy },
    growth: { ...DEFAULTS.growth },
    ui: { ...DEFAULTS.ui },
  }

  if (input.timeZone !== undefined) {
    if (isValidTz(input.timeZone)) config.timeZone = input.timeZone
    else errors.push(`timeZone 不是有效的 IANA 时区：${String(input.timeZone)}`)
  }
  if (input.retentionDays !== undefined) {
    config.retentionDays = withInteger(config.retentionDays, input.retentionDays, 1, 36500, 'retentionDays', errors)
  }
  if (input.namespace !== undefined) {
    if (typeof input.namespace === 'string' && input.namespace.trim() && input.namespace.length <= 64) {
      config.namespace = input.namespace.trim()
    } else {
      errors.push('namespace 必须是 1–64 字符的非空字符串')
    }
  }
  if (input.entities !== undefined) {
    if (Array.isArray(input.entities) && input.entities.length <= 100 && input.entities.every((x) => typeof x === 'string')) {
      config.entities = input.entities.map((x) => x.trim()).filter(Boolean)
    } else {
      errors.push('entities 必须是字符串数组（最多 100 项）')
    }
  }
  if (input.dir !== undefined && (typeof input.dir !== 'string' || !path.isAbsolute(input.dir))) {
    errors.push('dir 必须是绝对路径')
  }
  if (input.root !== undefined && (typeof input.root !== 'string' || !path.isAbsolute(input.root))) {
    errors.push('root 必须是绝对路径')
  }

  const capture = input.capture || {}
  config.capture.enabled = withBoolean(config.capture.enabled, capture.enabled, 'capture.enabled', errors)
  config.capture.maxRecordsPerTurn = withInteger(
    config.capture.maxRecordsPerTurn, capture.maxRecordsPerTurn, 1, 50, 'capture.maxRecordsPerTurn', errors,
  )

  const inject = input.inject || {}
  config.inject.enabled = withBoolean(config.inject.enabled, inject.enabled, 'inject.enabled', errors)
  config.inject.maxItems = withInteger(config.inject.maxItems, inject.maxItems, 1, 50, 'inject.maxItems', errors)
  config.inject.maxTokens = withInteger(config.inject.maxTokens, inject.maxTokens, 100, 8000, 'inject.maxTokens', errors)
  config.inject.coldStartDays = withInteger(config.inject.coldStartDays, inject.coldStartDays, 0, 90, 'inject.coldStartDays', errors)
  config.inject.coldStartItems = withInteger(config.inject.coldStartItems, inject.coldStartItems, 1, 20, 'inject.coldStartItems', errors)
  config.inject.cooldownTurns = withInteger(config.inject.cooldownTurns, inject.cooldownTurns, 0, 100, 'inject.cooldownTurns', errors)
  if (inject.maxChars !== undefined) {
    const value = integer(inject.maxChars, 200, 20000, 'inject.maxChars', errors)
    if (value !== null) config.inject.maxChars = value
  }

  const compile = input.compile || {}
  config.compile.minRecords = withInteger(config.compile.minRecords, compile.minRecords, 1, 50, 'compile.minRecords', errors)
  config.compile.maxTopics = withInteger(config.compile.maxTopics, compile.maxTopics, 1, 500, 'compile.maxTopics', errors)

  const privacy = input.privacy || {}
  config.privacy.enhanced = withBoolean(config.privacy.enhanced, privacy.enhanced, 'privacy.enhanced', errors)

  const growth = input.growth || {}
  config.growth.enabled = withBoolean(config.growth.enabled, growth.enabled, 'growth.enabled', errors)

  const ui = input.ui || {}
  if (ui.host !== undefined) {
    if (ui.host === '127.0.0.1' || ui.host === 'localhost' || ui.host === '::1') config.ui.host = ui.host
    else errors.push('ui.host 只允许本机地址（127.0.0.1 / localhost / ::1）')
  }
  config.ui.port = withInteger(config.ui.port, ui.port, 1024, 65535, 'ui.port', errors)

  // `journal` is still accepted even though it has no settings: older config
  // files may contain it, and warning about a key the plugin used to support
  // would be noise rather than help.
  const known = new Set(['timeZone', 'retentionDays', 'namespace', 'entities', 'dir', 'root', 'capture', 'inject', 'journal', 'compile', 'privacy', 'growth', 'ui'])
  for (const key of Object.keys(input)) {
    if (!known.has(key)) warnings.push(`忽略未知配置项：${key}`)
  }
  return { config, errors, warnings }
}

/**
 * Resolve the effective configuration and attach runtime metadata.
 *
 * `root` is the single memory root (`$DSH_HOME/memory/temporal` by default).
 * It is resolved before `config.json` is read, because the file lives inside
 * that root. The returned object additionally carries `root`, `rootSource`,
 * `configFile`, `configSources`, `configErrors`, and `configWarnings`.
 */
export function resolveConfig(rawConfig = {}) {
  const rootErrors = []
  let root
  let rootSource
  if (rawConfig.root !== undefined) {
    if (typeof rawConfig.root === 'string' && path.isAbsolute(rawConfig.root)) {
      root = rawConfig.root
      rootSource = 'root'
    } else {
      rootErrors.push('root 必须是绝对路径')
      root = resolveRoot({ ...rawConfig, root: undefined })
      rootSource = rootSourceOf(rawConfig)
    }
  } else {
    root = resolveRoot(rawConfig)
    rootSource = rootSourceOf(rawConfig)
  }
  const fileConfig = readFileConfig(root)
  const merged = {
    ...fileConfig,
    ...rawConfig,
    capture: { ...(fileConfig.capture || {}), ...(rawConfig.capture || {}) },
    inject: { ...(fileConfig.inject || {}), ...(rawConfig.inject || {}) },
    compile: { ...(fileConfig.compile || {}), ...(rawConfig.compile || {}) },
    privacy: { ...(fileConfig.privacy || {}), ...(rawConfig.privacy || {}) },
    growth: { ...(fileConfig.growth || {}), ...(rawConfig.growth || {}) },
    ui: { ...(fileConfig.ui || {}), ...(rawConfig.ui || {}) },
  }
  const { config, errors, warnings } = validateConfig(merged)

  // Record the winning layer per leaf. A value that failed validation is no
  // longer considered an override, so the UI shows the layer that actually
  // supplied the effective value.
  const configSources = {}
  for (const leaf of DEFAULT_LEAVES) {
    const final = readPath(config, leaf)
    if (hasPath(rawConfig, leaf) && sameValue(readPath(rawConfig, leaf), final)) configSources[leaf] = 'patch'
    else if (hasPath(fileConfig, leaf) && sameValue(readPath(fileConfig, leaf), final)) configSources[leaf] = 'config.json'
    else configSources[leaf] = 'default'
  }
  if (config.inject.maxChars !== undefined) {
    const final = config.inject.maxChars
    if (hasPath(rawConfig, 'inject.maxChars') && sameValue(readPath(rawConfig, 'inject.maxChars'), final)) {
      configSources['inject.maxChars'] = 'patch'
    } else if (hasPath(fileConfig, 'inject.maxChars') && sameValue(readPath(fileConfig, 'inject.maxChars'), final)) {
      configSources['inject.maxChars'] = 'config.json'
    } else {
      configSources['inject.maxChars'] = 'default'
    }
  }

  return {
    ...config,
    root,
    rootSource,
    configFile: configPath(root),
    configSources,
    configErrors: rootErrors.concat(errors),
    configWarnings: warnings,
  }
}
