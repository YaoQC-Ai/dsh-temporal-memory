import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { DEFAULTS, resolveConfig, validateConfig } from '../lib/config.js'
import { apply } from '../tools.js'

function tmpHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tmem-cfg-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function writeConfig(home, value) {
  const root = path.join(home, 'memory', 'temporal')
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(value))
}

test('默认配置通过校验', () => {
  const { config, errors } = validateConfig({})
  assert.deepEqual(errors, [])
  assert.equal(config.timeZone, DEFAULTS.timeZone)
  assert.equal(config.retentionDays, 365)
  assert.equal(config.inject.maxTokens, 1200)
  assert.equal(config.capture.maxRecordsPerTurn, 8)
  // 没有日记配置项；旧 config.json 里的 journal 块不应报“未知配置项”。
  assert.equal(config.journal, undefined)
  assert.equal(config.privacy.enhanced, false)
  assert.equal(config.growth.enabled, false)
})

test('非法类型、范围、时区与相对路径都报错并回退默认值', () => {
  const { config, errors } = validateConfig({
    timeZone: 'Asia/Shangai',
    retentionDays: 'abc',
    namespace: 42,
    dir: 'relative-data',
    capture: { maxRecordsPerTurn: 0 },
    inject: { maxItems: -1, maxChars: 'abc', maxTokens: 1 },
    privacy: { enhanced: 'yes' },
    growth: { enabled: 1 },
  })
  assert.equal(config.timeZone, DEFAULTS.timeZone)
  assert.equal(config.retentionDays, 365)
  assert.equal(config.namespace, 'default')
  assert.equal(config.capture.maxRecordsPerTurn, 8)
  assert.equal(config.inject.maxItems, 6)
  assert.equal(config.inject.maxTokens, 1200)
  assert.equal(config.inject.maxChars, undefined)
  assert.equal(config.privacy.enhanced, false)
  assert.equal(config.growth.enabled, false)
  assert.equal(errors.length, 10)
})

test('旧的 journal 配置块被忽略，不报未知配置项', () => {
  const { config, errors, warnings } = validateConfig({ journal: { enabled: false, autoCatchUp: false, catchUpDays: 5, overview: true } })
  assert.deepEqual(errors, [])
  assert.deepEqual(warnings, [])
  assert.equal(config.journal, undefined)
})

test('隐私与成长开关接受布尔值', () => {
  const { config, errors } = validateConfig({ privacy: { enhanced: true }, growth: { enabled: true } })
  assert.deepEqual(errors, [])
  assert.equal(config.privacy.enhanced, true)
  assert.equal(config.growth.enabled, true)
})

test('config.json 与宿主配置合并，宿主优先', (t) => {
  const home = tmpHome(t)
  writeConfig(home, { timeZone: 'UTC', namespace: 'from-file', inject: { maxItems: 9 }, privacy: { enhanced: true }, growth: { enabled: true } })
  const file = resolveConfig({ dir: home })
  assert.equal(file.namespace, 'from-file')
  assert.equal(file.inject.maxItems, 9)
  assert.equal(file.timeZone, 'UTC')
  assert.equal(file.privacy.enhanced, true)
  assert.equal(file.growth.enabled, true)
  const host = resolveConfig({ dir: home, namespace: 'from-host', inject: { maxItems: 4 }, privacy: { enhanced: false } })
  assert.equal(host.namespace, 'from-host')
  assert.equal(host.inject.maxItems, 4)
  assert.equal(host.privacy.enhanced, false)
  assert.equal(host.growth.enabled, true)
})

test('tools 与宿主读取同一份 config.json', async (t) => {
  const home = tmpHome(t)
  writeConfig(home, { namespace: 'gui-ns', timeZone: 'UTC' })
  const map = new Map()
  const ctx = {
    tools: { register: (def) => map.set(def.name, def) },
    logger: () => ({ info() {}, warn() {} }),
  }
  apply(ctx, { dir: home })
  const health = await map.get('memory_health').execute()
  assert.equal(health.namespace, 'gui-ns')
  assert.equal(health.timeZone, 'UTC')
})
