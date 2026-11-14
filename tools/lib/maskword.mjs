// 快爆平台侧的敏感词检测：发出去之前，再问一次平台自己的词表。
//
// 接口文档：https://open.3839.com/console/docs/#/mga/maskword
//   GET  https://w.mobayx.com/test/matchService.do?appid=<appid>&ts=<秒>&sign=<md5>
//   POST toCheck=<文本>&level=1&byPinyin=true|false&simpleMatch=true|false
//   sign = md5("appid=<appid>&ts=<ts>" + "&" + key)        ← 按 PHP http_build_query 的编码规则
//   返回 {"13:15":{"level":1,"startPos":13,"endPos":15,"maskWord":"…"}, …}；空对象 = 通过
//   失败返回纯文本 "1003:链接过期(服务端ts-你的ts)"
//
// 为什么还要这一道：safety.mjs 的词表是我们自己攒的，平台词表才是**真正会拦你**的那一份。
//   本地放行、平台拦下 → 白写一条，还留一条被拦记录；
//   本地拦下、平台放行 → 白丢一次回复。
// 所以顺序是：本地闸（免费、零延迟）→ 平台闸（一次请求、几毫秒）→ 真发出去。
//
// 没配 appid / 密钥时整道闸自动跳过，不报错、不打扰。密钥单独存 ~/.hykb-ai/maskword-key。
import { createHash } from 'node:crypto'
import { config, loadMaskwordKey } from './config.mjs'

/** 文档里给的「正式请求URL」就是 /test/matchService.do 这段路径；不带 /test 的生产路径直接 403。 */
export const DEFAULT_URL = 'https://w.mobayx.com/test/matchService.do'

/** 接口自己的错误码，返回体是纯文本 "1003:…" 这种。 */
export const ERRORS = {
  1001: '参数为空',
  1002: '私钥为空或未配置',
  1003: '链接过期（ts 和服务端差太多，检查本机时间）',
  1004: '签名匹配错误（appid 和密钥对不上）',
}

/**
 * PHP urlencode 的等价物。
 * encodeURIComponent 不转义 ! ' ( ) * ~，PHP 的 urlencode 会转义前五个；空格两边的写法也不同（PHP 是 +）。
 * appid / ts 都是普通字符，这里只是别让「以后有人把中文塞进 appid」时两边算法悄悄分叉。
 */
export function phpUrlencode(v) {
  return encodeURIComponent(String(v))
    .replace(/[!'()*~]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
    .replace(/%20/g, '+')
}

/**
 * 签名：ksort 之后只剩 appid、ts 两个键（字母序 appid 在前），拼成 query 再补 "&<key>" 做 md5。
 * @returns {string} 32 位小写 hex
 */
export function sign({ appid = '', ts = 0, key = '' } = {}) {
  const query = 'appid=' + phpUrlencode(appid) + '&ts=' + phpUrlencode(ts)
  return createHash('md5').update(query + '&' + key, 'utf8').digest('hex')
}

/** 拼完整请求地址（sign 放最后，和文档里 http_build_query($params) 的顺序一致）。 */
export function buildUrl({ url = DEFAULT_URL, appid = '', ts = 0, key = '' } = {}) {
  const q = 'appid=' + phpUrlencode(appid) + '&ts=' + phpUrlencode(ts) + '&sign=' + sign({ appid, ts, key })
  return String(url || DEFAULT_URL) + (String(url || '').includes('?') ? '&' : '?') + q
}

const asInt = (v, d = 0) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.trunc(n) : d
}

/**
 * 解析返回体。两种形状都要认：
 *   · 正常：{"13:15":{level,startPos,endPos,maskWord}, …}，空对象 = 通过
 *   · 出错："1003:链接过期(...)" 这种纯文本
 * @returns {{ok:boolean, hits:Array<{word:string,start:number,end:number,level:number}>, error?:string, code?:number}}
 */
export function parse(body) {
  const raw = String(body ?? '').trim()
  if (!raw) return { ok: true, hits: [] }
  const m = /^(\d{4})\s*[:：]/.exec(raw)
  if (m) {
    const code = Number(m[1])
    // 错误串里带着服务端时间，对排查「本机时钟偏了」有用，但别把它整段回显到日志里
    return { ok: false, hits: [], code, error: ERRORS[code] || ('接口错误 ' + code) }
  }
  let data
  try {
    data = JSON.parse(raw)
  } catch {
    return { ok: false, hits: [], error: '返回不是 JSON：' + raw.slice(0, 60) }
  }
  const rows = Array.isArray(data) ? data : Object.values(data || {})
  const hits = []
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue
    const word = String(r.maskWord ?? r.word ?? '').trim()
    if (!word) continue
    hits.push({ word, start: asInt(r.startPos), end: asInt(r.endPos), level: asInt(r.level, 1) })
  }
  return { ok: hits.length === 0, hits }
}

/**
 * 问一次平台。
 * @returns {Promise<{configured:boolean, skipped?:string, ok:boolean, hits:Array, error?:string}>}
 *   skipped 有值 = 这一道没开（没启用 / 没配 appid 或密钥），调用方应当放行
 */
export async function checkText(text, opts = {}) {
  const cfg = opts.cfg || config()
  const mw = cfg?.safety?.maskword || {}
  if (opts.force !== true && mw.enabled !== true) return { configured: false, skipped: 'off', ok: true, hits: [] }

  const appid = String(opts.appid ?? mw.appid ?? '').trim()
  const key = String(opts.key ?? loadMaskwordKey()).trim()
  if (!appid || !key) return { configured: false, skipped: 'no-credential', ok: true, hits: [] }

  const ts = Math.floor((Number(opts.now) || Date.now()) / 1000)
  const url = buildUrl({ url: opts.url || mw.url || DEFAULT_URL, appid, ts, key })
  const body = new URLSearchParams({
    toCheck: String(text ?? ''),
    level: String(asInt(mw.level, 1)),
    byPinyin: String(mw.byPinyin === true),
    simpleMatch: String(mw.simpleMatch !== false),
  }).toString()

  const timeout = Math.max(500, asInt(opts.timeoutMs ?? mw.timeoutMs, 3000))
  const doFetch = opts.fetchImpl || globalThis.fetch
  let res
  try {
    res = await doFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(timeout),
    })
  } catch (e) {
    const why = e?.name === 'TimeoutError' || e?.name === 'AbortError' ? ('超时 ' + timeout + 'ms') : String(e?.message || e)
    return { configured: true, ok: false, hits: [], error: '请求失败：' + why }
  }

  let raw = ''
  try { raw = await res.text() } catch { raw = '' }
  if (!res.ok) return { configured: true, ok: false, hits: [], error: 'HTTP ' + res.status + '：' + raw.slice(0, 60) }
  const r = parse(raw)
  return { configured: true, ...r }
}

/**
 * 出站最后一道：本地闸过了才轮到它。拦截时**不回显命中的词**（日志里出现原文等于扩散一次）。
 * @returns {{allow:boolean, why?:string, count?:number, error?:string}}
 */
export async function gate(text, { cfg = config(), log = () => {}, fetchImpl } = {}) {
  const S = cfg?.safety || {}
  const mw = S.maskword || {}
  // 总闸关掉 = 内容安全整块不工作；平台闸跟着一起关，别出现「总闸关了它还在发请求」
  if (S.enabled === false || mw.enabled !== true) return { allow: true }

  const r = await checkText(text, { cfg, fetchImpl })
  if (r.skipped) return { allow: true }
  if (r.ok) return { allow: true }

  if (r.error) {
    // 接口本身不可用（没密钥、超时、签名错）：默认放行 —— 本地闸还在，不能因为第三方挂了把回帖全停掉。
    if (mw.blockOnError === true) {
      log('  [maskword] ' + r.error + '（按设置拦下）')
      return { allow: false, why: 'platform-error', error: r.error }
    }
    log('  [maskword] ' + r.error + '（放行，本地闸仍然有效）')
    return { allow: true, error: r.error }
  }

  log('  [maskword] 平台词表命中 ' + r.hits.length + ' 处，拦下不发')
  return { allow: false, why: 'platform-word', count: r.hits.length }
}
