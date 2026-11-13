// App 网关（api.3839app.com）签名层：把原 libne.so 干的两件事搬到 Node。
//
// 来源：_re/token-spec.md（从 libne.dec.so 反汇编还原，已用真实网关验证被服务端接受）。
//   · client token  t = md5( "|".join(按 key 排序后的 values) )，排序时多带一对固定 ("secret", …)
//   · 请求体      body = base64( AES-128-CBC(零填充补整块, key[type], iv[type], json) )
// 两者都是纯计算，无随机、无时间参与 —— 服务器上可以直接算。
import crypto from 'node:crypto'

const SEP = '|'
const SECRET_NAME = 'secret'
const SECRET = 'c1714e41e5a907874c59a4d81a8486ea'

/** type → [key, iv]，取自 libne.dec.so 的 7×32 字节表（release 组）。 */
const AES_TABLE = {
  0: ['nP[$9^B6s73@i#2Y', 'Kw%g@T@O5#N7j&hU'],
  1: ['z@xgw2rd!S!cur7Z', '1zPtVector2025!1'],
  2: ['Ma0B5^Ps7@7GQt#2', 'd@J%0WK8#znQ$PFH'],
  3: ['D(9m+j~CtX^HbY#2', 'hn0{@"`Ldm!ruPFH'],
  4: ['ajnzif42dm129xkt', 'amrxlr103xinr34x'],
  5: ['}S*ubW4VtCYJvpLD', 'kHW3cym6z)H)%Ayt'],
  6: ['^0!o2=kH_%AOh+?N', 'i}G~P^uc]-<+0_JC'],
}

/** 服务端只认 URL 上这几个 key，其余参数必须进加密体。 */
export const QUERY_WHITELIST = ['v', 'c', 'a', 'uid', 'device', 'vc', 'params_encryption']

/**
 * client token。keys/values 是 Java 层丢给 generateCommonToken 的那两个 Object[]。
 * 排序按 key 的 UTF-8 字节序（原生侧是 strcmp）。
 */
export function commonToken(keys, values) {
  const pairs = []
  const n = Math.min(keys.length, values.length)
  for (let i = 0; i < n; i++) pairs.push([String(keys[i]), String(values[i])])
  pairs.push([SECRET_NAME, SECRET])
  pairs.sort((a, b) => Buffer.compare(Buffer.from(a[0], 'utf8'), Buffer.from(b[0], 'utf8')))
  const joined = pairs.map((p) => p[1]).join(SEP)
  return crypto.createHash('md5').update(joined, 'utf8').digest('hex')
}

/** AES-128-CBC + 零填充（补满一整块，不是 PKCS#7），再 base64（无换行）。 */
export function encryptBody(plain, type = 0) {
  const [key, iv] = AES_TABLE[type] || AES_TABLE[0]
  const data = Buffer.from(String(plain), 'utf8')
  const pad = ((data.length & ~0xf) + 0x10) - data.length
  const buf = Buffer.concat([data, Buffer.alloc(pad, 0)])
  // autoPadding 必须关掉：Node 默认会补 PKCS#7，而原生是零填充，多出来的整块会让服务端解不开。
  // 注意 createCipheriv 的 { autoPadding: false } 在 Node 26.5 上不生效（实测仍多补一块），只能显式 setAutoPadding。
  const c = crypto.createCipheriv('aes-128-cbc', Buffer.from(key, 'utf8'), Buffer.from(iv, 'utf8'))
  c.setAutoPadding(false)
  return Buffer.concat([c.update(buf), c.final()]).toString('base64')
}

/**
 * 组一个 App 网关请求。
 * @param {Record<string,string|number>} map 相当于 HttpParamsHelper2.d() 产出的参数表
 * @param {{type?: number}} [opts]
 * @returns {{query: Record<string,string>, body: string, token: string, bodyMap: Record<string,string>}}
 */
export function buildRequest(map, { type = 0 } = {}) {
  const m = {}
  for (const [k, v] of Object.entries(map)) if (v != null) m[k] = String(v)
  const token = commonToken(Object.keys(m), Object.values(m))
  const query = {}
  for (const k of QUERY_WHITELIST) if (k in m) query[k] = m[k]
  query.params_encryption = '1'
  const bodyMap = {}
  for (const [k, v] of Object.entries(m)) if (!QUERY_WHITELIST.includes(k)) bodyMap[k] = v
  bodyMap.t = token
  const plain = JSON.stringify(bodyMap)
  return { query, body: encryptBody(plain, type), token, bodyMap }
}
