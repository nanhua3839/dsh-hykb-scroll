// 浏览记录：她到底读过哪些帖、做了什么、为什么跳过。
//
// 与 activity.mjs 的分工：
//   activity = 一轮做了什么（粗粒度流水：回帖一轮 / 刷帖一轮）
//   history  = 帖粒度的账：哪一帖、谁发的、什么时候发的/改的/最后一楼是什么时候、这次是回了还是跳过
//
// 落盘 ~/.hykb-ai/browsed.jsonl，一行一条，只追加。同一帖同一天同一个动作只记一次，
// 否则每 60 秒扫一遍会把同一批帖子重复写满（60 秒 × 20 帖 = 一小时 1200 行）。
import fs from 'node:fs'
import { historyPath, credDir, ensureDir, harden, localDay } from './paths.mjs'
import { parseKbTime, ago, timeLine } from './timefmt.mjs'

export const MAX_KEEP = 5000

/** 动作 → 中文。reply 真回了 / skip 判定不该回 / digest 写进日报 / read 只读过。 */
export const ACTIONS = { reply: '已回复', skip: '跳过', digest: '写进日报', read: '读过' }

let index = null      // Set<'YYYY-MM-DD|topicId|action'>，去重用
let lines = 0

const keyOf = (day, topicId, action) => day + '|' + String(topicId) + '|' + String(action)

function buildIndex() {
  index = new Set()
  lines = 0
  let raw = ''
  try { raw = fs.readFileSync(historyPath(), 'utf8') } catch { return index }
  const all = raw.split(/\r?\n/).filter(Boolean)
  lines = all.length
  for (const line of all.slice(-MAX_KEEP)) {
    try {
      const e = JSON.parse(line)
      const day = String(e.day || localDay(new Date(e.at)))
      if (e.topicId) index.add(keyOf(day, e.topicId, e.action))
    } catch {}
  }
  return index
}

const idx = () => index || buildIndex()

function trimIfNeeded() {
  if (lines <= MAX_KEEP) return
  try {
    const all = fs.readFileSync(historyPath(), 'utf8').split(/\r?\n/).filter(Boolean)
    if (all.length > MAX_KEEP) {
      fs.writeFileSync(historyPath(), all.slice(-MAX_KEEP).join('\n') + '\n')
      lines = MAX_KEEP
    }
  } catch {}
}

/**
 * 记一条。同一天同一帖同一动作重复调用会被丢掉（返回 null）。
 * @param {{topicId:string|number, title?:string, sectionId?:string, sectionTitle?:string,
 *          uid?:string, nickname?:string, published?:*, edited?:*, replied?:*,
 *          action?:'reply'|'skip'|'digest'|'read', why?:string, kind?:string}} e
 */
export function record(e = {}) {
  const topicId = String(e.topicId ?? '').trim()
  if (!topicId) return null
  const action = ACTIONS[e.action] ? e.action : 'read'
  const day = localDay()
  const set = idx()
  const k = keyOf(day, topicId, action)
  if (set.has(k)) return null
  set.add(k)
  const entry = {
    at: new Date().toISOString(),
    day,
    action,
    topicId,
    title: String(e.title ?? '').slice(0, 120),
    sectionId: String(e.sectionId ?? ''),
    sectionTitle: String(e.sectionTitle ?? '').slice(0, 40),
    uid: String(e.uid ?? ''),
    nickname: String(e.nickname ?? '').slice(0, 40),
    published: Number(parseKbTime(e.published) || e.published || 0) || 0,
    edited: Number(parseKbTime(e.edited) || e.edited || 0) || 0,
    replied: Number(parseKbTime(e.replied) || e.replied || 0) || 0,
    why: String(e.why ?? '').slice(0, 60),
  }
  try {
    ensureDir(credDir())
    const fresh = !fs.existsSync(historyPath())
    fs.appendFileSync(historyPath(), JSON.stringify(entry) + '\n', { mode: 0o600 })
    if (fresh) harden(historyPath())
    lines++
    if (lines > MAX_KEEP) trimIfNeeded()
  } catch { /* 浏览记录写不进去不能挡住主流程 */ }
  return entry
}

/** 最近的记录，新的在前。 */
export function list({ limit = 200 } = {}) {
  const n = Math.max(1, Math.min(MAX_KEEP, Number(limit) || 200))
  let raw = ''
  try { raw = fs.readFileSync(historyPath(), 'utf8') } catch { return [] }
  const all = raw.split(/\r?\n/).filter(Boolean)
  const out = []
  const now = Date.now()
  for (let i = all.length - 1; i >= 0 && out.length < n; i--) {
    try {
      const e = JSON.parse(all[i])
      out.push({
        ...e,
        actionText: ACTIONS[e.action] || e.action,
        // 三个时间在服务端就算好：浏览器侧没有 node 的 fs，也不该再抄一份时间格式化
        publishedText: timeLine('发布', e.published, now).replace(/^发布：/, ''),
        editedText: e.edited ? ago(e.edited, now) : '',
        repliedText: timeLine('最后回复', e.replied, now).replace(/^最后回复：/, ''),
      })
    } catch {}
  }
  return out
}

/** 今天各类动作的条数（设置页卡片标题用）。 */
export function counts() {
  const c = { reply: 0, skip: 0, digest: 0, read: 0, total: 0 }
  const day = localDay()
  let raw = ''
  try { raw = fs.readFileSync(historyPath(), 'utf8') } catch { return c }
  for (const line of raw.split(/\r?\n/).filter(Boolean).slice(-MAX_KEEP)) {
    try {
      const e = JSON.parse(line)
      if (String(e.day || '') !== day) continue
      c.total++
      if (e.action in c) c[e.action]++
    } catch {}
  }
  return c
}

/** 清空浏览记录（内存索引一起清）。 */
export function clear() {
  try { fs.writeFileSync(historyPath(), '') } catch {}
  index = new Set()
  lines = 0
}

/** 测试用：丢掉内存索引，下次从文件重建。 */
export function _reset() { index = null; lines = 0 }
