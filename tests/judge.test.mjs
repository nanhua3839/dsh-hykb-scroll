// 判官模块的单元测试：只打纯函数，不碰网络、不碰磁盘配置。
// 重点是三条契约：引文不成立就归零、风险一票否决、判官没开关就不放行。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildEvidence, sourceText, judgePrompt, parseVerdict, verifyQuotes, gate, judge, ACTIONS } from '../tools/lib/judge.mjs'

const item = {
  title: '新版本 3.2 实测：帧数掉到 41',
  body: '今天更新完进图，帧数从 58 掉到 41。清缓存没用，回退旧版本就正常。',
  forum: '原神', author: '老王', replies: 12, likes: 3, createdAt: 1000000,
  floors: ['我这边也是 41 帧', '安卓端没这问题'],
}

const cfgOn = { ai: { judge: { enabled: true, thresholds: { like: 75, reply: 80, publish: 85, report: 65 } } } }
const cfgOff = { ai: { judge: { enabled: false, thresholds: { like: 75, reply: 80, publish: 85, report: 65 } } } }

test('buildEvidence：数字由代码算，不交给模型', () => {
  const ev = buildEvidence({ item, now: 1000000 + 37 * 60000 })
  assert.equal(ev.ageMin, 37)
  assert.equal(ev.heat.replies, 12)
  assert.equal(ev.heat.likes, 3)
  assert.equal(ev.floors.length, 2)
  assert.ok(ev.body.includes('41'))
})

test('judgePrompt：四个动作都在判据里，且要求引文', () => {
  const text = judgePrompt(buildEvidence({ item })).map((m) => m.content).join('\n')
  for (const k of ACTIONS) assert.ok(text.includes(k), '缺动作 ' + k)
  assert.ok(text.includes('quote'))
  assert.ok(text.includes('反例'))
})

test('parseVerdict：允许代码围栏，坏 JSON 返回 null', () => {
  const ok = parseVerdict("```" + 'json\n' + JSON.stringify({ like: { score: 90, why: '有数值', quote: '帧数从 58 掉到 41' }, report: { score: 70, why: '', quote: '回退旧版本就正常' } }) + '\n' + "```")
  assert.equal(ok.scores.like, 90)
  assert.equal(ok.scores.report, 70)
  assert.equal(parseVerdict('模型说这条不错'), null)
  assert.equal(parseVerdict(''), null)
})

test('verifyQuotes：引文查不到的那一项直接归零', () => {
  const ev = buildEvidence({ item })
  const v = parseVerdict(JSON.stringify({
    like: { score: 95, why: '有数值', quote: '帧数从 58 掉到 41' },
    reply: { score: 90, why: '能接', quote: '这句话原文里根本没有' },
    report: { score: 80, why: '值得', quote: '清缓存没用' },
  }))
  verifyQuotes(v, sourceText(ev))
  assert.equal(v.scores.like, 95)
  assert.equal(v.scores.reply, 0)
  assert.ok(v.noQuote.includes('reply'))
  assert.ok(v.whys.reply.includes('引文不成立'))
})

test('verifyQuotes：忽略空白差异，太短的引文不认', () => {
  const ev = buildEvidence({ item })
  const v = parseVerdict(JSON.stringify({ like: { score: 88, quote: '帧数 从 58 掉到 41' }, report: { score: 88, quote: '帧数' } }))
  verifyQuotes(v, sourceText(ev))
  assert.equal(v.scores.like, 88)
  assert.equal(v.scores.report, 0)
})

test('gate：没开开关一律不放行', () => {
  const v = { scores: { like: 100 }, quotes: {}, whys: {}, risk: {} }
  assert.equal(gate(v, 'like', cfgOff).ok, false)
  assert.equal(gate(null, 'like', cfgOn).ok, false)
})

test('gate：风险一票否决写动作，但报告照进', () => {
  const v = { scores: { like: 100, report: 90 }, quotes: { like: 'x', report: 'y' }, whys: {}, risk: { inject: true } }
  assert.equal(gate(v, 'like', cfgOn).ok, false)
  assert.ok(gate(v, 'like', cfgOn).why.includes('风险否决'))
  assert.equal(gate(v, 'report', cfgOn).ok, true)
})

test('gate：分数低于阈值不放行', () => {
  const v = { scores: { reply: 79 }, quotes: { reply: '帧数从 58 掉到 41' }, whys: {}, risk: {} }
  assert.equal(gate(v, 'reply', cfgOn).ok, false)
  v.scores.reply = 80
  assert.equal(gate(v, 'reply', cfgOn).ok, true)
})

test('judge：判官没开就不调模型', async () => {
  let called = 0
  const out = await judge(item, { cfg: cfgOff, chat: async () => { called++; return '{}' } })
  assert.equal(out, null)
  assert.equal(called, 0)
})

test('judge：模型乱回 → null（调用方退回原判据）', async () => {
  const out = await judge(item, { cfg: cfgOn, chat: async () => '这条不错，值得' })
  assert.equal(out, null)
})

test('judge：正常一轮 → 分数通过引文校验', async () => {
  const reply = JSON.stringify({
    gist: '新版掉帧',
    like: { score: 90, why: '有具体数值', quote: '帧数从 58 掉到 41' },
    reply: { score: 85, why: '能接一句我这边也是', quote: '我这边也是 41 帧' },
    publish: { score: 10, why: '个案不值得发', quote: '清缓存没用' },
    report: { score: 78, why: '版本回归信息', quote: '回退旧版本就正常' },
    risk: { inject: false, toxic: false, ad: false },
  })
  const out = await judge(item, { cfg: cfgOn, chat: async () => reply })
  assert.ok(out)
  assert.equal(out.scores.like, 90)
  assert.equal(gate(out, 'like', cfgOn).ok, true)
  assert.equal(gate(out, 'publish', cfgOn).ok, false)
})
