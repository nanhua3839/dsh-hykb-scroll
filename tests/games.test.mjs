import test from 'node:test'
import assert from 'node:assert/strict'
import { parseRankHtml, pickComments, resolveGames, gameBlock, gamesPrompt, SOURCES } from '../tools/lib/games.mjs'

const HTML = `<ol id="rank_ol">
 <li style="display:"> <i class="num">1</i><a class="gameli" href="//m.3839.com/a/151743.htm">
   <div class="con"> <em class="name beta"><span class="sp-name">三角洲行动-微光赛季</span></em>
   <p class="info"> <span class="spec">6.3分</span> </p></div></a></li>
 <li style="display:"> <i class="num">2</i><a class="gameli" href="//m.3839.com/a/89222.htm">
   <div class="con"> <em class="name"><span class="sp-name">光·遇(官服)</span></em>
   <p class="info"> <span class="spec">8.7分</span> </p></div></a></li>
 <li><a href="//m.3839.com/a/151743.htm"><span class="sp-name">重复的那个</span></a></li>
 <li><a href="//m.3839.com/a/999.htm"></a></li>
</ol>`

test('parseRankHtml 拿到 id / 名字 / 分数，重复 id 只留一次，没名字的丢掉', () => {
  const list = parseRankHtml(HTML)
  assert.equal(list.length, 2)
  assert.deepEqual(list[0], { id: '151743', title: '三角洲行动-微光赛季', score: 6.3 })
  assert.equal(list[1].id, '89222')
  assert.equal(list[1].score, 8.7)
})

test('parseRankHtml 对空页面不炸', () => {
  assert.deepEqual(parseRankHtml(''), [])
  assert.deepEqual(parseRankHtml(null), [])
})

test('pickComments 丢掉太短的、去重、截断、去掉 HTML', () => {
  const list = [
    { star: '9', content: '<br />好玩', user: { nickname: 'a' }, time_str: '1小时前' },
    { star: '8', content: '这游戏的职业系统做得挺细，野猪旗配指挥戒指能压住补给', user: { nickname: 'b' }, time_str: '2小时前' },
    { star: '8', content: '这游戏的职业系统做得挺细，野猪旗配指挥戒指能压住补给', user: { nickname: 'c' } },
    { star: '7', content: '画质可以，优化一般，手机发热明显，希望下个版本修一下掉帧', user: { nickname: 'd' } },
  ]
  const out = pickComments(list, { max: 2, minLen: 12 })
  assert.equal(out.length, 2)
  assert.equal(out[0].user, 'b')
  assert.equal(out[0].star, 8)
  assert.ok(!out[0].content.includes('<'))
})

test('resolveGames：填了清单就只读清单，并按 pick 截断', async () => {
  const cfg = { games: { items: [{ id: '151743', title: '三角洲' }, { id: '89222', title: '光遇' }, '12345'], pick: 2 } }
  const out = await resolveGames(cfg, {})
  assert.deepEqual(out.map((x) => x.id), ['151743', '89222'])
  assert.equal(out[0].from, 'list')
})

test('resolveGames：清单里的脏数据被丢掉', async () => {
  const cfg = { games: { items: [{ id: 'abc' }, { id: '151743' }], pick: 3 } }
  const out = await resolveGames(cfg, {})
  assert.deepEqual(out.map((x) => x.id), ['151743'])
})

test('gameBlock / gamesPrompt 只给材料，不带任何写操作', () => {
  const block = gameBlock({ id: '1', title: '某游戏', score: 6.1, star: 7.2 }, [{ star: 8, content: '还行，玩法有点重复', user: 'a' }])
  assert.match(block, /某游戏/)
  assert.match(block, /8分/)
  const msgs = gamesPrompt({ blocks: [block], persona: { name: '小号', ownerTitle: '主人' }, date: '2026-11-13' })
  assert.equal(msgs.length, 2)
  assert.match(msgs[0].content, /不替任何人打分/)
  assert.match(msgs[1].content, /游戏评价观察/)
  assert.ok(SOURCES.hot && SOURCES.expect)
})
