import test from 'node:test'
import assert from 'node:assert/strict'
import { runOnce } from '../tools/lib/followback.mjs'

const NOW = Date.parse('2026-11-14T10:00:00+08:00')
const cfgOn = { followback: { enabled: true, dailyCap: 3, onlyNonMutual: true } }
const cfgOff = { followback: { enabled: false, dailyCap: 3, onlyNonMutual: true } }

const mkState = (pending) => ({
  baselineAt: '2026-11-01T00:00:00.000Z',
  seen: Object.fromEntries(pending.map((uid, i) => [uid, { at: NOW - i * 1000, nickname: 'n' + uid, relation: 4, action: 'pending' }])),
  daily: {},
})
const fakeScan = (state) => async () => ({ ok: true, items: 0, added: 0, pending: [], state })

test('开关关着：一个都不发', async () => {
  const calls = []
  const st = mkState(['1'])
  const r = await runOnce({ cfg: cfgOff, now: NOW, scan: fakeScan(st), load: () => st, save: (s) => s, follow: async (u) => { calls.push(u); return { code: 100 } } })
  assert.equal(calls.length, 0)
  assert.match(r.skipped, /开关关着/)
})

test('dry-run 只统计不发', async () => {
  const calls = []
  const st = mkState(['1', '2'])
  const r = await runOnce({ cfg: cfgOn, now: NOW, dryRun: true, scan: fakeScan(st), load: () => st, save: (s) => s, follow: async (u) => { calls.push(u); return { code: 100 } } })
  assert.equal(calls.length, 0)
  assert.equal(r.due, 2)
  assert.equal(r.skipped, 'dry-run')
})

test('成功回关：计数、结果都记账', async () => {
  let st = mkState(['1', '2'])
  const r = await runOnce({ cfg: cfgOn, now: NOW, scan: fakeScan(st), load: () => st, save: (s) => { st = JSON.parse(JSON.stringify(s)); return st }, follow: async () => ({ code: 100 }) })
  assert.equal(r.ok, 2)
  assert.equal(r.failed, 0)
  assert.equal(st.seen['1'].action, 'followed')
  const day = st.daily[Object.keys(st.daily)[0]]
  assert.equal(day, 2)
})

test('超过日限的不会被发出去', async () => {
  const calls = []
  let st = mkState(['1', '2', '3', '4', '5'])
  const r = await runOnce({ cfg: { followback: { enabled: true, dailyCap: 2 } }, now: NOW, scan: fakeScan(st), load: () => st, save: (s) => { st = JSON.parse(JSON.stringify(s)); return st }, follow: async (u) => { calls.push(u); return { code: 100 } } })
  assert.equal(r.due, 2)
  assert.equal(calls.length, 2)
})

test('单条失败只标记 failed，不占额度，继续下一条', async () => {
  let st = mkState(['1', '2'])
  const r = await runOnce({ cfg: cfgOn, now: NOW, scan: fakeScan(st), load: () => st, save: (s) => { st = JSON.parse(JSON.stringify(s)); return st }, follow: async (u) => (u === '1' ? { code: 103, msg: '关注的用户不能为本人' } : { code: 100 }) })
  assert.equal(r.failed, 1)
  assert.equal(r.ok, 1)
  assert.equal(st.seen['1'].action, 'failed')
  assert.match(st.seen['1'].note, /103/)
})

test('撞到登录失效/风控码立刻整批停手', async () => {
  const calls = []
  let st = mkState(['1', '2', '3'])
  const r = await runOnce({ cfg: cfgOn, now: NOW, scan: fakeScan(st), load: () => st, save: (s) => { st = JSON.parse(JSON.stringify(s)); return st }, follow: async (u) => { calls.push(u); return { code: 5001, msg: '未登录' } } })
  assert.equal(calls.length, 1)
  assert.match(r.skipped, /登录态不可用/)
})
