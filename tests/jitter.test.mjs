import test from 'node:test'
import assert from 'node:assert/strict'
import { withJitter } from '../lib/jitter.js'

test('jitterSec=0 原样返回', () => {
  assert.equal(withJitter(20000, 0), 20000)
  assert.equal(withJitter(20000, undefined), 20000)
})

test('抖动落在 ±区间内，跑多次真的会变', () => {
  const seen = new Set()
  for (let i = 0; i < 200; i++) {
    const v = withJitter(20000, 2)
    assert.ok(v >= 18000 && v <= 22000, '超出区间：' + v)
    seen.add(v)
  }
  assert.ok(seen.size > 10, '200 次只出了 ' + seen.size + ' 个值，等于没抖')
})

test('抖得比间隔还宽时压到 5 秒下限，不会变负数', () => {
  assert.ok(withJitter(2000, 100) >= 5000)
  assert.ok(withJitter(0, 60) >= 5000)
})
