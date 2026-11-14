
/**
 * 测试模式的两条硬要求：
 *   1. 新加的功能必须一起放宽（否则「测试模式」名不副实）
 *   2. 切回其它模式时，用户此前填的参数一个都不能变（widen 只在内存里叠一层，不写盘）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULTS } from '../tools/lib/config.mjs'
import { widen, effective, isTestMode, probeConfig } from '../tools/lib/testmode.mjs'

const deep = (v) => JSON.parse(JSON.stringify(v))

test('测试模式把新增的几块也放宽了（点赞 / 回关 / 游戏观察 / 题材 / 判官四条线）', () => {
  const cfg = deep(DEFAULTS)
  cfg.like = { browsed: false, quality: false, replies: false, perRoundMax: 1, qualityMinScore: 80, aiConfirmMax: 0, hotCommentsPerTopic: 0 }
  cfg.followback = { enabled: false, onlyNonMutual: true, dailyCap: 2, maxPages: 1 }
  cfg.games = { pick: 1, maxComments: 2, minLen: 40, items: [] }
  cfg.browse.interests = { tags: [], custom: [], weight: 30 }
  cfg.ai.judge.thresholds = { like: 90, reply: 90, publish: 90, report: 90 }

  const w = widen(cfg)
  assert.equal(w.like.browsed, true, '点赞：浏览过没放宽')
  assert.equal(w.like.quality, true, '点赞：优质内容没放宽')
  assert.equal(w.like.replies, true, '点赞：回复内容没放宽')
  assert.equal(w.like.perRoundMax, 5, '点赞：每轮上限没抬到 5')
  assert.equal(w.like.qualityMinScore, 0, '点赞：优质分数线没降到 0')

  assert.equal(w.followback.enabled, true, '回关没打开')
  assert.equal(w.followback.onlyNonMutual, false, '回关：没关掉「只回关没互关的」')
  assert.equal(w.followback.dailyCap, 20, '回关：每天上限没抬到 20')
  assert.equal(w.followback.maxPages, 3, '回关：每轮检测数没抬到 3')

  assert.equal(w.games.pick, 3, '游戏观察：每轮看几个没抬到 3')
  assert.equal(w.games.minLen, 0, '游戏观察：短评过滤没关掉')

  assert.equal(w.browse.interests.weight, 0, '题材加减分没归零（测试时会筛掉未命中题材的帖）')
  assert.deepEqual(w.ai.judge.thresholds, { like: 0, reply: 0, publish: 0, report: 0 }, '判官四条线没降到 0')
})

test('widen 只叠在内存里：入参一个字节都不改，切回其它模式参数原样', () => {
  const cfg = deep(DEFAULTS)
  cfg.listen.intervalSec = 999
  cfg.browse.intervalSec = 8888
  cfg.like.perRoundMax = 1
  cfg.ai.temperature = 1.4
  const before = deep(cfg)

  widen(cfg)
  assert.deepEqual(cfg, before, 'widen 改了入参')

  // 测试模式开 → 关：关掉之后生效的必须是用户原来填的那份
  const off = { ...deep(cfg), test: { enabled: false } }
  const eff = effective(off)
  assert.equal(isTestMode(off), false)
  assert.equal(eff.listen.intervalSec, 999, '关掉测试模式后回帖间隔被改了')
  assert.equal(eff.browse.intervalSec, 8888, '关掉测试模式后刷帖间隔被改了')
  assert.equal(eff.like.perRoundMax, 1, '关掉测试模式后点赞上限被改了')
  assert.equal(eff.ai.temperature, 1.4, '关掉测试模式后温度被改了')

  // 开着的这一轮也不该把 risk（安全阀）放宽
  const on = effective({ ...deep(cfg), test: { enabled: true } })
  assert.deepEqual(on.risk, cfg.risk, '安全阀被测试模式放宽了')
  assert.equal(on.listen.intervalSec, 30, '测试模式下回帖间隔该是 30')
})

test('一键自检用的配置同样是最宽，但每类只读一点点', () => {
  const cfg = deep(DEFAULTS)
  const p = probeConfig(cfg)
  assert.equal(p.listen.maxTopicsPerTick, 1)
  assert.equal(p.listen.maxRepliesPerTick, 1)
  assert.equal(p.browse.pick, 3)
  assert.equal(p.browse.wake, false)
  assert.equal(p.like.browsed, true, '自检也该把点赞打开')
})
