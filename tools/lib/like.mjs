// 自动点赞能力层：两个写接口 + 纯决策（挑谁赞）+ 模型判定口径。接线由外部做。
//
// 写接口的参数照抄 hykb-api.mjs 的 replyOperate：URLSearchParams + guardedFetch(..., 'write')，
// 写额度 / 写冷却 / 风控暂停全在 traffic.mjs 里，这里不绕过。
// 只读判重字段：读帖 result.topic.is_up_voted / result.reply[].is_up_voted（未赞实测 -1，已赞未观测），
// 所以一律走 liked() 归一化，不要拿 === 1 比。
import { guardedFetch } from './traffic.mjs'
import { loadCred, cookieHeader } from './cred.mjs'
import { PC } from './hykb-api.mjs'

const json = async (res) => {
  const text = await res.text()
  try { return JSON.parse(text) } catch { return { code: -1, msg: 'non-json', raw: text.slice(0, 300) } }
}

const post = (url, body) => guardedFetch(url, {
  method: 'POST',
  headers: {
    'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
    'x-requested-with': 'XMLHttpRequest',
    cookie: cookieHeader(loadCred()),
  },
  body: body.toString(),
}, 'write')

/**
 * 给帖子点赞 / 取消赞。
 * body 实测：type=10&state=1&tid=<tid>（取消 state=2）；成功 code===100。
 * 返回值就是平台响应原文（{code,msg,...}），调用方按 code 判。
 */
export async function likeTopic({ tid, like = true }) {
  const body = new URLSearchParams({ type: '10', state: like ? '1' : '2', tid: String(tid) })
  return json(await post(PC + '/index.php?m=api&c=thread&a=threadOperate', body))
}

/**
 * 给楼层（回复）点赞 / 取消赞。
 * body 实测：fid=<版块id>&tid=<tid>&replyId=<楼层id>&type=1&state=1（取消 state=2）；成功 code===100。
 */
export async function likeReply({ fid, tid, replyId, like = true }) {
  const body = new URLSearchParams({ fid: String(fid), tid: String(tid), replyId: String(replyId), type: '1', state: like ? '1' : '2' })
  return json(await post(PC + '/index.php?m=api&c=thread&a=replyOperate', body))
}

/** 平台 is_up_voted 归一化：1 / '1' → true；-1 / -2 / 0 / undefined / 非数字 → false。 */
export function liked(v) {
  const n = Number(v)
  return Number.isFinite(n) && n > 0
}

/** tag → like 里的开关字段。② 优质内容一类里，热评跟帖子共用 quality 开关。 */
const TAG_SWITCH = { browsed: 'browsed', quality: 'quality', hotcomment: 'quality', reply: 'replies' }
/** 轮流的固定顺序：先"读到过"，再"写得好"，再"热评"，最后"别人的回复"。 */
const TAG_ORDER = ['browsed', 'quality', 'hotcomment', 'reply']

function reasonOf(it, lk, min) {
  switch (it.tag) {
    case 'browsed': return '本轮读过'
    case 'quality': return lk.qualityJudge === 'ai' ? '待模型判定' : '打分 ' + (Number(it.score) || 0) + ' ≥ 分数线 ' + min
    case 'hotcomment': return '帖子下的热评'
    case 'reply': return '评论区里的回复'
    default: return String(it.tag || '')
  }
}

/**
 * 纯函数：把本轮扫到的候选排成要赞清单（≤ cfg.like.perRoundMax）。
 *
 * items: [{ kind:'topic'|'reply', id, topicId, fid, replyId, score, isOwn, alreadyLiked, read, tag }]
 *   tag = browsed / quality / hotcomment / reply，各自挂在 like.browsed / quality / replies 上（hotcomment 挂 quality）。
 * 规则：开关关掉的一类直接丢；自己是 / 已赞 / 明确没读过（read===false）的都跳过；
 *       qualityJudge==='score' 时 quality 类要过分数线；同一 kind+id 只留一条；
 *       三类同时开时按 browsed→quality→hotcomment→reply 轮流取，避免一类吃满额度。
 */
export function planLikes({ cfg = {}, items = [] } = {}) {
  const lk = cfg.like || {}
  const max = Math.trunc(Number(lk.perRoundMax) || 0)
  if (max <= 0 || !Array.isArray(items) || !items.length) return []
  const min = Number(lk.qualityMinScore) || 0
  const buckets = new Map(TAG_ORDER.map((t) => [t, []]))
  const seen = new Set()

  items.forEach((it, at) => {
    if (!it || !it.kind || it.id === undefined || it.id === null) return
    const sw = TAG_SWITCH[it.tag]
    if (!sw || !lk[sw]) return
    if (it.isOwn === true || liked(it.alreadyLiked) || it.read === false) return
    const key = it.kind + ':' + it.id
    if (seen.has(key)) return
    if (it.tag === 'quality' && lk.qualityJudge === 'score' && !(Number(it.score) >= min)) return
    seen.add(key)
    buckets.get(it.tag).push({
      at,
      item: {
        ...it,
        tid: it.kind === 'topic' ? it.id : it.topicId,
        needsJudge: it.tag === 'quality' && lk.qualityJudge === 'ai',
        reason: reasonOf(it, lk, min),
      },
    })
  })

  for (const t of TAG_ORDER) {
    buckets.get(t).sort((a, b) => (Number(b.item.score) || 0) - (Number(a.item.score) || 0) || a.at - b.at)
  }

  const out = []
  let moved = true
  while (out.length < max && moved) {
    moved = false
    for (const t of TAG_ORDER) {
      if (out.length >= max) break
      const b = buckets.get(t)
      if (!b.length) continue
      out.push(b.shift().item)
      moved = true
    }
  }
  return out
}

/** qualityJudge==='ai' 时交给模型的一句话：只回"是"或"否"，省 token 也好解析。 */
export function judgePrompt(item = {}) {
  const text = String(item.title || item.text || item.content || item.excerpt || '').replace(/\s+/g, ' ').trim().slice(0, 200)
  const what = item.kind === 'reply' ? '这条回复' : '这个帖子'
  return '值不值得给' + what + '点赞？只回一个字：是 或 否。内容：' + (text || '（无正文）')
}

/** 模型回答 → boolean：是 / 值得 / y / yes / 1 开头为正，其余（含含糊、空）为否。 */
export function parseJudge(text) {
  const s = String(text ?? '')
    .trim()
    .replace(/^[\s"'`*#>：:，,。.!！?？()（）\[\]【】]+/, '')
    .toLowerCase()
  if (!s) return false
  return /^(值得|是|对的|可以|好|y|yes|true|1)(?![0-9a-z])/.test(s)
}
