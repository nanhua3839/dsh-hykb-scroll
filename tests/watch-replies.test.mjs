// 「回复我的」+ 假@兜底 两类源的离线测试：开关、时限、落点、游标、去重键。
// fetch 全换桩，对平台 0 次真请求；seen / 台账落在临时 HOME 里，不碰真实数据。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hykb-replies-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSH_HOME = path.join(home, '.dsh')
process.env.HYKB_SCROLL_CONFIG = path.join(home, '.dsh', 'hykb-scroll.config.json')
fs.mkdirSync(path.join(home, '.dsh'), { recursive: true })
fs.mkdirSync(path.join(home, '.hykb-ai'), { recursive: true })
// 读最小间隔 / 抖动清零，否则每个请求都要等 1.5s，一个测试文件跑不完
// 通知列表要登录态（cookieHeader 读它），缺文件时 atList 会直接抛
fs.writeFileSync(path.join(home, '.hykb-ai', 'credentials.json'),
  JSON.stringify({ uid: '41227777', Pauth: 'PAUTH', Uauth: 'UAUTH', nickname: 'nanhua' }))
fs.writeFileSync(process.env.HYKB_SCROLL_CONFIG, JSON.stringify({
  risk: { minGapMs: 0, gapJitterMs: 0, readHourly: 1000, readDaily: 1000, writeHourly: 1000, writeDaily: 1000 },
}))

const ME = { uid: '41227777', nickname: 'nanhua' }

/* ── 平台替身：api_user.php 的 mode=1 通知列表 + 帖子详情 ── */
let notices = []
const topics = {}
const calls = []
const realFetch = globalThis.fetch
globalThis.fetch = async (url, init = {}) => {
  const u = String(url)
  const body = String(init.body ?? '')
  calls.push({ url: u, body })
  if (u.includes('api_user.php')) {
    const mode = new URLSearchParams(body).get('mode')
    const data = mode === '1' ? notices : []
    return new Response(JSON.stringify({ code: 100, result: { data, last_id: '-1', cursor: '-1' } }), { status: 200 })
  }
  if (u.includes('m=topic&ac=detail')) {
    const tid = new URL(u).searchParams.get('topic_id')
    const t = topics[tid]
    if (!t) return new Response(JSON.stringify({ code: 404, msg: 'gone' }), { status: 200 })
    return new Response(JSON.stringify({ code: 100, result: { topic: t.topic, reply: t.replies } }), { status: 200 })
  }
  return new Response(JSON.stringify({ code: 100, result: {} }), { status: 200 })
}
after(() => { globalThis.fetch = realFetch; fs.rmSync(home, { recursive: true, force: true }) })

const W = await import('../tools/lib/watch.mjs')
const { collect, evaluate, keyOf, forgetTopics, replyAgeMin, replyTargetOf, replyTypeOn, mineTopics, sidOf, tick } = W

/* ── 通知夹具：字段照真实返回抄（from_info 是富文本，to_info 是我那条） ── */
const notice = (over = {}) => ({
  from_uid: '147325082', from_nickname: '有蛋焉', type: '102', time: '3小时前',
  tid: '9290031', rid: '27121526', to_rid: '14890624', cid: '0', del_status: 0,
  to_info: '识别到违规内容，无法生成回复。',
  from_info: '666这也是AI生成的喵<kb-emoji data-value="狗头"/>', msg_type: '回复你的回帖', id: 9001,
  ...over,
})
const N102 = notice()
const N101 = notice({ type: '101', id: 9002, rid: '27119609', to_rid: '0', msg_type: '回复你的帖子', from_info: '@nanhua 总结一下', from_nickname: '哈基酩', from_uid: '179616435' })
const N103 = notice({ type: '103', id: 9003, tid: '9288290', rid: '27119050', to_rid: '14890310', reply_id: '27119050', msg_type: '回复你的回复', from_info: '没事，你们都是论坛的大肥鱼', from_nickname: '还是不吃香菜', from_uid: '99096916' })
const N102_OLD = notice({ id: 9004, time: '13小时前' })          // 780 分钟 > 720
const N102_DEL = notice({ id: 9005, del_status: 1, from_info: '该内容已删除' })
const N101_OLD = notice({ type: '101', id: 9006, time: '11-01', rid: '27094981', to_rid: '0', from_info: '@nanhuhu 总结一下' })

const F = () => ({ allowUsers: [], denyUsers: [], allowForums: [], denyForums: [], allowTopics: [], denyTopics: [] })
const cfgOf = (over = {}) => ({
  listen: {
    allDay: true, oncePerPerson: true, triggerMode: 'both', maxTopicsPerTick: 6, maxRepliesPerTick: 3,
    forum: { enabled: false, items: [], ...F() },
    topic: { enabled: false, items: [], floors: true, comments: true, ...F() },
    atme: { enabled: false, ...F() },
    replies: { enabled: true, onFloor: true, onComment: true, onPost: false, maxAgeMin: 720, ...F() },
    scanMine: { enabled: false, maxTopicsPerTick: 2 },
    at: { enabled: true, items: [], forums: [], ...F() },
    ...over,
  },
  owner: { uid: '11111', name: '大号' },
  self: { uid: ME.uid, name: ME.nickname },
  persona: {}, ai: {},
})
const sources = (cands) => cands.reduce((m, c) => ((m[c.source] = (m[c.source] || 0) + 1), m), {})
const detailTids = (from) => calls.slice(from).filter((c) => c.url.includes('ac=detail')).map((c) => new URL(c.url).searchParams.get('topic_id'))

/**
 * 103 要用的帖，形状照真数据：topic.sid 是空的，板块号只在 reply[].sid 上；
 * 那条对方评论在楼层底下（可按需改成「对不上」或去掉 sid）。
 */
const seedNoticeTopic = ({ commentContent = '没事，你们都是论坛的大肥鱼', sid = '23064' } = {}) => {
  for (const t of Object.keys(topics)) delete topics[t]
  topics['9288290'] = {
    topic: { id: '9288290', title: '快爆论坛日报 2026-11-13', section: { title: '生活区' } },
    replies: [{
      id: '27119050', sid, uid: '179616435', user: { nickname: '哈基酩' }, position: 4, content: '别的楼层',
      comment: { info: [{ id: '14890310', uid: '99096916', user: { nickname: '还是不吃香菜' }, content: commentContent + '<kb-emoji data-value="悲伤"/>' }] },
    }],
  }
}

/* ── ① 三类开关 ── */

test('回复我的：默认只接 102/103，101 被开关挡下', async () => {
  notices = [N102, N101, N103]
  calls.length = 0
  const cands = await collect(cfgOf())
  const byType = cands.filter((c) => c.source === 'replied').map((c) => c.noticeType).sort()
  assert.deepEqual(byType, ['102', '103'])
  // 通知自带字段直接构造候选，正文是 strip 过的富文本
  const c102 = cands.find((c) => c.noticeType === '102')
  assert.equal(c102.topicId, '9290031')
  assert.equal(c102.floorId, '27121526')
  assert.equal(c102.myReplyId, '14890624')
  assert.equal(c102.noticeId, '9001')
  assert.equal(c102.uid, '147325082')
  assert.equal(c102.nickname, '有蛋焉')
  assert.equal(c102.content, '666这也是AI生成的喵')
  assert.equal(c102.kind, 'floor')
  // 通知列表读的是 mode=1
  assert.ok(calls.some((c) => c.url.includes('api_user.php') && c.body.includes('mode=1')))
})

test('101/102 零额外读帖；103 只为一帖多读一次（同 tick 同帖只读一次）', async () => {
  // 101/102：候选全由通知字段构造，一次帖都不读
  notices = [N102, N101]
  calls.length = 0
  await collect(cfgOf({ replies: { ...cfgOf().listen.replies, onPost: true } }))
  assert.equal(calls.filter((c) => c.url.includes('ac=detail')).length, 0)

  // 103：同 tid 两条通知 → 只读这一帖一次
  notices = [N103, { ...N103, id: 9007 }]
  calls.length = 0
  await collect(cfgOf())
  assert.deepEqual(detailTids(0), ['9288290'])
})

test('103 定位到那条评论 → 带 fid / 楼层 / commentId，落点是楼中楼', async () => {
  seedNoticeTopic()
  notices = [N103]
  calls.length = 0
  const logs = []
  const c103 = (await collect(cfgOf(), { log: (m) => logs.push(m) })).find((c) => c.noticeType === '103')
  assert.equal(c103.sectionId, '23064')
  assert.equal(c103.commentFloorId, '27119050')
  assert.equal(c103.commentId, '14890310')
  assert.ok(logs.some((m) => m.includes('103 → 楼中楼') && m.includes('commentId=14890310')))
  assert.deepEqual(replyTargetOf(c103), { mode: 'comment', tid: '9288290', fid: '23064', replyId: '27119050', commentId: '14890310', mention: false })
})

test('103 定位不到 / 缺板块号 → 退回主楼回复 + 正文 @对方', async () => {
  // 帖读得到、有 sid，但第一页里没有那条评论
  seedNoticeTopic({ commentContent: '完全对不上的另一句话' })
  notices = [N103]
  let logs = []
  let c103 = (await collect(cfgOf(), { log: (m) => logs.push(m) })).find((c) => c.noticeType === '103')
  assert.equal(c103.commentId, undefined)
  assert.ok(logs.some((m) => m.includes('103 → 主楼 @')))
  assert.deepEqual(replyTargetOf(c103), { mode: 'reply', tid: '9288290', fid: '', replyId: '27119050', commentId: '0', mention: true })

  // 帖里没有 sid
  seedNoticeTopic({ sid: '' })
  logs = []
  c103 = (await collect(cfgOf(), { log: (m) => logs.push(m) })).find((c) => c.noticeType === '103')
  assert.ok(logs.some((m) => m.includes('103 → 主楼 @')))
  assert.equal(replyTargetOf(c103).mode, 'reply')
})

test('回复我的：101 打开才接，102/103 各自能关', async () => {
  notices = [N102, N101, N103]
  const on = await collect(cfgOf({ replies: { ...cfgOf().listen.replies, onPost: true } }))
  assert.deepEqual(on.filter((c) => c.source === 'replied').map((c) => c.noticeType).sort(), ['101', '102', '103'])

  const noFloor = await collect(cfgOf({ replies: { ...cfgOf().listen.replies, onPost: true, onFloor: false } }))
  assert.deepEqual(noFloor.filter((c) => c.source === 'replied').map((c) => c.noticeType).sort(), ['101', '103'])

  const noComment = await collect(cfgOf({ replies: { ...cfgOf().listen.replies, onPost: true, onComment: false } }))
  assert.deepEqual(noComment.filter((c) => c.source === 'replied').map((c) => c.noticeType).sort(), ['101', '102'])

  const off = await collect(cfgOf({ replies: { ...cfgOf().listen.replies, enabled: false } }))
  assert.equal(off.filter((c) => c.source === 'replied').length, 0)
})

test('replyTypeOn：默认值 101 关 / 102 103 开，未知频道不接', () => {
  const R = { enabled: true, onFloor: true, onComment: true, onPost: false }
  assert.equal(replyTypeOn(R, '101'), false)
  assert.equal(replyTypeOn(R, '102'), true)
  assert.equal(replyTypeOn(R, '103'), true)
  assert.equal(replyTypeOn(R, '202'), false)
  assert.equal(replyTypeOn({ ...R, onPost: true }, 101), true)
})

/* ── ② maxAgeMin ── */

test('maxAgeMin 挡掉太旧的通知，del_status=1 一律跳过', async () => {
  notices = [N102, N102_OLD, N102_DEL, N101_OLD]
  const cands = await collect(cfgOf())
  const ids = cands.filter((c) => c.source === 'replied').map((c) => c.noticeId)
  assert.deepEqual(ids, ['9001'])            // 9004 超时、9005 已删、9006 是 101（默认关）

  // 关掉时限（0）后 780 分钟的也进来
  const wide = await collect(cfgOf({ replies: { ...cfgOf().listen.replies, maxAgeMin: 0 } }))
  assert.deepEqual(wide.filter((c) => c.source === 'replied').map((c) => c.noticeId).sort(), ['9001', '9004'])

  // 「11-01」这种月-日写法也要能算出年龄：101 打开 + 时限 720 → 两周前的旧帖被挡
  const withPost = await collect(cfgOf({ replies: { ...cfgOf().listen.replies, onPost: true } }))
  assert.equal(withPost.some((c) => c.noticeId === '9006'), false)
})

test('replyAgeMin：相对时间与月-日两种写法', () => {
  assert.equal(replyAgeMin('55分钟前'), 55)
  assert.equal(replyAgeMin('11小时前'), 660)
  assert.equal(replyAgeMin('3天前'), 4320)
  assert.equal(replyAgeMin('90秒前'), 1.5)
  assert.equal(replyAgeMin('不知道'), null)
  // 两天前的「月-日」：算出 ≈2880 分钟（跨月也算得出来，这里只要求落在合理区间）
  const d = new Date(Date.now() - 2 * 86400000)
  const md = (d.getMonth() + 1) + '-' + String(d.getDate()).padStart(2, '0')
  const age = replyAgeMin(md)
  assert.ok(age >= 2880 && age <= 4320, 'MM-DD 年龄 ' + age)
  // 今天的「月-日」只算到今天 0 点，所以 < 1 天
  const t = new Date()
  const today = (t.getMonth() + 1) + '-' + String(t.getDate()).padStart(2, '0')
  assert.ok(replyAgeMin(today) < 1440)
})

/* ── ③ 落点 ── */

test('落点：101 主楼 / 102 回我的楼 / 103 拿不到楼层就 @ 对方', () => {
  const base = { source: 'replied', kind: 'floor', topicId: '9290031', sectionId: '', floorId: '27121526', myReplyId: '14890624' }
  assert.deepEqual(replyTargetOf({ ...base, noticeType: '101' }), { mode: 'reply', tid: '9290031', fid: '', replyId: '0', commentId: '0', mention: false })
  // 102 回在对方那层楼底下：replyId 是 rid（楼层），不是 to_rid（评论 id）
  assert.deepEqual(replyTargetOf({ ...base, noticeType: '102' }), { mode: 'reply', tid: '9290031', fid: '', replyId: '27121526', commentId: '0', mention: false })
  // 103 缺板块号/评论 → 主楼回复 + 正文 @ 对方，replyId 仍是 rid
  assert.deepEqual(replyTargetOf({ ...base, noticeType: '103' }), { mode: 'reply', tid: '9290031', fid: '', replyId: '27121526', commentId: '0', mention: true })
  // collect 定位到那条评论后 → 楼中楼，replyId=评论所在楼层、commentId=评论 id
  assert.deepEqual(
    replyTargetOf({ ...base, noticeType: '103', sectionId: '23064', commentFloorId: '27119050', commentId: '14890310' }),
    { mode: 'comment', tid: '9290031', fid: '23064', replyId: '27119050', commentId: '14890310', mention: false },
  )
})

test('落点：老的三种 kind 口径没变', () => {
  assert.deepEqual(
    replyTargetOf({ kind: 'topic', topicId: '1', sectionId: '23064' }),
    { mode: 'reply', tid: '1', fid: '', replyId: '0', commentId: '0', mention: false },
  )
  assert.deepEqual(
    replyTargetOf({ kind: 'floor', source: 'atme', topicId: '1', sectionId: '23064', floorId: '77' }),
    { mode: 'comment', tid: '1', fid: '23064', replyId: '77', commentId: '0', mention: false },
  )
  assert.deepEqual(
    replyTargetOf({ kind: 'comment', source: 'topic', topicId: '1', sectionId: '23064', floorId: '77', commentId: '88' }),
    { mode: 'comment', tid: '1', fid: '23064', replyId: '77', commentId: '88', mention: false },
  )
})

/* ── ④ 判定：通知类不再要求正文有 @ ── */

test('evaluate：replied 视为已触发，via=reply，其余闸照旧', async () => {
  notices = [N102, N103]
  const cands = (await collect(cfgOf())).filter((c) => c.source === 'replied')
  const c102 = cands.find((c) => c.noticeType === '102')
  const c103 = cands.find((c) => c.noticeType === '103')
  // 正文里没有 @ 也算叫我
  assert.deepEqual(evaluate(cfgOf(), c102, ME), { action: 'reply', why: 'at', via: 'reply' })
  assert.equal(evaluate(cfgOf(), c103, ME).via, 'reply')
  // 自说自话不回
  assert.equal(evaluate(cfgOf(), { ...c102, uid: ME.uid }, ME).why, 'self')
  // 总闸 / 分类开关
  assert.equal(evaluate(cfgOf({ replies: { ...cfgOf().listen.replies, enabled: false } }), c102, ME).why, 'replies-off')
  assert.equal(evaluate(cfgOf({ replies: { ...cfgOf().listen.replies, onFloor: false } }), c102, ME).why, 'replies-off-102')
  // at 名单（全站范围）与源自己的名单都还在
  assert.equal(evaluate(cfgOf({ at: { ...cfgOf().listen.at, denyUsers: ['147325082'] } }), c102, ME).why, 'at-user-deny')
  assert.equal(evaluate(cfgOf({ replies: { ...cfgOf().listen.replies, denyUsers: ['有蛋焉'] } }), c102, ME).why, 'replied-user-deny')
  // at.items 是「额外要盯的帖子」，不该卡通知源
  assert.equal(evaluate(cfgOf({ at: { ...cfgOf().listen.at, items: [{ id: '9999999' }] } }), c102, ME).action, 'reply')
})

test('evaluate：其它源的触发口径一点没动', () => {
  const floor = { source: 'topic', kind: 'floor', sectionId: '23064', topicId: '9', floorId: '7', uid: '22222', nickname: '路人', content: '路过看看' }
  assert.equal(evaluate(cfgOf(), floor, ME).why, 'no-trigger')
  assert.equal(evaluate(cfgOf(), { ...floor, content: '@nanhua 在吗' }, ME).action, 'reply')
  const noticeTag = { ...floor, source: 'atme', content: '<kb-contact data-id="41227777"/>' }
  assert.deepEqual(evaluate(cfgOf({ atme: { enabled: true, ...F() } }), noticeTag, ME), { action: 'reply', why: 'at', via: 'notice' })
  assert.equal(evaluate(cfgOf(), noticeTag, ME).why, 'atme-off')
})

/* ── ⑤ 去重键 ── */

test('通知类去重键是 n:<type>:<noticeId>，forgetTopics 不会删它', () => {
  assert.equal(keyOf({ source: 'replied', noticeType: '102', noticeId: '9001' }), 'n:102:9001')
  assert.equal(keyOf({ source: 'topic', kind: 'topic', topicId: '9' }), 't:9')
  assert.equal(keyOf({ source: 'atme', kind: 'floor', topicId: '9', floorId: '7' }), 'f:9:7')
  assert.equal(keyOf({ source: 'topic', kind: 'comment', topicId: '9', commentId: '8' }), 'c:9:8')

  const seenFile = path.join(home, '.hykb-ai', 'seen.json')
  fs.writeFileSync(seenFile, JSON.stringify({
    replies: { 'n:102:9001': { at: 1 }, 'n:103:9003': { at: 1 }, 'f:9290031:27121526': { at: 1 }, 'c:9290031:5': { at: 1 } },
    persons: {},
  }))
  assert.equal(forgetTopics(['9290031']), 2)               // 只删 f:/c:
  const after = JSON.parse(fs.readFileSync(seenFile, 'utf8'))
  assert.deepEqual(Object.keys(after.replies).sort(), ['n:102:9001', 'n:103:9003'])
})

/* ── ⑥ 假@扫描：游标轮转、每轮上限、关掉零额外读 ── */

const seedTopics = (n) => {
  for (const t of Object.keys(topics)) delete topics[t]
  for (let i = 1; i <= n; i++) {
    const tid = 't' + i
    topics[tid] = {
      topic: { id: tid, title: '帖' + i, sid: '23064', section: { title: '生活区' }, content: '正文' },
      replies: [{
        id: 'r' + i, uid: '2000' + i, user: { nickname: '路人' + i }, position: 1,
        content: i === 1 ? '@nanhua 这帖在说你' : '随便看看',
        comment: { info: [{ id: 'c' + i, uid: '300' + i, user: { nickname: '楼中楼' + i }, content: i === 1 ? '@nanhua 楼中楼喊你' : '嗯' }] },
      }],
    }
  }
}
const seenOf = (n) => {
  const replies = {}
  for (let i = 1; i <= n; i++) replies['t:t' + i] = { at: 1 }
  return { replies, persons: {} }
}
const scanCfg = (over = {}) => cfgOf({ replies: { ...cfgOf().listen.replies, enabled: false }, scanMine: { enabled: true, maxTopicsPerTick: 2, ...over } })

test('假@扫描：每轮只读 maxTopicsPerTick 帖，游标轮转覆盖全部', async () => {
  seedTopics(5)
  const seen = seenOf(5)
  assert.deepEqual(mineTopics(seen).sort(), ['t1', 't2', 't3', 't4', 't5'])

  let mark = 0
  const round = async () => {
    mark = calls.length
    const cands = await collect(scanCfg(), { seen })
    const read = detailTids(mark)
    const mineCands = cands.filter((c) => c.source === 'mine')
    return { read, mineCands }
  }

  const r1 = await round()
  assert.deepEqual(r1.read, ['t1', 't2'])
  assert.equal(seen.__scanCursor, 2)
  const r2 = await round()
  assert.deepEqual(r2.read, ['t3', 't4'])
  assert.equal(seen.__scanCursor, 4)
  const r3 = await round()
  assert.deepEqual(r3.read, ['t5', 't1'])          // 到底后从头接上
  assert.equal(seen.__scanCursor, 1)

  // 命中纯文本 @：楼层一条 + 楼中楼一条，via 是 plain，且判定为要回
  assert.deepEqual(r1.mineCands.map((c) => [c.kind, c.topicId, c.floorId, c.commentId]), [['floor', 't1', 'r1', ''], ['comment', 't1', 'r1', 'c1']])
  assert.equal(evaluate(scanCfg(), r1.mineCands[0], ME).via, 'plain')
  assert.equal(evaluate(scanCfg(), r1.mineCands[1], ME).action, 'reply')
  // at.items 只是「额外要盯的帖子」，不该把假@扫描挡掉
  assert.equal(evaluate(cfgOf({ replies: { ...cfgOf().listen.replies, enabled: false }, scanMine: { enabled: true, maxTopicsPerTick: 2 }, at: { ...cfgOf().listen.at, items: [{ id: 'nope' }] } }), r1.mineCands[0], ME).action, 'reply')
})

test('游标存独立字段，不进 seen.replies', async () => {
  seedTopics(3)
  const seen = seenOf(3)
  notices = []
  await collect(scanCfg(), { seen })
  assert.equal(seen.__scanCursor, 2)
  assert.deepEqual(Object.keys(seen.replies).sort(), ['t:t1', 't:t2', 't:t3'])
})

test('scanMine 关掉时零额外读', async () => {
  seedTopics(5)
  calls.length = 0
  const cands = await collect(cfgOf({ replies: { ...cfgOf().listen.replies, enabled: false }, scanMine: { enabled: false, maxTopicsPerTick: 2 } }), { seen: seenOf(5) })
  assert.equal(cands.length, 0)
  assert.equal(calls.length, 0)                  // 一个请求都不该发
  // 扫到之后配置被关掉的那一轮：判定兜住
  const c = { source: 'mine', kind: 'floor', sectionId: '23064', topicId: 't1', floorId: 'r1', uid: '20001', nickname: '路人1', content: '@nanhua 在吗' }
  assert.equal(evaluate(cfgOf({ scanMine: { enabled: false } }), c, ME).why, 'scanMine-off')
})

test('发帖台账里的帖也算「我参与过的帖」', async () => {
  fs.writeFileSync(path.join(home, '.hykb-ai', 'posts.json'), JSON.stringify([{ title: '日报', picks: ['9266632', '9260608'] }]))
  try {
    const seen = { replies: { 't:9290031': { at: 1 } }, persons: {} }
    assert.deepEqual(mineTopics(seen), ['9290031', '9266632', '9260608'])
  } finally {
    fs.rmSync(path.join(home, '.hykb-ai', 'posts.json'), { force: true })
  }
  // 台账坏了也不许抛
  fs.writeFileSync(path.join(home, '.hykb-ai', 'posts.json'), '{坏掉的 JSON')
  try { assert.deepEqual(mineTopics({ replies: {} }), []) } finally { fs.rmSync(path.join(home, '.hykb-ai', 'posts.json'), { force: true }) }
})

test('两类新源全关：候选与判定和现在完全一致', async () => {
  seedTopics(5)
  notices = [N102, N103]
  calls.length = 0
  const cfg = cfgOf({ replies: { ...cfgOf().listen.replies, enabled: false }, scanMine: { enabled: false, maxTopicsPerTick: 2 } })
  const cands = await collect(cfg, { seen: seenOf(5) })
  assert.equal(cands.length, 0)
  assert.equal(calls.length, 0)
  const on = cfgOf({ replies: { ...cfgOf().listen.replies, enabled: false }, scanMine: { enabled: false, maxTopicsPerTick: 2 }, atme: { enabled: true, ...F() } })
  assert.equal(evaluate(on, { source: 'atme', kind: 'floor', sectionId: '23064', topicId: '9', floorId: '7', uid: '22222', nickname: '路人', content: '随便' }, ME).via, 'notice')
  // 假@扫描的候选照旧要真的命中 @ 才回
  const scanOn = cfgOf({ replies: { ...cfgOf().listen.replies, enabled: false }, scanMine: { enabled: true, maxTopicsPerTick: 2 } })
  const mineCand = { source: 'mine', kind: 'floor', sectionId: '23064', topicId: '9', floorId: '7', uid: '22222', nickname: '路人' }
  assert.equal(evaluate(scanOn, { ...mineCand, content: '没有提到人' }, ME).why, 'no-trigger')
  assert.equal(evaluate(scanOn, { ...mineCand, content: '@nanhua 在吗' }, ME).action, 'reply')
})

/* ── ⑦ 板块号：topic.sid 常常是空的，值在楼层上 ── */

test('sidOf：topic.sid 优先，其次本楼层，其次任意楼层，都没有才空串', () => {
  const replies = [{ id: 'r1', sid: '23064' }, { id: 'r2', sid: '23064' }]
  assert.equal(sidOf({ sid: '3' }, replies, 'r1'), '3')              // topic.sid 有值就用它
  assert.equal(sidOf({ sid: '' }, replies, 'r2'), '23064')           // 空 → 这层楼的 sid
  assert.equal(sidOf({}, replies, '不存在'), '23064')                 // 本楼层找不到 → 任一楼层的
  assert.equal(sidOf({}, [{ id: 'r1', sid: '' }], 'r1'), '')         // 都没有 → 空串
  assert.equal(sidOf(undefined, undefined, undefined), '')           // 什么都不给也不许抛
  assert.equal(sidOf(null, [null, { id: 'r9' }]), '')                // 脏数据不抛
})

test('sectionId：帖子源与假@源在 topic.sid 为空时都取楼层上的 sid', async () => {
  for (const t of Object.keys(topics)) delete topics[t]
  topics['9200001'] = {
    // 真数据的形状：topic.sid 缺席，板块号只在 reply[].sid 上
    topic: { id: '9200001', title: '没有 sid 的帖', section: { title: '生活区' } },
    replies: [{
      id: 'r1', sid: '23064', uid: '20001', user: { nickname: '路人' }, position: 1, content: '@nanhua 在吗',
      comment: { info: [{ id: 'c1', uid: '30001', user: { nickname: '楼中楼' }, content: '@nanhua 楼里喊你' }] },
    }],
  }
  // 帖子源（楼层 + 楼中楼都过这一处）
  const fromTopic = (await collect(cfgOf({
    replies: { ...cfgOf().listen.replies, enabled: false },
    topic: { ...cfgOf().listen.topic, enabled: true, items: [{ id: '9200001' }] },
  }))).filter((c) => c.source === 'topic')
  assert.deepEqual(fromTopic.map((c) => c.kind).sort(), ['comment', 'floor'])
  assert.ok(fromTopic.every((c) => c.sectionId === '23064'))

  // 假@源
  const seen = { replies: { 't:9200001': { at: 1 } }, persons: {} }
  const fromMine = (await collect(scanCfg(), { seen })).filter((c) => c.source === 'mine')
  assert.ok(fromMine.length >= 1)
  assert.ok(fromMine.every((c) => c.sectionId === '23064'))

  // 103 那一支与它们同源：定位到的 fid 也是这个 23064
  seedNoticeTopic()
  notices = [N103]
  const c103 = (await collect(cfgOf())).find((c) => c.noticeType === '103')
  assert.equal(c103.sectionId, '23064')
})

/* ── ⑧ 首次启用 replies 的 bootstrap：第一轮只登记不回 ── */

const seenFile = () => path.join(home, '.hykb-ai', 'seen.json')
const resetSeen = (extra = {}) => fs.writeFileSync(seenFile(), JSON.stringify({ replies: {}, persons: {}, __primed: true, ...extra }))

test('首次启用：第一轮只登记不回、标记落盘，下一轮才真回', async () => {
  seedNoticeTopic()
  resetSeen()
  notices = [N103, N102]
  const cfg = cfgOf({ atme: { enabled: false, ...F() } })

  const logs1 = []
  const s1 = await tick(cfg, { dryRun: false, log: (m) => logs1.push(String(m)) })
  assert.equal(s1.replied, 0)
  assert.ok(logs1.some((m) => m.includes('首次启用') && m.includes('只登记不回')))
  assert.equal(logs1.some((m) => m.startsWith('[hit/')), false)     // 一条都不接
  const st1 = JSON.parse(fs.readFileSync(seenFile(), 'utf8'))
  assert.equal(st1.__repliedPrimed, true)
  assert.deepEqual(Object.keys(st1.replies).sort(), ['n:102:9001', 'n:103:9003'])

  // 下一轮：新来一条 102 通知 → 它才是真正被接的那条（AI 没配，命中行之后停在 [ai]）
  notices = [N103, N102, { ...N102, id: 9008 }]
  const logs2 = []
  const s2 = await tick(cfg, { dryRun: false, log: (m) => logs2.push(String(m)) })
  assert.ok(logs2.some((m) => m.startsWith('[hit/')))
  assert.equal(s2.replied, 0)
  assert.equal(logs2.some((m) => m.includes('首次启用')), false)     // 只发生一次
})

test('首次启用：dry-run 只演示不落盘，标记一个字节都不写', async () => {
  seedNoticeTopic()
  resetSeen()
  notices = [N103]
  const logs = []
  await tick(cfgOf(), { dryRun: true, log: (m) => logs.push(String(m)) })
  assert.ok(logs.some((m) => m.includes('只登记不回') && m.includes('dry-run 不落盘')))
  assert.equal(logs.some((m) => m.startsWith('[hit/')), false)
  const st = JSON.parse(fs.readFileSync(seenFile(), 'utf8'))
  assert.equal(st.__repliedPrimed, undefined)
  assert.deepEqual(st.replies, {})
})
