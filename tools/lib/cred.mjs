// 凭据层：只认 uid / Pauth / Uauth / nickname 这组 cookie。
// 缺字段直接说缺哪个，不拿 undefined 去发请求。
import fs from 'node:fs'
import path from 'node:path'
import { credentialsPath, accountDir, currentAccountId, ensureDir, harden } from './paths.mjs'

export const FIELDS = ['uid', 'Pauth', 'Uauth', 'nickname']

export function loadCred() {
  const file = credentialsPath()
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    throw new Error('没有凭据文件：' + file + '\n  先跑一条 hykb.mjs login --save 扫码登录一次')
  }
  let j
  try {
    j = JSON.parse(raw.replace(/^\uFEFF/, ''))
  } catch (e) {
    throw new Error('凭据文件不是合法 JSON：' + file + '\n  ' + String(e.message).slice(0, 120))
  }
  const clean = (v) => String(v ?? '').replace(/^["'\s]+|["'\s]+$/g, '')
  const out = {}
  for (const f of FIELDS) out[f] = clean(j[f])
  out.savedAt = j.savedAt || ''
  return out
}

/**
 * 快爆的登录态里**没有独立的 uid cookie** —— uid 只存在于 Pauth 里。
 * Pauth 的结构（ucenter.js:934 的注释与 Passport.get 的解析一致）：
 *   uid|nickname|avatar|credential|expires|sign[|...]
 * nickname 段是 URL 编码的，且用户名本身可能带 "|"（服务端靠段数差 add_key 反推），
 * 所以昵称要按"总段数 - 6"取前若干段拼回来，不能只取第 2 段。
 * 早先的扫码链路要求 jar 里同时有 uid 与 Pauth，于是永远等不到 uid，
 * 页面就一直停在"已确认，正在写入登录态"。这里把 uid 从 Pauth 里解出来。
 */
export function uidFromPauth(Pauth) {
  const v = String(Pauth || '')
  const first = v.split('|')[0] || ''
  const uid = first.trim()
  return /^\d+$/.test(uid) ? uid : ''
}

export function nicknameFromPauth(Pauth) {
  const parts = String(Pauth || '').split('|')
  if (parts.length < 6) return ''
  const extra = Math.max(0, parts.length - 7)
  const raw = parts.slice(1, 2 + extra).map((x) => String(x || '').trim()).join('|')
  try { return decodeURIComponent(raw) } catch { return raw }
}

/**
 * 昵称可能被平台按 URL 编码塞进 cookie（实测是 nanhua%E7%9A%84大肥鱼）。
 * 显示、落盘、做标签之前都先解一次；解不开（截断的半截序列）就原样返回。
 */
export function prettyNickname(v) {
  const s = String(v ?? '').trim()
  if (!s || s.indexOf('%') < 0) return s
  try { return decodeURIComponent(s).trim() || s } catch { return s }
}

/** 把手里的凭据补全：uid / nickname 缺失时从 Pauth 推。返回值不改原对象。 */
export function deriveCred(obj) {
  const src = obj || {}
  const Pauth = String(src.Pauth || '')
  const uid = String(src.uid || '').trim() || uidFromPauth(Pauth)
  const nickname = prettyNickname(src.nickname) || nicknameFromPauth(Pauth)
  return { ...src, uid, nickname }
}

function writeCred(file, input) {
  const obj = deriveCred(input)
  const clean = (v) => String(v ?? '').replace(/[\r\n;\x00-\x1f\x7f]/g, '').trim()
  const data = { uid: clean(obj.uid), Pauth: clean(obj.Pauth), Uauth: clean(obj.Uauth), nickname: clean(obj.nickname), savedAt: new Date().toISOString() }
  const tmp = file + '.' + process.pid + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
  harden(tmp)
  fs.renameSync(tmp, file)
  // Windows 上 chmod 的 mode 会被忽略，凭据文件实测是 666，必须用 icacls 收权。
  harden(file)
  return data
}

/** 写"当前激活账号"的凭据（改造前的单号布局下就是 ~/.hykb-ai/credentials.json）。 */
export function saveCred(input) {
  const id = currentAccountId()
  ensureDir(accountDir(id))
  return writeCred(credentialsPath(id), input)
}

/**
 * 写指定账号的凭据。扫码新增一个号时用这条：凭据按 uid 落盘，不落"当前账号"，
 * 免得把别人的 ticket 覆盖掉。
 */
export function saveCredFor(accountId, input) {
  const id = String(accountId || '').trim()
  if (!/^\d+$/.test(id)) throw new Error('账号 id 必须是纯数字 uid：' + id)
  ensureDir(accountDir(id))
  return writeCred(credentialsPath(id), input)
}

/** 拼 Cookie 头 */
export function cookieHeader(cred) {
  const c = cred || loadCred()
  return FIELDS.filter((f) => c[f]).map((f) => f + '=' + c[f]).join('; ')
}

/** 写操作前检查：缺什么，返回数组 */
export function missingForWrite(cred) {
  const miss = []
  if (!cred.uid) miss.push('uid（登录态）')
  if (!cred.Pauth) miss.push('Pauth（写操作必须的鉴权 cookie）')
  return miss
}

/** 常见返回码 → 人话 */
export const CODE_HINTS = {
  100: '成功',
  5001: '登录参数不完整 —— cookie 没带上，或者 uid/Pauth 已失效，重新扫码登录',
  8005: '违规内容 —— 被规则命中，换说法',
  8111: '命中敏感词',
  5003: '账号异地登录 —— 停下，人工去确认',
  403: '禁止访问 —— IP 级风控，退避',
  1000: '参数错误 / 模块不存在',
}

export function explainCode(code) {
  const k = String(code)
  const h = CODE_HINTS[k]
  return h ? 'code=' + k + ' ' + h : 'code=' + k + '（未知返回码）'
}

export function writeFailText(code, msg) {
  return '✗ 发送失败：HTTP 200 ' + explainCode(code) + (msg ? '（快爆原文：' + msg + '）' : '')
}

export const credFile = () => path.join(credDir(), 'credentials.json')
