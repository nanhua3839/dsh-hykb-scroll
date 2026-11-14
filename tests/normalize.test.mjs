import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeListen, normalizeGames } from '../lib/index.js'

test('normalizeListen 卡抖动范围、三个 skip 开关默认开', () => {
  const l = {}
  normalizeListen(l)
  assert.equal(l.jitterSec, 3)
  assert.equal(l.skip.essence, true)
  assert.equal(l.skip.official, true)
  assert.equal(l.skip.contribution, true)
  assert.deepEqual(l.skip.officialAllow, [])
  assert.deepEqual(l.skip.officialDeny, [])

  const l2 = { jitterSec: 9999, skip: { essence: false, official: false, contribution: false, officialAllow: '123 456' } }
  normalizeListen(l2)
  assert.equal(l2.jitterSec, 300)              // 上限
  assert.equal(l2.skip.essence, false)          // 显式关掉要保住
  assert.deepEqual(l2.skip.officialAllow, ['123', '456'])
  assert.equal(l2.skip.officialDeny.length, 0)
})

test('normalizeListen 对负数抖动压到 0', () => {
  const l = { jitterSec: -5 }
  normalizeListen(l)
  assert.equal(l.jitterSec, 0)
})

test('normalizeGames 只认四个榜单、脏 id 丢掉、去重、截断', () => {
  const g = { enabled: 'yes', source: 'nope', pick: 99, maxComments: 0, minLen: 0, items: ['151743', { id: '89222', title: '光遇' }, 'abc', '151743'] }
  normalizeGames(g)
  assert.equal(g.enabled, false)                // 只认真正的 true
  assert.equal(g.source, 'hot')
  assert.equal(g.pick, 10)
  assert.equal(g.maxComments, 1)
  assert.equal(g.minLen, 1)
  assert.deepEqual(g.items.map((x) => x.id), ['151743', '89222'])
  assert.equal(g.items[1].title, '光遇')
})

test('normalizeGames 对空配置给全套默认值', () => {
  const g = {}
  normalizeGames(g)
  assert.equal(g.enabled, false)
  assert.equal(g.pick, 3)
  assert.equal(g.maxComments, 20)
  assert.deepEqual(g.items, [])
})
