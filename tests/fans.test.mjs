import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeNotice, planScan, pendingList, dueList, markResult, remaining, todayCount, isMutual, FAN_NOT_BACK } from '../tools/lib/fans.mjs'

const cfg = { enabled: false, dailyCap: 2, onlyNonMutual: true, maxPages: 3 }
// fans_user_list2 的真实形状：uid / nickname / avatar / relation
const fan = (uid, relation = FAN_NOT_BACK, nickname = 'n' + uid) => ({ uid, nickname, avatar: 'https://imga.3839.com/' + uid, relation })
const NOW = Date.parse('2026-11-14T10:00:00+08:00')

test('normalizeNotice 取 fans_user_list2 的字段', () => {
  const n = normalizeNotice(fan(42, 4, '哈基酩'))
  assert.equal(n.uid, '42')
  assert.equal(n.nickname, '哈基酩')
  assert.equal(n.relation, 4)
  assert.equal(n.headPic, 'https://imga.3839.com/42')
})

test('relation 语义：4=粉丝未回关，1=陌生人', () => {
  assert.equal(isMutual(4), false)
  assert.equal(isMutual(1), true)
  assert.equal(isMutual(3), true)
})

test('首次扫描只登记基线，不回关历史粉丝', () => {
  const r = planScan({ items: [fan('1'), fan('2')], state: { seen: {}, daily: {} }, cfg, now: NOW })
  assert.equal(r.first, true)
  assert.equal(r.added, 2)
  assert.deepEqual(r.pending, [])
  assert.equal(r.state.seen['1'].action, 'baseline')
  assert.ok(r.state.baselineAt)
})

test('基线之后的新粉丝进 pending，且只进一次', () => {
  let st = planScan({ items: [fan('1')], state: { seen: {}, daily: {} }, cfg, now: NOW }).state
  st = planScan({ items: [fan('2'), fan('2')], state: st, cfg, now: NOW + 1000 }).state
  assert.equal(st.seen['2'].action, 'pending')
  assert.equal(pendingList(st, { cfg }).length, 1)
  assert.equal(st.seen['1'].action, 'baseline')
})

test('relation 不是 4 的不进 pending', () => {
  const st = planScan({ items: [fan('1')], state: { seen: {}, daily: {} }, cfg, now: NOW }).state
  const r = planScan({ items: [fan('3', 3)], state: st, cfg, now: NOW + 1000 })
  assert.equal(r.pending.length, 0)
  assert.equal(r.state.seen['3'].action, 'mutual')
})

test('已知 pending 后来变成已互关，自动改判 mutual', () => {
  let st = planScan({ items: [fan('1')], state: { seen: {}, daily: {} }, cfg, now: NOW }).state
  st = planScan({ items: [fan('4')], state: st, cfg, now: NOW + 1000 }).state
  assert.equal(st.seen['4'].action, 'pending')
  st = planScan({ items: [fan('4', 3)], state: st, cfg, now: NOW + 2000 }).state
  assert.equal(st.seen['4'].action, 'mutual')
  assert.equal(pendingList(st, { cfg }).length, 0)
})

test('每日额度限制本批可做数量，成功回关才计数', () => {
  let st = planScan({ items: [fan('1')], state: { seen: {}, daily: {} }, cfg, now: NOW }).state
  st = planScan({ items: [fan('a'), fan('b'), fan('c')], state: st, cfg, now: NOW + 1000 }).state
  assert.equal(pendingList(st, { cfg }).length, 3)
  assert.equal(dueList(st, { cfg, now: NOW + 1000 }).length, 2)
  st = markResult(st, 'a', 'followed', { now: NOW + 2000 })
  assert.equal(todayCount(st, NOW + 2000), 1)
  assert.equal(remaining(st, cfg, NOW + 2000), 1)
  assert.equal(dueList(st, { cfg, now: NOW + 2000 }).length, 1)
  st = markResult(st, 'b', 'failed', { now: NOW + 3000, note: 'code=103' })
  assert.equal(todayCount(st, NOW + 3000), 1, '失败不占额度')
  assert.equal(st.seen['b'].action, 'failed')
})
