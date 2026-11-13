import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  EMOJI_SET,
  EMOJI_SETS,
  emojiNames,
  render,
  stripEmoji,
  hasEmoji,
  EMOJI_PROMPT_RULE,
} from '../tools/lib/emoji.mjs'
import { tidy } from '../tools/lib/ai.mjs'

// 下面 6 条是从线上正文里原样抄下来的（_facts/emoji_probe/online_pairs.json 的 raw），
// 逐字节对照：render 出来的串必须和线上发出去的一模一样。
const ONLINE = [
  ['不好', '<kb-emoji src="https://bbs.3839app.com/app/static/images/v2/baomeiwuxianda/baomeiwuxianda003.gif" data-value="不好"/>'],
  ['不好意思', '<kb-emoji src="https://bbs.3839app.com/app/static/images/v2/baomeixiankazhangjia/baomeixiankazhangjia001.gif" data-value="不好意思"/>'],
  ['舔镜头', '<kb-emoji src="https://bbs.3839app.com/app/static/images/v2/baomeixiankazhangjia/baomeixiankazhangjia019.gif" data-value="舔镜头"/>'],
  ['侧脸看', '<kb-emoji src="https://bbs.3839app.com/app/static/images/v2/baomeixiankazhangjia/baomeixiankazhangjia003.gif" data-value="侧脸看"/>'],
  ['嘻嘻', '<kb-emoji src="https://bbs.3839app.com/app/static/images/v2/baomeixiankazhangjia/baomeixiankazhangjia021.gif" data-value="嘻嘻"/>'],
  ['卖萌.png', '<kb-emoji src="https://bbs.3839app.com/app/static/images/v2/kbxiaobaomei/kbxiaobaomei071.png" data-value="卖萌.png"/>'],
]

test('和线上正文逐字节一致（6 条线上样本，两种写法都认）', () => {
  assert.ok(ONLINE.length >= 5)
  for (const [name, raw] of ONLINE) {
    assert.equal(render('[表情:' + name + ']'), raw, name + ' 拼出来和线上不一样')
    assert.equal(render('[' + name + ']'), raw, name + ' 的 [名] 写法拼出来和线上不一样')
  }
})

test('线上样本还能在 emoji_map 里对上号（防手抄错）', () => {
  const facts = new URL('../../_facts/emoji_probe/online_pairs.json', import.meta.url)
  if (!fs.existsSync(facts)) return
  const pairs = JSON.parse(fs.readFileSync(facts, 'utf8'))
  const sends = new Set(EMOJI_SET.map((e) => e.send))
  const verbatim = pairs.filter((p) => sends.has(p.raw))
  assert.ok(verbatim.length >= 5, '线上样本里逐字节能对上的不到 5 条：' + verbatim.length)
  for (const [name, raw] of ONLINE) assert.ok(sends.has(raw), name + ' 的线上串不在表里')
})

test('448 条，索引键 group+name 唯一，16 个包', () => {
  assert.equal(EMOJI_SET.length, 448)
  assert.equal(EMOJI_SETS.length, 16)
  assert.ok(EMOJI_SETS.includes('emoji'))
  const keys = new Set()
  for (const e of EMOJI_SET) {
    assert.deepEqual(Object.keys(e).sort(), ['group', 'name', 'send'])
    assert.match(e.send, /^<kb-emoji src="https:\/\/[^"]+" data-value="[^"]+"\/>$/)
    keys.add(e.group + '\u0000' + e.name)
  }
  assert.equal(keys.size, 448, 'group+name 有重复')
  assert.equal(emojiNames().length, 373, '去重后的名字数')
})

test('表里没有的名字整个消失，不留空方括号', () => {
  assert.equal(render('[偷笑]'), '')            // 偷笑只在线上出现，表里没有
  assert.equal(render('好[偷笑]啊'), '好啊')
  assert.equal(render('[表情:偷笑]'), '')
  assert.equal(render('a [笑哭] b'), 'a  b')
  assert.ok(!render('[偷笑][偷笑]').includes('['))
})

test('表里有的名字（比如 微笑）照常解析——别再拿它当反例', () => {
  assert.match(render('[微笑]'), /data-value="微笑"/)
  assert.equal(hasEmoji('[微笑]'), true)
})

test('跨包重名 点赞（7 个包）稳定解析、不抛错', () => {
  const likes = EMOJI_SET.filter((e) => e.name === '点赞')
  assert.equal(likes.length, 7)
  const got = render('[表情:点赞]')
  assert.equal(got, likes[0].send)                        // 取表里第一条，规则固定
  assert.equal(render('[点赞]'), got)
  assert.equal(render('[点赞]'), render('[表情:点赞]'))     // 反复调用不变
  assert.ok(likes.some((e) => e.send === got))
})

test('max 生效：给 5 个只留 3 个，且不留方括号', () => {
  const s = render('[点赞][抱抱][比心][开心][摸鱼]')
  assert.equal((s.match(/<kb-emoji/g) || []).length, 3)
  assert.ok(!s.includes('['))
  assert.equal((render('[点赞][抱抱][比心]', { max: 1 }).match(/<kb-emoji/g) || []).length, 1)
  assert.equal((render('[点赞][抱抱]', { max: Infinity }).match(/<kb-emoji/g) || []).length, 2)
})

test('同一表情只留第一个', () => {
  const s = render('[表情:点赞][点赞][抱抱]')
  assert.equal((s.match(/data-value="点赞"/g) || []).length, 1)
  assert.equal((s.match(/<kb-emoji/g) || []).length, 2)
})

test('render 不动普通中文、标点、全角括号、换行', () => {
  const plain = '兄弟们，这游戏真好玩！\n第 2 天了，还是没抽到（哭）。\n「见上文」——OK？'
  assert.equal(render(plain), plain)
  assert.equal(stripEmoji(plain), plain)
  assert.equal(hasEmoji(plain), false)
  const mixed = '好耶' + ONLINE[0][1] + '！'
  assert.equal(render(mixed), mixed, '已经拼好的标签不该被再动手')
})

test('顺序契约：tidy 会吃掉标签，所以 render 必须在清洗之后', () => {
  const tag = render('[表情:点赞]')
  assert.equal(tidy(tag, 140), '')           // 先 render 再 tidy → 表情没了
  assert.equal(tidy('恭喜[表情:点赞]', 140), '恭喜[表情:点赞]') // 先 tidy 再 render 才是对的
  const kept = render(tidy('恭喜[表情:点赞]', 140))
  assert.equal(kept.slice(0, 2), '恭喜')
  assert.match(kept, /^恭喜<kb-emoji src="[^"]+" data-value="点赞"\/>$/)
})

test('stripEmoji 之后再 tidy 不残留标签碎片（含被截断的标签）', () => {
  const full = '恭喜' + render('[表情:点赞][表情:抱抱]', { max: 2 })
  assert.equal((full.match(/<kb-emoji/g) || []).length, 2)
  const truncated = full.slice(0, full.length - 8)   // 模拟截断把标签砍断
  assert.match(truncated, /<kb-emoji [^>]*$/)   // 尾巴上留了个没收口的标签头
  for (const s of [full, truncated, 'x' + render('[表情:抱抱]') + '[偷笑]']) {
    const cleaned = tidy(stripEmoji(s), 140)
    assert.ok(!/kb-emoji|data-value|src=/.test(cleaned), '残留标签：' + cleaned)
    assert.ok(!/[<>]/.test(cleaned), '残留尖括号：' + cleaned)
  }
  assert.equal(stripEmoji('恭喜[表情:点赞]'), '恭喜')
  assert.equal(stripEmoji(full), '恭喜')
  assert.equal(hasEmoji(full), true)
  assert.equal(hasEmoji('[偷笑]'), false)
})

test('emojiNames: common 挑精选（≤40、抱抱系优先）；默认给全表', () => {
  const all = emojiNames()
  assert.equal(all.length, 373)
  assert.equal(new Set(all).size, 373)
  const common = emojiNames({ common: true })
  assert.ok(common.length > 0 && common.length <= 40, 'common 数量：' + common.length)
  assert.equal(common[0], '抱抱')
  assert.ok(common.slice(0, 3).every((n) => n.includes('抱')))
  const allSet = new Set(all)
  for (const n of common) assert.ok(allSet.has(n), n + ' 不在表里')
  for (const n of common) assert.match(render('[表情:' + n + ']'), /<kb-emoji /)
})

test('EMOJI_PROMPT_RULE 是中文规则，只给名单、要求克制', () => {
  assert.match(EMOJI_PROMPT_RULE, /\[表情:/)
  assert.match(EMOJI_PROMPT_RULE, /克制/)
  assert.match(EMOJI_PROMPT_RULE, /抱抱/)
  assert.match(EMOJI_PROMPT_RULE, /最多 3 个/)
  assert.ok(!EMOJI_PROMPT_RULE.includes('<kb-emoji'), '别让模型自己拼标签')
})
