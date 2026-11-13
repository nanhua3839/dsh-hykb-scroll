// 自动点赞：planLikes 的挑选规则、liked() 归一化、两个写接口的请求体、模型判定口径。
// 全部离线：fetch 换成替身，对平台 0 次真写。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hykb-like-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSH_HOME = path.join(home, '.dsh')
process.env.HYKB_SCROLL_CONFIG = path.join(home, '.dsh', 'hykb-scroll.config.json')
fs.mkdirSync(path.join(home, '.dsh'), { recursive: true })
fs.mkdirSync(path.join(home, '.hykb-ai'), { recursive: true })
fs.writeFileSync(path.join(home, '.hykb-ai', 'credentials.json'),
  JSON.stringify({ uid: '1001', Pauth: 'PAUTH', Uauth: 'UAUTH', nickname: '小鲸鱼' }))
// 写冷却 / 最小间隔清零、额度放大，否则同一进程里连点几次会被 traffic.mjs 挡下来
fs.writeFileSync(process.env.HYKB_SCROLL_CONFIG, JSON.stringify({
  risk: { minGapMs: 0, writeGapSec: 0, writeHourly: 1000, writeDaily: 1000, readHourly: 1000, readDaily: 1000 },
}))

const calls = []
const realFetch = globalThis.fetch
globalThis.fetch = async (url, init = {}) => {
  calls.push({ url: String(url), method: init.method, headers: init.headers || {}, body: String(init.body ?? '') })
  return { status: 200, ok: true, text: async () => JSON.stringify({ code: 100, msg: 'ok' }) }
}
after(() => { globalThis.fetch = realFetch })

const { likeTopic, likeReply, liked, planLikes, judgePrompt, parseJudge } = await import('../tools/lib/like.mjs')

const cfgOf = (like = {}) => ({
  like: {
    browsed: false, quality: false, replies: false, perRoundMax: 5,
    qualityJudge: 'score', qualityMinScore: 40, aiConfirmMax: 3, hotCommentsPerTopic: 2,
    ...like,
  },
})
const tp = (id, tag, extra = {}) => ({ kind: 'topic', id, score: 0, tag, ...extra })
const rp = (id, tag, extra = {}) => ({ kind: 'reply', id, topicId: '900', fid: '23064', replyId: id, tag, ...extra })
const tagsOf = (list) => list.map((x) => x.tag)

test('三个开关全关：一条都不赞', () => {
  const items = [tp('1', 'browsed'), tp('2', 'quality', { score: 90 }), tp('3', 'hotcomment', { score: 90 }), rp('4', 'reply')]
  assert.deepEqual(planLikes({ cfg: cfgOf(), items }), [])
})

test('只开 browsed：只收浏览过的，quality/hotcomment/reply 一律不进', () => {
  const items = [tp('1', 'browsed'), tp('2', 'quality', { score: 99 }), tp('3', 'hotcomment', { score: 99 }), rp('4', 'reply')]
  const out = planLikes({ cfg: cfgOf({ browsed: true }), items })
  assert.deepEqual(out.map((x) => x.id), ['1'])
  assert.equal(out[0].reason, '本轮读过')
})

test('只开 quality：帖子和热评都进，其它不进', () => {
  const items = [tp('1', 'browsed'), tp('2', 'quality', { score: 55 }), tp('3', 'hotcomment', { score: 55 }), rp('4', 'reply')]
  const out = planLikes({ cfg: cfgOf({ quality: true }), items })
  assert.deepEqual(out.map((x) => x.id).sort(), ['2', '3'])
})

test('只开 replies：只收别人的回复', () => {
  const items = [tp('1', 'browsed'), tp('2', 'quality', { score: 99 }), rp('3', 'reply'), rp('4', 'reply')]
  const out = planLikes({ cfg: cfgOf({ replies: true }), items })
  assert.deepEqual(out.map((x) => x.id), ['3', '4'])
  assert.equal(out[0].kind, 'reply')
})

test('perRoundMax 是硬上限，三类合计不超', () => {
  const items = [tp('1', 'browsed'), tp('2', 'browsed'), tp('3', 'browsed'), tp('4', 'browsed')]
  const out = planLikes({ cfg: cfgOf({ browsed: true, perRoundMax: 2 }), items })
  assert.equal(out.length, 2)
  assert.deepEqual(planLikes({ cfg: cfgOf({ browsed: true, perRoundMax: 0 }), items }), [])
})

test('三类同时开：按 browsed → quality → reply 轮流取，不让一类吃满', () => {
  const items = [tp('1', 'browsed'), tp('2', 'browsed'), tp('3', 'browsed'), tp('4', 'quality', { score: 60 }), rp('5', 'reply')]
  const out = planLikes({ cfg: cfgOf({ browsed: true, quality: true, replies: true }), items })
  assert.deepEqual(tagsOf(out), ['browsed', 'quality', 'reply', 'browsed', 'browsed'])
  assert.deepEqual(out.map((x) => x.id), ['1', '4', '5', '2', '3'])
})

test('已赞的跳过：true / 1 / "1" 都算已赞，-1 算没赞', () => {
  const items = [
    tp('1', 'browsed', { alreadyLiked: true }),
    tp('2', 'browsed', { alreadyLiked: 1 }),
    tp('3', 'browsed', { alreadyLiked: '1' }),
    tp('4', 'browsed', { alreadyLiked: -1 }),
    tp('5', 'browsed', { alreadyLiked: -2 }),
    tp('6', 'browsed'),
  ]
  assert.deepEqual(planLikes({ cfg: cfgOf({ browsed: true }), items }).map((x) => x.id), ['4', '5', '6'])
})

test('自己的帖子 / 自己的回复跳过；明确 read===false 也跳过', () => {
  const items = [tp('1', 'browsed', { isOwn: true }), rp('2', 'reply', { isOwn: true }), tp('3', 'browsed', { read: false }), tp('4', 'browsed', { read: true })]
  assert.deepEqual(planLikes({ cfg: cfgOf({ browsed: true, replies: true }), items }).map((x) => x.id), ['4'])
})

test('qualityJudge=score 时 quality 类要过分数线；ai 时分数线不看，改标记待判定', () => {
  const items = [tp('1', 'quality', { score: 39 }), tp('2', 'quality', { score: 40 }), tp('3', 'quality', { score: 45 })]
  const byScore = planLikes({ cfg: cfgOf({ quality: true, qualityMinScore: 40 }), items })
  assert.deepEqual(byScore.map((x) => x.id), ['3', '2'])
  assert.equal(byScore[0].reason, '打分 45 ≥ 分数线 40')

  const byAi = planLikes({ cfg: cfgOf({ quality: true, qualityJudge: 'ai' }), items })
  assert.deepEqual(byAi.map((x) => x.id), ['3', '2', '1'])
  assert.ok(byAi.every((x) => x.needsJudge === true))
})

test('同一 kind+id 只出现一次，但同 id 不同 kind 是两件事', () => {
  const items = [tp('1', 'browsed'), tp('1', 'browsed', { score: 9 }), rp('1', 'reply'), rp('1', 'reply')]
  const out = planLikes({ cfg: cfgOf({ browsed: true, replies: true }), items })
  assert.deepEqual(out.map((x) => x.kind + ':' + x.id), ['topic:1', 'reply:1'])
})

test('liked() 归一化：1 / "1" 为真，-1 / -2 / 0 / undefined 为假', () => {
  assert.equal(liked(1), true)
  assert.equal(liked('1'), true)
  assert.equal(liked(-1), false)
  assert.equal(liked(-2), false)
  assert.equal(liked(0), false)
  assert.equal(liked(undefined), false)
  assert.equal(liked(null), false)
  assert.equal(liked(''), false)
})

test('likeTopic 赞：POST threadOperate，body 是 type=10&state=1&tid=', async () => {
  calls.length = 0
  const res = await likeTopic({ tid: 123456 })
  assert.equal(res.code, 100)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].method, 'POST')
  assert.equal(calls[0].url, 'https://bbs.3839.com/index.php?m=api&c=thread&a=threadOperate')
  assert.equal(calls[0].body, 'type=10&state=1&tid=123456')
  assert.match(calls[0].headers.cookie, /Pauth=PAUTH/)
})

test('likeTopic 取消赞：同一 URL，state=2', async () => {
  calls.length = 0
  await likeTopic({ tid: '123456', like: false })
  assert.equal(calls[0].body, 'type=10&state=2&tid=123456')
  assert.equal(calls[0].url, 'https://bbs.3839.com/index.php?m=api&c=thread&a=threadOperate')
})

test('likeReply：POST replyOperate，body 是 fid&tid&replyId&type=1&state', async () => {
  calls.length = 0
  await likeReply({ fid: '23064', tid: '900', replyId: '4567' })
  assert.equal(calls[0].url, 'https://bbs.3839.com/index.php?m=api&c=thread&a=replyOperate')
  assert.equal(calls[0].body, 'fid=23064&tid=900&replyId=4567&type=1&state=1')

  await likeReply({ fid: 23064, tid: 900, replyId: 4567, like: false })
  assert.equal(calls[1].body, 'fid=23064&tid=900&replyId=4567&type=1&state=2')
})

test('parseJudge：是 / 值得 / y / yes / 1 开头为正，含糊与否为否', () => {
  for (const s of ['是', '是。', '值得', '值得点赞', 'y', 'Y', 'yes', 'YES!', '1', ' **是** ']) {
    assert.equal(parseJudge(s), true, '应为正：' + JSON.stringify(s))
  }
  for (const s of ['否', '不', '不值得', 'no', '0', '-1', '不清楚', '说不准', '', '   ', null, undefined]) {
    assert.equal(parseJudge(s), false, '应为否：' + JSON.stringify(s))
  }
})

test('judgePrompt 把正文带上并约束成只回是/否', () => {
  const q = judgePrompt({ kind: 'topic', title: '这游戏真香', text: '细节很多' })
  assert.match(q, /帖子/)
  assert.match(q, /只回一个字：是 或 否/)
  assert.match(q, /这游戏真香/)
  assert.match(judgePrompt({ kind: 'reply', text: 'x' }), /回复/)
  assert.match(judgePrompt({ kind: 'topic' }), /（无正文）/)
})
