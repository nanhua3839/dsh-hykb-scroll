// 快爆表情层：把 [表情:名] / [小表情:名] / [表情包:名] / [名] 拼成线上正文里那种自闭合短标签：
//   <kb-emoji src="https://…/xxx.gif" data-value="点赞"/>
// 线上就是这个形态（_facts/emoji_probe/online_pairs.json），全链路没有「方括号 → 图片」的转换器，
// [微笑] 这种永远是字符，所以表情只能由这里拼出来。
//
// 两种表情，同一个标签、只是图片不同（实测图片尺寸分的家，_facts/emoji_probe）：
//   小表情   emoji 包 80 条，/v2/emoji/kbemojiNNN.png，64×64；
//   表情包   其余 15 个包 368 条，120–168 的 gif/png 大图。
// 同名（点赞 / 生气 / 鼓掌…）两边都有，表里表情包在前，只按名字索引就会永远落到表情包 ——
// 所以这里按「包」分了两张索引表，不带前缀时**小表情优先**，要表情包就写 [表情包:名]。
//
// ⚠️ 顺序契约：清洗 → 截断 → render()。
//   ai.mjs 的 tidy() 和 digest.mjs 的 strip() 都带 replace(/<[^>]+>/g, ' ')，会把 <kb-emoji …/> 整块吃掉；
//   render() 之后再 slice / 截断会把标签拦腰砍断，留下 <kb-emoji src="htt 这种碎片。
//   所以拼表情必须发生在一切清洗与截断之后，render 之后不许再 tidy / slice。
//
// 这一层不接线，也不联网：只出数据 + 纯函数。
import { EMOJI_DATA } from './emoji-data.mjs'

/** 小表情的包名。别的包都是表情包（大图）。 */
const FACE_PACKS = new Set(['emoji'])

/** 线上发送串：自闭合、无空格、无嵌套，和正文里逐字节一致。 */
const send = (src, name) => '<kb-emoji src="' + src + '" data-value="' + name + '"/>'

/** 全部表情：[{ group, kind, name, send }]，顺序即 emoji-data.mjs 的表顺序。 */
export const EMOJI_SET = Object.freeze(
  EMOJI_DATA.map(([group, name, src]) => Object.freeze({
    group,
    kind: FACE_PACKS.has(group) ? 'face' : 'sticker',
    name,
    send: send(src, name),
  })),
)

/** 去重后的包名（16 个）。 */
export const EMOJI_SETS = Object.freeze([...new Set(EMOJI_DATA.map(([group]) => group))])

/**
 * 两张名字索引，各按包内顺序取第一条：
 *   face    小表情（emoji 包），64×64
 *   sticker 表情包，大图
 * 45 个名字跨包重名，kind 内部也可能重名（同一个包里重复），所以仍然是「先到先得」。
 */
const byKind = { face: new Map(), sticker: new Map() }
for (const e of EMOJI_SET) if (!byKind[e.kind].has(e.name)) byKind[e.kind].set(e.name, e)

/** 不带前缀时的解析顺序：小表情优先，小表情里没有再落到表情包。 */
const ORDER = ['face', 'sticker']

/** 前缀 → 偏好；两边都找不到时会落到另一边，所以不会因为写错前缀就一条表情都没有。 */
const PREF = { 小表情: 'face', 表情: 'face', 表情包: 'sticker', 大表情: 'sticker' }

/** 一个 token 的样子：[名] / [表情:名] / [小表情:名] / [表情包:名]。名字里不许出现方括号、尖括号、空白。 */
const TOKEN_ALL = /\[(?:(表情包|小表情|大表情|表情)[:：])?([^\[\]<>()（）\s]{1,12})\]/gu
/** 已拼好的标签，含被截断的残片（没有收尾的 > 就吃到行/串尾）。 */
const TAG = /<kb-emoji\b[^>]*(?:\/>|>|$)/gi

/** 按名字找：先按前缀偏好那一边找，找不到再落到另一边。 */
function resolve(name, pref) {
  const order = pref ? [pref, ...ORDER.filter((k) => k !== pref)] : ORDER
  for (const k of order) {
    const hit = byKind[k].get(name)
    if (hit) return hit
  }
  return null
}

/** 精选小表情：挑的是「随便说句话就能带一个」的那批，都在 emoji 包里。 */
export const FACE_COMMON = Object.freeze([
  '微笑', '哈哈', '开心', '调皮', '眨眼', '斜眼', '亲亲', '飞吻',
  '破涕为笑', '脸红', '吐舌头', '满足', '耶', '鼓掌', '点赞', '爱心',
  '心碎', '祈祷', '生气', '难过', '哭泣', '星星', '玫瑰花', '咖啡',
  '蛋糕', '炸弹', '足球', '钻石',
].filter((n) => byKind.face.has(n)))

/** 精选表情包：大图，一条里最多一个，用来表达「整段情绪」而不是补一个语气。 */
export const STICKER_COMMON = Object.freeze([
  '抱抱', '抱大腿', '吃瓜', '摸鱼', '暗中观察', '大受震撼',
  '好耶', '下次一定', '不愧是我', '举手手', '在搬了', '吃一口',
].filter((n) => byKind.sticker.has(n)))

/**
 * 可选名字。
 * @param {{ common?: boolean, kind?: 'face'|'sticker' }} [opts]
 *   common:true 给精选（face 28 / sticker 12，适合塞进提示词）；kind 限定某一边；都不给 = 全表去重名（373）。
 */
export function emojiNames({ common = false, kind } = {}) {
  const k = kind === 'face' || kind === 'sticker' ? kind : null
  if (common) {
    if (k === 'face') return [...FACE_COMMON]
    if (k === 'sticker') return [...STICKER_COMMON]
    return [...new Set([...FACE_COMMON, ...STICKER_COMMON])]
  }
  const out = []
  const seen = new Set()
  for (const e of EMOJI_SET) {
    if (k && e.kind !== k) continue
    if (seen.has(e.name)) continue
    seen.add(e.name)
    out.push(e.name)
  }
  return out
}

/**
 * 强制用的那一个小表情：先看给的名字（小表情里得有），再按精选顺序，最后取表里第一个小表情。
 * @param {string} [name]
 * @returns {{ group: string, kind: string, name: string, send: string }}
 */
export function pickFace(name) {
  const want = String(name ?? '').trim()
  if (want) {
    const hit = byKind.face.get(want)
    if (hit) return hit
  }
  for (const n of FACE_COMMON) {
    const hit = byKind.face.get(n)
    if (hit) return hit
  }
  return EMOJI_SET.find((e) => e.kind === 'face') || EMOJI_SET[0]
}

/**
 * 把 token 换成线上发送串。
 * 规则：
 *   - 不带前缀 → 小表情优先，小表情里没有再落到表情包；
 *   - 带前缀 → 先按前缀那一边找，那边没有再落到另一边（别让写错前缀把表情写没）；
 *   - 名字两边都没有 → 整个 token 删掉，不留方括号（[偷笑] 这种本来就是字符垃圾）；
 *   - 同一个发送串出现多次 → 只保留第一个，后面的 token 删掉；
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
  return s.replace(TOKEN_ALL, (whole, prefix, name) => {
    const hit = resolve(name, PREF[prefix] || null)
    if (!hit) return ''
    if (used.has(hit.send)) return ''
    if (used.size >= limit) return ''
    used.add(hit.send)
    return hit.send
  })
}

/**
 * 没有表情就补一个（表情包在末尾）。
 * 「对方让你发表情」那条需求靠它兜底：不指望模型自觉。
 * suffix 给了就先在正文末尾、后缀之前插进去，别把表情拼到「-内容由AI生成」后面。
 * @param {string} text
 * @param {{ name?: string, suffix?: string }} [opts]
 * @returns {string}
 */
export function ensureEmoji(text, { name, suffix } = {}) {
  const s = String(text ?? '')
  if (!s.trim()) return s
  if (hasEmoji(s)) return s
  const tag = pickFace(name).send
  const suf = String(suffix ?? '').trim()
  if (suf) {
    const at = s.lastIndexOf(suf)
    if (at >= 0) return s.slice(0, at) + tag + s.slice(at)
  }
  return s + tag
}

/**
 * 回复正文的最后一刀：先 render 成真标签，再在「对方要表情」时兜底补一个。
 * 顺序不能反 —— render 之后不许再清洗/截断（会把标签削断）。
 * allow=false（楼中楼关了表情）时 token 一并删掉，也不会补。
 * @param {string} text
 * @param {{ wants?: boolean, allow?: boolean, max?: number, suffix?: string }} [opts]
 * @returns {string}
 */
export function finishReply(text, { wants = false, allow = true, max = 3, suffix } = {}) {
  let s = render(text, { max: allow ? max : 0 })
  if (allow && wants) s = ensureEmoji(s, { suffix })
  return s
}

/**
 * 去掉表情：已拼好的 <kb-emoji …/>（含被截断的残片）和所有 token 都删掉。
 * 用来算字数、做纯文本展示、或者给不认识标签的地方兜底。
 */
export function stripEmoji(text) {
  return String(text ?? '').replace(TAG, '').replace(TOKEN_ALL, '')
}

/** 有没有表情：已经拼好的标签，或者一个能解析的 token。未知名 token 不算。 */
export function hasEmoji(text) {
  const s = String(text ?? '')
  if (/<kb-emoji\b/iu.test(s)) return true
  for (const m of s.matchAll(TOKEN_ALL)) if (resolve(m[2], PREF[m[1]] || null)) return true
  return false
}

/**
 * 对方是不是在要表情（「发个表情」「来一个表情包」）。
 * 陈述句「这个表情包太搞笑了」不匹配；带请求动词的才匹配。
 * 宁可多补一个，也别把「发表情」变成嘴上说说 —— 所以判定放在请求动词上，不放在「有没有表情」上。
 * @param {string} text
 */
const ASK_EMOJI = /(?:发|来|给|整|甩|安排|求|要)[^。！？!?\n]{0,4}(?:表情包?|小表情)|(?:表情包?|小表情)[^。！？!?\n]{0,4}(?:发|来|给|整|安排)/u
export function wantsEmoji(text) {
  return ASK_EMOJI.test(String(text ?? ''))
}

/** 拼在系统提示最后的表情规则。两边的名单独给精选，别把 373 个塞进去。 */
export const EMOJI_PROMPT_RULE = [
  '想放表情就写 [小表情:名]，比如 [小表情:微笑]；直接写 [名] 也认（不带前缀时优先小表情）。',
  '小表情名字只能从这份名单里挑：' + FACE_COMMON.join('、') + '。',
  '想要表情包（大图）就写 [表情包:名]，名字只能从这份名单里挑：' + STICKER_COMMON.join('、') + '。',
  '克制使用：一条消息最多 3 个，能不用就不用；别自己去拼标签、别贴图片地址。',
  '对方要你发表情、或者你本来就想发一个时，必须真的写一个 token —— 光说「给你一个表情」不算发。',
].join('\n')
