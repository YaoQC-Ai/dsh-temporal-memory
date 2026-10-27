/**
 * 回归：/memory-ui 路由必须走 cordis 可选注入。
 *
 * 旧写法是 apply 阶段直接 ctx.get('webServer')——webServer 是 Service，
 * 要等 [Service.init] 异步 listen 完成才 available，apply 时必然 undefined，
 * 结果路由静默不注册，设置页拿到 404 空 body。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { apply } from '../index.js'

function tmpHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tmem-route-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function logger() {
  const log = (...args) => log.debug('unused: %s', args)
  log.info = () => {}
  log.warn = () => {}
  log.debug = () => {}
  log.error = () => {}
  return log
}

/** 假宿主 ctx：记录 inject / get / on / plugin 的调用形态。 */
function fakeCtx() {
  const state = {
    injects: [],
    injectCallback: null,
    getCalls: [],
    handlers: [],
    plugins: [],
  }
  const ctx = {
    logger: () => logger(),
    get(name) {
      state.getCalls.push(name)
      return undefined
    },
    on(event, handler) {
      state.handlers.push({ event, handler })
    },
    plugin(module, options) {
      state.plugins.push({ module, options })
    },
    inject(deps, callback) {
      state.injects.push(deps)
      state.injectCallback = callback
      return () => {}
    },
  }
  return { ctx, state }
}

/** 假 webCtx：只提供注入回调会用到的 effect 与 webServer.register。 */
function fakeWebCtx() {
  const routes = []
  return {
    routes,
    webCtx: {
      effect(fn) {
        fn()
        return () => {}
      },
      webServer: {
        register(route) {
          routes.push(route)
        },
      },
    },
  }
}

function mockRes() {
  const out = { status: 0, headers: {}, body: '' }
  let sent = false
  out.writeHead = (status, headers = {}) => {
    out.status = status
    out.headers = headers
    sent = true
  }
  out.end = (chunk) => {
    if (chunk) out.body += String(chunk)
  }
  Object.defineProperty(out, 'headersSent', { get: () => sent })
  return out
}

async function request(handler, url, method = 'GET') {
  const res = mockRes()
  await handler({ url, method, headers: {} }, res)
  return res
}

test('apply 不直接读 webServer，改由 ctx.inject 等 Service 就绪', (t) => {
  const home = tmpHome(t)
  const { ctx, state } = fakeCtx()
  apply(ctx, { dir: home })

  // 旧写法的特征：apply 阶段 ctx.get('webServer')。它拿到的永远是 undefined。
  // （get('sessionQuery') 是 L0 适配层的正常探测，不受此约束。）
  assert.equal(state.getCalls.includes('webServer'), false)
  assert.deepEqual(state.injects, [['webServer']])
  assert.equal(typeof state.injectCallback, 'function')

  // 服务未就绪时不应注册任何路由（也不应该抛错）。
  assert.equal(state.handlers.length >= 1, true)
})

test('注入回调就绪后按 prefix 注册 /memory-ui', (t) => {
  const home = tmpHome(t)
  const { ctx, state } = fakeCtx()
  apply(ctx, { dir: home })
  assert.equal(state.injects.length, 1)

  const { webCtx, routes } = fakeWebCtx()
  state.injectCallback(webCtx)

  assert.equal(routes.length, 1)
  assert.equal(routes[0].kind, 'prefix')
  assert.equal(routes[0].path, '/memory-ui')
  assert.equal(typeof routes[0].handler, 'function')
})

test('handler 剥掉 /memory-ui 前缀后交给配置台处理器', async (t) => {
  const home = tmpHome(t)
  const { ctx, state } = fakeCtx()
  apply(ctx, { dir: home })

  const { webCtx, routes } = fakeWebCtx()
  state.injectCallback(webCtx)
  const handler = routes[0].handler

  const config = await request(handler, '/memory-ui/api/config')
  assert.equal(config.status, 200)
  const body = JSON.parse(config.body)
  assert.equal(body.status, 'ok')
  assert.equal(body.root, path.join(home, 'memory', 'temporal'))

  // 子路由同样要剥前缀，不能因为带 query 就落到兜底。
  const configWithQuery = await request(handler, '/memory-ui/api/config?x=1')
  assert.equal(configWithQuery.status, 200)

  // servePage 为 false：前端页面由插件包提供，宿主路由只做 API。
  const bare = await request(handler, '/memory-ui')
  assert.equal(bare.status, 404)

  const unknown = await request(handler, '/memory-ui/api/nope')
  assert.equal(unknown.status, 404)
  assert.equal(JSON.parse(unknown.body).message, '未找到该接口')
})
