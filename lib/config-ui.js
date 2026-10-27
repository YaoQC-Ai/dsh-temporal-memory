/**
 * Configuration console HTTP handler.
 *
 * One implementation serves both deployment shapes: the standalone loopback
 * server (used during first-run setup) and the host-mounted `/memory-ui` route.
 * The standalone server enforces Host/Origin checks; the host route relies on
 * DSH authentication and turns them off. Either way the body limit, the JSON
 * content-type requirement, schema validation, and the prohibition on writing
 * `dir`/`root` from a browser stay in force.
 *
 * The handler is stateless: every request re-resolves the configuration, so a
 * saved `config.json` is visible on the next read. `restartRequired` is still
 * reported because the host caches some values at startup.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { listConcepts } from './concepts.js'
import { configPath, readFileConfig, resolveConfig, validateConfig } from './config.js'
import { writeJsonAtomic } from './paths.js'
import { searchRecords } from './search.js'
import { Store } from './store.js'
import { dayRange } from './time.js'

/** 64 KiB is far more than a settings object needs; it bounds memory abuse. */
const BODY_LIMIT = 64 * 1024
/** Top-level keys the console may read/write. `dir` and `root` are deliberately absent. */
const CONFIG_KEYS = ['timeZone', 'retentionDays', 'namespace', 'entities', 'capture', 'inject', 'compile', 'privacy', 'growth', 'ui']
/** Sections merged one level deep so saving one switch does not erase its siblings. */
const NESTED_KEYS = ['capture', 'inject', 'compile', 'privacy', 'growth', 'ui']
/** Same status vocabulary as `memory_search`; anything else is a 400. */
const STATUSES = new Set(['active', 'history', 'all', 'superseded', 'disputed'])
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])
/** Static console page; resolved once relative to this module. */
const PAGE_URL = new URL('../scripts/config-ui.html', import.meta.url)

function json(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(body)
}

/** Host headers may carry a port; strip it and lower-case the name. Invalid input → ''. */
function hostnameOf(value) {
  try {
    return new URL('http://' + String(value)).hostname.toLowerCase()
  } catch {
    return ''
  }
}

function localHost(value) {
  return LOOPBACK.has(hostnameOf(value))
}

/**
 * A browser Origin is acceptable only when it is an http(s) loopback page on
 * the same port as the server. This stops other localhost services, and any
 * remote page, from driving the config API via the user's browser.
 */
function originAllowed(origin, port) {
  let url
  try {
    url = new URL(String(origin))
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  if (!LOOPBACK.has(url.hostname.toLowerCase())) return false
  return url.port === String(port) || (url.port === '' && String(port) === '80')
}

/** Collect the request body, rejecting as soon as it exceeds BODY_LIMIT. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let tooLarge = false
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > BODY_LIMIT) {
        tooLarge = true
        chunks.length = 0
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (tooLarge) {
        const err = new Error(`请求体超过 ${BODY_LIMIT} 字节`)
        err.status = 413
        reject(err)
        return
      }
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', reject)
  })
}

/** Dotted-path lookup, used to attach a value to each config source. */
function getPath(object, key) {
  let node = object
  for (const part of key.split('.')) {
    if (!node || typeof node !== 'object') return undefined
    node = node[part]
  }
  return node
}

/** Effective value plus where it came from (`default` / `file` / `patch`). */
function fieldsOf(resolved) {
  const out = {}
  for (const [key, source] of Object.entries(resolved.configSources || {})) {
    const value = getPath(resolved, key)
    if (value === undefined) continue
    out[key] = { effectiveValue: value, source }
  }
  return out
}

/** Whitelist known keys; nested sections are cloned so callers cannot mutate the resolved config. */
function pickConfig(config) {
  const out = {}
  for (const key of CONFIG_KEYS) {
    if (config[key] !== undefined) out[key] = config[key]
  }
  for (const key of NESTED_KEYS) {
    out[key] = { ...(config[key] || {}) }
  }
  return out
}

/** Persist only known keys, so a future field cannot leak into `config.json` unnoticed. */
function fileConfigOf(merged) {
  const out = {}
  for (const key of CONFIG_KEYS) {
    if (merged[key] !== undefined) out[key] = merged[key]
  }
  return out
}

/**
 * Patch semantics: objects merge one level (a partial `inject` keeps other
 * inject keys), scalars and arrays replace. Deeper nesting is replaced as a
 * unit because the schema has no deeper structure.
 */
function mergeConfig(existing, patch) {
  const out = { ...existing }
  for (const key of Object.keys(patch)) {
    const next = patch[key]
    const prev = existing[key]
    const bothObjects = next && typeof next === 'object' && !Array.isArray(next)
      && prev && typeof prev === 'object' && !Array.isArray(prev)
    out[key] = bothObjects ? { ...prev, ...next } : next
  }
  return out
}

/** Keys fixed by the host at startup; shown in the UI as read-only. */
function hostOverrides(resolved) {
  return Object.entries(resolved.configSources || {})
    .filter(([, source]) => source === 'patch')
    .map(([key]) => key)
}

/**
 * A present-but-unparseable `config.json` is reported, not repaired: saving
 * from the console will overwrite it, and the user deserves to know first.
 */
function fileWarning(file) {
  try {
    const text = fs.readFileSync(file, 'utf8')
    if (!text.trim()) return null
    JSON.parse(text)
    return null
  } catch (err) {
    return err.code === 'ENOENT' ? null : `config.json 无法解析，保存后将覆盖：${err.message}`
  }
}

/** Check the nearest existing ancestor, since the data directory may not exist yet. */
function isWritable(dir) {
  let target = dir
  while (!fs.existsSync(target) && target !== path.dirname(target)) target = path.dirname(target)
  try {
    fs.accessSync(target, fs.constants.W_OK)
    return true
  } catch {
    return false
  }
}

/** Strict `YYYY-MM-DD`; semantic validity is checked later by `dayRange`. */
function parseDate(value, name) {
  if (!value) return null
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const err = new Error(`${name} 必须是 YYYY-MM-DD`)
    err.status = 400
    throw err
  }
  return value
}

/**
 * @param {object} [options]
 * @param {object} [options.rawConfig] Host-level overrides (highest precedence).
 * @param {boolean} [options.localOnly=true] Enforce loopback Host/Origin checks.
 * @param {boolean} [options.servePage=true] Serve the HTML console at `/`.
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createConfigHandler(options = {}) {
  const rawConfig = { ...(options.rawConfig || {}) }
  const localOnly = options.localOnly !== false
  const servePage = options.servePage !== false
  const current = () => resolveConfig(rawConfig)

  async function handle(req, res) {
    if (localOnly) {
      const port = req.socket?.localPort || 0
      if (!localHost(req.headers.host || '')) {
        json(res, 403, { status: 'error', message: '只接受本机 Host 访问' })
        return
      }
      if (String(req.headers['sec-fetch-site'] || '') === 'cross-site') {
        json(res, 403, { status: 'error', message: '拒绝跨站请求' })
        return
      }
      const origin = req.headers.origin
      if (origin && !originAllowed(origin, port)) {
        json(res, 403, { status: 'error', message: 'Origin 不是本机页面' })
        return
      }
    }

    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const route = url.pathname

    if (servePage && (route === '/' || route === '/index.html')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        json(res, 405, { status: 'error', message: '方法不允许' })
        return
      }
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        // Inline script/style are required by the single-file console; everything else is denied.
        'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
      })
      res.end(req.method === 'HEAD' ? '' : fs.readFileSync(fileURLToPath(PAGE_URL), 'utf8'))
      return
    }

    if (route === '/api/config') {
      if (req.method === 'GET') {
        const resolved = current()
        json(res, 200, {
          status: 'ok',
          root: resolved.root,
          rootSource: resolved.rootSource,
          configFile: resolved.configFile,
          effective: pickConfig(resolved),
          fields: fieldsOf(resolved),
          file: readFileConfig(resolved.root),
          errors: resolved.configErrors,
          warnings: resolved.configWarnings,
          hostOverrides: hostOverrides(resolved),
          firstRun: !fs.existsSync(resolved.configFile),
          fileWarning: fileWarning(resolved.configFile),
        })
        return
      }
      if (req.method !== 'PUT') {
        json(res, 405, { status: 'error', message: '方法不允许' })
        return
      }
      if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) {
        json(res, 415, { status: 'error', message: 'Content-Type 必须是 application/json' })
        return
      }
      let body
      try {
        body = JSON.parse(await readBody(req))
      } catch (err) {
        json(res, err.status || 400, { status: 'error', message: err.message })
        return
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        json(res, 400, { status: 'error', message: '配置必须是 JSON 对象' })
        return
      }
      // The data directory is deployment input, not a preference. Letting a
      // page move it would allow pointing the plugin at arbitrary paths.
      if (body.dir !== undefined || body.root !== undefined) {
        json(res, 400, { status: 'error', errors: ['数据目录只能在宿主配置或启动参数中指定'] })
        return
      }
      const resolved = current()
      const merged = mergeConfig(readFileConfig(resolved.root), body)
      const { errors, warnings } = validateConfig(merged)
      if (errors.length) {
        // Validate before writing: an invalid file must never reach disk.
        json(res, 400, { status: 'error', errors, warnings })
        return
      }
      writeJsonAtomic(configPath(resolved.root), fileConfigOf(merged))
      const after = current()
      json(res, 200, {
        status: 'ok',
        root: after.root,
        rootSource: after.rootSource,
        configFile: after.configFile,
        effective: pickConfig(after),
        fields: fieldsOf(after),
        errors: after.configErrors,
        warnings: after.configWarnings.concat(warnings),
        hostOverrides: hostOverrides(after),
        restartRequired: true,
      })
      return
    }

    if (route === '/api/health') {
      if (req.method !== 'GET') {
        json(res, 405, { status: 'error', message: '方法不允许' })
        return
      }
      const resolved = current()
      const store = new Store(resolved.root)
      const health = store.health({ namespace: resolved.namespace })
      json(res, 200, {
        ...health,
        concepts: listConcepts(resolved.root, { namespace: resolved.namespace }).length,
        writable: isWritable(resolved.root),
        timeZone: resolved.timeZone,
        configFile: resolved.configFile,
        configRootSource: resolved.rootSource,
        configErrors: resolved.configErrors,
        configWarnings: resolved.configWarnings,
        hostOverrides: hostOverrides(resolved),
        firstRun: !fs.existsSync(resolved.configFile),
        retentionNotice: `L1 默认保留 ${resolved.retentionDays} 天；过期记录仅在对应事件日已有 L2 日记覆盖时自动清理。`,
      })
      return
    }

    if (route === '/api/memories') {
      if (req.method !== 'GET') {
        json(res, 405, { status: 'error', message: '方法不允许' })
        return
      }
      const resolved = current()
      try {
        const fromKey = parseDate(url.searchParams.get('date_from'), 'date_from')
        const toKey = parseDate(url.searchParams.get('date_to'), 'date_to')
        // Dates are local days in the configured zone; `dayRange` returns null for a non-existent date.
        const fromMs = fromKey ? dayRange(fromKey, resolved.timeZone)?.startMs : undefined
        const toMs = toKey ? dayRange(toKey, resolved.timeZone)?.endMs : undefined
        if (fromKey && fromMs === undefined) throw Object.assign(new Error('date_from 不是真实日期'), { status: 400 })
        if (toKey && toMs === undefined) throw Object.assign(new Error('date_to 不是真实日期'), { status: 400 })
        if (fromMs !== undefined && toMs !== undefined && fromMs > toMs) {
          throw Object.assign(new Error('date_from 不能晚于 date_to'), { status: 400 })
        }
        const status = url.searchParams.get('status') || 'active'
        if (!STATUSES.has(status)) throw Object.assign(new Error('status 取值无效'), { status: 400 })
        const limit = Math.min(100, Math.max(1, Number.parseInt(url.searchParams.get('limit') || '20', 10) || 20))
        const query = (url.searchParams.get('query') || '').slice(0, 200)
        const result = searchRecords(new Store(resolved.root).readAll(), {
          query,
          fromMs,
          toMs,
          status,
          namespace: resolved.namespace,
          cursor: url.searchParams.get('cursor') || undefined,
          limit,
          nowMs: Date.now(),
          retentionDays: resolved.retentionDays,
          tz: resolved.timeZone,
        })
        json(res, 200, result)
      } catch (err) {
        json(res, err.status || 500, { status: 'error', message: err.message })
      }
      return
    }

    json(res, 404, { status: 'error', message: '未找到该接口' })
  }

  return async function dispatch(req, res) {
    try {
      await handle(req, res)
    } catch (err) {
      // Last resort: a handler bug must not crash the host process.
      if (!res.headersSent) json(res, 500, { status: 'error', message: err.message })
      else res.end()
    }
  }
}
