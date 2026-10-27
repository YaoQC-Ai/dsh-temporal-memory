import test from 'node:test'
import assert from 'node:assert/strict'
import { createL0Reader } from '../lib/l0.js'

const engine = { readSession: async () => ({ events: [] }) }

// 回归：真实宿主（DSH rc.3 web profile）中插件未声明 inject，直接读 ctx.sessionQuery
// 会被 cordis 抛 `cannot get property "sessionQuery" without inject`，导致两个插件条目
// 全部 did not activate。必须降级为「L0 不可用」，不能崩掉整个插件。
test('ctx.sessionQuery 抛 inject 保护错时，L0 降级为不可用', () => {
  const ctx = {
    get: () => undefined,
    get sessionQuery() {
      throw new Error('cannot get property "sessionQuery" without inject')
    },
  }
  const reader = createL0Reader(ctx)
  assert.equal(reader.available, false)
  assert.equal(reader.engine, null)
})

test('ctx.get 能拿到服务时优先走它', () => {
  const reader = createL0Reader({ get: (k) => (k === 'sessionQuery' ? engine : undefined) })
  assert.equal(reader.available, true)
  assert.equal(reader.engine, engine)
})

test('服务在 reader 创建后才就绪时，available 会重新解析', () => {
  let ready = false
  const reader = createL0Reader({ get: () => (ready ? engine : undefined) })
  assert.equal(reader.available, false)
  ready = true
  assert.equal(reader.available, true)
})

test('read() 在 L0 不可用时给出明确错误而非 TypeError', async () => {
  const reader = createL0Reader({ get: () => undefined })
  await assert.rejects(() => reader.read('any'), /L0 resolver（sessionQuery）不可用/)
})
