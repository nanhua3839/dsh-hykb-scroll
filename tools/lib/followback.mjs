// 自动回关执行链：读粉丝列表 → 挑出还没回关的人 → 调网页关注接口 → 记账。
//
// 分工：
//   fans.mjs   我的粉丝、谁还没回关、今天还能做几个（只读 + 台账）
//   hykb-api   真正发关注请求（网页用户中心 api_user.php，cookie 鉴权，无需签名）
//   这里        把两边串起来，并且管住开关、日限、失败停机、审计
import { config } from './config.mjs'
import { scan, dueList, markResult, remaining, loadFans, saveFans, pendingList } from './fans.mjs'
import { focusUser } from './hykb-api.mjs'
import { add as activity } from './activity.mjs'
import { audit } from './state.mjs'

/** 这些码说明再打下去也没用（登录态失效 / 被风控），必须整批停手。 */
const STOP_CODES = new Set([5001, 5003, 403])

/**
 * 跑一轮回关。
 * @param {{cfg?:object, now?:number, dryRun?:boolean, force?:boolean,
 *          follow?:Function, scan?:Function, load?:Function, save?:Function}} o
 */
export async function runOnce(o = {}) {
  const cfg = o.cfg || config()
  const fb = cfg.followback || {}
  const now = o.now || Date.now()
  const follow = o.follow || ((vuid) => focusUser({ vuid }))
  const load = o.load || loadFans
  const save = o.save || saveFans
  const dryRun = o.dryRun === true

  const doScan = o.scan || scan
  const scanned = await doScan({ cfg: fb, now })
  let state = scanned.state || load()
  const due = dueList(state, { cfg: fb, now })

  const out = { enabled: !!fb.enabled, scanned: scanned.items ?? 0, added: scanned.added ?? 0, due: due.length, sent: 0, ok: 0, failed: 0, skipped: '', results: [], remaining: remaining(state, fb, now) }
  if (!scanned.ok) { out.skipped = '读通知失败'; return out }
  if (!due.length) { out.skipped = '没有该回关的人'; return out }
  if (!fb.enabled && !o.force) { out.skipped = '开关关着'; return out }

  if (dryRun) { out.skipped = 'dry-run'; return out }

  for (const who of due) {
    out.sent++
    let resp
    try {
      resp = await follow(who.uid)
    } catch (e) {
      resp = { code: -1, msg: String(e.message || e) }
    }
    const code = Number(resp?.code)
    const text = 'code=' + code + (resp?.msg ? '（' + resp.msg + '）' : '')
    if (code === 100) {
      out.ok++
      markResult(state, who.uid, 'followed', { now })
      activity({ kind: 'focus', text: '已回关 ' + (who.nickname || who.uid), meta: { uid: who.uid } })
      audit({ action: 'follow', uid: who.uid, ok: true })
    } else {
      out.failed++
      markResult(state, who.uid, 'failed', { now, note: 'code=' + code + ' ' + (resp?.msg || '') })
      activity({ kind: 'focus', ok: false, text: '回关失败 ' + (who.nickname || who.uid) + '：' + text })
      audit({ action: 'follow', uid: who.uid, ok: false, code, msg: resp?.msg || '' })
    }
    out.results.push({ uid: who.uid, nickname: who.nickname || '', code, ok: code === 100 })
    state = save(state)
    if (STOP_CODES.has(code)) { out.skipped = '登录态不可用，整批停下：' + text; break }
  }
  out.remaining = remaining(save(state), fb, now)
  return out
}

/** 给设置页/命令行看的现状。 */
export function status({ cfg, now = Date.now() } = {}) {
  const c = cfg || config()
  const fb = c.followback || {}
  const state = loadFans()
  return {
    enabled: !!fb.enabled,
    dailyCap: Number(fb.dailyCap ?? 0),
    today: Number(state.daily?.[new Date(now).toISOString().slice(0, 10)] ?? 0),
    remaining: remaining(state, fb, now),
    pending: pendingList(state, { cfg: fb }).length,
    baselineAt: state.baselineAt || '',
  }
}