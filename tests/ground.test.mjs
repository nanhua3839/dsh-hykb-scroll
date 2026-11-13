// ground 的离线测试：不联网、不读写用户目录，只验「事实由代码拥有」这件事。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildEvidence,
  digestProsePrompt,
  parseProseJson,
  validateProse,
  fallbackWhy,
  renderReport,
  renderCoverageLine,
} from '../tools/lib/ground.mjs'

// 围栏用转义写，测试文件里不出现真的反引号，避免和模板字符串打架
const FENCE = '\u0060\u0060\u0060'
const NO_BAD_WORDS = /undefined|NaN|null/

const COVERAGE = {
  sections: 3,
  reachedCutoff: true,
  postsToday: 87,
  requests: 12,
  gaps: [],
  platformToday: 1200,
  bySection: [
    { id: '23064', title: '爆友生活区', posts: 40, todayPosts: 12 },
    { id: '23066', title: '游戏攻略区', posts: 22, todayPosts: 20 },
  ],
}

const mkPick = (over = {}) => ({
  topicId: '111',
  title: '二游的定义该怎么算',
  content: '最近群里一直在吵二游的边界',
  sectionId: '23064',
  sectionTitle: '爆友生活区',
  uid: 'u1',
  nickname: '老张',
  replyCount: 34,
  commentCount: 2,
  upVote: 12,
  views: 210,
  timeMs: Date.parse('2026-11-13T01:20:00Z'),
  timeStr: '2026-11-13 09:20',
  score: 47.5,
  contentLen: 86,
  dims: { heat: 0.88, discussion: 0.95, quality: 0.7, freshness: 0.6 },
  stats: { reply: 34, comment: 2, upVote: 12, views: 210, participants: 12, lastReply: '2026-11-13 10:02' },
  quotes: [
    { nickname: '阿明', text: '我觉得要看内容导向', upVote: 5 },
    { nickname: '小柯', text: '定义这种东西本来就模糊', upVote: 2 },
  ],
  gist: '楼主在问二游的定义边界，楼下给了两种口径。',
  ...over,
})

const mkPick2 = () => mkPick({
  topicId: '222',
  title: 'PV 里的战斗系统是不是换皮',
  sectionId: '23066',
  sectionTitle: '游戏攻略区',
  replyCount: 18,
  commentCount: 1,
  upVote: 4,
  views: 90,
  score: 33,
  contentLen: 120,
  stats: { reply: 18, comment: 1, upVote: 4, views: 90, participants: 6, lastReply: '2026-11-13 11:00' },
  quotes: [{ nickname: '阿凯', text: '实机肯定还要再看一遍', upVote: 1 }],
  gist: '楼主怀疑战斗系统换皮，楼下在等实机演示。',
  dims: { heat: 0.7, discussion: 0.6, quality: 0.8, freshness: 0.9 },
})

const EV = buildEvidence({ date: '2026-11-13', picks: [mkPick(), mkPick2()], coverage: COVERAGE })
const URL1 = 'https://bbs.3839.com/thread-111.htm'
const URL2 = 'https://bbs.3839.com/thread-222.htm'

/* ───────────── 1. 编造数字 ───────────── */

test('编造的数字：整句 dropped，renderReport 退回 fallbackWhy', () => {
  const v = validateProse('这帖回复 999，热度很高。', EV)
  assert.equal(v.ok, false)
  assert.equal(v.dropped.length, 1)
  assert.equal(v.dropped[0].reason, 'number')
  assert.equal(v.dropped[0].sentence, '这帖回复 999，热度很高。')
  assert.equal(v.text, '')

  const md = renderReport(EV, {
    overview: ['今天回复 999 的帖子最多。'],
    posts: { 1: '这帖回复 999，热度很高。' },
    mode: 'ai',
  })
  assert.ok(!md.includes('999'))
  assert.ok(md.includes('入选理由：' + fallbackWhy(EV.picks[0])))
  assert.ok(md.includes('## 值得看的 2 帖'))
})

/* ───────────── 2. 编造链接 ───────────── */

test('编造链接：丢弃；证据里的链接放行', () => {
  const bad = validateProse('原文在 http://evil.example/thread-111.htm 。', EV)
  assert.equal(bad.ok, false)
  assert.equal(bad.dropped[0].reason, 'url')

  const good = validateProse('原文在 ' + URL1 + ' 里。', EV)
  assert.equal(good.ok, true)
  assert.equal(good.stats.urls, 1)

  const md = renderReport(EV, { posts: { 1: '详见 http://evil.example/thread-111.htm 。' }, mode: 'ai' })
  assert.ok(!md.includes('evil.example'))
  assert.ok(md.includes('入选理由：' + fallbackWhy(EV.picks[0])))
})

/* ───────────── 3. 编造引文 ───────────── */

test('编造引文（「…」）：丢弃；语料里的引文放行', () => {
  const bad = validateProse('有人说是「这帖里根本没有出现过的原话」。', EV)
  assert.equal(bad.ok, false)
  assert.equal(bad.dropped[0].reason, 'quote')

  const good = validateProse('阿明那句「我觉得要看内容导向」被顶到 5 赞。', EV)
  assert.equal(good.ok, true)
  assert.equal(good.stats.quotes, 1)
})

/* ───────────── 4. 引用不存在的编号 ───────────── */

test('引用不存在的【99】：丢弃；【1】放行', () => {
  const bad = validateProse('【99】这帖很有意思。', EV)
  assert.equal(bad.ok, false)
  assert.equal(bad.dropped[0].reason, 'cite')

  const good = validateProse('【1】这帖在问二游的定义边界。', EV)
  assert.equal(good.ok, true)
  assert.equal(good.stats.citations, 1)
})

/* ───────────── 5. 合法材料全部保留 ───────────── */

test('合法材料里的数字 / 引文 / 编号都保留', () => {
  const v = validateProse('【2】回复 18 说明大家在等实机，阿凯那句「实机肯定还要再看一遍」是主流态度。', EV)
  assert.deepEqual(v.dropped, [])
  assert.equal(v.ok, true)
  assert.ok(v.text.includes('回复 18'))
  assert.ok(v.text.includes('【2】'))
  assert.equal(v.stats.sentences, 1)
  assert.equal(v.stats.kept, 1)
  assert.equal(v.stats.citations, 1)
  assert.equal(v.stats.quotes, 1)
})

test('validateProse 逐句判定：好句留、坏句丢', () => {
  const v = validateProse('【1】这帖在问定义。第二条是编的 999。', EV)
  assert.equal(v.stats.sentences, 2)
  assert.equal(v.stats.kept, 1)
  assert.equal(v.dropped.length, 1)
  assert.equal(v.text, '【1】这帖在问定义。')
})

/* ───────────── 6. fallback 模式 ───────────── */

test("mode='fallback'：整份报告不含模型文字，但结构完整", () => {
  const md = renderReport(EV, {
    overview: ['今天模型编的概览。'],
    posts: { 1: '模型编的点评。', 2: '模型编的第二条点评。' },
    mode: 'fallback',
  })
  assert.ok(md.startsWith('# 好游快爆 · 日报 2026-11-13'))
  assert.ok(!md.includes('模型编的'))
  assert.ok(!NO_BAD_WORDS.test(md))
  assert.ok(md.includes(URL1))
  assert.ok(md.includes(URL2))
  for (const h of ['## 今天论坛在聊什么', '## 值得看的 2 帖', '## 今日板块分布', '## 这期怎么排的', '## 原帖链接']) {
    assert.ok(md.includes(h), '缺少章节 ' + h)
  }
  assert.ok(md.includes(fallbackWhy(EV.picks[0])))
  assert.ok(md.includes(fallbackWhy(EV.picks[1])))
  // 引用楼层由代码渲染
  assert.ok(md.includes('> 阿明：我觉得要看内容导向（赞 5）'))
})

test('ai 模式整份报告也不含 undefined / NaN', () => {
  const md = renderReport(EV, {
    overview: ['今天这批帖子在聊二游的定义和换皮争议。'],
    posts: { 1: '【1】这帖在问二游的定义边界。' },
    mode: 'ai',
  })
  assert.ok(!NO_BAD_WORDS.test(md))
  assert.ok(md.includes('点评：《二游的定义该怎么算》这帖在问二游的定义边界。'))
})

test('概览里只留通过校验的句子，坏句不进日报', () => {
  const md = renderReport(EV, {
    overview: ['今天回复 999 的帖子最多。', '【1】这帖在问二游的定义边界。'],
    posts: {},
  })
  assert.ok(!md.includes('999'))
  assert.ok(md.includes('- 《二游的定义该怎么算》这帖在问二游的定义边界。'))
  assert.ok(md.includes('入选理由：' + fallbackWhy(EV.picks[0])))
})

/* ───────────── 7. parseProseJson ───────────── */

test('parseProseJson 容忍围栏与前后废话', () => {
  const raw = '好的，下面是这份日报：\n'
    + FENCE + 'json\n'
    + '{"overview":["今天在聊二游定义。","还有换皮争议。"],"posts":{"1":"这帖在问定义边界。","2":"这帖在等实机。"}}\n'
    + FENCE + '\n以上。'
  const r = parseProseJson(raw)
  assert.deepEqual(r.overview, ['今天在聊二游定义。', '还有换皮争议。'])
  assert.equal(r.posts['1'], '这帖在问定义边界。')
  assert.equal(r.posts['2'], '这帖在等实机。')
})

test('parseProseJson 坏 JSON / 空输入返回空结构且不抛错', () => {
  const empty = { overview: [], posts: {} }
  assert.deepEqual(parseProseJson('完全不是 JSON'), empty)
  assert.deepEqual(parseProseJson('{"overview":['), empty)
  assert.deepEqual(parseProseJson(''), empty)
  assert.deepEqual(parseProseJson(null), empty)
  assert.deepEqual(parseProseJson(undefined), empty)
  assert.deepEqual(parseProseJson('{"overview":[],"posts":{}}'), empty)
  assert.deepEqual(parseProseJson('{"overview":"一句概览","posts":[]}'), { overview: ['一句概览'], posts: {} })
})

/* ───────────── 8. 缺 posts[n] 时兜底 ───────────── */

test('缺少 posts[1] 时自动用 fallbackWhy，结构完整', () => {
  const md = renderReport(EV, { posts: { 2: '【2】这帖在等实机。' } })
  assert.ok(md.includes('入选理由：' + fallbackWhy(EV.picks[0])))
  assert.ok(md.includes('点评：《PV 里的战斗系统是不是换皮》这帖在等实机。'))
  assert.ok(md.includes('### 1. 二游的定义该怎么算'))
  assert.ok(md.includes('### 2. PV 里的战斗系统是不是换皮'))
  assert.ok(!NO_BAD_WORDS.test(md))
  assert.ok(md.includes(URL1))
  assert.ok(md.includes(URL2))
})

/* ───────────── 9. 证据包 ───────────── */

test('buildEvidence：idx 从 1、链接由 threadUrl 拼、语料含引文与统计', () => {
  assert.equal(EV.date, '2026-11-13')
  assert.deepEqual(EV.picks.map((p) => p.idx), [1, 2])
  assert.equal(EV.picks[0].url, URL1)
  assert.equal(EV.picks[1].url, URL2)
  assert.deepEqual(EV.urls, [URL1, URL2])
  assert.ok(EV.corpus.includes('我觉得要看内容导向'))
  assert.ok(EV.corpus.includes('楼主在问二游的定义边界'))
  assert.ok(EV.corpus.includes('实机肯定还要再看一遍'))
  // stats.participants / stats.lastReply 也进证据
  assert.equal(EV.picks[0].participants, 12)
  assert.equal(EV.picks[0].lastReply, '2026-11-13 10:02')
  assert.ok(EV.corpus.includes('2026-11-13 10:02'))
  assert.ok(EV.numbers.includes(34))
  assert.ok(EV.numbers.includes(18))
  assert.ok(EV.numbers.includes(2026))
  assert.ok(EV.numbers.includes(5)) // discussion 0.95 → 今日前 5%
  assert.equal(typeof EV.generatedAt, 'string')
  assert.ok(EV.generatedAt.length > 0)
  assert.equal(EV.coverage.postsToday, 87)
})

test('buildEvidence 容忍字段缺失，不编标题 / 板块 / 数字', () => {
  const ev = buildEvidence({ date: '2026-11-13', picks: [{ topicId: '9' }] })
  assert.equal(ev.picks[0].title, '(无标题)')
  assert.equal(ev.picks[0].url, 'https://bbs.3839.com/thread-9.htm')
  assert.equal(ev.picks[0].sectionTitle, '未标板块')
  assert.equal(ev.picks[0].reply, null)
  const md = renderReport(ev, { mode: 'fallback' })
  assert.ok(!NO_BAD_WORDS.test(md))
  assert.ok(md.includes('### 1. (无标题)'))
  assert.ok(md.includes('https://bbs.3839.com/thread-9.htm'))
})

/* ───────────── 10. 覆盖行 / 板块分布 ───────────── */

test('renderCoverageLine：完整 / 缺字段 / 空都不出 undefined', () => {
  assert.equal(renderCoverageLine(COVERAGE), '覆盖：3 个板块 · 今日抓到 87 帖 · 12 次请求 · 已翻到当日首帖')
  assert.equal(renderCoverageLine({ sections: 2 }), '覆盖：2 个板块')
  assert.equal(renderCoverageLine(undefined), '覆盖：本轮没有覆盖数据')
  assert.equal(renderCoverageLine({ bySection: [{ id: '9', title: '测试区', todayPosts: 4 }] }), '覆盖：1 个板块')
  assert.equal(renderCoverageLine({ postsToday: 3 }), '覆盖：今日抓到 3 帖')
  assert.ok(!NO_BAD_WORDS.test(renderCoverageLine({ requests: 5, reachedCutoff: false })))
})

test('今日板块分布按 todayPosts 降序，没有 bySection 就整段省略', () => {
  const md = renderReport(EV, { mode: 'fallback' })
  const start = md.indexOf('## 今日板块分布')
  assert.ok(start > 0)
  const dist = md.slice(start, md.indexOf('## 这期怎么排的'))
  assert.ok(dist.includes('- 游戏攻略区：今日 20 帖 / 池内 22 帖'))
  assert.ok(dist.includes('- 爆友生活区：今日 12 帖 / 池内 40 帖'))
  assert.ok(dist.indexOf('游戏攻略区') < dist.indexOf('爆友生活区'))

  const noDist = renderReport(
    buildEvidence({ date: '2026-11-13', picks: [mkPick()], coverage: { sections: 1, postsToday: 3, requests: 1 } }),
    { mode: 'fallback' },
  )
  assert.ok(!noDist.includes('## 今日板块分布'))
  assert.ok(noDist.includes('覆盖：1 个板块 · 今日抓到 3 帖 · 1 次请求'))
})

/* ───────────── 11. fallbackWhy ───────────── */

test('fallbackWhy 只由数字和分位数拼，有参与人数时优先人数', () => {
  assert.equal(fallbackWhy(EV.picks[0]), '回复 34 · 12 人参与 · 赞/看 6%，讨论度今日前 5%')
  assert.equal(fallbackWhy(EV.picks[1]), '回复 18 · 6 人参与 · 赞/看 4%，讨论度今日前 40%')
  assert.equal(fallbackWhy(EV.picks[0]), fallbackWhy(EV.picks[0]))
  assert.ok(!fallbackWhy(EV.picks[0]).includes('值得一看'))
})

test('fallbackWhy：没有参与人数时退回回复 / 赞 / 浏览', () => {
  const ev = buildEvidence({
    date: '2026-11-13',
    picks: [mkPick({
      stats: { reply: 34, comment: 2, upVote: 12, views: 210, lastReply: '2026-11-13 10:02' },
      dims: { heat: 0.88 },
    })],
    coverage: COVERAGE,
  })
  assert.equal(fallbackWhy(ev.picks[0]), '回复 34 · 赞 12 · 浏览 210，热度今日前 12%')
})

test('fallbackWhy 在没有统计时也给一句确定的话，不出现 undefined / NaN', () => {
  const why = fallbackWhy({})
  assert.equal(typeof why, 'string')
  assert.ok(why.length > 0)
  assert.ok(!NO_BAD_WORDS.test(why))
  assert.equal(fallbackWhy({ score: 12.5 }), '本轮打分 12.5，按分数排序入选')
})

/* ───────────── 12. 提示词 ───────────── */

test('digestProsePrompt：系统提示写死硬规则，用户材料带编号与 JSON 格式', () => {
  const msgs = digestProsePrompt(EV, { persona: { name: '小号', ownerTitle: '主人', style: '口语' }, style: '口语' })
  assert.equal(msgs.length, 2)
  assert.equal(msgs[0].role, 'system')
  assert.equal(msgs[1].role, 'user')
  const sys = msgs[0].content
  for (const rule of ['不写链接', '不写数字', '【n】', '编造', 'JSON', '只写材料里']) {
    assert.ok(sys.includes(rule), '系统提示缺少规则：' + rule)
  }
  const user = msgs[1].content
  assert.ok(user.includes('【1】'))
  assert.ok(user.includes('【2】'))
  assert.ok(user.includes('"overview"'))
  assert.ok(user.includes('编号范围 1 - 2'))
  assert.ok(user.includes('回复 34'))
  assert.ok(user.includes('讨论度前 5%'))
  // 空证据也能生成提示词（不抛错、不出现 undefined）
  const msgs2 = digestProsePrompt(buildEvidence({ date: '2026-11-13', picks: [] }))
  assert.ok(!NO_BAD_WORDS.test(msgs2[0].content + msgs2[1].content))
})

/* ───────────── 13. 代码写的字段不被模型覆盖 ───────────── */

test('标题 / 链接 / 统计由代码渲染，模型文字只进点评位', () => {
  const md = renderReport(EV, {
    overview: [],
    posts: { 1: '【1】这句是合规的。' },
  })
  assert.ok(md.includes('### 1. 二游的定义该怎么算'))
  assert.ok(md.includes('链接：' + URL1))
  assert.ok(md.includes('作者 老张'))
  assert.ok(md.includes('47.5 分'))
  assert.ok(md.includes('## 原帖链接'))
  assert.ok(md.includes('1. 二游的定义该怎么算 — ' + URL1))
  assert.ok(md.includes('2. PV 里的战斗系统是不是换皮 — ' + URL2))
})

/* ───────────── 14. 【n】在校验通过后展开成《标题》 ───────────── */

test('校验通过后【n】展开成《标题》，最终日报里不留编号', () => {
  const md = renderReport(EV, {
    overview: ['【1】和【2】都在聊同一个焦虑。'],
    posts: { 1: '【1】这帖在问定义。', 2: '【2】这帖在等实机。' },
  })
  assert.ok(!/【\d+】/.test(md), '最终日报不应再出现【n】编号')
  assert.ok(md.includes('- 《二游的定义该怎么算》和《PV 里的战斗系统是不是换皮》都在聊同一个焦虑。'))
  assert.ok(md.includes('点评：《二游的定义该怎么算》这帖在问定义。'))
  assert.ok(md.includes('点评：《PV 里的战斗系统是不是换皮》这帖在等实机。'))
  // 没通过校验的句子不展开、也不进日报
  const bad = renderReport(EV, { overview: ['【1】编的 999。'] })
  assert.ok(!bad.includes('999'))
  assert.ok(!bad.includes('《二游的定义该怎么算》编的'))
})

/* ───────────── 15. 上游 p.reason 优先 ───────────── */

test('上游 p.reason 存在时优先作为入选理由，否则用 fallbackWhy', () => {
  const withReason = buildEvidence({
    date: '2026-11-13',
    picks: [mkPick({ reason: '四维加权 0.82，热度今日前 12%' })],
    coverage: COVERAGE,
  })
  const md = renderReport(withReason, { mode: 'fallback' })
  assert.ok(md.includes('入选理由：四维加权 0.82，热度今日前 12%'))
  assert.ok(!md.includes('入选理由：' + fallbackWhy(withReason.picks[0])))

  const noReason = buildEvidence({ date: '2026-11-13', picks: [mkPick()], coverage: COVERAGE })
  assert.ok(renderReport(noReason, { mode: 'fallback' }).includes('入选理由：' + fallbackWhy(noReason.picks[0])))
})

/* ───────────── 16. 评分口径（新四维口径） ───────────── */

test('评分口径用四维分位数新口径，并写明跨天不可比', () => {
  const md = renderReport(EV, { mode: 'fallback' })
  assert.ok(md.includes('热度/讨论度/质量/活跃度四维打分'))
  assert.ok(md.includes('30/35/22/13'))
  assert.ok(md.includes('分位数'))
  assert.ok(md.includes('跨天不可直接比'))
  assert.ok(!md.includes('回复×3'))
})
