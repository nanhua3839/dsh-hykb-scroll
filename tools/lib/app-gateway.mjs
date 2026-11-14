// App 网关（api.3839app.com）调用层：签名 + 加密体 + 传输。
//
// 与 hykb-api.mjs 的网页接口是两套东西，别混：
//   · 网页/bbs 域 —— cookie(uid/Pauth/Uauth) 明文请求，只读接口都在这
//   · App 网关   —— 需要 client token + AES 体，业务参数还得带 type / user_token（App 登录态）
// 签名与加密在 app-sign.mjs（纯计算），这里只负责发请求与解释返回码。
import { buildRequest } from './app-sign.mjs'
import { guardedFetch } from './traffic.mjs'
import { loadCred } from './cred.mjs'

export const APP_API = 'https://api.3839app.com/kuaibao/android/api.php'
const UA = 'okhttp/3.12.13'

/** 网关最常见的几个拒绝码 → 人话。 */
export const APP_CODE_HINTS = {
  100: '成功',
  1000: '网关签名/加密体不对（plength error / token error）',
  2001: '缺参数（client token / type / user_token）—— 多半是 App 登录态没配',
  2005: '非法操作 —— 参数不全',
  5001: '未登录 —— user_token 无效或过期，重新登录一次',
  5003: '账号在另一台设备登录 —— 停下，人工确认',
}

export function explainAppCode(code, msg) {
  const h = APP_CODE_HINTS[String(code)]
  return h ? 'code=' + code + ' ' + h + (msg ? '（原文：' + msg + '）' : '') : 'code=' + code + (msg ? '（' + msg + '）' : '')
}

/**
 * 发一个 App 网关请求。
 * @param {{c:string,a:string,v?:string|number,params?:Record<string,any>,type?:number,device?:string,vc?:string,
 *          uid?:string,userToken?:string,action?:'read'|'write'}} o
 */
export async function appCall(o) {
  const {
    c, a, v = '1536', params = {}, type = 0, vc = '20260', action = 'read',
  } = o
  const uid = String(o.uid || loadCred().uid || '')
  // n / ts 是网关强制要求的一次性参数（缺了回 nonce error），且它们参与签名
  const now = Math.floor(Date.now() / 1000)
  const nonce = String(1000000 + Math.floor(Math.random() * 9000000))
  const map = {
    v: String(v), c, a, uid, device: o.device || 'android', vc,
    isNightMode: '0', permission_storage: '1',
    ts: String(o.ts || now), n: String(o.nonce || nonce),
    ...params,
  }
  if (o.userToken) { map.type = String(type); map.user_token = String(o.userToken) }
  const { query, body } = buildRequest(map, { type })
  const url = APP_API + '?' + new URLSearchParams(query).toString()
  const res = await guardedFetch(url, {
    method: 'POST',
    headers: { 'content-type': 'text/x-markdown', 'user-agent': UA },
    body,
  }, action)
  const text = await res.text()
  try { return JSON.parse(text) } catch { return { code: -1, msg: 'non-json', raw: text.slice(0, 300) } }
}

/** 只读探针：粉丝列表（App 侧）。用于验证签名层是否真被网关接受。 */
export function fansList({ vuid, page = 1, userToken, type = 0 } = {}) {
  return appCall({ c: 'kifansother2', a: 'home', v: '1536', params: { page: String(page), vuid: String(vuid || loadCred().uid) }, userToken, type })
}

/** 关注某人（回关）。写操作 —— 调用方必须自己先过开关、日限与审计。 */
export function followUser(vuid, { userToken, type = 0 } = {}) {
  return appCall({ c: 'kirelation', a: 'add', v: '1536', params: { vuid: String(vuid) }, userToken, type, action: 'write' })
}
