// 快爆表情层：把 [表情:名] / [名] 拼成线上正文里那种自闭合短标签：
//   <kb-emoji src="https://…/xxx.gif" data-value="点赞"/>
// 线上就是这个形态（_facts/emoji_probe/online_pairs.json），全链路没有「方括号 → 图片」的转换器，
// [微笑] 这种永远是字符，所以表情只能由这里拼出来。
//
// ⚠️ 顺序契约：清洗 → 截断 → render()。
//   ai.mjs 的 tidy() 和 digest.mjs 的 strip() 都带 replace(/<[^>]+>/g, ' ')，会把 <kb-emoji …/> 整块吃掉；
//   render() 之后再 slice / 截断会把标签拦腰砍断，留下 <kb-emoji src="htt 这种碎片。
//   所以拼表情必须发生在一切清洗与截断之后，render 之后不许再 tidy / slice。
//
// 这一层不接线，也不联网：只出数据 + 纯函数。
import { EMOJI_DATA } from './emoji-data.mjs'

/** 线上发送串：自闭合、无空格、无嵌套，和正文里逐字节一致。 */
const send = (src, name) => '<kb-emoji src="' + src + '" data-value="' + name + '"/>'

/** 全部表情：[{ group, name, send }]，顺序即 emoji-data.mjs 的表顺序（决定重名解析结果）。 */
export const EMOJI_SET = Object.freeze(
  EMOJI_DATA.map(([group, name, src]) => Object.freeze({ group, name, send: send(src, name) })),
)

/** 去重后的表情包名（16 个）。 */
export const EMOJI_SETS = Object.freeze([...new Set(EMOJI_DATA.map(([group]) => group))])

/**
 * 名字索引。45 个名字跨包重名（点赞在 7 个包里都有），所以：
 *   - 真索引键是 group + name（唯一，换包不串味）；
 *   - 只给名字时取表里第一条，这是稳定的解析规则，不随机、不抛错。
 */
const byName = new Map()
for (const e of EMOJI_SET) if (!byName.has(e.name)) byName.set(e.name, e)

/** 一个 token 的样子：[表情:名] 或 [名]。名字只许这么些字符——带空格/括号/尖括号的段落不算 token。 */
const TOKEN_SRC = '\\[(?:表情[:：])?([^\\[\\]<>()（）\\s]{1,12})\\]'
const TOKEN_ALL = new RegExp(TOKEN_SRC, 'gu')
/** 已拼好的标签，含被截断的残片（没有收尾的 > 就吃到行/串尾）。 */
const TAG = /<kb-emoji\b[^>]*(?:\/>|>|$)/gi

/** 精选常用名：抱抱系排最前，其余按下面的顺序；表里没有的自动剔除，总数 ≤ 40。 */
const COMMON_BASE = [
  '抱抱', '抱大腿', '抱小腿',
  '点赞', '比心', '开心', '哈哈', '好耶', '加油', '冲鸭', '摸鱼', '吃瓜',
  '生气', '无语', '尴尬', '思考', '疑问', '摆烂', '暗中观察', '大受震撼',
  '收到', '谢谢', '再见', '哭泣', '难过', '破涕为笑', '斜眼', '狗头',
  '爱心', '鼓掌', 'OK', '满足', '调皮', '亲亲', '爆米花雨', '下次一定',
  '不愧是我', '举手手', '在搬了', '吃一口',
]
const COMMON = (() => {
  const names = COMMON_BASE.filter((n) => byName.has(n))
  return Object.freeze([
    ...names.filter((n) => n.includes('抱')),
    ...names.filter((n) => !n.includes('抱')),
  ].slice(0, 40))
})()

/**
 * 可选名字。common:true 给精选常用（≤40，抱抱系优先，适合塞进提示词）；默认给全表 373 个名字。
 * 都是去重后的名字，顺序稳定。
 */
export function emojiNames({ common = false } = {}) {
  return common ? [...COMMON] : [...byName.keys()]
}

/**
 * 把 [表情:名] / [名] 换成线上发送串。
 * 规则：
 *   - 名字在表里 → 取表里第一条（跨包重名也一样，稳定）；
 *   - 名字不在表里 → 整个 token 删掉，不留方括号（[偷笑] 这种本来就是字符垃圾）；
 *   - 同一个表情出现多次 → 只保留第一个，后面的 token 删掉；
 *   - 最多 max 个，超出的 token 删掉（不是留成字符）；
 *   - 其它文本（中文、标点、换行、已经存在的 <kb-emoji …/>）一个字节都不动。
 * @param {string} text
 * @param {{ max?: number }} [opts] max 默认 3；Infinity 表示不限
 * @returns {string}
 */
export function render(text, { max = 3 } = {}) {
  const s = String(text ?? '')
  if (!s) return s
  const n = Number(max)
  const limit = n === Infinity ? Infinity : Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 3
  const used = new Set()
  return s.replace(TOKEN_ALL, (whole, name) => {
    const hit = byName.get(name)
    if (!hit) return ''
    if (used.has(hit.name)) return ''
    if (used.size >= limit) return ''
    used.add(hit.name)
    return hit.send
  })
}

/**
 * 去掉表情：已拼好的 <kb-emoji …/>（含被截断的残片）和 [表情:名] / [名] token 都删掉。
 * 用来算字数、做纯文本展示、或者给不认识标签的地方兜底。
 */
export function stripEmoji(text) {
  return String(text ?? '').replace(TAG, '').replace(TOKEN_ALL, '')
}

/** 有没有表情：已经拼好的标签，或者一个能解析的 token。未知名 token 不算。 */
export function hasEmoji(text) {
  const s = String(text ?? '')
  if (/<kb-emoji\b/iu.test(s)) return true
  for (const m of s.matchAll(TOKEN_ALL)) if (byName.has(m[1])) return true
  return false
}

/** 拼在系统提示最后的表情规则。名单只给精选常用名，别塞 373 个进去。 */
export const EMOJI_PROMPT_RULE = [
  '想放表情就写 [表情:名]，比如 [表情:抱抱]；写成 [名] 也认。',
  '名字只能从这份名单里挑，别自己编、别写别的表情包名：' + COMMON.join('、') + '。',
  '克制使用：一条消息最多 3 个，能不用就不用；别自己去拼标签、别贴图片地址。',
].join('\n')
