// rank.mjs 的离线单测：不联网、不读 _probe，全部用小 fixture 构造边界。
import test from 'node:test'
import assert from 'node:assert/strict'
import { rawDims, pctRank, scorePool, selectPicks, explainPick } from '../tools/lib/rank.mjs'

const NOW = Date.parse('2026-11-13T12:00:00Z')
const H = 3600000

const mk = (over = {}) => ({
  topicId: '1', title: 't', sectionId: '23064', sectionTitle: '爆友生活区',
  uid: 'u1', nickname: 'n1', content: '', contentLen: 0,
  timeMs: NOW, replyMs: NOW, replyCount: 0, commentCount: 0, upVote: 0, views: 0,
  isEssence: false, isTop: false, isOfficial: false, isContribution: false, ...over,
})

const byId = (scored) => new Map(scored.map((s) => [String(s.topicId), s]))
const orderOf = (scored) => scored.map((s) => String(s.topicId))

test('高浏览零回复的旧帖，排不过当天还在讨论的新帖', () => {
  const posts = [
    mk({ topicId: 'old', title: '半年前的高浏览', timeMs: NOW - 500 * H, replyMs: NOW - 500 * H, views: 8000, upVote: 200, contentLen: 200 }),
    mk({ topicId: 'new', title: '今天在聊', timeMs: NOW - 2 * H, replyMs: NOW - 0.5 * H, views: 120, upVote: 6, replyCount: 30, commentCount: 4, contentLen: 300 }),
  ]
  // 中间再放几条普通帖，保证两头的分位不是被 min-max 极度放大
  for (let i = 0; i < 8; i++) {
    posts.push(mk({
      topicId: 'mid' + i, uid: 'um' + i, sectionId: 'S' + i,
      timeMs: NOW - (10 + i * 6) * H, replyMs: NOW - (10 + i * 6) * H,
      views: 60 + i * 30, upVote: 3 + i, replyCount: 1 + i, contentLen: 150,
    }))
  }
  const scored = scorePool(posts, { now: NOW })
  const order = orderOf(scored)
  assert.ok(order.indexOf('new') < order.indexOf('old'), '有讨论的新帖应排在零回复老帖前面')
  assert.equal(scored[0].topicId, 'new')
})

test('确定性：同输入两次 scorePool 逐字段相同，同分按 topicId 升序', () => {
  const posts = []
  for (let i = 0; i < 12; i++) {
    posts.push(mk({
      topicId: 'p' + i, uid: 'u' + i, sectionId: 'S' + (i % 3),
      timeMs: NOW - i * H, replyMs: NOW - i * H * 0.5,
      views: 100 + i * 37, upVote: 5 + i * 3, replyCount: i, commentCount: i % 4, contentLen: 100 + i * 20,
    }))
  }
  const a = scorePool(posts, { now: NOW })
  const b = scorePool(posts, { now: NOW })
  assert.deepEqual(a, b)
  assert.deepEqual(orderOf(a), orderOf(b))

  // 完全相同的两条帖（只有 topicId 不同）→ 同分，topicId 升序决定先后
  const tie = scorePool([
    mk({ topicId: 'b', uid: 'u1' }), mk({ topicId: 'a', uid: 'u1' }),
    ...posts,
  ], { now: NOW })
  const tiePairs = tie.filter((s) => s.topicId === 'a' || s.topicId === 'b')
  assert.equal(tiePairs.length, 2)
  assert.equal(tiePairs[0].score, tiePairs[1].score)
  assert.deepEqual(tiePairs.map((s) => s.topicId), ['a', 'b'])

  const pickA = selectPicks(a, { pick: 5, now: NOW })
  const pickB = selectPicks(b, { pick: 5, now: NOW })
  assert.deepEqual(pickA.picks.map((x) => x.topicId), pickB.picks.map((x) => x.topicId))
})

test('分位数归一：counters ×10 的分数变化远小于线性叠加（|Δ|<3 且仍是第一）', () => {
  const base = []
  for (let i = 0; i < 12; i++) {
    base.push(mk({
      topicId: 'p' + i, uid: 'u' + i, sectionId: 'S' + (i % 4),
      replyCount: 100 - i * 7, commentCount: 20 - i, views: 2000 - i * 120,
      upVote: 300 - i * 20, contentLen: 600 - i * 30,
      timeMs: NOW - i * H, replyMs: NOW - i * 0.5 * H,
    }))
  }
  const blown = base.map((p) => (p.topicId === 'p0'
    ? { ...p, replyCount: p.replyCount * 10, commentCount: p.commentCount * 10, views: p.views * 10, upVote: p.upVote * 10 }
    : p))
  const a = byId(scorePool(base, { now: NOW }))
  const b = byId(scorePool(blown, { now: NOW }))
  const delta = Math.abs(b.get('p0').score - a.get('p0').score)
  assert.ok(delta < 3, '分位数归一后 counter ×10 不该带来线性级别涨分，实际 Δ=' + delta)
  assert.equal(a.get('p0').rank, 1)
  assert.equal(b.get('p0').rank, 1)

  // 对照：线性叠加时代 counter ×10 会让这条帖的原始项翻十倍；这里原始 dims 也几乎不变（分位打满）
  assert.equal(b.get('p0').dims.heat, a.get('p0').dims.heat)
  assert.equal(b.get('p0').dims.discussion, a.get('p0').dims.discussion)
})

test('零信号帖进不了 picks，并归到 excluded.lowSignal', () => {
  const posts = [
    mk({ topicId: 'good1', uid: 'g1', sectionId: 'A', replyCount: 12, upVote: 8, views: 400, contentLen: 300 }),
    mk({ topicId: 'good2', uid: 'g2', sectionId: 'B', replyCount: 9, upVote: 5, views: 300, contentLen: 250 }),
    mk({ topicId: 'zero', uid: 'z1', sectionId: 'C', replyCount: 0, upVote: 0, views: 5, contentLen: 8, timeMs: NOW, replyMs: NOW }),
  ]
  const scored = scorePool(posts, { now: NOW })
  const { picks, ranked, excluded } = selectPicks(scored, { pick: 5, now: NOW })
  assert.deepEqual(excluded.lowSignal.map((x) => x.topicId), ['zero'])
  assert.ok(!picks.some((p) => p.topicId === 'zero'))
  // ranked 里仍保留（面板/调试要能看到为什么没选）
  assert.equal(ranked.length, 3)
  assert.equal(ranked.find((x) => x.topicId === 'zero').excludedReason, 'lowSignal')
  // 即使配额放宽也放不回来：只有 2 条合法帖，pick 5 也只能出 2 条
  assert.equal(picks.length, 2)
})

test('perSectionMax 生效：同板块 6 条高分帖最多选 2 条', () => {
  const posts = []
  for (let i = 0; i < 6; i++) {
    posts.push(mk({
      topicId: 'a' + i, uid: 'ua' + i, sectionId: 'S1', sectionTitle: '爆友生活区',
      replyCount: 300 - i * 10, views: 2000 - i * 50, upVote: 200 - i * 5,
      contentLen: 500, timeMs: NOW - 1 * H, replyMs: NOW - 0.2 * H,
    }))
  }
  for (let i = 0; i < 3; i++) {
    posts.push(mk({
      topicId: 'b' + i, uid: 'ub' + i, sectionId: 'S2', sectionTitle: '综合讨论',
      replyCount: 8 - i * 2, views: 100, upVote: 3, contentLen: 100,
      timeMs: NOW - 5 * H, replyMs: NOW - 5 * H,
    }))
  }
  const scored = scorePool(posts, { now: NOW })
  // pick 恰好被第一轮填满，所以不会触发「放宽配额」
  const { picks, excluded } = selectPicks(scored, { pick: 4, perSectionMax: 2, perAuthorMax: 1, now: NOW })
  assert.equal(picks.length, 4)
  assert.equal(picks.filter((p) => p.sectionId === 'S1').length, 2)
  assert.equal(picks.filter((p) => p.sectionId === 'S2').length, 2)
  assert.equal(excluded.lowSignal.length, 0)
  // picks 必须按 score 降序
  for (let i = 1; i < picks.length; i++) assert.ok(picks[i - 1].score >= picks[i].score)
})

test('perAuthorMax 生效：同一作者最多 1 条', () => {
  const posts = []
  for (let i = 0; i < 5; i++) {
    posts.push(mk({
      topicId: 'x' + i, uid: 'SAME', title: '同作者第 ' + i + ' 帖', sectionId: 'S' + i, sectionTitle: 'S' + i,
      replyCount: 200 - i, views: 800, upVote: 80, contentLen: 400,
      timeMs: NOW - 2 * H, replyMs: NOW - 2 * H,
    }))
  }
  for (let i = 0; i < 5; i++) {
    posts.push(mk({
      topicId: 'y' + i, uid: 'other' + i, sectionId: 'T' + i, sectionTitle: 'T' + i,
      replyCount: 20 - i, views: 250, upVote: 20, contentLen: 150,
      timeMs: NOW - 3 * H, replyMs: NOW - 3 * H,
    }))
  }
  const scored = scorePool(posts, { now: NOW })
  const { picks } = selectPicks(scored, { pick: 3, perSectionMax: 5, perAuthorMax: 1, now: NOW })
  assert.equal(picks.length, 3)
  assert.equal(picks.filter((p) => p.uid === 'SAME').length, 1)
})

test('官方作者单独上限：同一官方作者 5 条高分帖默认最多 3 条入选', () => {
  const posts = []
  for (let i = 0; i < 5; i++) {
    posts.push(mk({
      topicId: 'off' + i, uid: 'OFFICIAL', title: '官方公告 ' + i, sectionId: 'S' + i, sectionTitle: 'S' + i,
      isOfficial: true, replyCount: 300 - i * 20, views: 2000 - i * 100, upVote: 200 - i * 10, contentLen: 500,
      timeMs: NOW - 1 * H, replyMs: NOW - 0.2 * H,
    }))
  }
  for (let i = 0; i < 3; i++) {
    posts.push(mk({
      topicId: 'na' + i, uid: 'NA', title: '普通作者 ' + i, sectionId: 'T' + i, sectionTitle: 'T' + i,
      replyCount: 30 - i * 5, views: 300, upVote: 20, contentLen: 200,
      timeMs: NOW - 3 * H, replyMs: NOW - 3 * H,
    }))
  }
  posts.push(mk({ topicId: 'nb', uid: 'NB', title: '另一个作者', sectionId: 'U', replyCount: 20, views: 200, upVote: 15, contentLen: 200, timeMs: NOW - 4 * H, replyMs: NOW - 4 * H }))
  const scored = scorePool(posts, { now: NOW })
  // pick 恰好在前两轮被填满（3 官方 + 1 普通 A + 1 B），不会走到「放宽作者上限」那轮
  const { picks } = selectPicks(scored, { pick: 5, perSectionMax: 9, perAuthorMax: 1, now: NOW })
  assert.equal(picks.length, 5)
  assert.equal(picks.filter((p) => p.isOfficial).length, 3)
  assert.equal(picks.filter((p) => p.uid === 'NA').length, 1) // 普通作者仍按 perAuthorMax=1
  assert.ok(picks.some((p) => p.uid === 'NB'))
  // 官方总量上限独立生效：作者上限放到 5、但 officialMax 默认 3 → 仍只有 3 条官方
  const capped = selectPicks(scored, { pick: 5, perSectionMax: 9, perAuthorMax: 1, perAuthorMaxOfficial: 5, now: NOW })
  assert.equal(capped.picks.filter((p) => p.isOfficial).length, 3)
  // 两个上限都显式放到 5 → 5 条官方帖都能进（参数确实可覆盖）
  const all = selectPicks(scored, { pick: 5, perSectionMax: 9, perAuthorMax: 1, perAuthorMaxOfficial: 5, officialMax: 5, now: NOW })
  assert.equal(all.picks.filter((p) => p.isOfficial).length, 5)
})

test('selfUid / selfName 对应的帖子被排除', () => {
  const posts = [
    mk({ topicId: 'mine', uid: 'me', nickname: '小号', sectionId: 'A', replyCount: 50, views: 500, upVote: 30, contentLen: 300 }),
    mk({ topicId: 'mine2', uid: 'other', nickname: '小号', sectionId: 'B', replyCount: 40, views: 400, upVote: 20, contentLen: 200 }),
    mk({ topicId: 'other', uid: 'u9', nickname: '别人', sectionId: 'C', replyCount: 10, views: 100, upVote: 5, contentLen: 100 }),
  ]
  const scored = scorePool(posts, { now: NOW })
  const { picks, excluded } = selectPicks(scored, { pick: 5, selfUid: 'me', selfName: '小号', now: NOW })
  assert.deepEqual(excluded.self.map((x) => x.topicId).sort(), ['mine', 'mine2'])
  assert.deepEqual(picks.map((x) => x.topicId), ['other'])
})

test('选不满 pick 时放宽板块/作者配额，但不放宽零信号下限', () => {
  const posts = []
  for (let i = 0; i < 3; i++) {
    posts.push(mk({
      topicId: 's' + i, uid: 'SAME', title: '同作者不同标题 ' + i, sectionId: 'SAME_SEC', sectionTitle: '同一板块',
      replyCount: 50 - i, views: 500, upVote: 30, contentLen: 300,
      timeMs: NOW - 2 * H, replyMs: NOW - 2 * H,
    }))
  }
  // 零信号，但新鲜度满分（若没有零信号下限，它的分不会太低）
  posts.push(mk({ topicId: 'zz', uid: 'z', sectionId: 'Z', replyCount: 0, upVote: 0, views: 2, contentLen: 6, timeMs: NOW, replyMs: NOW }))
  const scored = scorePool(posts, { now: NOW })
  const { picks, excluded } = selectPicks(scored, { pick: 4, perSectionMax: 1, perAuthorMax: 1, now: NOW })
  // 作者配额从 1 放宽后，同一作者 3 条都能进；pick=4 但只剩 3 条合法帖
  assert.equal(picks.length, 3)
  assert.deepEqual(picks.map((x) => x.topicId).sort(), ['s0', 's1', 's2'])
  assert.ok(!picks.some((p) => p.topicId === 'zz'))
  assert.deepEqual(excluded.lowSignal.map((x) => x.topicId), ['zz'])
})

test('weights 只给 heat 时，heat 原始分最高的排第一', () => {
  const posts = []
  // hot：浏览/赞极高，但回复很少
  posts.push(mk({
    topicId: 'hot', uid: 'uh', sectionId: 'A', views: 6000, upVote: 500,
    replyCount: 1, commentCount: 0, contentLen: 300,
    timeMs: NOW - 1 * H, replyMs: NOW - 1 * H,
  }))
  // discuss：回复极多，但浏览/赞低
  posts.push(mk({
    topicId: 'discuss', uid: 'ud', sectionId: 'B', views: 300, upVote: 10,
    replyCount: 200, commentCount: 20, contentLen: 200,
    timeMs: NOW - 6 * H, replyMs: NOW - 5 * H,
  }))
  for (let i = 0; i < 8; i++) {
    posts.push(mk({
      topicId: 'm' + i, uid: 'um' + i, sectionId: 'M' + i,
      views: 100 + i * 40, upVote: 5 + i * 2, replyCount: 3 + i * 4, contentLen: 120,
      timeMs: NOW - (3 + i) * H, replyMs: NOW - (3 + i) * H,
    }))
  }
  const scored = scorePool(posts, { now: NOW, weights: { heat: 1 } })
  assert.equal(scored[0].topicId, 'hot')
  const heatRaw = new Map(scored.map((s) => [String(s.topicId), s.rawDims.heat]))
  assert.equal(heatRaw.get('hot'), Math.max(...heatRaw.values()))
})

test('n<8 / n==1 时分位数不产生 NaN', () => {
  assert.deepEqual(pctRank([5]), [0.5])
  assert.deepEqual(pctRank([1, 2, 3]), [0, 0.5, 1])
  assert.deepEqual(pctRank([2, 2, 2]), [0.5, 0.5, 0.5])
  assert.deepEqual(pctRank([]), [])

  const one = scorePool([mk({ topicId: 'only', timeMs: NOW })], { now: NOW })
  assert.equal(one.length, 1)
  assert.ok(Number.isFinite(one[0].score))
  assert.deepEqual(one[0].dims, { heat: 0.5, discussion: 0.5, quality: 0.5, freshness: 0.5 })
  assert.ok(Math.abs(one[0].score - 50) <= 0.1)

  const few = scorePool([
    mk({ topicId: 'f1', uid: 'a', views: 10 }),
    mk({ topicId: 'f2', uid: 'b', views: 20, replyCount: 2 }),
    mk({ topicId: 'f3', uid: 'c', views: 30, replyCount: 5, upVote: 2, contentLen: 90 }),
  ], { now: NOW })
  for (const s of few) {
    for (const d of ['heat', 'discussion', 'quality', 'freshness']) {
      assert.ok(Number.isFinite(s.dims[d]), d + ' 分位应为有限数')
      assert.ok(s.dims[d] >= 0 && s.dims[d] <= 1, d + ' 分位应在 0..1')
    }
    assert.ok(s.score >= 0 && s.score <= 100)
  }
})

test('explainPick 是一句话，且不出现 undefined / NaN', () => {
  const posts = [
    mk({ topicId: 'e1', uid: 'e1', sectionId: 'A', replyCount: 34, upVote: 12, views: 210, contentLen: 260, isEssence: true }),
    ...Array.from({ length: 9 }, (_, i) => mk({
      topicId: 'e' + (i + 2), uid: 'e' + (i + 2), sectionId: 'B' + i,
      replyCount: 5 + i, upVote: 2 + i, views: 90 + i * 10, contentLen: 120,
      timeMs: NOW - i * H, replyMs: NOW - i * H,
    })),
  ]
  const { picks } = selectPicks(scorePool(posts, { now: NOW }), { pick: 2, now: NOW })
  assert.equal(picks.length, 2)
  for (const p of picks) {
    const s = explainPick(p, { total: posts.length })
    assert.equal(typeof s, 'string')
    assert.ok(s.length > 0)
    assert.ok(!/undefined|NaN/.test(s), '不应出现 undefined/NaN：' + s)
    assert.ok(/回复 \d+ · 赞 \d+ · 浏览 \d+/.test(s), s)
    assert.match(s, /讨论度今日前 \d+%/)
    // picks 上直接带 why（面板「为什么入选」字段）
    assert.equal(typeof p.why, 'string')
    assert.ok(!/undefined|NaN/.test(p.why))
  }
  // 缺 dims / 缺字段也不能炸
  const bare = explainPick({ title: 'x', replyCount: 3 }, { total: 0 })
  assert.ok(!/undefined|NaN/.test(bare), bare)
  assert.ok(bare.includes('回复 3'))
})

test('静音词 / 置顶 / 最近同标题 三类排除各归各的桶', () => {
  const posts = [
    mk({ topicId: 'muted', uid: 'm1', sectionId: 'A', title: '中奖名单公布啦', replyCount: 20, views: 300, upVote: 10, contentLen: 200 }),
    mk({ topicId: 'topped', uid: 't1', sectionId: 'B', title: '版务公告', isTop: true, replyCount: 20, views: 300, upVote: 10, contentLen: 200 }),
    mk({ topicId: 'dupe', uid: 'u9', sectionId: 'C', title: '同一句话', replyCount: 20, views: 300, upVote: 10, contentLen: 200, timeMs: NOW - 2 * H }),
    mk({ topicId: 'ok1', uid: 'o1', sectionId: 'D', replyCount: 6, views: 120, upVote: 4, contentLen: 100 }),
    mk({ topicId: 'ok2', uid: 'o2', sectionId: 'E', replyCount: 5, views: 100, upVote: 4, contentLen: 100 }),
  ]
  const scored = scorePool(posts, { now: NOW })
  const { picks, excluded } = selectPicks(scored, {
    pick: 5,
    mutedTitles: ['中奖', '开奖'],
    skipTop: true,
    recentTitles: [{ title: '同一 句话', uid: 'u9', timeMs: NOW - 3 * H }],
    now: NOW,
  })
  assert.deepEqual(excluded.muted.map((x) => x.topicId), ['muted'])
  assert.deepEqual(excluded.top.map((x) => x.topicId), ['topped'])
  assert.deepEqual(excluded.dupeTitle.map((x) => x.topicId), ['dupe'])
  assert.deepEqual(picks.map((x) => x.topicId).sort(), ['ok1', 'ok2'])

  // 超过 24h 的旧标题不算重复
  const again = selectPicks(scored, {
    pick: 5,
    recentTitles: [{ title: '同一句话', uid: 'u9', timeMs: NOW - 25 * H }],
    now: NOW,
  })
  assert.equal(again.excluded.dupeTitle.length, 0)
  assert.ok(again.picks.some((p) => p.topicId === 'dupe'))
})

test('minScore 以下归 excluded.belowMin，不入选', () => {
  const posts = [
    mk({ topicId: 'a', uid: 'a', sectionId: 'A', replyCount: 20, views: 300, upVote: 10, contentLen: 200 }),
    mk({ topicId: 'b', uid: 'b', sectionId: 'B', replyCount: 5, views: 80, upVote: 2, contentLen: 100 }),
  ]
  const scored = scorePool(posts, { now: NOW })
  const { picks, excluded } = selectPicks(scored, { pick: 5, minScore: 100, now: NOW })
  assert.equal(picks.length, 0)
  assert.equal(excluded.belowMin.length, 2)
  // 阈值放到 0 就都能选
  assert.equal(selectPicks(scored, { pick: 5, minScore: 0, now: NOW }).picks.length, 2)
})

test('池内同作者同标题去重：只留分最高的一条，且不被配额放宽放回来', () => {
  const posts = [
    mk({ topicId: 'x0', uid: 'SAME', title: '求推荐游戏', sectionId: 'S1', replyCount: 40, views: 400, upVote: 20, contentLen: 200 }),
    mk({ topicId: 'x1', uid: 'SAME', title: '求推荐游戏 ', sectionId: 'S1', replyCount: 20, views: 300, upVote: 10, contentLen: 200 }),
    mk({ topicId: 'x2', uid: 'SAME', title: '求 推荐 游戏', sectionId: 'S1', replyCount: 10, views: 200, upVote: 5, contentLen: 200 }),
    mk({ topicId: 'y1', uid: 'other1', title: '求推荐游戏', sectionId: 'S2', replyCount: 8, views: 150, upVote: 4, contentLen: 150 }),
    mk({ topicId: 'y2', uid: 'other2', title: '别的帖', sectionId: 'S3', replyCount: 6, views: 120, upVote: 3, contentLen: 150 }),
  ]
  const scored = scorePool(posts, { now: NOW })
  // 配额放很宽，确保只剩「池内同标题去重」这条规则在起作用
  const { picks, ranked, excluded } = selectPicks(scored, { pick: 8, perSectionMax: 5, perAuthorMax: 5, now: NOW })
  // 同一作者 3 条同标题（含空格变体）只留分最高的一条
  const sameAuthor = picks.filter((p) => p.uid === 'SAME')
  assert.equal(sameAuthor.length, 1)
  assert.equal(sameAuthor[0].topicId, 'x0')
  assert.deepEqual(excluded.dupeTitle.map((x) => x.topicId).sort(), ['x1', 'x2'])
  // 不同作者用相同标题不算重复
  assert.ok(picks.some((p) => p.topicId === 'y1'))
  // ranked 里能看到剔除原因；去重不因配额放宽而放宽（只剩 3 条合法候选）
  assert.equal(ranked.find((x) => x.topicId === 'x2').excludedReason, 'dupeTitle')
  assert.equal(picks.length, 3)
})

test('scored / picks 保留渲染层要的字段（topicId/sectionId/uid/score/dims/rawDims）', () => {
  const posts = [
    mk({ topicId: 'r1', uid: 'u1', sectionId: '23064', replyCount: 20, views: 300, upVote: 10, contentLen: 200 }),
    mk({ topicId: 'r2', uid: 'u2', sectionId: '23066', replyCount: 15, views: 260, upVote: 9, contentLen: 180 }),
    mk({ topicId: 'r3', uid: 'u3', sectionId: '3', replyCount: 12, views: 220, upVote: 8, contentLen: 160 }),
  ]
  const scored = scorePool(posts, { now: NOW })
  const fields = ['topicId', 'sectionId', 'uid', 'score', 'dims', 'rawDims']
  for (const s of scored) {
    for (const k of fields) assert.ok(k in s, 'scored 缺字段 ' + k)
    assert.ok(Number.isFinite(s.score))
    for (const d of ['heat', 'discussion', 'quality', 'freshness']) assert.ok(Number.isFinite(s.dims[d]))
  }
  const { picks } = selectPicks(scored, { pick: 3, now: NOW })
  assert.ok(picks.length > 0)
  for (const p of picks) {
    for (const k of fields) assert.ok(k in p, 'picks 缺字段 ' + k)
    assert.equal(typeof p.why, 'string')
  }
})

test('rawDims 各维度非负，四维键齐全', () => {
  const d = rawDims(mk({
    views: 500, upVote: 20, replyCount: 10, commentCount: 3, contentLen: 400,
    timeMs: NOW - 6 * H, replyMs: NOW - 1 * H, isEssence: true, isContribution: true,
  }), { now: NOW })
  for (const k of ['heat', 'discussion', 'quality', 'freshness']) {
    assert.ok(Number.isFinite(d[k]) && d[k] >= 0, k + ' 应为非负有限数')
  }
  // 新鲜度 = 最后活动距今的 6h 半衰：发帖 6h 前、最后回复 1h 前 → 0.5**(1/6) ≈ 0.8909
  assert.ok(Math.abs(d.freshness - 0.5 ** (1 / 6)) < 1e-9)
  // 「早上发、现在还在被回复」的老帖要比「刚发但已经沉了」的新帖更新鲜（活动口径，不看发布时间）
  const activeOld = rawDims(mk({ timeMs: NOW - 18 * H, replyMs: NOW - 0.2 * H }), { now: NOW })
  const deadNew = rawDims(mk({ timeMs: NOW - 2 * H, replyMs: 0 }), { now: NOW })
  assert.ok(activeOld.freshness > deadNew.freshness)
  // 2 小时内被回复过 → 讨论度多 0.5
  // 两条帖的活跃时长（发帖→最近回复）都是 5h、回复数相同，只有「最近回复是否在 2h 内」不同
  const still = rawDims(mk({ replyCount: 10, replyMs: NOW - 1 * H, timeMs: NOW - 6 * H }), { now: NOW })
  const idle = rawDims(mk({ replyCount: 10, replyMs: NOW - 21 * H, timeMs: NOW - 26 * H }), { now: NOW })
  assert.ok(Math.abs(still.discussion - idle.discussion - 0.5) < 1e-9)
})
