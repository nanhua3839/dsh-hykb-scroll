import test from 'node:test'
import assert from 'node:assert/strict'
import { skipRule, flagsOf, evaluate } from '../tools/lib/watch.mjs'
import { timeMs } from '../tools/lib/browse.mjs'

const cfgWith = (skip) => ({ listen: { skip, triggerMode: 'both', at: { enabled: true }, atme: { enabled: true } } })
const ALL_ON = { essence: true, official: true, contribution: true, officialAllow: [], officialDeny: [] }

test('flagsOf 认四个标记和三个时间', () => {
  const f = flagsOf({ is_essence: '1', is_top: '0', is_official: '1', is_article_contribution: '1', time: '2026-11-13 19:44:04', edit_time: '0000-00-00 00:00:00', reply_time: '2026-11-13 20:00:00' })
  assert.equal(f.isEssence, true)
  assert.equal(f.isTop, false)
  assert.equal(f.isOfficial, true)
  assert.equal(f.isContribution, true)
  assert.ok(f.publishMs > 0)
  assert.equal(f.editMs, 0)
  assert.ok(f.replyMs > f.publishMs)
})

test('精华 / 官方 / 投稿：开着就跳过，关了就放行', () => {
  assert.equal(skipRule(cfgWith(ALL_ON), { isEssence: true }), 'essence')
  assert.equal(skipRule(cfgWith(ALL_ON), { isOfficial: true }), 'official')
  assert.equal(skipRule(cfgWith(ALL_ON), { isContribution: true }), 'contribution')
  assert.equal(skipRule(cfgWith(ALL_ON), {}), '')
  const off = { essence: false, official: false, contribution: false }
  assert.equal(skipRule(cfgWith(off), { isEssence: true, isOfficial: true, isContribution: true }), '')
})

test('官方白名单点名放行，黑名单压过白名单', () => {
  const S = { ...ALL_ON, officialAllow: ['162319955', '快爆官方'], officialDeny: ['广告号'] }
  assert.equal(skipRule(cfgWith(S), { isOfficial: true, uid: '162319955' }), '')
  assert.equal(skipRule(cfgWith(S), { isOfficial: true, nickname: '快爆官方' }), '')
  assert.equal(skipRule(cfgWith(S), { isOfficial: true, uid: '999' }), 'official')
  // 黑白名单同时命中 → 黑名单赢
  assert.equal(skipRule(cfgWith({ ...S, officialAllow: ['号'], officialDeny: ['号'] }), { isOfficial: true, uid: '号' }), 'official-deny')
  // 白名单为空时不要凭「名单里没有」就放行
  assert.equal(skipRule(cfgWith({ ...ALL_ON, officialAllow: [] }), { isOfficial: true, uid: 'x' }), 'official')
})

test('evaluate 里创作内容走 skip，连触发词都不看', () => {
  const cfg = cfgWith(ALL_ON)
  const me = { uid: 'me', nickname: '大肥鱼' }
  const cand = { source: 'forum', kind: 'topic', topicId: '1', uid: 'u2', nickname: 'n2', content: '@大肥鱼 你看看', isEssence: true }
  assert.deepEqual(evaluate(cfg, cand, me), { action: 'skip', why: 'essence' })
  // 官方内容同一个结论
  assert.equal(evaluate(cfg, { ...cand, isEssence: false, isOfficial: true }, me).why, 'official')
  // 关掉开关后回到正常判定：正文里 @ 了她 → 走 at 放行（说明确实不再被精华那条拦）
  assert.equal(evaluate(cfgWith({ ...ALL_ON, essence: false }), cand, me).why, 'at')
})

test('timeMs 认得字符串时间（老写法 Number() 会得 NaN）', () => {
  assert.ok(timeMs({ time: '2026-11-13 19:44:04' }) > 0)
  assert.equal(timeMs({ time: '0000-00-00 00:00:00' }), 0)
  assert.equal(timeMs({ time: 1794000000 }), 1794000000000)   // 秒 → 毫秒
  assert.equal(timeMs({ time: 1794000000000 }), 1794000000000)
})
