// 复读查重：同一段话（或近似的话）在 N 天内已经发过，就不发。
//
// 为什么这条属于风控：机器最容易暴露的不是频率，是「同一句话反复出现」。
// 平台的风控和真人都能一眼看出「这个用户半小时前刚说过一模一样的」。
//
// 两档判定：
//   · 完全相同（归一化后一致）→ 直接判重
//   · 近似（二元组 Jaccard ≥ dedupeSimilar）→ 判重
//
// 落盘是 JSONL 追加（~/.hykb-ai/said.jsonl）：每发一句话只 append 一行。
// 早先版本每次「全量读 → 全量重写」，200 条就要 44 秒（O(n²) 的 IO），
// 在真实运行里会直接卡住回帖链。追加写 + 超过上限时才压缩，是这个量级该有的做法。
import fs from 'node:fs'
import { credDir, ensureDir, harden, saidPath } from './paths.mjs'
import { normalize } from './safety.mjs'

const DAY = 86400000
const MAX = 2000

let cache = null          // { at, list }：进程内缓存，避免每次判重都读一遍文件
let count = null          // 台账现有条数（append 时递增）。用「条数」而不是「字节数」判断该不该压缩，
                          // 因为一条记录的长度取决于正文长短，按字节数猜会时灵时不灵。

function readAll() {
  let text
  try { text = fs.readFileSync(saidPath(), 'utf8') } catch { return [] }
  const list = []
  for (const line of text.split('\n')) {
    const s = line.trim()
    if (!s) continue
    try {
      const v = JSON.parse(s)
      if (v && v.text) list.push(v)
    } catch { /* 半行 / 坏行跳过，不因为一行坏掉整个台账 */ }
  }
  return list
}

/** 带上进程内缓存：判重是热路径（每生成一条回复都要查一次）。 */
function entries() {
  if (cache && Date.now() - cache.at < 5000) return cache.list
  const list = readAll()
  cache = { at: Date.now(), list }
  return list
}

function invalidate() { cache = null; count = null }

/**
 * 追加一条。超过上限才整体压缩一次（把最老的丢掉）。
 * 正常路径是纯 append，一次 write 一个 syscall。
 */
function append(entry) {
  ensureDir(credDir())
  const f = saidPath()
  const fresh = !fs.existsSync(f)
  fs.appendFileSync(f, JSON.stringify(entry) + '\n', { mode: 0o600 })
  if (fresh) { try { harden(f) } catch {} }
  // 先拿条数再让它失效（invalidate 会把 count 归零）
  const n = (count == null ? readAll().length : count) + 1
  invalidate()
  count = n
  // 不是「超一条就压」：那会在 MAX 附近变成每条都全量重写（O(n²)）。
  // 留 20% 余量，压完回到 MAX，接下来 400 条都只走 append。
  if (n > MAX + Math.floor(MAX * 0.2)) compact()
}

/** 把台账压到 MAX 条以内（留最新的）。 */
function compact() {
  const list = readAll().slice(-MAX)
  const f = saidPath()
  const tmp = f + '.' + process.pid + '.tmp'
  fs.writeFileSync(tmp, list.map((e) => JSON.stringify(e)).join('\n') + (list.length ? '\n' : ''), { mode: 0o600 })
  harden(tmp)
  fs.renameSync(tmp, f)
  harden(f)
  invalidate()
  count = list.length
}

/** 归一化文本的 bigram 集合。中文没有空格，字符二元组比按词切更稳。 */
function bigrams(s) {
  const t = normalize(s)
  const out = new Set()
  for (let i = 0; i < t.length - 1; i += 1) out.add(t.slice(i, i + 2))
  if (t.length === 1) out.add(t)
  return out
}

/** 两段文本的近似度（Jaccard）。空文本一律 0。 */
export function similarity(a, b) {
  const A = bigrams(a)
  const B = bigrams(b)
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const x of A) if (B.has(x)) inter += 1
  return inter / (A.size + B.size - inter)
}

/** 稳定的小哈希（只用来做快路径比较，不用于安全用途）。 */
function hashOf(s) {
  let hash = 0x811c9dc5
  const t = normalize(s)
  for (let i = 0; i < t.length; i += 1) {
    hash ^= t.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16)
}

/**
 * 查重。命中返回命中的那条（含当时的时间），否则 null。
 * @param {object} o
 * @param {string} o.text       这次要发的话
 * @param {object} o.cfg
 * @param {number} [o.now]
 */
export function findRepeat({ text, cfg, now = Date.now() } = {}) {
  const R = cfg?.risk || {}
  const days = Number(R.dedupeDays)
  if (!Number.isFinite(days) || days <= 0) return null        // 0 = 关掉查重
  const th = Number.isFinite(Number(R.dedupeSimilar)) ? Math.min(1, Math.max(0.5, Number(R.dedupeSimilar))) : 0.86
  const key = hashOf(text)
  const cutoff = now - days * DAY
  const mine = normalize(text)
  const myLen = mine.length
  // 预筛：长度差一倍的句子不可能达到 0.86 的 bigram 相似度，直接跳过省掉昂贵比较。
  // 台账 2000 条时这一条把单次判重从 ~22ms 压到 1ms 量级。
  const lo = Math.floor(myLen * 0.5)
  const hi = Math.ceil(myLen * 1.6) + 2
  for (const e of entries()) {
    if (!e || !e.text) continue
    if ((e.at || 0) < cutoff) continue                        // 超出窗口的老记录不参与
    if (e.hash === key) return e                              // 快路径：一模一样
    const L = normalize(e.text).length
    if (L < lo || L > hi) continue
    if (similarity(text, e.text) >= th) return e              // 慢路径：近似
  }
  return null
}

/** 记一条「说过了」。只记正文，不记帖 id（跨帖复读也要拦）。 */
export function rememberSaid({ text, at = Date.now() } = {}) {
  const body = String(text || '').trim()
  if (!body) return null
  const entry = { at, hash: hashOf(body), text: body.slice(0, 300) }
  append(entry)
  return entry
}

/** 台账概况：给设置页看「复读库里现在有多少条」。 */
export function saidStats({ cfg, now = Date.now() } = {}) {
  const days = Number(cfg?.risk?.dedupeDays) || 0
  const list = entries()
  const cutoff = now - Math.max(1, days) * DAY
  return { total: list.length, inWindow: list.filter((e) => (e.at || 0) >= cutoff).length, days }
}

/** 清空复读库（改话术风格后想重新开始，或误判太多时用）。 */
export function clearSaid() {
  const f = saidPath()
  try { fs.rmSync(f, { force: true }) } catch {}
  invalidate()
}
