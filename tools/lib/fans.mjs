// 粉丝台账：谁关注了小号、哪些还没回关、今天还能回关几个。
//
// 数据源只有一条：网页消息中心的「关注」频道（api_user.php ac=message&mode=5）。
// 每条通知里 from_uid 是关注你的人，relation 是关注关系（1=互相关注，其余=单向，待实测确认）。
// 关注动作本身在 App 网关（kirelation/add），不在这一层 —— 这里只负责"该回关谁"。
//
// 落盘 ~/.hykb-ai/fans.json：
//   baselineAt  首次扫描时间。基线之前就存在的粉丝只登记不处理（免得第一次跑就把历史全回一遍）
//   seen        { uid: { at, nickname, relation, msgId, action } }
//               action: baseline 基线内 / pending 待回关 / mutual 已互关 / followed 已回关
//                       skipped 主动跳过 / failed 失败
//   daily       { 'YYYY-MM-DD': 当天已回关数 }
import fs from 'node:fs'
import { fansPath, credDir, ensureDir, harden, localDay } from './paths.mjs'
import { config } from './config.mjs'
import { fansList2, followingList2 } from './hykb-api.mjs'
import { add as activity } from './activity.mjs'

const MAX_SEEN = 5000

/** 粉丝列表里的一条 → 台账字段（fans_user_list2 实测字段：uid / nickname / avatar / relation）。 */
export function normalizeNotice(it) {
  const uid = String(it?.uid ?? it?.from_uid ?? '').trim()
  return {
    uid,
    nickname: String(it?.nickname ?? it?.from_nickname ?? '').trim(),
    headPic: String(it?.avatar ?? it?.from_head_pic ?? ''),
    msgId: String(it?.id ?? ''),
    time: String(it?.time ?? ''),
    relation: Number(it?.relation ?? 0),
  }
}

/**
 * relation 语义（实测）：1 = 陌生人（无关系）；4 = 他关注我、我还没回关。
 * 所以「该回关」= relation 4；回关成功后服务端会改成别的值，天然幂等。
 */
export const FAN_NOT_BACK = 4
export const isMutual = (relation) => Number(relation) !== FAN_NOT_BACK

/**
 * 由「本轮拿到的通知」算出新的台账与待回关列表。纯函数，测试直接喂数据。
 * items 必须是**新的在前**（接口本来就是这个顺序）。
 */
export function planScan({ items = [], following = null, state, cfg, now = Date.now() } = {}) {
  const seen = JSON.parse(JSON.stringify(state?.seen || {}))
  // 判断「回关过没有」只有一条可靠依据：他在不在「我的关注」列表里。
  // relation 字段分辨不了（粉丝 4、互关 4、陌生人 1），别拿它当判据。
  const followed = following instanceof Set ? following : null
  const isBack = (uid, relation) => (followed ? followed.has(String(uid)) : isMutual(relation))
  const first = !state?.baselineAt
  const pending = []
  let added = 0

  for (const raw of items) {
    const n = normalizeNotice(raw)
    if (!n.uid) continue
    const rec = seen[n.uid]
    if (!rec) {
      added++
      if (first) {
        seen[n.uid] = { at: now, nickname: n.nickname, relation: n.relation, msgId: n.msgId, action: 'baseline' }
      } else if (cfg?.onlyNonMutual !== false && isBack(n.uid, n.relation)) {
        seen[n.uid] = { at: now, nickname: n.nickname, relation: n.relation, msgId: n.msgId, action: 'mutual' }
      } else {
        seen[n.uid] = { at: now, nickname: n.nickname, relation: n.relation, msgId: n.msgId, action: 'pending' }
        pending.push({ ...n })
      }
      continue
    }
    // 已知的人：之前待回关但现在已在「我的关注」里，就不用再回
    if (rec.action === 'pending' && isBack(n.uid, n.relation)) rec.action = 'mutual'
    rec.relation = n.relation
    if (n.nickname) rec.nickname = n.nickname
  }

  // 台账不能无限长：超了就按时间砍最旧的
  const keys = Object.keys(seen)
  if (keys.length > MAX_SEEN) {
    keys.sort((a, b) => (seen[a].at || 0) - (seen[b].at || 0))
    for (const k of keys.slice(0, keys.length - MAX_SEEN)) delete seen[k]
  }

  const next = {
    baselineAt: state?.baselineAt || new Date(now).toISOString(),
    seen,
    daily: { ...(state?.daily || {}) },
  }
  return { state: next, pending, added, first }
}

/** 今天已经回关了几个。 */
export function todayCount(state, now = Date.now()) {
  return Number(state?.daily?.[localDay(new Date(now))] || 0)
}

/** 还剩多少额度。 */
export function remaining(state, cfg, now = Date.now()) {
  const cap = Math.max(0, Number(cfg?.dailyCap ?? 0) || 0)
  return Math.max(0, cap - todayCount(state, now))
}

export function loadFans() {
  try {
    const v = JSON.parse(fs.readFileSync(fansPath(), 'utf8'))
    const out = v && typeof v === 'object' && !Array.isArray(v) ? v : {}
    if (!out.seen || typeof out.seen !== 'object') out.seen = {}
    if (!out.daily || typeof out.daily !== 'object') out.daily = {}
    return out
  } catch { return { baselineAt: '', seen: {}, daily: {} } }
}

/**
 * 写盘。watch 循环与命令行可能同时在，所以这里先读最新再合并：
 * seen 取 at 更大的那条，daily 取更大的计数（计数只会单调涨，取大不会丢）。
 */
export function saveFans(next) {
  ensureDir(credDir())
  const latest = loadFans()
  const merged = {
    baselineAt: next.baselineAt || latest.baselineAt || '',
    seen: { ...latest.seen },
    daily: { ...latest.daily },
  }
  for (const [uid, rec] of Object.entries(next.seen || {})) {
    const old = merged.seen[uid]
    if (!old || (rec.at || 0) >= (old.at || 0)) merged.seen[uid] = rec
  }
  for (const [day, n] of Object.entries(next.daily || {})) {
    merged.daily[day] = Math.max(Number(merged.daily[day] || 0), Number(n) || 0)
  }
  const f = fansPath()
  const tmp = f + '.' + process.pid + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), { mode: 0o600 })
  harden(tmp)
  fs.renameSync(tmp, f)
  harden(f)
  return merged
}

/** 现有台账里待回关的人（不回网络）。 */
export function pendingList(state, { cfg } = {}) {
  const only = cfg?.onlyNonMutual !== false
  return Object.entries(state?.seen || {})
    .filter(([, r]) => r.action === 'pending' && (!only || !isMutual(r.relation)))
    .map(([uid, r]) => ({ uid, nickname: r.nickname || '', relation: r.relation, at: r.at }))
    .sort((a, b) => (b.at || 0) - (a.at || 0))
}

/**
 * 拉一轮关注通知，更新台账，返回本轮新增的待回关。
 * 只读：不调用任何写接口。
 */
export async function scan({ now = Date.now(), cfg } = {}) {
  const c = cfg || config().followback || {}
  const maxPages = Math.max(1, Math.min(10, Number(c.maxPages) || 3))
  const items = []
  const following = new Set()
  for (let page = 1; page <= maxPages; page++) {
    const j = await followingList2({ page })
    if (j?.code === 100) {
      for (const it of j.result?.data || []) following.add(String(it.uid))
      if (!Number(j?.result?.nextpage || 0)) break
    } else break
  }
  for (let page = 1; page <= maxPages; page++) {
    const j = await fansList2({ page })
    if (j?.code !== 100) {
      activity({ kind: 'notice', ok: false, text: '读粉丝列表失败：' + String(j?.msg || j?.code || '未知').slice(0, 120) })
      return { ok: false, code: j?.code, msg: j?.msg, items: [], pending: [], added: 0, state: loadFans() }
    }
    const list = j?.result?.data || []
    items.push(...list)
    if (!Number(j?.result?.nextpage || 0) || !list.length) break
  }

  const before = loadFans()
  const plan = planScan({ items, following, state: before, cfg: c, now })
  const state = saveFans(plan.state)
  if (plan.added) {
    activity({
      kind: 'notice',
      text: '粉丝名单 ' + items.length + ' 个，新来的 ' + plan.added + ' 个（待回关 ' +
        plan.pending.length + '，剩余额度 ' + remaining(state, c, now) + '）',
      meta: { pages: maxPages, items: items.length, added: plan.added, pending: plan.pending.length },
    })
  }
  return { ok: true, items: items.length, added: plan.added, pending: plan.pending, state, first: plan.first }
}

/** 一批要做的事，受每日额度限制。 */
export function dueList(state, { cfg, now = Date.now() } = {}) {
  const c = cfg || config().followback || {}
  const left = remaining(state, c, now)
  return pendingList(state, { cfg: c }).slice(0, left)
}

/** 记账：把某人标记成某个结果（回关成功/失败/跳过），并给成功的那次加当日计数。 */
export function markResult(state, uid, action, { now = Date.now(), note = '' } = {}) {
  const rec = state?.seen?.[String(uid)]
  if (!rec) return state
  rec.action = action
  rec.doneAt = now
  if (note) rec.note = String(note).slice(0, 200)
  if (action === 'followed') {
    const day = localDay(new Date(now))
    state.daily = state.daily || {}
    state.daily[day] = Number(state.daily[day] || 0) + 1
  }
  return state
}
