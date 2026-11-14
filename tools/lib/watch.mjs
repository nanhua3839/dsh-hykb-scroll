// 监听引擎：六类监听源 + 白黑名单 + 去重冷却 + AI 回复，全部在这里。
//
// 六类源：
//   ① forum   —— 填板块 id，扫这个板块的最新帖子（按最后回复时间倒序的第一页）
//   ② topic   —— 填帖子 id/链接，扫这帖的主楼层和楼中楼
//   ③ atme    —— @ 我：消息中心的 mode=3 通知列表（全站唯一能拿到「谁 @ 了我」明细的地方），
//                不需要填任何 id 就能工作 —— 这就是「什么都不配、只靠别人 @ 她就回」的那条路
//   ④ at      —— 对 ①②③ 扫到的内容统一做「算不算叫我」的收窄，也能单独指定范围
//   ⑤ replied —— 回复我的：消息中心的 mode=1 通知（101/102/103）。通知自带 tid / rid / to_rid
//                和对方那句话：101/102 零额外读帖，只有 103 为一帖多读一次（回进楼中楼要板块号）
//   ⑥ mine    —— 假 @ 兜底：平台不为正文里的纯文本「@昵称」发任何通知，只能自己扫
//                「我参与过的帖」，每轮按游标轮转读几个
//
// 触发条件（满足任一）：
//   · 内容 @ 我（富文本 kb-contact 或纯文本 @昵称，判据在 trigger.mjs）
//   · 平台通知说有人 @ 我 / 回了我（③⑤：这两类不再拿正文匹配一遍）
//   · 作者是 owner（大号）—— 这就是「大号发帖/回帖 → 小号接话」的主场景
//
// 首次扫描只登记不回复（bootstrap）：否则第一次启动会把历史内容全回一遍。
import { sectionTopics } from './forum.mjs'
import { topicDetail, replyOperate, commentOperate, atList } from './hykb-api.mjs'
import { finishReply, wantsEmoji, EMOJI_PROMPT_RULE } from './emoji.mjs'
import { likeTopic, likeReply } from './like.mjs'
import { makeFilter } from './filter.mjs'
import { matchTrigger } from './trigger.mjs'
import { loadSeen, saveSeen, seenReply, markReply, seenPerson, markPerson, audit } from './state.mjs'
import { loadCred, missingForWrite } from './cred.mjs'
import { chat, replyPrompt, replySummaryPrompt, applySuffix } from './ai.mjs'
import { screenInbound, screenOutbound, describeVerdict } from './safety.mjs'
import { gate as maskwordGate } from './maskword.mjs'
import { findRepeat, rememberSaid } from './dedupe.mjs'
import { parseKbTime, kbTimeText } from './timefmt.mjs'
import { record as recordHistory } from './history.mjs'
import { loadPostLog } from './post.mjs'

const strip = (h) => String(h || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)

/**
 * 帖子的四种「身份标记」和三个时间，列表项与详情页字段同名同义：
 *   is_essence 精华 / is_top 置顶 / is_official 官方发布 / is_article_contribution 长文投稿
 *   time 发布 / edit_time 修改 / reply_time 最近回复（都是「YYYY-MM-DD HH:MM:SS」字符串）
 */
export const flagsOf = (t) => {
  const o = t || {}
  return {
    isEssence: num(o.is_essence) > 0,
    isTop: num(o.is_top) > 0,
    isOfficial: num(o.is_official) > 0,
    isContribution: num(o.is_article_contribution) > 0,
    publishMs: parseKbTime(o.time),
    editMs: parseKbTime(o.edit_time),
    replyMs: parseKbTime(o.reply_time),
    publishStr: kbTimeText(o.time),
    editStr: kbTimeText(o.edit_time),
    replyStr: kbTimeText(o.reply_time),
  }
}

/**
 * 板块号（commentOperate 的 fid）。
 * 实测有的帖 topic.sid 是空的，真正的值在楼层上（reply[].sid，例如 23064），
 * 拿 topic.sid 一处读会在真机上一直发出 fid=''。取法按可靠度排：
 *   ① topic.sid 有值就用它
 *   ② 否则这层楼自己的 sid
 *   ③ 再否则任一楼层的 sid（同帖各楼层板块号一致）
 *   ④ 都没有才回空串（调用方照旧：sectionId 空只是过滤/兜底口径变，不另外抛错）
 * @returns {string}
 */
export function sidOf(topic, replies, floorId) {
  const own = String(topic?.sid || '')
  if (own) return own
  const list = Array.isArray(replies) ? replies : []
  const want = String(floorId || '')
  if (want) {
    const mine = list.find((r) => String(r?.id ?? '') === want && String(r?.sid || ''))
    if (mine) return String(mine.sid)
  }
  const any = list.find((r) => String(r?.sid || ''))
  return any ? String(any.sid) : ''
}

/**
 * 创作/官方内容不回复。三类各有独立开关（默认都开），官方这一类还支持按人放行/强制跳过：
 *   官方黑名单命中 → 一律不回（优先于白名单）
 *   官方白名单非空且命中 → 官方内容照常回
 *   否则官方内容跳过
 * @returns {string} 空串 = 可以回；非空 = 跳过的原因
 */
export function skipRule(cfg, cand) {
  const S = cfg?.listen?.skip || {}
  const keys = [cand?.uid, cand?.nickname].map((x) => String(x ?? '').trim().toLowerCase()).filter(Boolean)
  const hit = (list) => (list || [])
    .map((x) => String(x ?? '').trim().toLowerCase())
    .filter(Boolean)
    .some((v) => keys.includes(v))

  if (cand?.isOfficial) {
    if (hit(S.officialDeny)) return 'official-deny'
    const allow = (S.officialAllow || []).filter((x) => String(x ?? '').trim())
    if (allow.length && hit(S.officialAllow)) return ''       // 白名单里点名的官方号照常回
    if (S.official !== false) return 'official'
  }
  if (cand?.isEssence && S.essence !== false) return 'essence'
  if (cand?.isContribution && S.contribution !== false) return 'contribution'
  return ''
}

/** 浏览记录用的那一份字段（帖 id / 标题 / 板块 / 作者 / 三个时间）。 */
const histOf = (c) => ({
  topicId: c.topicId,
  title: c.topicTitle || c.topic?.title || '',
  sectionId: c.sectionId,
  sectionTitle: c.sectionTitle,
  uid: c.uid,
  nickname: c.nickname,
  published: c.publishMs,
  edited: c.editMs,
  replied: c.replyMs,
})

/** keyOf 产出的三类前缀；别的（b:/r:）是刷帖层自己的标记。 */
const LISTEN_KEY_PREFIX = new Set(['t', 'f', 'c'])

/** 触发文本是「让我总结这帖」的意思 */
const WANT_SUMMARY = /总结|汇总|概括|梳理|讲(了)?(啥|什么)|说(了)?(啥|什么)|什么内容|大概内容|什么情况/

/** 把多行总结压成能直接发出去的一段（保留换行，但不超过论坛能接受的体量） */
function toPostText(md) {
  return String(md || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .join('\n')
    .slice(0, 900)
}

/** 去重键：带 topicId，换监听范围时能只清掉这一帖的记录。 */
export const keyOf = (c) =>
  // 通知类（回复我的）按通知 id 去重：一条通知只回一次，而且不能落进 t:/f:/c: 前缀里 ——
  // forgetTopics 会按那几个前缀把一整帖的记录删掉，通知记录不该跟着帖子一起消失。
  c.source === 'replied' ? 'n:' + c.noticeType + ':' + c.noticeId
  : c.kind === 'topic' ? 't:' + c.topicId
  : c.kind === 'floor' ? 'f:' + c.topicId + ':' + c.floorId
  : 'c:' + c.topicId + ':' + c.commentId

/** 「@ 我」通知里的 time 是人话（"55分钟前"），不是时间戳：只用来挡掉太旧的，解析不了就放行。 */
const ATME_MAX_AGE_MIN = 7 * 24 * 60
function noticeAgeMin(s) {
  const m = /^(\d+)\s*(秒|分钟|小时|天)前$/.exec(String(s || '').trim())
  if (!m) return null
  const n = Number(m[1])
  return m[2] === '秒' ? n / 60 : m[2] === '分钟' ? n : m[2] === '小时' ? n * 60 : n * 1440
}

/**
 * 「回复我的」通知的 time 有两种写法：「11小时前」和「11-07」（月-日）。
 * 后者要拿当前日期才算出年龄 —— 只认相对时间的话，两周前的旧回复会被当成新的回一遍。
 * @returns {number|null} 分钟数；解析不了返回 null（调用方按「放行」处理，宁可多回一条也不静默丢）
 */
export function replyAgeMin(s, now = Date.now()) {
  const rel = noticeAgeMin(s)
  if (rel != null) return rel
  const m = /^(?:(\d{4})-)?(\d{1,2})-(\d{1,2})$/.exec(String(s || '').trim())
  if (!m) return null
  const year = m[1] ? Number(m[1]) : new Date(now).getFullYear()
  const at = (y) => new Date(y, Number(m[2]) - 1, Number(m[3])).getTime()
  let t = at(year)
  // 没写年份时，「比今天还晚」只能是去年的（1 月看到「12-30」）
  if (!m[1] && t - now > 86400000) t = at(year - 1)
  return Math.max(0, Math.round((now - t) / 60000))
}

/**
 * 「回复我的」三类通知的开关：
 *   101 回复你的帖子（默认关：自己帖子下的新回复最容易在自己楼里刷屏）/ 102 回复你的回帖 / 103 回复你的回复。
 * 别的 type 一律不接 —— 平台以后加频道也不该自动开口。
 */
export function replyTypeOn(R, type) {
  const t = String(type || '')
  if (t === '101') return R?.onPost === true
  if (t === '102') return R?.onFloor !== false
  if (t === '103') return R?.onComment !== false
  return false
}

/**
 * 回复落点：一条候选 → 具体用哪个写接口、带什么参数。纯函数。
 *
 * 原来的三种 kind 口径不变：topic 发主楼、floor 回楼层（commentOperate 回在这层楼下）、
 * comment 回楼中楼。「回复我的」再按通知类型分：
 *   101 回复你的帖子 → 主楼回复（replyId=0）
 *   102 回复你的回帖 → 回到对方那层楼底下（replyId=rid：实测 rid 是楼层 id，to_rid 是评论 id）
 *   103 回复你的回复 → 回进那条评论所在的楼中楼（replyId=楼层、commentId=定位到的评论 id）
 * 103 的板块号与评论楼道号通知里都没有，要 collect 为它多读一次帖补上；补不到就退回
 * 主楼回复 + 正文里纯文本 @ 对方 —— 宁可 @ 一句也别装作回上了。
 * @returns {{mode:'reply'|'comment', tid:string, fid:string, replyId:string, commentId:string, mention:boolean}}
 */
export function replyTargetOf(c) {
  const tid = String(c?.topicId || '')
  const fid = String(c?.sectionId || '')
  if (c?.source === 'replied') {
    const type = String(c?.noticeType || '')
    if (type === '103') {
      // 有板块号 + 定位到了那条评论 → 回进它所在的楼中楼；否则主楼回复 + 正文 @ 对方
      if (fid && c?.commentId) {
        return { mode: 'comment', tid, fid, replyId: String(c.commentFloorId || c.floorId || '0'), commentId: String(c.commentId), mention: false }
      }
      return { mode: 'reply', tid, fid: '', replyId: String(c.floorId || '0'), commentId: '0', mention: true }
    }
    if (type === '102') return { mode: 'reply', tid, fid, replyId: String(c.floorId || '0'), commentId: '0', mention: false }
    return { mode: 'reply', tid, fid: '', replyId: '0', commentId: '0', mention: false }
  }
  if (c?.kind === 'topic') return { mode: 'reply', tid, fid: '', replyId: '0', commentId: '0', mention: false }
  return {
    mode: 'comment', tid, fid,
    replyId: String(c?.floorId || '0'),
    commentId: c?.kind === 'comment' ? String(c?.commentId || '0') : '0',
    mention: false,
  }
}

/**
 * 103 要回进楼中楼，缺三样通知里没有的东西：板块号（fid）、那条评论所在楼层、评论 id。
 * 所以只给 103 多读一次帖（同 tick 同一帖只读一次），102/101 一次都不读。
 * 定位靠对方 uid + 正文前 20 字：富文本标签和表情都在 strip 里被抹平，两边口径一致。
 * @returns {Promise<{fid:string, floorId:string, commentId:string}|null>} 定位不到返回 null（调用方退回 @ 对方）
 */
export async function locateComment(tid, n, cache, { log = () => {} } = {}) {
  const key = String(tid)
  let detail = cache.get(key)
  if (detail === undefined) {
    let j = null
    try {
      j = await topicDetail(key, { sort: 2 })
    } catch (e) {
      log('[replied] 103 读帖失败 ' + e.message)
    }
    if (j && j.code !== 100) log('[replied] 103 读帖失败 ' + j.code + ' ' + (j.msg || ''))
    detail = j && j.code === 100 ? (j.result || {}) : null
    cache.set(key, detail)          // 读失败也缓存：同一轮别为一个坏帖反复重试
  }
  if (!detail) return null
  const want = strip(n.from_info).slice(0, 20)
  const uid = String(n.from_uid || '')
  if (!want) return null
  const replies = detail.reply || []
  for (const r of replies) {
    for (const x of (r.comment?.info || [])) {
      if (String(x.uid) !== uid) continue
      if (strip(x.content).slice(0, 20) !== want) continue
      const fid = sidOf(detail.topic, replies, r.id)   // 板块号与其它源同一处实现
      return fid ? { fid, floorId: String(r.id), commentId: String(x.id) } : null
    }
  }
  return null
}

/**
 * 「我参与过的帖」：监听记录里出现过的帖子（t:/f:/c: 三种键的第二段）+ 发帖台账里点到过的帖。
 * 台账里没有「我自己那篇帖的 id」（平台发帖接口不回 id），只有 picks，所以两者都收 ——
 * 那份清单里的帖本来也都是我读过、写过日报的。文件读不到就当没有，不许抛。
 */
export function mineTopics(seen) {
  const ids = new Set()
  for (const k of Object.keys(seen?.replies || {})) {
    const parts = String(k).split(':')
    if (!LISTEN_KEY_PREFIX.has(parts[0]) || parts.length < 2) continue
    if (parts[1]) ids.add(String(parts[1]))
  }
  for (const p of loadPostLog()) {
    if (!p || typeof p !== 'object') continue
    if (p.topicId) ids.add(String(p.topicId))
    for (const id of p.picks || []) if (id) ids.add(String(id))
  }
  return [...ids]
}

/**
 * 把六类源的当前内容扫成候选列表。只读，不发任何东西。
 * @param {object} [opts.seen] 传进来就顺手推进假@扫描的游标（由调用方决定要不要落盘）
 * @returns {Promise<Array>} 候选事件
 */
export async function collect(cfg, { log = () => {}, seen = null } = {}) {
  const out = []
  const L = cfg.listen || {}
  const me = { uid: cfg.self?.uid || '', nickname: cfg.self?.name || '' }

  /* ① 论坛源：扫板块第一页的帖子 */
  if (L.forum?.enabled) {
    for (const item of L.forum.items || []) {
      if (!item?.id) continue
      const j = await sectionTopics(item.id, {})
      if (j.code !== 100) { log('[forum] ' + item.id + ' 读失败 ' + j.code + ' ' + (j.msg || '')); continue }
      const list = j.result?.data || []
      for (const t of list) {
        out.push({
          source: 'forum', kind: 'topic',
          sectionId: String(item.id), sectionTitle: item.title || '',
          topicId: String(t.id), topicTitle: t.title || '',
          uid: String(t.uid), nickname: t.user?.nickname || t.uid,
          content: strip(t.title) + ' ' + strip(t.content),
          timeStr: t.time_str || kbTimeText(t.time), replyCount: t.reply_count,
          ...flagsOf(t),
          raw: t,
        })
      }
      log('[forum] ' + (item.title || item.id) + ' 扫到 ' + list.length + ' 帖')
    }
  }

  /* ③ @ 我 源：消息中心的通知列表。整条链路里唯一「什么都不用填」的源。 */
  // mode=3 就是消息中心第三个 tab「@我的」。它给的是明细（谁、哪个帖、哪层楼），
  // 拿不到正文本身，所以还要按 tid 去读一次帖，把 rid 那层楼捞出来。
  if (L.atme?.enabled !== false) {
    const capAtme = Math.max(1, Number(L.maxTopicsPerTick) || 6)
    let j = null
    try {
      j = await atList({ mode: 3 })
    } catch (e) {
      log('[atme] 通知读失败 ' + e.message)
    }
    if (j && j.code !== 100) log('[atme] 通知读失败 ' + j.code + ' ' + (j.msg || ''))
    const all = (j && j.code === 100 ? j.result?.data || [] : [])
    const pick = all.filter((n) => {
      if (String(n.del_status) === '1') return false          // 内容已删，没正文也没楼层
      if (String(n.type) !== '202') return false              // 200 = 发帖里@我，没有楼层可回
      if (!n.tid || !n.rid || String(n.rid) === '0') return false
      const age = noticeAgeMin(n.time)
      return age == null || age <= ATME_MAX_AGE_MIN
    })
    if (all.length) log('[atme] 通知 ' + all.length + ' 条，可用 ' + pick.length + ' 条')

    // 同一帖里的多条 @ 只读一次帖
    const byTopic = new Map()
    for (const n of pick) {
      const tid = String(n.tid)
      if (!byTopic.has(tid)) byTopic.set(tid, [])
      byTopic.get(tid).push(n)
    }
    const atmeTids = [...byTopic.keys()].slice(0, capAtme)
    if (byTopic.size > atmeTids.length) {
      log('[atme] 本轮只读前 ' + atmeTids.length + ' 帖（上限 maxTopicsPerTick=' + capAtme + '，通知里共 ' + byTopic.size + ' 帖）')
    }
    for (const tid of atmeTids) {
      const jj = await topicDetail(tid, { sort: 2 })
      if (jj.code !== 100) { log('[atme] ' + tid + ' 读失败 ' + jj.code + ' ' + (jj.msg || '')); continue }
      const topic = jj.result?.topic || {}
      const replies = jj.result?.reply || []
      for (const n of byTopic.get(tid)) {
        const rid = String(n.rid)
        const floor = replies.find((r) => String(r.id) === rid)
        out.push({
          source: 'atme', kind: 'floor',
          sectionId: sidOf(topic, replies, rid), sectionTitle: topic.section?.title || n.from_info || '',
          topicId: tid, topicTitle: topic.title || '',
          floorId: rid, position: floor?.position || '',
          uid: String(n.from_uid || floor?.uid || ''),
          nickname: n.from_nickname || floor?.user?.nickname || String(n.from_uid || ''),
          // 楼层不在第一页时用通知里的富文本兜底，commentOperate 只认 replyId，照样能回
          content: floor?.content || n.to_info || '',
          timeStr: floor?.time_str || n.time || '',
          ...flagsOf(topic),
          noticeId: String(n.id || ''),
          topic, replies,
        })
      }
      log('[atme] ' + (topic.title || tid) + ' 命中 ' + byTopic.get(tid).length + ' 条通知')
    }
  }

  /* ⑤ 回复我的源：消息中心 mode=1（1 回复我的 / 2 系统 / 3 @我 / 4 赞 / 5 关注）。
     和 ③ 同一个接口，但这一路的消息自带 tid、rid、to_rid 和对方那句话（from_info），
     101/102 完全不用再读帖；只有 103 要回进楼中楼，缺板块号与评论楼道号，才补一次读
     （同 tick 同一帖只读一次）。 */
  const R = L.replies || {}
  if (R.enabled) {
    let j = null
    try {
      j = await atList({ mode: 1 })
    } catch (e) {
      log('[replied] 通知读失败 ' + e.message)
    }
    if (j && j.code !== 100) log('[replied] 通知读失败 ' + j.code + ' ' + (j.msg || ''))
    const all = (j && j.code === 100 ? j.result?.data || [] : [])
    const maxAge = Number(R.maxAgeMin)
    const pick = all.filter((n) => {
      if (String(n.del_status) === '1') return false          // 内容已删，没有正文可接
      if (!n.id || !n.tid) return false                       // 没有通知 id 就没法去重，没有 tid 就没地方回
      if (!replyTypeOn(R, n.type)) return false                // 101/102/103 三个开关各管一类
      const age = replyAgeMin(n.time)
      return age == null || !Number.isFinite(maxAge) || maxAge <= 0 || age <= maxAge
    })
    if (all.length) {
      log('[replied] 通知 ' + all.length + ' 条，可用 ' + pick.length + ' 条（101=' + (R.onPost ? '开' : '关')
        + ' 102=' + (R.onFloor === false ? '关' : '开') + ' 103=' + (R.onComment === false ? '关' : '开')
        + '，maxAgeMin=' + maxAge + '）')
    }
    const replyCache = new Map()      // 本 tick 内 103 的帖只读一次
    for (const n of pick) {
      // 标题只能读帖才拿到，这里不读：用通知频道名顶上，AI 至少知道这是「回复你的回帖」而不是新帖。
      const c = {
        source: 'replied', kind: 'floor',
        sectionId: '', sectionTitle: '',
        topicId: String(n.tid), topicTitle: n.msg_type || '',
        floorId: String(n.rid || ''), myReplyId: String(n.to_rid || ''),
        uid: String(n.from_uid || ''), nickname: n.from_nickname || String(n.from_uid || ''),
        content: strip(n.from_info), timeStr: n.time || '',
        noticeId: String(n.id), noticeType: String(n.type),
      }
      if (c.noticeType === '103') {
        // 只有这一类值得多读一次：回进楼中楼要板块号 + 楼层 + 评论 id，通知里一样都没有。
        const hit = await locateComment(c.topicId, n, replyCache, { log })
        if (hit) {
          c.sectionId = hit.fid
          c.commentFloorId = hit.floorId
          c.commentId = hit.commentId
          log('[replied] 103 → 楼中楼 ' + c.topicId + ' fid=' + hit.fid + ' 楼层=' + hit.floorId + ' commentId=' + hit.commentId)
        } else {
          log('[replied] 103 → 主楼 @' + c.nickname + '（读不到帖 / 没有板块号 / 第一页里定位不到那条评论）')
        }
      }
      out.push(c)
      log('[replied] ' + c.noticeType + ' ' + c.topicId + ' rid=' + c.floorId + ' to_rid=' + c.myReplyId
        + ' ' + c.nickname + '：' + c.content.slice(0, 40))
    }
  }

  /* ② 帖子源：扫指定帖的楼层与楼中楼 */
  // maxTopicsPerTick 是每轮最多读几个帖：帖子源的条数直接受它约束，
  // 不然一次 tick 把所有帖都拉一遍，读额度会在几秒内见底。
  const capTopics = Math.max(1, Number(L.maxTopicsPerTick) || 6)
  const allTopics = (L.topic?.enabled ? (L.topic.items || []) : [])
    .concat((L.at?.enabled ? (L.at.items || []) : []))
  const topicItems = allTopics.slice(0, capTopics)
  if (allTopics.length > topicItems.length) {
    log('[topic] 本轮只读前 ' + topicItems.length + ' 帖（上限 maxTopicsPerTick=' + capTopics + '，共 ' + allTopics.length + ' 帖在列）')
  }
  const seenTopic = new Set()
  for (const item of topicItems) {
    if (!item?.id || seenTopic.has(String(item.id))) continue
    seenTopic.add(String(item.id))
    const src = (L.topic?.items || []).some((x) => String(x.id) === String(item.id)) ? 'topic' : 'at'
    const j = await topicDetail(item.id, { sort: 2 })
    if (j.code !== 100) { log('[topic] ' + item.id + ' 读失败 ' + j.code + ' ' + (j.msg || '')); continue }
    const topic = j.result?.topic || {}
    const replies = j.result?.reply || []
    const wantFloors = src === 'topic' ? L.topic?.floors !== false : true
    const wantComments = src === 'topic' ? L.topic?.comments !== false : true

    if (wantFloors) {
      for (const r of replies) {
        out.push({
          source: src, kind: 'floor',
          sectionId: sidOf(topic, replies, r.id), sectionTitle: topic.section?.title || '',
          topicId: String(item.id), topicTitle: topic.title || '',
          floorId: String(r.id), position: r.position,
          uid: String(r.uid), nickname: r.user?.nickname || r.uid,
          content: r.content || '', timeStr: r.time_str || '',
          ...flagsOf(topic),
          topic, replies,
        })
      }
    }
    if (wantComments) {
      for (const r of replies) {
        for (const c of (r.comment?.info || [])) {
          out.push({
            source: src, kind: 'comment',
            sectionId: sidOf(topic, replies, r.id), sectionTitle: topic.section?.title || '',
            topicId: String(item.id), topicTitle: topic.title || '',
            floorId: String(r.id), commentId: String(c.id), position: r.position,
            uid: String(c.uid), nickname: c.user?.nickname || c.uid,
            content: c.content || '', timeStr: c.time_str || '',
            ...flagsOf(topic),
            topic, replies,
          })
        }
      }
    }
    log('[topic] ' + (topic.title || item.id) + ' 楼层 ' + replies.length + '，楼中楼 ' + replies.reduce((n, r) => n + (r.comment?.info?.length || 0), 0))
  }

  /* ⑥ 假 @ 兜底：正文里的纯文本「@昵称」平台不发通知，只能自己读帖找。
     范围是我参与过的帖，每轮按游标轮转读 maxTopicsPerTick 帖 —— 一次把几百个历史帖
     全读一遍会把读额度（600/时）在几分钟内烧光，轮转才能长期扫。 */
  const SC = L.scanMine || {}
  if (SC.enabled) {
    const list = mineTopics(seen)
    const cap = Math.max(1, Number(SC.maxTopicsPerTick) || 2)
    if (!list.length) {
      log('[mine] 还没有参与过的帖可扫（等监听记录 / 发帖台账攒起来）')
    } else {
      const start = Math.max(0, Number(seen && seen.__scanCursor) || 0) % list.length
      const picked = []
      for (let i = 0; i < Math.min(cap, list.length); i++) picked.push(list[(start + i) % list.length])
      // 游标只记位置，不写进 seen.replies —— 那是去重记录，混进去会被 forgetTopics 之类的逻辑误伤。
      if (seen) seen.__scanCursor = (start + picked.length) % list.length
      log('[mine] 参与过的帖 ' + list.length + ' 个，本轮读 ' + picked.length + ' 个（游标 ' + start + '→' + (start + picked.length) % list.length + '，上限 maxTopicsPerTick=' + cap + '）')
      for (const tid of picked) {
        const j = await topicDetail(tid, { sort: 2 })
        if (j.code !== 100) { log('[mine] ' + tid + ' 读失败 ' + j.code + ' ' + (j.msg || '')); continue }
        const topic = j.result?.topic || {}
        const replies = j.result?.reply || []
        let hits = 0
        let floors = 0
        for (const r of replies) {
          floors++
          const rows = [{
            kind: 'floor', commentId: '', floorId: String(r.id), position: r.position,
            uid: String(r.uid), nickname: r.user?.nickname || r.uid, content: r.content || '',
          }]
          for (const x of (r.comment?.info || [])) {
            floors++
            rows.push({
              kind: 'comment', commentId: String(x.id), floorId: String(r.id), position: r.position,
              uid: String(x.uid), nickname: x.user?.nickname || x.uid, content: x.content || '',
            })
          }
          for (const row of rows) {
            const trig = matchTrigger(row.content, me, L.triggerMode)
            if (!trig.hit) continue
            hits++
            out.push({
              source: 'mine', kind: row.kind,
              sectionId: sidOf(topic, replies, row.floorId), sectionTitle: topic.section?.title || '',
              topicId: tid, topicTitle: topic.title || '',
              floorId: row.floorId, commentId: row.commentId, position: row.position,
              uid: row.uid, nickname: row.nickname,
              content: row.content, timeStr: '',
              ...flagsOf(topic),
              topic, replies,
            })
            log('[mine] ' + tid + ' ' + row.kind + ' ' + row.floorId + (row.commentId ? '/' + row.commentId : '')
              + ' 命中 ' + trig.via + ' ' + row.nickname + '：' + strip(row.content).slice(0, 40))
          }
        }
        log('[mine] ' + (topic.title || tid) + ' 楼层 ' + replies.length + '，楼层+楼中楼 ' + floors + ' 条，命中 ' + hits + ' 条')
      }
    }
  }

  return out
}

/**
 * 判定一条候选要不要回。
 * @returns {{action:'reply'|'skip', why:string, via?:string}}
 */
export function evaluate(cfg, cand, me) {
  const L = cfg.listen || {}
  const ownerUid = String(cfg.owner?.uid || '')

  if (!cand.uid || String(cand.uid) === String(me.uid)) return { action: 'skip', why: 'self' }
  if (cand.source === 'atme' && L.atme?.enabled === false) return { action: 'skip', why: 'atme-off' }
  // 新增的两类源各一道总闸。collect 已经先筛过一遍，这里兜的是「扫到判定之间配置被改掉」。
  if (cand.source === 'replied') {
    const R = L.replies || {}
    if (R.enabled === false) return { action: 'skip', why: 'replies-off' }
    if (!replyTypeOn(R, cand.noticeType)) return { action: 'skip', why: 'replies-off-' + cand.noticeType }
  }
  if (cand.source === 'mine' && L.scanMine?.enabled === false) return { action: 'skip', why: 'scanMine-off' }

  // 创作/官方内容不接话：三类独立开关，官方还能按人放行/强制跳过。
  // 放在触发判定之前 —— 这类内容连 AI 都不该被叫起来，也省一次模型调用。
  const skipWhy = skipRule(cfg, cand)
  if (skipWhy) return { action: 'skip', why: skipWhy }

  // 违禁内容闸（入站）：别人写的正文里命中三类黑名单就当场判死。
  // 位置很关键 —— 在触发判定和模型调用**之前**，命中就一次 token 都不花。
  const guard = screenInbound(cand.content, cfg)
  if (!guard.ok) return { action: 'refuse', why: guard.why, cat: guard.cat }

  // 触发条件只有一个：内容里 @ 我。作者是大号不等于叫我，不能凭这个就回。
  // atme / replied 例外：平台的通知本身就是「有人叫了你」，再拿正文匹配一遍反而会被
  // triggerMode='plain'（只认文字 @）挡掉 —— 富文本里的 @ 是 <kb-contact> 标签，不是字面 @。
  const isNotice = cand.source === 'atme' || cand.source === 'replied'
  const trig = isNotice
    ? { hit: true, via: cand.source === 'replied' ? 'reply' : 'notice' }
    : matchTrigger(cand.content, me, cfg.listen?.triggerMode)
  if (!trig.hit) return { action: 'skip', why: 'no-trigger' }
  const byOwner = ownerUid && String(cand.uid) === ownerUid

  // 内容本身的筛选（板块 / 帖子）先过一遍，避免对不想看的地方做任何动作。
  // source 名与配置键不同名的两类要对一下：replied → listen.replies、mine → listen.scanMine。
  const group = cand.source === 'replied' ? (L.replies || {})
    : cand.source === 'mine' ? (L.scanMine || {})
    : (L[cand.source] || {})

  // 主人 @ 我 一律放行：不用加好友、不用进白名单
  if (byOwner) return { action: 'reply', why: 'owner', via: trig.via || null }

  // 其他人 @ 我 还要再过一道 at 的名单与范围限制
  if (L.at?.enabled) {
    const fa = makeFilter(L.at)
    const u = fa.user(cand.uid, cand.nickname)
    if (!u.ok) return { action: 'skip', why: 'at-' + u.why }
    const f = fa.forum(cand.sectionId, cand.sectionTitle)
    if (!f.ok) return { action: 'skip', why: 'at-' + f.why }
    const t = fa.topic(cand.topicId)
    if (!t.ok) return { action: 'skip', why: 'at-' + t.why }
    // at.items / at.forums 非空 = 只在这些范围里应 @
    // at.items 对通知源与假@扫描都不生效：那份清单是「额外要盯的帖子」，
    // 通知本身已经是全站的叫，假@扫的是我自己参与过的帖 —— 拿清单卡它们等于把功能关掉。
    const listed = !isNotice && cand.source !== 'mine'
    if (listed && (L.at.items || []).length && !L.at.items.some((x) => String(x.id) === String(cand.topicId))) {
      return { action: 'skip', why: 'at-topic-not-allowed' }
    }
    if ((L.at.forums || []).length && !L.at.forums.some((x) => String(x.id) === String(cand.sectionId))) {
      return { action: 'skip', why: 'at-forum-not-allowed' }
    }
  }

  // 源自己的名单
  const fs = makeFilter(group)
  const su = fs.user(cand.uid, cand.nickname)
  if (!su.ok) return { action: 'skip', why: cand.source + '-' + su.why }
  const sf = fs.forum(cand.sectionId, cand.sectionTitle)
  if (!sf.ok) return { action: 'skip', why: cand.source + '-' + sf.why }
  const st = fs.topic(cand.topicId)
  if (!st.ok) return { action: 'skip', why: cand.source + '-' + st.why }

  return { action: 'reply', why: 'at', via: trig.via || null }
}

/**
 * 回完帖顺手点赞：聊的是楼层就赞那条楼层（like.replies），聊的是主帖就赞这帖（like.browsed）。
 * 只处理"我刚回复的那一条"，不做整帖扫荡——扫荡的活归刷帖流程（digest 的 runLikes）。
 */
async function likeAfterReply(cfg, c, seen, { log = () => {} } = {}) {
  const LK = cfg.like || {}
  const jobs = []
  if (c.kind === 'comment' && c.floorId && LK.replies) {
    jobs.push({
      key: 'l:r:' + c.floorId, what: '楼层 ' + c.floorId,
      run: () => likeReply({ fid: c.sectionId, tid: c.topicId, replyId: c.floorId }),
    })
  }
  if (c.kind === 'topic' && LK.browsed) {
    jobs.push({ key: 'l:t:' + c.topicId, what: '帖 ' + c.topicId, run: () => likeTopic({ tid: c.topicId }) })
  }
  for (const j of jobs) {
    if (seenReply(seen, j.key)) continue
    try {
      const out = await j.run()
      if (out.code === 100) {
        markReply(seen, j.key, { liked: true })
        audit({ action: 'like-' + (j.key.startsWith('l:t:') ? 'topic' : 'reply'), topicId: c.topicId, replyId: c.floorId || null, via: '回帖后顺手赞', ok: true })
        log('[like] ✓ 赞了' + j.what)
      } else {
        log('[like] 没赞成 ' + j.what + '：code=' + out.code + ' ' + (out.msg || ''))
      }
    } catch (e) { log('[like] 被拦（多半是写额度/冷却/风控）：' + e.message); break }
  }
}

/** 把表情用法接到 system 提示后面；on 为假时原样返回（模型就不会写 [表情:名]）。 */
function withEmojiRule(msgs, on) {
  if (!on) return msgs
  return msgs.map((m, i) => (i === 0 && m.role === 'system' ? { ...m, content: m.content + '\n\n' + EMOJI_PROMPT_RULE } : m))
}

/**
 * 违禁内容命中后回的那一句。
 * 关键：这句话是配置里的死文本，**不经过模型** —— 所以整条链路零 token。
 * refuseText 留空 = 静默跳过（只记日志，不发任何东西）。
 * @returns {Promise<boolean>} 是否真的发出去了
 */
async function refuseSend(cfg, c, ev, { log = () => {}, dryRun = false } = {}) {
  const S = cfg?.safety || {}
  const text = String(S.refuseText || '').trim()
  const label = describeVerdict({ ok: false, cat: ev.cat, why: ev.why })
  if (!text) {
    log('  [safety] 命中' + label + '：话术留空，静默跳过（未调用模型）')
    return false
  }
  if (dryRun) {
    log('  [safety][dry-run] 命中' + label + ' → 会直发固定话术（不调模型）：「' + text + '」')
    return false
  }
  const target = replyTargetOf(c)
  const body = target.mention ? '@' + (c.nickname || c.uid) + ' ' + text : text
  let out
  try {
    out = target.mode === 'comment'
      ? await commentOperate({ fid: target.fid, replyId: target.replyId, commentId: target.commentId, content: body })
      : await replyOperate({ tid: target.tid, content: body, replyId: target.replyId, type: 3, state: 1 })
  } catch (e) {
    log('  [safety] 固定话术发送被拦：' + e.message)
    return false
  }
  const ok = out.code === 100
  if (ok) {
    log('  ⛔ 命中' + label + '：已回固定话术（未调用模型）')
    audit({ action: 'refuse', topicId: c.topicId, floorId: c.floorId || null, triggerUid: c.uid, via: ev.why, text: body, ok: true })
  } else {
    log('  ✗ 固定话术没发出去 ' + out.code + ' ' + (out.msg || ''))
    audit({ action: 'refuse', topicId: c.topicId, floorId: c.floorId || null, ok: false, code: out.code, msg: out.msg })
  }
  return ok
}

/**
 * 出站闸 + 复读查重，两件事都发生在「模型已经写完、还没发出去」这一格。
 * @returns {{allow:boolean, why?:string}}
 */
function gateOutbound(cfg, text, { log = () => {} } = {}) {
  const S = cfg.safety || {}
  if (S.enabled === false) return { allow: true }
  if (S.blockOutbound !== false) {
    const v = screenOutbound(text, cfg)
    if (!v.ok) {
      log('  [safety] 模型写出' + describeVerdict(v) + '，拦下不发')
      return { allow: false, why: 'outbound-' + (v.cat || '') }
    }
  }
  const rep = findRepeat({ text, cfg })
  if (rep) {
    log('  [dedupe] 这段话' + Math.round((Date.now() - (rep.at || 0)) / 60000) + ' 分钟前说过，不重复发')
    return { allow: false, why: 'repeat' }
  }
  return { allow: true }
}

/** 在哪些时间窗内允许干活。allDay=true 时永远允许。 */
export function inWindow(cfg, now = new Date()) {
  const L = cfg.listen || {}
  if (L.allDay !== false) return true
  const mins = now.getHours() * 60 + now.getMinutes()
  const toMin = (s) => {
    const [h, m] = String(s || '0:0').split(':').map(Number)
    return (h || 0) * 60 + (m || 0)
  }
  for (const w of L.windows || []) {
    const a = toMin(w.start)
    const b = toMin(w.end) === 0 ? 1440 : toMin(w.end)
    if (a <= b ? (mins >= a && mins < b) : (mins >= a || mins < b)) return true
  }
  return false
}

/**
 * 跑一轮。dryRun=true 时只打印打算做什么，不发任何写请求。
 * @returns {Promise<{scanned:number, replied:number, skipped:number, bootstrapped:boolean}>}
 */
export async function tick(cfg, { dryRun = false, log = console.log } = {}) {
  const seen = loadSeen()
  const me = { uid: cfg.self?.uid || '', nickname: cfg.self?.name || '' }
  const stats = { scanned: 0, replied: 0, skipped: 0, refused: 0, bootstrapped: false, blocked: null }

  if (!inWindow(cfg)) { log('[watch] 不在时间窗内，跳过本轮'); return stats }

  // 没有 Pauth 就没有写权限：读帖能跑，发出去一律 5001。
  // 与其每轮都发一遍再失败，不如在入口就停下来说清楚（dryRun 仍然放行，方便预览）。
  if (!dryRun) {
    const miss = missingForWrite(loadCred())
    if (miss.length) {
      log('[watch] 写权限缺失：' + miss.join('、') + ' —— 本轮只登记不发送。去设置页扫码登录一次再开监听')
      stats.blocked = 'no-pauth'
      return stats
    }
  }

  const cands = await collect(cfg, { log, seen })
  stats.scanned = cands.length

  // 首次扫描：只登记，不回复（dry-run 不登记，预览不能改变真实状态）
  const primed = seen.__primed === true
  if (!primed && !dryRun) {
    for (const c of cands) markReply(seen, keyOf(c), { boot: true })
    seen.__primed = true
    seen.__primedAt = Date.now()
    // 全量登记已经覆盖了通知源，免得它下一次又单独登记一轮
    seen.__repliedPrimed = true
    saveSeen(seen)
    stats.bootstrapped = true
    log('[watch] 首次扫描，登记 ' + cands.length + ' 条历史内容，不回复')
    return stats
  }

  // 「回复我的」自己一套 bootstrap：老装升级上来的那一刻，通知列表里全是历史回复，
  // 一上来就回等于冲着一片 12 小时前的旧消息刷屏 —— 第一轮只登记，下一轮才真回。
  // dry-run 不落盘，但行为按真实第一轮演示（否则预览会看见一堆真发不出去的回复）。
  const freshReplied = seen.__repliedPrimed !== true
  if (freshReplied) {
    const hist = cands.filter((c) => c.source === 'replied')
    if (!dryRun) {
      for (const c of hist) markReply(seen, keyOf(c), { boot: true })
      seen.__repliedPrimed = true
      seen.__repliedPrimedAt = Date.now()
      saveSeen(seen)
    }
    log('[replied] 首次启用：登记 ' + hist.length + ' 条历史通知，本轮只登记不回（下一轮开始真回）' + (dryRun ? '（dry-run 不落盘）' : ''))
  }

  const cap = Math.max(1, Number(cfg.listen?.maxRepliesPerTick) || 3)
  const repliedTopics = new Set()

  for (const c of cands) {
    if (stats.replied >= cap) { log('[watch] 本轮已达上限 ' + cap + ' 条，剩下的下轮再说'); break }
    // 同一帖一轮只回一条：两个楼层都 @ 我时，发两遍几乎一样的回复等于刷屏
    if (repliedTopics.has(String(c.topicId))) {
      if (!dryRun) markReply(seen, keyOf(c), { skip: 'same-topic-this-tick' })
      stats.skipped++
      continue
    }
    // 首次启用那一轮：replied 的候选刚登记完，本轮一条都不接
    if (freshReplied && c.source === 'replied') { stats.skipped++; continue }
    const k = keyOf(c)
    if (seenReply(seen, k)) continue
    const ev = evaluate(cfg, c, me)
    if (ev.action === 'skip') {
      if (!dryRun) {
        markReply(seen, k, { skip: ev.why })
        recordHistory({ ...histOf(c), action: 'skip', why: ev.why })
      }
      stats.skipped++
      continue
    }
    // 违禁内容：直接回一句固定话术，**不进模型**。
    // 这是「识别到违规内容 → 无法生成回复」的那条路：零 token、零思考、零生成。
    if (ev.action === 'refuse') {
      const sent = await refuseSend(cfg, c, ev, { log, dryRun })
      if (!dryRun) {
        markReply(seen, k, { refuse: ev.why })
        recordHistory({ ...histOf(c), action: 'refuse', why: ev.why })
      }
      if (sent) repliedTopics.add(String(c.topicId))
      stats.refused++
      continue
    }
    const who = c.nickname || c.uid
    const text = strip(c.content)
    const where = c.kind === 'topic'
      ? ('新帖 ' + c.topicId)
      : (c.topicId + ' ' + (c.position ? (String(c.position).endsWith('楼') ? c.position : c.position + '楼') : (c.floorId + '楼')))
    log('[hit/' + ev.why + (ev.via ? '/' + ev.via : '') + '] ' + where + ' ' + who + '：' + text.slice(0, 60))

    // 落点放在调模型之前算：dry-run 里 AI 不可用时也能看出「会回到哪儿」（102 是 rid、103 走楼中楼还是退路）。
    const target = replyTargetOf(c)
    if (dryRun) {
      log('  [dry-run] 落点：' + (target.mode === 'comment'
        ? '楼中楼 fid=' + target.fid + ' replyId=' + target.replyId + ' commentId=' + target.commentId
        : '主楼回复 tid=' + target.tid + ' replyId=' + target.replyId)
        + (target.mention ? '（正文 @对方）' : '')
        + (c.source === 'replied' ? '　通知 ' + c.noticeType : ''))
    }

    if (cfg.listen.oncePerPerson && seenPerson(seen, c.uid)) {
      log('  [skip] ' + who + ' 冷却期内已回过')
      if (!dryRun) {
        markReply(seen, k, { skip: 'person-cooldown' })
        recordHistory({ ...histOf(c), action: 'skip', why: 'person-cooldown' })
      }
      stats.skipped++
      continue
    }

    // 表情是默认能力，没有总开关：楼层带，楼中楼也带（emoji.inComment 已固定为 true，配置改不动）。
    const canEmoji = true
    let reply
    try {
      // 对方是让我「总结 / 说说这帖讲了啥」→ 真总结，不是敷衍一句
      if (WANT_SUMMARY.test(text)) {
        reply = await chat(replySummaryPrompt(
          c.topic || { id: c.topicId, title: c.topicTitle, content: '' },
          c.replies || [],
          cfg.persona,
        ), { maxTokens: 400, temperature: 0.5 })
        reply = applySuffix(toPostText(reply), { suffix: cfg.prompt?.suffix, max: 900, sep: '\n' })
      } else {
        reply = await chat(withEmojiRule(replyPrompt({
          topic: c.topic || { id: c.topicId, title: c.topicTitle, content: '' },
          floors: c.replies || [],
          trigger: { nickname: who, uid: c.uid },
          persona: cfg.persona,
          triggerText: text,
        }), canEmoji), { maxTokens: cfg.ai?.maxTokens ? Math.min(300, cfg.ai.maxTokens) : 300 })
        reply = String(reply || '').replace(/\s+/g, ' ').trim().slice(0, 200)
        reply = applySuffix(reply, { suffix: cfg.prompt?.suffix, max: 200 })
      }
    } catch (e) {
      // DeepSeek 官方 safety_check 命中：服务端已经拦了，这里按「命中」处理 ——
      // 回固定话术（不调模型，零 token），而不是当成普通错误重试/跳过。
      if (e && e.safetyBlocked) {
        log('  [safety] DeepSeek 内容审核拒答：' + e.message)
        const sent = await refuseSend(cfg, c, { cat: 'official', why: 'official-refusal' }, { log, dryRun })
        if (!dryRun) {
          markReply(seen, k, { refuse: 'official-refusal' })
          recordHistory({ ...histOf(c), action: 'refuse', why: 'official-refusal' })
        }
        if (sent) repliedTopics.add(String(c.topicId))
        stats.refused++
        continue
      }
      log('  [ai] ' + e.message)
      continue
    }
    if (!reply) { log('  [ai] 空回复，跳过'); continue }
    // 表情只能在这里拼：上面的 strip / slice / applySuffix 都会把 <kb-emoji …/> 削断或删光。
    // canEmoji 为假时 max:0 表示「解析出来的 token 一并删掉」，避免把 [表情:x] 原样发出去。
    if (typeof reply === 'string') {
      // 对方要表情而模型自己没写（或者只写了句「给你一个表情」）：补一个小表情，别让这条需求落空。
      reply = finishReply(reply, {
        wants: wantsEmoji(text),
        allow: canEmoji,
        suffix: cfg.prompt?.suffix,
      })
    }

    // 出站闸 + 复读查重：模型写完了才查，所以这一步不省 token，但能保证不把脏东西发出去。
    const gate = gateOutbound(cfg, reply, { log })
    if (!gate.allow) {
      // 出站命中（模型自己跑偏）默认不回任何东西；repOnOutbound 打开时回固定话术。
      const replyOnOut = gate.why !== 'repeat' && (cfg.safety?.replyOnOutbound === true)
      if (replyOnOut && !dryRun) await refuseSend(cfg, c, { cat: String(gate.why || '').replace('outbound-', ''), why: gate.why }, { log, dryRun })
      if (!dryRun) {
        markReply(seen, k, { skip: gate.why })
        recordHistory({ ...histOf(c), action: 'skip', why: gate.why })
      }
      stats.skipped++
      continue
    }

    // 平台词表预检：本地闸过了，再问一次快爆自己的敏感词接口（没配 appid / 密钥时这一步自动跳过）。
    // 位置在「真发出去」之前、dry-run 分支之前 —— 预览也该看得出平台会不会拦。
    const mw = await maskwordGate(reply, { cfg, log })
    if (!mw.allow) {
      if (!dryRun) {
        markReply(seen, k, { skip: mw.why })
        recordHistory({ ...histOf(c), action: 'skip', why: mw.why })
      }
      stats.skipped++
      continue
    }

    // 落点退化（103 定位不到那条评论）时在正文里纯文本 @ 对方：平台不会替我们提人，
    // 点一次名才有机会被看见 —— 比"看起来回上了"其实没人收到强。
    const body = target.mention ? '@' + (c.nickname || c.uid) + ' ' + reply : reply

    if (dryRun) {
      log('  [dry-run] 会回复' + (target.mention ? '（正文 @对方）' : '') + '：' + body)
      repliedTopics.add(String(c.topicId))
      stats.replied++
      continue
    }

    let out
    if (target.mode === 'comment') {
      out = await commentOperate({ fid: target.fid, replyId: target.replyId, commentId: target.commentId, content: body })
    } else {
      out = await replyOperate({ tid: target.tid, content: body, replyId: target.replyId, type: 3, state: 1 })
    }

    if (out.code === 100) {
      log('  ✓ 已回复：' + body)
      audit({ action: 'auto-' + (c.source === 'replied' ? 'replied-' + c.noticeType : c.kind), topicId: c.topicId, floorId: c.floorId || null, triggerUid: c.uid, via: ev.why, text: body, ok: true })
      try { rememberSaid({ text: body }) } catch {}
      markReply(seen, k, { replied: true })
      recordHistory({ ...histOf(c), action: 'reply', why: ev.why })
      repliedTopics.add(String(c.topicId))
      markPerson(seen, c.uid, { nickname: who })
      saveSeen(seen)
      stats.replied++
      // 自动点赞：我刚回过谁，就把那条内容赞一下（回楼层赞楼层、回主帖赞主帖）。
      // 写额度与冷却仍由 traffic.mjs 兜；同一对象只赞一次（seen 留痕 + 平台 is_up_voted）。
      if (!dryRun) await likeAfterReply(cfg, c, seen, { log })
    } else {
      log('  ✗ ' + out.code + ' ' + (out.msg || ''))
      audit({ action: 'auto-' + c.kind, topicId: c.topicId, floorId: c.floorId || null, ok: false, code: out.code, msg: out.msg })
      markReply(seen, k, { fail: out.code })
      recordHistory({ ...histOf(c), action: 'skip', why: 'fail-' + out.code })
    }
  }

  if (!dryRun) saveSeen(seen)
  return stats
}

/** 清掉 bootstrap 标记，下次 tick 会重新登记（改了监听范围后用它，避免把旧内容当新内容回）。 */
export function resetPrimed() {
  const seen = loadSeen()
  delete seen.__primed
  delete seen.__primedAt
  saveSeen(seen)
}

/**
 * 忘掉某帖的全部去重记录：改监听范围或想让旧内容重新可回时用。
 * 只动这一帖的键，别的地方的记录不受影响。
 */
export function forgetTopics(topicIds) {
  const seen = loadSeen()
  const ids = new Set((topicIds || []).map(String).filter(Boolean))
  if (!ids.size) return 0
  let n = 0
  for (const k of Object.keys(seen.replies || {})) {
    // 键格式见 keyOf：t:<topicId>（整帖）/ f:<topicId>:<floorId> / c:<topicId>:<commentId>。
    // b:<topicId> 是刷帖日报的标记、r:<topicId> 是日报回帖标记，都不属于监听记录，别误删。
    const parts = String(k).split(':')
    if (!LISTEN_KEY_PREFIX.has(parts[0]) || parts.length < 2) continue
    if (ids.has(String(parts[1]))) { delete seen.replies[k]; n++ }
  }
  saveSeen(seen)
  return n
}

/**
 * 监听范围变了（换了帖子/板块）就忘掉旧帖的去重记录，
 * 否则那些帖永远标着"已回"，改配置等于没改。
 * 返回被清掉的键数。
 */
export function syncScope(cfg, prevCfg) {
  const now = scopeTopics(cfg)
  const before = scopeTopics(prevCfg || {})
  const dropped = before.filter((id) => !now.includes(id))
  if (!dropped.length) return 0
  return forgetTopics(dropped)
}

/** 当前配置扫到的所有帖子 id（用于 forgetTopics 定范围）。 */
export function scopeTopics(cfg) {
  const L = cfg.listen || {}
  const ids = []
  if (L.topic?.enabled) for (const x of L.topic.items || []) ids.push(String(x.id))
  if (L.at?.enabled) for (const x of L.at.items || []) ids.push(String(x.id))
  return Array.from(new Set(ids.filter(Boolean)))
}
