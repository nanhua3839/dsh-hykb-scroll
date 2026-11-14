// daypool 的离线测试：globalThis.fetch 全部换桩，now 传固定时间，不联网、不看真实时钟。
// HOME 必须在动态 import 之前改好 —— paths/traffic 在模块顶层就把家目录定下了。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hykb-daypool-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSH_HOME = path.join(home, '.dsh')
fs.mkdirSync(path.join(home, '.dsh'), { recursive: true })
// 限流层读配置文件：最小间隔/抖动归零，否则每个请求要真等 1.5 秒
fs.writeFileSync(path.join(home, '.dsh', 'hykb-scroll.config.json'), JSON.stringify({
  risk: {
    minGapMs: 0, gapJitterMs: 0,
    readHourly: 100000, readDaily: 200000,
    writeHourly: 1000, writeDaily: 1000, writeGapSec: 0, backoffOnBlock: [1],
  },
}))

const { poolPath, emptyPool, loadPool, savePool, sectionsFor, crawlDay, coverageOf } = await import('../tools/lib/daypool.mjs')

const MIN = 60000
const pad = (n) => String(n).padStart(2, '0')
const fmt = (ms) => {
  const d = new Date(ms)
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
    ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
}
const localDate = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
const midnightOf = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()

const mkPost = (id, ms, extra = {}) => ({
  id: String(id), uid: 'u' + id, title: '帖 ' + id, content: '内容 ' + id,
  time: fmt(ms), edit_time: '0000-00-00 00:00:00', reply_time: fmt(ms),
  reply_count: 0, comment_count: 0, reply_comment_count: 0, up_vote: 0, views: 0,
  is_essence: -1, is_top: -1, is_official: -1, is_note: -1,
  user: { nickname: '甲' + id }, status: '1', del_status: '0', client_status: '0', pic: '',
  ...extra,
})

// 列表分页：每页 perPage 条，翻页游标用 key / nextLast 成对模拟（真实接口是 last_id + cursor）。
function pagesOf(posts, perPage = 10) {
  const chunks = []
  for (let i = 0; i < posts.length; i += perPage) chunks.push(posts.slice(i, i + perPage))
  return chunks.map((data, idx) => ({
    key: idx === 0 ? '0' : 'p' + idx,
    data,
    // 最后一页把 last_id 回成自己：模拟「没有下一页」，避免桩里造出无限翻页
    nextLast: idx + 1 < chunks.length ? 'p' + (idx + 1) : 'p' + idx,
  }))
}

// 4 页 × 10 条的板块夹具：前 3 页是今天 21:30 起每 40 分钟一条（最老 02:10，仍在今天），
// 第 4 页是昨天 23:50 起每 10 分钟一条 —— 第 4 页跨过当天 00:00，扫到它就 done。
function daySection(sid, now) {
  const mid = midnightOf(now)
  const posts = []
  for (let i = 0; i < 30; i++) posts.push(mkPost(sid + '-' + i, now.getTime() - i * 40 * MIN))
  for (let i = 0; i < 10; i++) posts.push(mkPost(sid + '-y' + i, mid - (10 + i * 10) * MIN))
  return pagesOf(posts, 10)
}

const realFetch = globalThis.fetch
let calls = []
let catalogStub = { code: 500, msg: 'catalog not stubbed' }
const jsonRes = (j) => new Response(JSON.stringify(j), { status: 200 })

// spec: { <sectionId>: { pages } | { errorCode } }；catalogStub 单独控制板块目录那条接口。
function installFetch(spec) {
  calls = []
  globalThis.fetch = async (url) => {
    const u = new URL(String(url))
    const ac = u.searchParams.get('ac')
    calls.push({
      ac,
      sid: u.searchParams.get('section_id') || '',
      lastId: u.searchParams.get('last_id'),
      cursor: u.searchParams.get('cursor'),
    })
    if (ac === 'index') return jsonRes(catalogStub)
    const entry = spec[u.searchParams.get('section_id')]
    if (!entry) return jsonRes({ code: 1000, msg: 'section not stubbed' })
    if (entry.errorCode) return jsonRes({ code: entry.errorCode, msg: entry.msg || 'boom' })
    const lastId = u.searchParams.get('last_id')
    const page = entry.pages.find((x) => String(x.key) === String(lastId))
    if (!page) return jsonRes({ code: 100, result: { data: [], last_id: lastId, cursor: u.searchParams.get('cursor') } })
    return jsonRes({ code: 100, result: { data: page.data, last_id: page.nextLast, cursor: 'c-' + page.nextLast } })
  }
  return calls
}

const cfgFor = (sections, extra = {}) => ({
  browse: { sections, skipTop: true, muteTitles: [], ...extra },
})

test('① 3 板块 × 4 页：跨过 00:00 判 done，覆盖率对', async () => {
  const now = new Date(2026, 10, 13, 21, 30, 0)
  const ids = ['101', '102', '103']
  installFetch(Object.fromEntries(ids.map((sid) => [sid, { pages: daySection(sid, now) }])))
  const r = await crawlDay(cfgFor(ids), { date: localDate(now), now })

  assert.equal(r.stats.round.requests, 12, '3 板块 × 4 页 = 12 请求（第一轮前脸并进补历史）')
  assert.equal(r.stats.reachedCutoff, true)
  const cov = coverageOf(r.pool)
  assert.equal(cov.sections, 3)
  assert.equal(cov.gaps.length, 0)
  assert.equal(cov.postsToday, 90, '每板块 30 条今天发布')
  assert.equal(cov.oldestCoveredMs, midnightOf(now), '全部 done 时覆盖到当天 00:00')
  assert.equal(Object.keys(r.pool.posts).length, 120)
  assert.equal(r.pool.stats.requests, 12)
  for (const id of ids) {
    assert.equal(r.pool.sections[id].backfill.done, true, id + ' 应已到当天 0 点')
    assert.ok(r.pool.sections[id].frontWmMs > 0, id + ' 应有前脸水位')
    assert.equal(r.pool.sections[id].pages, 4)
  }
  // bySection：每板块池内帖数 / 今天发布的帖数
  assert.deepEqual(cov.bySection.map((x) => [x.id, x.posts, x.todayPosts]), [
    ['101', 40, 30], ['102', 40, 30], ['103', 40, 30],
  ])
})

test('② 第二轮只发 1 页前脸，不重扫历史', async () => {
  const now = new Date(2026, 10, 14, 21, 30, 0)
  const ids = ['201', '202', '203']
  installFetch(Object.fromEntries(ids.map((sid) => [sid, { pages: daySection(sid, now) }])))
  const cfg = cfgFor(ids)
  const date = localDate(now)
  await crawlDay(cfg, { date, now })
  const firstRound = calls.length
  assert.equal(firstRound, 12)

  const r2 = await crawlDay(cfg, { date, now: new Date(now.getTime() + 10 * MIN) })
  const round2 = calls.slice(firstRound)
  assert.equal(round2.length, 3, '每板块只应发 1 个前脸请求')
  assert.ok(round2.every((c) => c.lastId === '0'), '只请求顶部，不重扫历史页')
  assert.equal(r2.stats.round.added, 0, '没有新帖')
  assert.equal(r2.stats.round.updated, 30, '顶部 10 条 × 3 板块只是刷新计数')
  assert.equal(r2.stats.reachedCutoff, true)
  // pool.stats 是当天累计值（coverageOf 读它），不是本轮增量
  assert.equal(r2.stats.requests, 15, '12 + 3 跨轮累加')
  assert.equal(r2.pool.stats.requests, 15)
  assert.equal(r2.pool.stats.added, 120, '累加：两轮都没有新帖')
  assert.equal(r2.pool.stats.updated, 30)
  assert.equal(Object.keys(r2.pool.posts).length, 120)
  for (const id of ids) assert.equal(r2.pool.sections[id].pages, 5, id + ' 只在第 1 轮基础上多了 1 页')
})

test('③ 重复 topicId 只留一份，计数用新数据覆盖，firstSeenAt 保留', async () => {
  const now = new Date(2026, 10, 15, 21, 30, 0)
  const mid = midnightOf(now)
  const dup1 = mkPost('dup', now.getTime() - 60 * MIN, { reply_count: 1 })
  const dup2 = mkPost('dup', now.getTime() - 120 * MIN, { reply_count: 5, views: 42 })
  const old = mkPost('old', mid - 60 * MIN)
  installFetch({ '301': { pages: pagesOf([dup1, dup2, old]) } })
  const cfg = cfgFor(['301'])
  const date = localDate(now)

  const r1 = await crawlDay(cfg, { date, now })
  assert.equal(Object.keys(r1.pool.posts).length, 2, '同 topicId 只留一份')
  assert.equal(r1.pool.posts.dup.replyCount, 5, '后到的计数覆盖先到的')
  assert.equal(r1.pool.posts.dup.views, 42)
  const firstSeen = r1.pool.posts.dup.firstSeenAt
  assert.equal(firstSeen, now.getTime())

  const now2 = new Date(now.getTime() + 5 * MIN)
  const r2 = await crawlDay(cfg, { date, now: now2 })
  assert.equal(r2.pool.posts.dup.firstSeenAt, firstSeen, 'firstSeenAt 不能被覆盖')
  assert.equal(r2.pool.posts.dup.lastSeenAt, now2.getTime())
  assert.equal(Object.keys(r2.pool.posts).length, 2)
})

test('④ crawlMaxRequests 到顶当轮停，下一轮接着补', async () => {
  const now = new Date(2026, 10, 16, 21, 30, 0)
  installFetch({ '401': { pages: daySection('401', now) }, '402': { pages: daySection('402', now) } })
  const date = localDate(now)

  // 新配置把预算放在 browse.coverage.crawlMaxRequests
  const r1 = await crawlDay({ browse: { sections: ['401', '402'], coverage: { crawlMaxRequests: 5 } } }, { date, now })
  assert.equal(r1.stats.round.requests, 5, '到顶立刻停')
  assert.equal(r1.pool.sections['401'].backfill.done, true)
  assert.equal(r1.pool.sections['402'].backfill.done, false, '没扫完的板块要留在 backfill 里')
  assert.equal(String(r1.pool.sections['402'].backfill.lastId), 'p1', '游标停在下一页')
  assert.equal(r1.stats.reachedCutoff, false)
  assert.ok(coverageOf(r1.pool).gaps.some((g) => g.id === '402'))

  // 旧配置写在顶层 browse.crawlMaxRequests 的也要认（向后兼容）
  const r2 = await crawlDay({ browse: { sections: ['401', '402'], crawlMaxRequests: 10 } }, { date, now: new Date(now.getTime() + 10 * MIN) })
  assert.equal(r2.stats.round.requests, 5, '401 前脸 1 + 402 前脸 1 + 402 补历史 3')
  assert.equal(r2.pool.sections['402'].backfill.done, true, '下一轮能把剩下的历史补完')
  assert.equal(r2.stats.reachedCutoff, true)
  assert.equal(r2.pool.stats.requests, 10, '预算计数跨轮累加（5 + 5）')
})

test('⑤ 单板块 code!=100 不整轮失败，记 gaps', async () => {
  const now = new Date(2026, 10, 17, 21, 30, 0)
  installFetch({ '501': { pages: daySection('501', now) }, '502': { errorCode: 1000 } })
  const r = await crawlDay({ browse: { sections: ['501', '502'] } }, { date: localDate(now), now })

  assert.equal(r.pool.sections['501'].backfill.done, true, '好板块照常扫完')
  assert.match(r.pool.sections['502'].error, /code=1000/)
  const cov = coverageOf(r.pool)
  assert.equal(cov.reachedCutoff, false)
  assert.ok(cov.gaps.some((g) => g.id === '502' && /code=1000/.test(g.reason)), '失败板块要出现在 gaps 里')
  assert.equal(cov.bySection.find((x) => x.id === '502').posts, 0)
  assert.equal(r.stats.round.requests, 5, '501 四页 + 502 一次失败尝试')
})

test('⑥ savePool/loadPool 往返 + 坏文件当空池', () => {
  const date = '2030-01-01'
  const pool = emptyPool(date)
  pool.sections['1'] = {
    id: '1', title: 'A 板', frontWmMs: 123,
    backfill: { lastId: 'x', cursor: 9, oldestMs: 456, done: true },
    pages: 2, requests: 2, lastRunAt: 42, error: '', today: 238000,
  }
  pool.posts['9001'] = {
    topicId: '9001', title: 't', content: 'c', sectionId: '1', sectionTitle: 'A 板',
    uid: 'u', nickname: 'n', replyCount: 3, commentCount: 0, upVote: 1, views: 9,
    isEssence: true, isTop: false, isOfficial: false, isContribution: false,
    timeMs: new Date(2030, 0, 1, 12).getTime(), editMs: 0, replyMs: 0, timeStr: '',
    contentLen: 1, firstSeenAt: 1, lastSeenAt: 2,
  }
  pool.stats.requests = 7
  savePool(pool)

  assert.ok(poolPath(date).endsWith('daypool-' + date + '.json'))
  assert.ok(fs.existsSync(poolPath(date)))
  const back = loadPool(date)
  assert.equal(back.date, date)
  assert.equal(back.sections['1'].title, 'A 板')
  assert.equal(back.sections['1'].frontWmMs, 123)
  assert.equal(back.sections['1'].today, 238000)
  assert.deepEqual(back.sections['1'].backfill, { lastId: 'x', cursor: 9, oldestMs: 456, done: true })
  assert.deepEqual(back.posts['9001'], pool.posts['9001'])
  assert.equal(back.stats.requests, 7)

  // 坏 JSON → 空池（池子是可重建缓存，读坏了不能把整轮抓取带崩）
  fs.writeFileSync(poolPath('2030-01-02'), '{ 这不是 JSON')
  const bad = loadPool('2030-01-02')
  assert.equal(bad.date, '2030-01-02')
  assert.deepEqual(bad.posts, {})
  assert.deepEqual(bad.sections, {})
  assert.deepEqual(bad.stats, { requests: 0, added: 0, updated: 0, skipped: 0 })
  // 文件不存在也当空池
  assert.deepEqual(loadPool('2030-01-03').posts, {})
})

test('⑦ reply_time 为 0000-00-00 时用 time 兜底，不提前结束翻页', async () => {
  const now = new Date(2026, 10, 18, 21, 30, 0)
  const mid = midnightOf(now)
  const p0 = []
  for (let i = 0; i < 10; i++) p0.push(mkPost('z' + i, now.getTime() - i * 10 * MIN))
  // 第 6 条没回复：reply_time 是占位值，只能靠 time（今天 20:40）判断它不老
  p0[5] = mkPost('z5', now.getTime() - 50 * MIN, { reply_time: '0000-00-00 00:00:00' })
  const p1 = []
  for (let i = 0; i < 10; i++) p1.push(mkPost('y' + i, mid - (10 + i * 10) * MIN))
  installFetch({ '601': { pages: [
    { key: '0', data: p0, nextLast: 'p1' },
    { key: 'p1', data: p1, nextLast: 'p1' },
  ] } })

  const r = await crawlDay({ browse: { sections: ['601'] } }, { date: localDate(now), now })
  assert.equal(r.stats.round.requests, 2, '零回复帖不该让翻页停在第 1 页')
  assert.equal(r.pool.sections['601'].backfill.done, true)
  assert.equal(calls.filter((c) => c.lastId === 'p1').length, 1, '确实翻到了第 2 页')
  assert.equal(r.pool.posts.z5.replyMs, 0)
  assert.equal(r.pool.posts.z5.timeMs, now.getTime() - 50 * MIN)
  assert.equal(coverageOf(r.pool).postsToday, 10)
})

test('⑧ 过滤 status/client_status/del_status/置顶/静音标题，-1 不当真', async () => {
  const now = new Date(2026, 10, 19, 21, 30, 0)
  const mid = midnightOf(now)
  const posts = [
    mkPost('keep1', now.getTime() - 1 * MIN, { is_essence: 1, is_official: 1, is_article_contribution: '1', content: '<p>你好</p>   世界</p>' }),
    mkPost('hide-status', now.getTime() - 2 * MIN, { status: '0' }),
    mkPost('hide-client', now.getTime() - 3 * MIN, { client_status: '4' }),
    mkPost('hide-del', now.getTime() - 4 * MIN, { del_status: '2' }),
    mkPost('hide-top', now.getTime() - 5 * MIN, { is_top: 1 }),
    mkPost('hide-mute', now.getTime() - 6 * MIN, { title: '开奖结果公布' }),
    mkPost('long', now.getTime() - 7 * MIN, { content: 'x'.repeat(700) }),
    mkPost('old', mid - 60 * MIN),
  ]
  installFetch({ '701': { pages: pagesOf(posts) } })
  const r = await crawlDay(cfgFor(['701'], { muteTitles: ['开奖'] }), { date: localDate(now), now })

  assert.deepEqual(Object.keys(r.pool.posts).sort(), ['keep1', 'long', 'old'])
  assert.equal(r.stats.round.skipped, 5, '不可见 3 条 + 置顶 1 条 + 静音标题 1 条')
  const keep = r.pool.posts.keep1
  assert.equal(keep.content, '你好 世界', '去 HTML、压空白')
  assert.equal(keep.isEssence, true)
  assert.equal(keep.isOfficial, true)
  assert.equal(keep.isContribution, true)
  assert.equal(keep.isTop, false, '-1 不能用 !! 判真')
  assert.equal(r.pool.posts.long.content.length, 600, '正文截 600')
  assert.equal(r.pool.posts.long.contentLen, 700, 'contentLen 记全文长度')
})

test('⑨ sectionsFor：手配优先、目录按今日讨论量降序去重、目录失败退回默认', async () => {
  // 手配：字符串 + {id,title} 混着来，按 id 去重；手配了就不该去拉目录
  installFetch({})
  const explicit = await sectionsFor({ browse: { sections: ['23064', { id: '3', title: '综合讨论' }, '23064'] } })
  assert.deepEqual(explicit.map((x) => [x.id, x.title]), [['23064', ''], ['3', '综合讨论']])
  assert.equal(calls.length, 0, '手配板块后不应请求目录')

  // 目录：有重复 id，今日讨论量是「23.8万」这种字符串，要解析后降序
  catalogStub = { code: 100, result: { data: [
    { type_name: 'g1', list: [
      { id: '1', title: 'A', discuss_num: '999', today_discuss_num: '23.8万' },
      { id: '2', title: 'B', discuss_num: '1', today_discuss_num: '1.2万' },
    ] },
    { type_name: 'g2', list: [
      { id: '1', title: 'A 重复', discuss_num: '0', today_discuss_num: '99万' },
      { id: '3', title: 'C', discuss_num: '0', today_discuss_num: '800' },
    ] },
  ] } }
  installFetch({})
  const byCat = await sectionsFor({ browse: {} })
  assert.deepEqual(byCat.map((x) => x.id), ['1', '2', '3'], '按今日讨论量降序、重复 id 只留一份')
  assert.equal(byCat[0].title, 'A', '重复 id 取先出现的标题')
  assert.equal(byCat[0].today, 238000, '「23.8万」要解析成 238000')

  // 全站目录按 coverage.maxSections 封顶（降序截断），旧字段 browse.maxSections 兼容
  const capped = await sectionsFor({ browse: { coverage: { maxSections: 2 } } })
  assert.deepEqual(capped.map((x) => x.id), ['1', '2'])
  const cappedLegacy = await sectionsFor({ browse: { maxSections: 2 } })
  assert.deepEqual(cappedLegacy.map((x) => x.id), ['1', '2'])

  // 目录失败 → 退回 defaultSections
  catalogStub = { code: 500, msg: 'down' }
  installFetch({})
  const fallback = await sectionsFor({ browse: { defaultSections: ['23064', '3', '23064'] } })
  assert.deepEqual(fallback.map((x) => x.id), ['23064', '3'])
})

test('⑩ 翻到空页（流到头）也算当天扫全，不会永远 done 不了', async () => {
  const now = new Date(2026, 10, 20, 21, 30, 0)
  // 只有 5 条今天发的帖，第 2 页直接空：这种低流量板块也必须能判 done
  const posts = []
  for (let i = 0; i < 5; i++) posts.push(mkPost('e' + i, now.getTime() - (i + 1) * MIN))
  installFetch({ '801': { pages: [{ key: '0', data: posts, nextLast: 'p1' }] } })
  const r = await crawlDay({ browse: { sections: ['801'] } }, { date: localDate(now), now })

  assert.equal(r.stats.round.requests, 2, '第 1 页有数据 + 第 2 页空')
  assert.equal(r.pool.sections['801'].backfill.done, true, '空页要判成已扫全')
  assert.equal(r.stats.reachedCutoff, true)
  const cov = coverageOf(r.pool)
  assert.equal(cov.postsToday, 5)
  assert.equal(cov.oldestCoveredMs, midnightOf(now))
})

test.after(() => {
  globalThis.fetch = realFetch
  fs.rmSync(home, { recursive: true, force: true })
})
