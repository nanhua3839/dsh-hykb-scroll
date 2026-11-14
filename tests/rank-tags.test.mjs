// 兴趣标签硬加权的离线单测：不联网、不读配置，全部用小 fixture。
// 两个必须守住的点：
//   1) 标签层只在四维分之后加减分 —— 所以「标签为空 / weight<=0」要逐帖回到改动前的分值，
//      这里不是「差不多就行」，是对着独立重算的旧公式做 === 断言；
//   2) 标签为空时 digestPrompt 与没有这个功能时逐字相同，否则回退开关是假的。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  DEFAULT_WEIGHTS, DIMENSIONS, rawDims, pctRank, scorePool, selectPicks, explainPick,
  interestLabels, matchInterests,
} from '../tools/lib/rank.mjs'

// ai.mjs 会读 ~/.hykb-ai 之类路径，先把它指到临时目录再 import（与 ai-wire.test.mjs 同一套办法）。
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hykb-tags-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSH_HOME = path.join(home, '.dsh')
fs.mkdirSync(path.join(home, '.dsh'), { recursive: true })
const { digestPrompt } = await import('../tools/lib/ai.mjs')

const NOW = Date.parse('2026-11-13T12:00:00Z')
const H = 3600000

const mk = (over = {}) => ({
  topicId: '1', title: 't', sectionId: '23064', sectionTitle: '爆友生活区',
  uid: 'u1', nickname: 'n1', content: '', contentLen: 0,
  timeMs: NOW, replyMs: NOW, replyCount: 0, commentCount: 0, upVote: 0, views: 0,
  isEssence: false, isTop: false, isOfficial: false, isContribution: false, ...over,
})

/** 一个 12 帖的池子：n>=8 走 midrank 分支，分数铺得开，加减分有空间看得出差别。 */
const pool = () => [
  mk({ topicId: 'g1', uid: 'g1', sectionId: 'S1', title: '游戏区今天这个瓜真香', content: '聊聊新版本', contentLen: 260, replyCount: 24, commentCount: 6, upVote: 9, views: 320, timeMs: NOW - 3 * H, replyMs: NOW - H }),
  mk({ topicId: 'g2', uid: 'g2', sectionId: 'S2', title: '换了个显示器', content: '数码党进来看看这块面板', contentLen: 200, replyCount: 12, upVote: 5, views: 180, timeMs: NOW - 5 * H, replyMs: NOW - 2 * H }),
  mk({ topicId: 'g3', uid: 'g3', sectionId: 'S3', title: '求推荐一部片', content: '影视动漫区的朋友说说', contentLen: 150, replyCount: 8, upVote: 3, views: 120, timeMs: NOW - 7 * H, replyMs: NOW - 3 * H }),
  ...Array.from({ length: 9 }, (_, i) => mk({
    topicId: 'w' + i, uid: 'w' + i, sectionId: 'W' + i,
    title: '随手一帖 ' + i, content: '今天天气不错，出去走了走。'.repeat(3), contentLen: 120 + i * 10,
    replyCount: 2 + i, upVote: 1 + i, views: 60 + i * 20,
    timeMs: NOW - (4 + i) * H, replyMs: NOW - (1 + i) * H,
  })),
]

/**
 * 改动前的打分公式（四维分位 + 归一权重 → 0–100），独立重算一遍：
 * 用它当基准，才能断言「回退时逐帖完全相等」，而不是拿同一个函数自己跟自己比。
 */
const legacyScoreOf = (posts, now = NOW) => {
  // 默认权重同样要按和归一（scorePool 内部就是这么做的）：0.30+0.35+0.22+0.13 在浮点下不是精确的 1，
  // 不归一会在一分小数位的边界上差 0.1，那不是行为变化而是我这份基准算错了。
  const total = DIMENSIONS.reduce((s, d) => s + DEFAULT_WEIGHTS[d], 0)
  const w = {}
  for (const d of DIMENSIONS) w[d] = DEFAULT_WEIGHTS[d] / total
  const raws = posts.map((p) => rawDims(p, { now }))
  const pcts = DIMENSIONS.map((d) => pctRank(raws.map((r) => r[d])))
  const out = new Map()
  posts.forEach((p, i) => {
    let sum = 0
    DIMENSIONS.forEach((d, k) => { sum += w[d] * pcts[k][i] })
    out.set(String(p.topicId), Math.round(sum * 1000) / 10)
  })
  return out
}

test('interestLabels：tags + custom 合并去重，trim、大小写不敏感、丢空串', () => {
  const labels = interestLabels({ tags: ['游戏', ' 数码 '], custom: ['游戏', 'GAME', 'game', '', '   ', '影视动漫'], weight: 10 })
  assert.deepEqual(labels, ['游戏', '数码', 'GAME', '影视动漫'])
  // 缺字段 / 非对象 / 空配置都不能炸
  assert.deepEqual(interestLabels(undefined), [])
  assert.deepEqual(interestLabels({}), [])
  assert.deepEqual(interestLabels({ tags: [], custom: [] }), [])
})

test('matchInterests：标题 / 正文 / 板块名 任一处出现就算命中，可取出命中列表', () => {
  const interests = { tags: ['游戏', '数码'], custom: ['影视动漫', '福利'], weight: 10 }
  // 标题命中
  assert.deepEqual(matchInterests(mk({ title: '游戏区的事', content: '', sectionTitle: '爆友生活区' }), interests), ['游戏'])
  // 正文命中
  assert.deepEqual(matchInterests(mk({ title: '求助', content: '想买个新的数码产品', sectionTitle: '爆友生活区' }), interests), ['数码'])
  // 板块名命中（标题正文都不提）
  assert.deepEqual(matchInterests(mk({ title: '随手', content: '路过', sectionTitle: '影视动漫' }), interests), ['影视动漫'])
  // 多个命中，顺序跟标签配置一致
  assert.deepEqual(
    matchInterests(mk({ title: '数码 + 游戏双修', content: '顺便发点福利', sectionTitle: '爆友生活区' }), interests),
    ['游戏', '数码', '福利'],
  )
  // 全不命中
  assert.deepEqual(matchInterests(mk({ title: '随手', content: '路过', sectionTitle: '爆友生活区' }), interests), [])
  // 大小写不敏感（英文标签）
  assert.deepEqual(matchInterests(mk({ title: 'Today GAME night', content: '' }), { tags: ['game'], weight: 10 }), ['game'])
  // 正文里的 HTML 属性值不算命中（英文标签最容易踩这个坑）
  assert.deepEqual(matchInterests(mk({ title: '随手', content: '<div class="demo">路过</div>' }), { tags: ['demo'], weight: 10 }), [])
})

test('scorePool：命中一个 +weight、命中多个 +N×weight、全不命中 -weight', () => {
  const weight = 3
  const interests = { tags: ['游戏', '数码'], custom: [], weight }
  const posts = pool()
  const base = legacyScoreOf(posts)
  const scored = scorePool(posts, { now: NOW, interests })
  const byId = new Map(scored.map((s) => [String(s.topicId), s]))

  const g1 = byId.get('g1') // 只标题里出现「游戏」
  assert.deepEqual(g1.interestHits, ['游戏'])
  assert.equal(g1.score, Math.round((base.get('g1') + weight) * 10) / 10)
  assert.equal(g1.interestDelta, weight)

  const g2 = byId.get('g2') // 正文出现「数码」
  assert.deepEqual(g2.interestHits, ['数码'])
  assert.equal(g2.score, Math.round((base.get('g2') + weight) * 10) / 10)

  const plain = byId.get('w0') // 一个都不中
  assert.deepEqual(plain.interestHits, [])
  assert.equal(plain.score, Math.round((base.get('w0') - weight) * 10) / 10)
  assert.equal(plain.interestDelta, -weight)
})

test('scorePool：多命中叠加，加减分后 clamp 回 0–100', () => {
  const posts = pool()
  const base = legacyScoreOf(posts)
  const scored = scorePool(posts, {
    now: NOW,
    interests: { tags: ['游戏', '数码', '影视动漫'], custom: [], weight: 5 },
  })
  const g3 = scored.find((s) => s.topicId === 'g3') // 标题命不中，正文「影视动漫」命中
  assert.deepEqual(g3.interestHits, ['影视动漫'])

  // clamp 上界：权重给到离谱也压不过 100
  const huge = scorePool(posts, { now: NOW, interests: { tags: ['游戏'], custom: [], weight: 1000 } })
  assert.equal(huge.find((s) => s.topicId === 'g1').score, 100)
  // clamp 下界：全不命中的帖扣到底也是 0
  assert.equal(huge.find((s) => s.topicId === 'w0').score, 0)

  // 没有 clamp 介入时，分差就是 Σ 命中数 ×weight
  const small = scorePool(posts, { now: NOW, interests: { tags: ['游戏'], custom: [], weight: 2 } })
  for (const s of small) {
    const b = base.get(String(s.topicId))
    const expect = Math.max(0, Math.min(100, b + (s.interestHits.length ? s.interestHits.length * 2 : -2)))
    assert.equal(s.score, Math.round(expect * 10) / 10, s.topicId + ' 分值应为基准分 ± 标签加减分')
  }
})

test('回退：label 空 / weight=0 / 不传 interests，逐帖与改动前完全相等（连字段都不多）', () => {
  const posts = pool()
  const base = legacyScoreOf(posts)

  const variants = [
    scorePool(posts, { now: NOW }), // 老调用方，压根不传 interests
    scorePool(posts, { now: NOW, interests: undefined }),
    scorePool(posts, { now: NOW, interests: { tags: [], custom: [], weight: 10 } }), // 标签为空
    scorePool(posts, { now: NOW, interests: { tags: ['  '], custom: [''], weight: 10 } }), // 标签全是空白
    scorePool(posts, { now: NOW, interests: { tags: ['游戏', '数码'], custom: [], weight: 0 } }), // 标签有但 weight=0
    scorePool(posts, { now: NOW, interests: { tags: ['游戏'], custom: [], weight: -10 } }), // 负权重 = 关掉
  ]

  const plain = scorePool(posts, { now: NOW })
  for (const v of variants) {
    // JSON 逐字段相等：连键集合和字段顺序都一致，不会多出 interestHits 之类的空字段
    assert.equal(JSON.stringify(v), JSON.stringify(plain))
    for (const s of v) {
      assert.equal(s.score, base.get(String(s.topicId)), '回退时逐帖分值必须相等：' + s.topicId)
      assert.equal('interestHits' in s, false)
      assert.equal('interestDelta' in s, false)
    }
  }
})

test('explainPick：命中标签写进解释，没命中的帖不出现这半句', () => {
  const posts = pool()
  // weight 取 2：g1 是池子里分最高的帖，加 10 会撞 100 上限，那个 delta 就不是 10 了（clamp 是对的，
  // 但这里要验的是「解释里报出的加减分和真实加分一致」）。
  const scored = scorePool(posts, { now: NOW, interests: { tags: ['游戏'], custom: [], weight: 2 } })
  const hit = scored.find((s) => s.topicId === 'g1')
  const miss = scored.find((s) => s.topicId === 'w0')
  assert.equal(hit.interestDelta, 2)

  const hitWhy = explainPick(hit, { total: posts.length })
  assert.match(hitWhy, /命中标签 游戏 \+2/, hitWhy)
  assert.ok(!/undefined|NaN/.test(hitWhy), hitWhy)

  const missWhy = explainPick(miss, { total: posts.length })
  assert.ok(!missWhy.includes('命中标签'), missWhy)
  assert.ok(!/undefined|NaN/.test(missWhy), missWhy)

  // 选帖后的 why 字段同样能看到命中原因（面板/日报都读它）
  const { picks } = selectPicks(scored, { pick: 3, now: NOW, perSectionMax: 3, perAuthorMax: 1 })
  const g1Pick = picks.find((p) => p.topicId === 'g1')
  assert.ok(g1Pick, 'g1 应进入 picks')
  assert.match(g1Pick.why, /命中标签 游戏 \+2/, g1Pick.why)
})

test('digestPrompt：标签为空时与改动前逐字相同', () => {
  const persona = { name: '小号', ownerTitle: '主人', style: '口语' }
  const picks = [{
    topicId: '12345', title: '游戏区今天这个瓜真香', sectionTitle: '爆友生活区',
    score: 72.5, replyCount: 24, upVote: 9, content: '聊聊新版本', gist: '楼主在说新版本的问题',
  }]
  const plain = digestPrompt({ picks, persona, date: '2026-11-13', style: '要点式' })
  const legacy = JSON.stringify(plain)
  assert.ok(!legacy.includes('偏好的题材'))

  const same = [
    digestPrompt({ picks, persona, date: '2026-11-13', style: '要点式', interests: undefined }),
    digestPrompt({ picks, persona, date: '2026-11-13', style: '要点式', interests: { tags: [], custom: [], weight: 10 } }),
    digestPrompt({ picks, persona, date: '2026-11-13', style: '要点式', interests: { tags: ['  '], custom: [''], weight: 10 } }),
  ]
  for (const s of same) assert.equal(JSON.stringify(s), legacy)
})

test('digestPrompt：有标签时多一行题材偏好，且合并去重后的标签都在里面', () => {
  const persona = { name: '小号', ownerTitle: '主人', style: '口语' }
  const picks = [{ topicId: '12345', title: 't', sectionTitle: 'S', score: 60, replyCount: 1, upVote: 1, content: 'c' }]
  const msgs = digestPrompt({
    picks, persona, date: '2026-11-13', style: '要点式',
    interests: { tags: ['游戏', '数码'], custom: ['游戏'], weight: 10 },
  })
  const user = msgs.find((m) => m.role === 'user').content
  assert.ok(user.includes('他常年偏好的题材：游戏、数码'), user)
  assert.ok(user.includes('不要为了凑标签硬写'), user)
  // 日期行后面紧跟偏好行：材料顺序稳定，模型不会把偏好当成帖子内容
  assert.ok(user.indexOf('日期：2026-11-13') < user.indexOf('他常年偏好的题材'))
  assert.ok(user.indexOf('他常年偏好的题材') < user.indexOf('下面是今天扫到并打分排序后的帖子'))
})
