// 运行日志：把插件做过的事（收到 @、回了评论、扫了论坛、写日报、发帖、叫醒会话、自检……）
// 记成一条条结构化记录，给设置页「运行日志」卡片看。
//
// 落盘：~/.hykb-ai/activity.jsonl（一行一条，超过 MAX_LINES 自动截掉旧的）。
// 内存里留一份最近的，读日志不用每次扫文件。写盘失败不影响业务。
//
// 记录来源 src：
//   run      —— 调度器真跑（自动回帖 / 自动刷帖）
//   manual   —— 设置页手动点的预览、试跑
//   selftest —— 一键自检（不计入「今日统计」，免得把测试当成真实动作）
import fs from 'node:fs'
import path from 'node:path'
import { credDir, ensureDir, localDay } from './paths.mjs'

export const activityPath = () => path.join(credDir(), 'activity.jsonl')

/** 种类 → 中文名。设置页按这个显示标签。 */
export const KINDS = {
  at: '收到 @',
  reply: '回复评论',
  forum: '扫描论坛',
  topic: '扫描帖子',
  notice: '读通知',
  listen: '回帖一轮',
  browse: '刷帖一轮',
  digest: '写日报',
  post: '发帖',
  focus: '回关',
  wake: '叫醒会话',
  ai: 'AI',
  skip: '跳过',
  test: '自检',
  system: '状态',
}

const MAX_LINES = 2000
const MAX_MEM = 500
let mem = null
let appended = 0

function loadMem() {
  if (mem) return mem
  mem = []
  try {
    const raw = fs.readFileSync(activityPath(), 'utf8').split(/\r?\n/).filter(Boolean)
    for (const line of raw.slice(-MAX_MEM)) {
      try { mem.push(JSON.parse(line)) } catch {}
    }
  } catch {}
  return mem
}

function trimFile() {
  try {
    const raw = fs.readFileSync(activityPath(), 'utf8').split(/\r?\n/).filter(Boolean)
    if (raw.length > MAX_LINES) fs.writeFileSync(activityPath(), raw.slice(-MAX_LINES).join('\n') + '\n')
  } catch {}
}

/**
 * 记一条。
 * @param {{kind:string, text:string, ok?:boolean, level?:'info'|'pass'|'warn'|'fail'|'skip', src?:string, meta?:object}} e
 */
export function add(e) {
  const entry = {
    at: new Date().toISOString(),
    kind: KINDS[e?.kind] ? e.kind : 'system',
    text: String(e?.text ?? '').slice(0, 400),
    ok: e?.ok !== false,
    level: e?.level || (e?.ok === false ? 'fail' : 'info'),
    src: e?.src || 'run',
  }
  if (e?.meta && typeof e.meta === 'object') entry.meta = e.meta
  const m = loadMem()
  m.push(entry)
  if (m.length > MAX_MEM) m.splice(0, m.length - MAX_MEM)
  try {
    ensureDir(credDir())
    fs.appendFileSync(activityPath(), JSON.stringify(entry) + '\n')
    if (++appended % 200 === 0) trimFile()
  } catch {}
  return entry
}

// 日志行 → 记录。只认有意义的几类，其余（逐条 AI 思考、调试细节）不进运行日志。
const RULES = [
  [/^\s*✓ 已回复：?\s*(.*)$/, 'reply', true, (m) => '回复了一条评论：' + m[1]],
  [/^\s*✗\s*(.*)$/, 'reply', false, (m) => '回复失败：' + m[1]],
  [/^\s*\[dry-run\] 会回复：?\s*(.*)$/, 'reply', true, (m) => '（预演）会回复：' + m[1]],
  [/^\[hit\/[^\]]*\]\s*(.*)$/, 'at', true, (m) => '收到一次 @：' + m[1]],
  [/^\s*\[skip\]\s*(.*)$/, 'skip', true, (m) => m[1]],
  [/^\s*\[ai\] 空回复/, 'ai', false, () => 'AI 返回空回复，已跳过'],
  [/^\[forum\]\s*(.*扫到.*)$/, 'forum', true, (m) => '扫描论坛：' + m[1]],
  [/^\[forum\]\s*(.*读失败.*)$/, 'forum', false, (m) => '扫描论坛失败：' + m[1]],
  [/^\[atme\]\s*(通知.*条.*)$/, 'notice', true, (m) => '读 @我 通知：' + m[1]],
  [/^\[atme\]\s*(.*失败.*)$/, 'notice', false, (m) => '读 @我 通知失败：' + m[1]],
  [/^\[topic\]\s*(.*读失败.*)$/, 'topic', false, (m) => '读帖子失败：' + m[1]],
  [/^\[topic\]\s*(.*楼层.*)$/, 'topic', true, (m) => '扫描帖子：' + m[1]],
  [/^\[watch\]\s*(首次扫描.*)$/, 'listen', true, (m) => m[1]],
  [/^\[watch\]\s*(写权限缺失.*)$/, 'listen', false, (m) => m[1]],
  [/^\[watch\]\s*(本轮已达上限.*)$/, 'listen', true, (m) => m[1]],
  [/^\[browse\]\s*本轮：(.*)$/, 'browse', true, (m) => '刷了一轮论坛：' + m[1]],
  [/^\[browse\]\s*本轮失败：?(.*)$/, 'browse', false, (m) => '刷帖失败：' + m[1]],
  [/^\[browse\]\s*已叫醒会话\s*(.*)$/, 'wake', true, (m) => '叫醒了会话 ' + m[1]],
  [/^\[browse\]\s*叫醒失败：?(.*)$/, 'wake', false, (m) => '叫醒会话失败：' + m[1]],
  [/^\[browse\]\s*(.*扫到.*帖)$/, 'forum', true, (m) => '扫描板块：' + m[1]],
  [/^\[browse\]\s*(.*(读失败|code=|目录失败).*)$/, 'forum', false, (m) => '扫描板块失败：' + m[1]],
  [/^\[digest\]\s*✓\s*(.*)$/, 'reply', true, (m) => '刷帖时回了一帖：' + m[1]],
  [/^\[digest\]\s*✗\s*(.*)$/, 'reply', false, (m) => '刷帖回帖失败：' + m[1]],
  [/^\[digest\]\s*(回帖被拦.*)$/, 'reply', false, (m) => m[1]],
  [/^\[digest\]\s*(写了.*)$/, 'digest', true, (m) => '写日报：' + m[1]],
  [/^\[digest\]\s*(\[dry-run\].*)$/, 'digest', true, (m) => '（预演）' + m[1].replace(/^\[dry-run\]\s*/, '')],
  [/^\[digest\]\s*(没扫到帖子|打分后没有新帖.*)$/, 'digest', true, (m) => m[1]],
  [/^\[post\]\s*✓\s*(.*)$/, 'post', true, (m) => '发了一篇帖：' + m[1]],
  [/^\[post\]\s*\[dry-run\]\s*(.*)$/, 'post', true, (m) => '（预演）' + m[1]],
  [/^\[post\]\s*(✗.*|发帖被拦.*|发帖失败.*)$/, 'post', false, (m) => m[1]],
  [/^\[post\]\s*没发：?(.*)$/, 'post', true, (m) => '没发帖：' + m[1]],
]

/** 把一行日志归类；认不出来返回 null。 */
export function classify(line) {
  const s = String(line || '').replace(/^\[hykb-scroll\]\s*/, '')
  for (const [re, kind, ok, fmt] of RULES) {
    const m = s.match(re)
    if (m) return { kind, ok, text: fmt(m).trim() }
  }
  return null
}

/** 日志回调用：能归类就记一条，返回记录或 null。 */
export function fromLog(line, { src = 'run' } = {}) {
  const c = classify(line)
  if (!c) return null
  return add({ ...c, src })
}

/**
 * 最近的记录，新的在前。
 * @param {{limit?:number, kind?:string, src?:string}} [q]
 */
export function list({ limit = 100, kind = '', src = '' } = {}) {
  const n = Math.max(1, Math.min(MAX_MEM, Number(limit) || 100))
  const out = []
  const m = loadMem()
  for (let i = m.length - 1; i >= 0 && out.length < n; i--) {
    const e = m[i]
    if (kind && e.kind !== kind) continue
    if (src && e.src !== src) continue
    out.push(e)
  }
  return out
}

/** 今天（本地日）各类真实动作的次数。自检和预演不算。 */
export function counts(now = new Date()) {
  const day = localDay(now)
  const c = { at: 0, reply: 0, replyFail: 0, forum: 0, notice: 0, listen: 0, browse: 0, digest: 0, post: 0, wake: 0, fail: 0 }
  for (const e of loadMem()) {
    if (e.src === 'selftest' || e.src === 'manual') continue
    if (localDay(new Date(e.at)) !== day) continue
    if (/^（预演）/.test(e.text)) continue
    if (!e.ok) { c.fail++; if (e.kind === 'reply') c.replyFail++; continue }
    if (e.kind in c) c[e.kind]++
  }
  return c
}

/** 清空运行日志（内存 + 文件）。 */
export function clear() {
  mem = []
  try { fs.writeFileSync(activityPath(), '') } catch {}
}

/** 测试用：丢掉内存缓存，下次从文件重读。 */
export function _reset() { mem = null; appended = 0 }
