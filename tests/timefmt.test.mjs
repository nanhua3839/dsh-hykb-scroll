import test from 'node:test'
import assert from 'node:assert/strict'
import { parseKbTime, kbTimeText, ago, timeLine } from '../tools/lib/timefmt.mjs'

test('parseKbTime 认平台那种字符串，占位符当没有', () => {
  const ms = parseKbTime('2026-11-13 19:44:04')
  assert.equal(new Date(ms).getFullYear(), 2026)
  assert.equal(new Date(ms).getHours(), 19)
  assert.equal(parseKbTime('0000-00-00 00:00:00'), 0)
  assert.equal(parseKbTime(''), 0)
  assert.equal(parseKbTime(null), 0)
  assert.equal(parseKbTime('昨天'), 0)
})

test('kbTimeText 把占位符变空串', () => {
  assert.equal(kbTimeText('2026-11-13 19:44:04'), '2026-11-13 19:44:04')
  assert.equal(kbTimeText('0000-00-00 00:00:00'), '')
})

test('ago 分档', () => {
  const now = Date.parse('2026-11-13T12:00:00')
  assert.equal(ago(0, now), '')
  assert.equal(ago(now - 30 * 1000, now), '刚刚')
  assert.equal(ago(now - 12 * 60000, now), '12 分钟前')
  assert.equal(ago(now - 3 * 3600000, now), '3 小时前')
  assert.equal(ago(now - 5 * 86400000, now), '5 天前')
})

test('timeLine 没有时间就说没有', () => {
  const now = Date.parse('2026-11-13T12:00:00')
  assert.equal(timeLine('发布', 0, now), '发布：—')
  assert.match(timeLine('发布', now - 3600000, now), /^发布：1 小时前（2026-11-13 11:00）$/)
})
