// 敏感词「强制发布」（平台 mask=1 = 命中敏感词也照发，词显示成星号）
// + /api/models 把掩码当真密钥导致的 ByteString 崩溃。
// 平台全部换桩，对 B 站快爆 0 次真请求；配置 / 台账 / seen 都在临时 HOME 里。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hykb-forcemask-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSH_HOME = path.join(home, '.dsh')
process.env.HYKB_SCROLL_CONFIG = path.join(home, '.dsh', 'hykb-scroll.config.json')
fs.mkdirSync(path.join(home, '.dsh'), { recursive: true })
fs.mkdirSync(path.join(home, '.hykb-ai'), { recursive: true })
// 读/写间隔与额度清零，否则每个请求都要等 1.5s
fs.writeFileSync(process.env.HYKB_SCROLL_CONFIG, JSON.stringify({
  risk: { minGapMs: 0, gapJitterMs: 0, writeGapSec: 0, readHourly: 1000, readDaily: 1000, writeHourly: 1000, writeDaily: 1000 },
}))
fs.writeFileSync(path.join(home, '.hykb-ai', 'credentials.json'),
  JSON.stringify({ uid: '41227777', Pauth: 'PAUTH', Uauth: 'UAUTH', nickname: 'nanhua' }))

const MASK = '••••••••'
const BAD = '某个外挂名'          // 自加违禁词：入站命中 → 直接回固定话术（零 token），正好走到写接口
const REFUSE = '识别到违规内容无法生成回复'

/* ── 平台替身 ── */
let notices = []
const topics = {}
const calls = []
const realFetch = globalThis.fetch
globalThis.fetch = async (url, init = {}) => {
  const u = String(url)
  const h = (init && init.headers) || {}
  calls.push({ url: u, body: String((init && init.body) || ''), auth: h.authorization || h.Authorization || '' })
  if (u.includes('api_user.php')) {
    const mode = new URLSearchParams(String(init.body || '')).get('mode')
    return new Response(JSON.stringify({ code: 100, result: { data: mode === '1' ? notices : [], last_id: '-1', cursor: '-1' } }), { status: 200 })
  }
  if (u.includes('m=topic&ac=detail')) {
    const tid = new URL(u).searchParams.get('topic_id')
    const t = topics[tid]
    if (!t) return new Response(JSON.stringify({ code: 404, msg: 'gone' }), { status: 200 })
    return new Response(JSON.stringify({ code: 100, result: { topic: t.topic, reply: t.replies } }), { status: 200 })
  }
  if (u.endsWith('/models')) {
    return new Response(JSON.stringify({ data: [{ id: 'm-b' }, { id: 'm-a' }] }), { status: 200 })
  }
  return new Response(JSON.stringify({ code: 100, msg: 'ok' }), { status: 200 })
}
after(() => { globalThis.fetch = realFetch; fs.rmSync(home, { recursive: true, force: true }) })

const C = await import('../tools/lib/config.mjs')
const { DEFAULTS } = C
const { seenPath } = await import('../tools/lib/paths.mjs')
const { publishDigest } = await import('../tools/lib/post.mjs')
const W = await import('../tools/lib/watch.mjs')
const A = await import('../tools/lib/ai.mjs')
const { default: plugin, normalizeSafety } = await import('../lib/index.js')

/* ── ① 配置默认值 + 归一 ── */

test('cfg.safety.forceMask 默认 true', () => {
  assert.equal(DEFAULTS.safety.forceMask, true)
  assert.equal(C.config().safety.forceMask, true)   // 配置文件里没写也认默认值
})

test('normalizeSafety：只有显式 false 才关，脏值一律当开', () => {
  const a = normalizeSafety({})
  assert.equal(a.forceMask, true, '缺字段该当开')
  const b = normalizeSafety({ forceMask: false })
  assert.equal(b.forceMask, false, '显式关掉要保住')
  assert.equal(b.politics, true, 'forceMask 不该混进强制开启的列表')
  const d = normalizeSafety({ forceMask: 'false' })
  assert.equal(d.forceMask, true, '字符串 "false" 和其它开关一个口径：只认布尔 false')
  const e = normalizeSafety({ forceMask: undefined })
  assert.equal(e.forceMask, true)
})

/* ── ② 发帖：mask 跟着 cfg.safety.forceMask ── */

const picks = [{ topicId: '111', title: 'A 帖' }, { topicId: '222', title: 'B 帖' }, { topicId: '333', title: 'C 帖' }]
const postCfg = (safety = {}) => ({
  post: { enabled: true, section: { id: '23064', title: '综合讨论' }, title: '日报 {date}', maxPerDay: 5, minPicks: 3, links: true },
  prompt: { rules: '', suffix: '' },
  safety,
})
const threadMask = () => {
  const req = calls.filter((c) => c.url.includes('a=setThread')).pop()
  assert.ok(req, '没打到 setThread')
  return new URLSearchParams(req.body).get('mask')
}

test('发帖：默认带 mask=1，显式关掉回 mask=0', async () => {
  calls.length = 0
  const r = await publishDigest({ body: '## 今天' + '\n聊得挺多', picks, cfg: postCfg(), date: '2026-11-20' })
  assert.equal(r.status, 'posted', JSON.stringify(r))
  assert.equal(threadMask(), '1', '默认应该强制发布')

  calls.length = 0
  const r2 = await publishDigest({ body: '## 今天' + '\n聊得挺多', picks, cfg: postCfg({ forceMask: false }), date: '2026-11-21' })
  assert.equal(r2.status, 'posted', JSON.stringify(r2))
  assert.equal(threadMask(), '0', '关掉后要回到旧行为')
})

/* ── ③ 回帖 + 楼中楼：两条写路径的 mask ── */

const ME = { uid: '41227777', nickname: 'nanhua' }
const F = () => ({ allowUsers: [], denyUsers: [], allowForums: [], denyForums: [], allowTopics: [], denyTopics: [] })
const watchCfg = (safety = {}) => ({
  listen: {
    allDay: true, oncePerPerson: false, triggerMode: 'both', maxTopicsPerTick: 6, maxRepliesPerTick: 3,
    forum: { enabled: false, items: [], ...F() },
    topic: { enabled: false, items: [], floors: true, comments: true, ...F() },
    atme: { enabled: false, ...F() },
    replies: { enabled: true, onFloor: true, onComment: true, onPost: false, maxAgeMin: 720, ...F() },
    scanMine: { enabled: false, maxTopicsPerTick: 2 },
    at: { enabled: false, items: [], forums: [], ...F() },
  },
  owner: { uid: '11111', name: '大号' },
  self: { uid: ME.uid, name: ME.nickname },
  persona: {}, ai: {},
  safety: { extraWords: [BAD], refuseText: REFUSE, ...safety },
})

const notice = (over = {}) => ({
  from_uid: '147325082', from_nickname: '有蛋焉', type: '102', time: '3小时前',
  tid: '9290031', rid: '27121526', to_rid: '14890624', cid: '0', del_status: 0,
  to_info: '我上一条', from_info: BAD + '广告', msg_type: '回复你的回帖', id: 9001,
  ...over,
})
const N102 = notice()
const N103 = notice({ type: '103', id: 9003, tid: '9288290', rid: '27119050', to_rid: '14890310', reply_id: '27119050', msg_type: '回复你的回复', from_info: BAD + '拿去用', from_uid: '99096916', from_nickname: '还是不吃香菜' })

const seedTopic = () => {
  for (const t of Object.keys(topics)) delete topics[t]
  topics['9288290'] = {
    topic: { id: '9288290', title: '快爆论坛日报', section: { title: '生活区' } },
    replies: [{
      id: '27119050', sid: '23064', uid: '99096916', user: { nickname: '还是不吃香菜' }, position: 4, content: '别的楼层',
      comment: { info: [{ id: '14890310', uid: '99096916', user: { nickname: '还是不吃香菜' }, content: BAD + '拿去用' }] },
    }],
  }
}
const freshSeen = () => fs.writeFileSync(seenPath(), JSON.stringify({ replies: {}, persons: {}, __primed: true, __repliedPrimed: true }))
const writeMask = (suffix) => {
  const req = calls.filter((c) => c.url.includes(suffix)).pop()
  assert.ok(req, '没打到 ' + suffix)
  return new URLSearchParams(req.body).get('mask')
}

test('回帖 / 楼中楼：默认 mask=1，显式关掉回 mask=0', async () => {
  for (const [forceMask, want] of [[undefined, '1'], [false, '0']]) {
    seedTopic()
    freshSeen()
    notices = [N102, N103]
    calls.length = 0
    const logs = []
    const cfg = watchCfg(forceMask === undefined ? {} : { forceMask })
    const s = await W.tick(cfg, { dryRun: false, log: (m) => logs.push(String(m)) })
    assert.equal(s.refused, 2, '两条违禁内容都该走固定话术：' + logs.join(' | '))
    assert.equal(writeMask('a=replyOperate'), want, '回帖 mask（forceMask=' + forceMask + '）')
    assert.equal(writeMask('a=commentOperate'), want, '楼中楼 mask（forceMask=' + forceMask + '）')
  }
})

/* ── ④ /api/models：掩码当密钥要回退已存密钥，非 ASCII 要有可读报错 ── */

const LOOPBACK = { host: '127.0.0.1:51548' }
function makeCtx({ connection } = {}) {
  const routes = []
  const ctx = {
    effect: (fn) => { fn() },
    get: (n) => (n === 'connection' ? connection : undefined),
    webServer: { register: (o) => { routes.push(o); return () => {} } },
  }
  return { ctx, routes }
}
function fakeRes() {
  const out = { code: 0, body: '' }
  return { out, setHeader() {}, writeHead(c) { out.code = c }, end(b) { out.body = String(b || '') }, writableEnded: false }
}
function postReq(body) {
  const str = JSON.stringify(body)
  const req = {
    method: 'POST', url: '/', headers: LOOPBACK, body: str,
    on(ev, fn) {
      if (ev === 'data') queueMicrotask(() => fn(Buffer.from(str, 'utf8')))
      if (ev === 'end') queueMicrotask(() => fn())
      return req
    },
    resume() {}, destroy() {}, socket: { remoteAddress: '127.0.0.1' },
  }
  return req
}
const routesOf = () => {
  const { ctx, routes } = makeCtx({ connection: { isTrusted: () => true, requestRejection: () => null } })
  plugin.apply(ctx)
  return routes
}
const callModels = async (routes, body) => {
  const res = fakeRes()
  await routes.find((x) => String(x.path || x.pathname) === '/dsh-hykb/api/models').handler(postReq(body), res)
  return { code: res.out.code, j: JSON.parse(res.out.body || '{}') }
}
const lastAuth = () => calls.filter((c) => c.url.endsWith('/models')).pop()?.auth

test('/api/models：apiKey 是掩码 / 含非 ASCII 时当没传，回退已存密钥', async () => {
  C.saveAiKey('sk-stored-123')
  const routes = routesOf()

  calls.length = 0
  const a = await callModels(routes, { baseUrl: 'https://api.example.test/v1', apiKey: MASK })
  assert.equal(a.code, 200, JSON.stringify(a.j))
  assert.deepEqual(a.j.models, ['m-a', 'm-b'])
  assert.equal(lastAuth(), 'Bearer sk-stored-123', '掩码被当成密钥发出去了')

  calls.length = 0
  const b = await callModels(routes, { baseUrl: 'https://api.example.test/v1', apiKey: 'sk-live-••' })
  assert.equal(b.code, 200, JSON.stringify(b.j))
  assert.equal(lastAuth(), 'Bearer sk-stored-123', '混了掩码字符的密钥该当没传')

  // 页面上真敲进去的 ASCII 密钥照旧优先
  calls.length = 0
  const c = await callModels(routes, { baseUrl: 'https://api.example.test/v1', apiKey: 'sk-fresh-999' })
  assert.equal(c.code, 200, JSON.stringify(c.j))
  assert.equal(lastAuth(), 'Bearer sk-fresh-999')
})

test('listModels 拿到非 ASCII 密钥时抛可读错误，而不是 fetch 的 ByteString', async () => {
  const real = globalThis.fetch
  let hit = 0
  globalThis.fetch = async () => { hit++; return new Response('{}') }
  try {
    await assert.rejects(
      () => A.listModels({ baseUrl: 'https://api.example.test/v1', apiKey: MASK }),
      (e) => /掩码/.test(e.message) && !/ByteString/.test(e.message),
    )
    assert.equal(hit, 0, '这种密钥根本不该出网')
  } finally { globalThis.fetch = real }
})
