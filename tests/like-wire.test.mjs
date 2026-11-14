/**
 * 接线层单测：runLikes 只做「按开关挑人 + 按 reason 记账」，不在这里测平台。
 * 全程 dryRun，零网络、零写请求。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { runLikes } from '../tools/lib/digest.mjs'
import { markReply } from '../tools/lib/state.mjs'

const mkSeen = () => ({ __primed: true, replies: {}, persons: {} })

const picks = [
  {
    topicId: '111', sectionId: '23064', uid: 'u9', score: 50, isUpVoted: false,
    floors: [
      { id: 'r1', uid: 'u2', content: '热评一', upVote: 9, isUpVoted: false },
      { id: 'r2', uid: 'u2', content: '热评二', upVote: 3, isUpVoted: true },
      { id: 'r3', uid: 'u1', content: '自己的楼层', upVote: 7, isUpVoted: false },
    ],
  },
  { topicId: '222', sectionId: '23064', uid: 'u1', score: 10, floors: null, isUpVoted: false },
]

const collect = () => {
  const lines = []
  return { lines, log: (s) => lines.push(String(s)) }
}

test('三个开关全关：一条都不赞，也不打印', async () => {
  const { lines, log } = collect()
  const n = await runLikes({ like: { browsed: false, quality: false, replies: false, perRoundMax: 5 } }, picks, { seen: mkSeen(), dryRun: true, log })
  assert.equal(n, 0)
  assert.deepEqual(lines, [])
})

test('只开浏览过的：只赞真读过楼层的那帖，没读过的跳过', async () => {
  const { lines, log } = collect()
  await runLikes({ self: { uid: 'u1' }, like: { browsed: true, perRoundMax: 5 } }, picks, { seen: mkSeen(), dryRun: true, log })
  const liked = lines.filter((l) => l.includes('会赞帖'))
  assert.equal(liked.length, 1)
  assert.match(liked[0], /111/)
})

test('只开优质：只收过分数线的帖', async () => {
  const { lines, log } = collect()
  await runLikes({ self: { uid: 'u1' }, like: { quality: true, qualityJudge: 'score', qualityMinScore: 40, perRoundMax: 5 } }, picks, { seen: mkSeen(), dryRun: true, log })
  const liked = lines.filter((l) => l.includes('会赞帖'))
  assert.equal(liked.length, 1)
  assert.match(liked[0], /111/)
})

test('只开回复：只赞别人的热评，自己的楼层与已赞的楼层都不碰', async () => {
  const { lines, log } = collect()
  await runLikes({ self: { uid: 'u1' }, like: { replies: true, hotCommentsPerTopic: 3, perRoundMax: 5 } }, picks, { seen: mkSeen(), dryRun: true, log })
  const liked = lines.filter((l) => l.includes('会赞楼层'))
  assert.equal(liked.length, 1)
  assert.match(liked[0], /r1/)
})

test('每轮上限硬生效：三类全开也只赞 perRoundMax 条', async () => {
  const { lines, log } = collect()
  const many = Array.from({ length: 9 }, (_, i) => ({ topicId: String(900 + i), sectionId: '23064', uid: 'u1', score: 99, floors: [], isUpVoted: false }))
  await runLikes({ like: { browsed: true, quality: true, replies: true, qualityMinScore: 1, perRoundMax: 2 } }, many, { seen: mkSeen(), dryRun: true, log })
  assert.equal(lines.filter((l) => l.includes('会赞')).length, 2)
})

test('seen 留痕过的对象不会再赞第二遍', async () => {
  const { lines, log } = collect()
  const seen = mkSeen()
  markReply(seen, 'l:t:111', { liked: true })
  await runLikes({ self: { uid: 'u1' }, like: { browsed: true, perRoundMax: 5 } }, picks, { seen, dryRun: true, log })
  assert.equal(lines.filter((l) => l.includes('会赞')).length, 0)
})

test('stats.likes 会回填给调用方（干跑不计入）', async () => {
  const stats = {}
  await runLikes({ self: { uid: 'u1' }, like: { browsed: true, perRoundMax: 5 } }, picks, { seen: mkSeen(), dryRun: true, log: () => {}, stats })
  assert.equal(stats.likes, 0)
})