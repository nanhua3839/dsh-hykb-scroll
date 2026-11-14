// 测试模式：设置页第五个模板「测试」。
//
// 打开后不改配置文件里用户自己填的东西，只在运行时叠一层「最宽」的设置：
//   - 自动回帖、自动刷帖、发帖全开；四个监听源全开；白黑名单全部视为空；全天运行；间隔调到最短
//   - 没填任何板块时，监听论坛默认扫「爆友生活区」，开箱就有东西可扫
// 关掉测试模式，原来的配置原样生效。
//
// 唯一不放宽的是 risk（安全阀：读写额度、写冷却、被拦退避）。它保护的是账号本身，
// 测试时被平台风控同样会封号；而且 traffic.mjs 直接读配置文件里的 risk，叠层也改不到它。
import { FILTER_KEYS } from './config.mjs'

export const TEST_FORUM = { id: '23064', title: '爆友生活区' }

/** 配置里是否开了测试模式。 */
export const isTestMode = (cfg) => cfg?.test?.enabled === true

const clone = (v) => JSON.parse(JSON.stringify(v ?? {}))
const clearFilters = (o) => { for (const k of FILTER_KEYS) o[k] = []; return o }
const ids = (list) => (Array.isArray(list) ? list : []).filter((x) => x && x.id != null && String(x.id) !== '')
const uniq = (list) => {
  const seen = new Set()
  return list.filter((x) => { const k = String(x.id); if (seen.has(k)) return false; seen.add(k); return true })
}

/**
 * 返回「最宽」的运行时配置（新对象，不改入参，不写盘）。
 * 不管 test.enabled 开没开都会放宽 —— 一键自检也用它，好把每个功能都过一遍。
 */
export function widen(cfg) {
  const c = clone(cfg)
  const L = (c.listen = c.listen || {})
  L.enabled = true
  L.allDay = true
  L.intervalSec = 30
  L.oncePerPerson = false
  L.triggerMode = 'both'
  L.maxTopicsPerTick = Math.max(6, Number(L.maxTopicsPerTick) || 0)
  L.maxRepliesPerTick = 10

  L.forum = clearFilters({ ...(L.forum || {}), enabled: true })
  L.forum.items = ids(L.forum.items)
  if (!L.forum.items.length) L.forum.items = [{ ...TEST_FORUM }]

  // ④「有人 @ 我」单独指定的帖子会把 @ 识别限制在这几帖里；测试时把它们并进
  // 「监听帖子」一起扫，然后清掉限制，哪里 @ 都认。
  const atItems = ids(L.at?.items)
  L.topic = clearFilters({ floors: true, comments: true, ...(L.topic || {}), enabled: true })
  L.topic.items = uniq([...ids(L.topic.items), ...atItems])
  L.atme = clearFilters({ ...(L.atme || {}), enabled: true })
  L.at = clearFilters({ ...(L.at || {}), enabled: true, items: [], forums: [] })

  const B = (c.browse = c.browse || {})
  B.enabled = true
  B.allDay = true
  B.intervalSec = 300
  B.minScore = 0
  B.skipTop = false
  B.muteTitles = []
  B.autoReply = true
  B.replyMinScore = 0
  B.replyMax = Math.max(3, Number(B.replyMax) || 0)
  B.wake = true
  clearFilters(B)

  const P = (c.post = c.post || {})
  P.enabled = true
  P.minPicks = 1

  c.test = { ...(c.test || {}), enabled: isTestMode(cfg), widened: true }
  return c
}

/** 调度器用的配置：测试模式开着就放宽，否则原样。 */
export const effective = (cfg) => (isTestMode(cfg) ? widen(cfg) : cfg)

/** 一键自检用：最宽，但每类只读一点点，省读额度。 */
export function probeConfig(cfg) {
  const c = widen(cfg)
  c.listen.maxTopicsPerTick = 1
  c.listen.maxRepliesPerTick = 1
  c.listen.forum.items = c.listen.forum.items.slice(0, 1)
  c.listen.topic.items = c.listen.topic.items.slice(0, 1)
  c.browse.pages = 1
  c.browse.maxSections = 1
  c.browse.pick = 3
  c.browse.deep = 1
  c.browse.replyMax = 1
  c.browse.wake = false
  return c
}
