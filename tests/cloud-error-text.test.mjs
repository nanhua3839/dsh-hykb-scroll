import test from 'node:test'
import assert from 'node:assert/strict'

// 网关状态码 → 人话 的映射。重点：410 这个「空响应体 + 无错误码字段」的停服信号要说人话，
// 而不是把裸状态码丢给用户（原来界面显示「同步失败：云端返回 410」）。
const { explainStatus } = await import('../tools/lib/cloud.mjs')

test('410 说「资源用尽」，并保留 HTTP 码便于对照', () => {
  const s = explainStatus(410)
  assert.match(s, /资源用尽/)
  assert.match(s, /停服/)
  assert.match(s, /410/)
  assert.equal(/^云端返回/.test(s), false, '不能再是裸状态码')
})

test('其它网关错误各有对应说法', () => {
  assert.match(explainStatus(401), /登录已失效/)
  assert.match(explainStatus(403), /没有权限/)
  assert.match(explainStatus(429), /限流/)
  assert.match(explainStatus(500), /云端故障/)
  assert.match(explainStatus(502), /502/)
  assert.equal(explainStatus(418), '云端返回 418', '没见过的码保持原样，别乱猜')
  assert.equal(explainStatus(0), '云端返回 0')
})
