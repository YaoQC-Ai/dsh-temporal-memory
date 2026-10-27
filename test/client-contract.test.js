import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CLIENT = path.join(ROOT, 'client.js')

test('package.json 暴露 dsh.client 与 ./client 导出', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  // 只校验版本号格式与是否跟随本快照，不写死具体版本——写死会让每次发版都误报。
  assert.match(pkg.version, /^1\.\d+\.\d+$/, `版本号应为 1.x.y，实际 ${pkg.version}`)
  assert.equal(pkg.exports['./client'], './client.js')
  assert.ok(pkg.files.includes('client.js'))
  assert.deepEqual(pkg.dsh.client, { platform: 'web', immediately: true })
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
})

test('client.js 按 lazy-CJS 契约注册 settings.section，含 16 个字段', () => {
  const source = fs.readFileSync(CLIENT, 'utf8')
  let registration = null
  const fakeWindow = {
    __ModuleLoader__: {
      load(value) { registration = value },
    },
  }
  const fakeDocument = {
    getElementById: () => null,
    createElement: () => ({ id: '', textContent: '' }),
    head: { appendChild: () => {} },
  }
  const fakeReact = {
    createElement: () => null,
    useState: (value) => [value, () => {}],
    useCallback: (fn) => fn,
    useEffect: () => {},
  }

  new Function('window', 'document', 'fetch', source)(fakeWindow, fakeDocument, () => {})
  assert.ok(registration)
  assert.equal(registration.id, 'dsh-temporal-memory')

  const module = registration.factory((name) => {
    assert.equal(name, 'react')
    return fakeReact
  })
  assert.deepEqual(module.inject, ['slots'])

  const registered = []
  module.apply({
    slots: {
      inject(slot, callback) {
        assert.equal(slot, 'settings.section')
        callback()
      },
      register(options, component) {
        registered.push({ options, component })
      },
    },
  })
  assert.equal(registered.length, 1)
  assert.deepEqual(registered[0].options, {
    name: 'settings.section',
    id: 'memory',
    order: 25,
    label: '记忆',
  })
  assert.equal(typeof registered[0].component, 'function')

  assert.equal((source.match(/\{ key: '/g) || []).length, 16)
  assert.match(source, /fetch\('\/memory-ui' \+ path/)
  assert.match(source, /method: 'PUT'/)
  assert.match(source, /部署固定/)
  assert.match(source, /在这里改不会生效/)
  assert.match(source, /记忆默认保留 365 天/)
  // ui.host / ui.port 已被本页取代，不应回到 FIELDS；growth.enabled 则因 L4 落地而放回。
  assert.doesNotMatch(source, /\{ key: 'ui\.host'/)
  assert.doesNotMatch(source, /\{ key: 'ui\.port'/)
  // 日记没有配置项：写日记归宿主的定时任务。
  assert.doesNotMatch(source, /\{ key: 'journal\./)
  assert.match(source, /\{ key: 'growth\.enabled'/)
})
