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
  ensureEmoji,
  finishReply,
  pickFace,
  wantsEmoji,
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

test('和线上正文逐字节一致（6 条线上样本，三种写法都对得上）', () => {
  assert.ok(ONLINE.length >= 5)
  for (const [name, raw] of ONLINE) {
    assert.equal(render('[表情:' + name + ']'), raw, name + ' 拼出来和线上不一样')
    assert.equal(render('[' + name + ']'), raw, name + ' 的 [名] 写法拼出来和线上不一样')
    assert.equal(render('[表情包:' + name + ']'), raw, name + ' 的 [表情包:名] 写法拼出来和线上不一样')
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
    assert.deepEqual(Object.keys(e).sort(), ['group', 'kind', 'name', 'send'])
    assert.ok(e.kind === 'face' || e.kind === 'sticker')
    assert.equal(e.kind === 'face', e.group === 'emoji', '只有 emoji 包算小表情')
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

test('跨包重名 点赞（7 个包）：不带前缀先给小表情，要表情包得写前缀', () => {
  const likes = EMOJI_SET.filter((e) => e.name === '点赞')
  assert.equal(likes.length, 7)
  const faceLike = likes.find((e) => e.kind === 'face')
  assert.ok(faceLike, '小表情包里应该有 点赞')
  const got = render('[点赞]')
  assert.equal(got, faceLike.send)                 // 小表情优先（她以前只会发表情包就是这里反的）
  assert.equal(render('[表情:点赞]'), got)
  assert.equal(render('[小表情:点赞]'), got)
  assert.match(got, /\/v2\/emoji\//)               // 64×64 那一家
  const stickerLike = render('[表情包:点赞]')
  assert.equal(stickerLike, likes.find((e) => e.kind === 'sticker').send)
  assert.notEqual(stickerLike, got)
  assert.ok(!/\/v2\/emoji\//.test(stickerLike))
})

test('前缀那一边没有这个名字时回落到另一边，不会一条表情都不发', () => {
  const bao = EMOJI_SET.find((e) => e.name === '抱抱')
  assert.equal(bao.kind, 'sticker')                 // 抱抱 只在小表情表里没有
  assert.equal(render('[抱抱]'), bao.send)
  assert.equal(render('[小表情:抱抱]'), bao.send)     // 前缀落空 → 回到表情包
  assert.equal(render('[表情包:微笑]'), EMOJI_SET.find((e) => e.name === '微笑' && e.kind === 'face').send)
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

test('emojiNames: common 两边各给精选、可按 kind 取；默认给全表', () => {
  const all = emojiNames()
  assert.equal(all.length, 373)
  assert.equal(new Set(all).size, 373)
  const face = emojiNames({ common: true, kind: 'face' })
  const sticker = emojiNames({ common: true, kind: 'sticker' })
  assert.ok(face.length > 0 && face.length <= 28, 'face 精选数量：' + face.length)
  assert.ok(sticker.length > 0 && sticker.length <= 12, 'sticker 精选数量：' + sticker.length)
  assert.equal(sticker[0], '抱抱')
  assert.equal(emojiNames({ kind: 'face' }).length, 80)
  assert.equal(emojiNames({ kind: 'sticker' }).length, 302)
  for (const n of face) assert.match(render('[小表情:' + n + ']'), /\/v2\/emoji\//)
  for (const n of sticker) assert.match(render('[表情包:' + n + ']'), /<kb-emoji /)
})

test('ensureEmoji：没表情就补一个小表情；有表情不动；后缀之前插', () => {
  const plain = ensureEmoji('这不是挺好玩')
  assert.equal((plain.match(/<kb-emoji/g) || []).length, 1)
  assert.match(plain, /\/v2\/emoji\//)          // 补的是 64×64 小表情
  assert.equal(ensureEmoji(plain), plain)          // 已经有了就不再加
  assert.equal(ensureEmoji('恭喜' + render('[表情包:抱抱]')), '恭喜' + render('[表情包:抱抱]'))
  const withSuffix = ensureEmoji('真好玩\n-内容由AI生成', { suffix: '-内容由AI生成' })
  assert.equal(withSuffix, '真好玩\n<EMOJI>-内容由AI生成'.replace('<EMOJI>', pickFace().send))
  assert.equal(ensureEmoji('   '), '   ')
  assert.equal(pickFace().kind, 'face')
  assert.equal(pickFace('抱抱').kind, 'face', '表情包名字进来也只能挑小表情')
})

test('finishReply：对方要表情就真发一个；没人要就不多发；关了表情连补都不补', () => {
  const forced = finishReply('祝你玩得开心', { wants: true })
  assert.equal((forced.match(/<kb-emoji/g) || []).length, 1)
  assert.match(forced, /\/v2\/emoji\//)             // 强制补的是小表情
  assert.ok(!/\[/.test(forced), '不能留方括号')

  const own = finishReply('太强了[微笑]', { wants: true })
  assert.equal((own.match(/<kb-emoji/g) || []).length, 1, '自己写了就不再补')

  const pack = finishReply('哈哈[表情包:抱抱]', { wants: true })
  assert.equal((pack.match(/<kb-emoji/g) || []).length, 1)
  assert.ok(!/\/v2\/emoji\//.test(pack), '她选了表情包就尊重她的选择')

  assert.equal(finishReply('祝你玩得开心'), '祝你玩得开心', '没人要表情时一个都不补')

  const off = finishReply('给你[微笑]', { wants: true, allow: false })
  assert.equal(off, '给你', '楼中楼关了表情：token 删掉，也不补')

  // 真机上 applySuffix 已经把后缀贴在末尾了，这里照着实际传入
  const s = finishReply('真好玩\n-内容由AI生成', { wants: true, suffix: '-内容由AI生成' })
  assert.match(s, /<kb-emoji [^>]*\/>-内容由AI生成$/, '表情要在后缀前面')
  assert.ok(!s.includes('真好玩<kb-emoji'), '别插在后缀后面')
})

test('wantsEmoji：认「发个表情」，不把陈述句当请求', () => {
  for (const s of ['给我发个表情', '来一个表情包', '发表情', '整个表情看看', '表情发一个']) {
    assert.equal(wantsEmoji(s), true, s)
  }
  for (const s of ['这个表情包太搞笑了', '我看不懂这个表情', '你好呀']) {
    assert.equal(wantsEmoji(s), false, s)
  }
})

test('EMOJI_PROMPT_RULE 只给名单、两种写法都在、要求克制', () => {
  assert.match(EMOJI_PROMPT_RULE, /\[小表情:/)
  assert.match(EMOJI_PROMPT_RULE, /\[表情包:/)
  assert.match(EMOJI_PROMPT_RULE, /克制/)
  assert.match(EMOJI_PROMPT_RULE, /抱抱/)       // 表情包精选里有
  assert.match(EMOJI_PROMPT_RULE, /微笑/)       // 小表情精选里有
  assert.match(EMOJI_PROMPT_RULE, /最多 3 个/)
  assert.match(EMOJI_PROMPT_RULE, /必须真的写一个/)
  assert.ok(!EMOJI_PROMPT_RULE.includes('<kb-emoji'), '别让模型自己拼标签')
})
