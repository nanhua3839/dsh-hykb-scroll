// 游戏评价层：**只读**。读榜单挑游戏，读游戏页的评价，压成日报里的一段观察。
//
// 明确不做的事：不发任何游戏评价/评论。这里连写接口都不 import，
// 平台对「刷好评」有礼仪考试闸（comment.php 会拦），也不该由脚本替她打分。
//
// 两个数据源（都实测过）：
//   榜单   GET https://m.3839.com/top/<hot|sugar|expect|down>.html   服务端渲染，直接给 id + 名字
//   评价   GET https://www.3839.com/app/comment.php?ac=get_comment_list&m=pc&v=1.0&pid=1&fid=<游戏id>
//          返回 {code, result:{star_info, count, count_str, data:[…]}}，data 里每条有 star / content / time_str
import { guardedFetch } from './traffic.mjs'
import { tidy } from './ai.mjs'

const TOP = 'https://m.3839.com/top/'
const WEB = 'https://www.3839.com'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131 Safari/537.36'

/** 榜单页文件名 → 人话。只有这几个是服务端渲染的（top.js 那个是 JS 渲染，拿不到）。 */
export const SOURCES = {
  hot: '热门榜',
  sugar: '飙升榜',
  expect: '预约榜',
  down: '下载榜',
}

const strip = (h) => String(h || '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()

/**
 * 解析榜单页：每个 <li> 一个游戏，id 在 /a/<id>.htm，名字在 span.sp-name，分数在 span.spec「6.3分」。
 * @returns {Array<{id:string, title:string, score:number}>}
 */
export function parseRankHtml(html) {
  const out = []
  const seen = new Set()
  for (const chunk of String(html || '').split('<li').slice(1)) {
    const id = (chunk.match(/\/a\/(\d{2,10})\.htm/) || [])[1]
    if (!id || seen.has(id)) continue
    const title = strip((chunk.match(/class="sp-name"[^>]*>([^<]+)</) || [])[1])
    if (!title) continue
    const score = Number((chunk.match(/class="spec"[^>]*>\s*([\d.]+)\s*分/) || [])[1]) || 0
    seen.add(id)
    out.push({ id, title, score })
  }
  return out
}

/** 拉一个榜单。失败返回 {code, msg, games:[]}，调用方自己决定要不要继续。 */
export async function rankGames(source = 'hot') {
  const key = SOURCES[source] ? source : 'hot'
  let res
  try {
    res = await guardedFetch(TOP + key + '.html', { headers: { 'user-agent': UA } }, 'read')
  } catch (e) { return { code: -1, msg: e.message, games: [] } }
  const html = await res.text().catch(() => '')
  const games = parseRankHtml(html)
  return { code: games.length ? 100 : -1, msg: games.length ? '' : '榜单页没解析出游戏（平台改版？）', source: key, games }
}

/** 一个游戏的评价列表（只读）。 */
export async function gameComments(fid, { page = 1 } = {}) {
  const uid = String(fid || '').trim()
  if (!/^\d{1,10}$/.test(uid)) return { code: -3, msg: '游戏 id 不对：' + fid }
  const url = WEB + '/app/comment.php?ac=get_comment_list&m=pc&v=1.0&pid=1&fid=' + uid + '&page=' + Number(page || 1)
  const res = await guardedFetch(url, {
    headers: { 'user-agent': UA, referer: WEB + '/a/' + uid + '.htm', 'x-requested-with': 'XMLHttpRequest' },
  }, 'read')
  try { return await res.json() } catch { return { code: -1, msg: 'non-json' } }
}

/**
 * 挑出能用的评价：去掉纯表情/太短的，去重，按平台顺序取前 max 条。
 * @returns {Array<{star:number, content:string, time:string, user:string}>}
 */
export function pickComments(list, { max = 20, minLen = 12 } = {}) {
  const out = []
  const seen = new Set()
  for (const c of list || []) {
    const content = strip(c?.content)
    if (content.length < Math.max(1, minLen)) continue
    const k = content.slice(0, 40)
    if (seen.has(k)) continue
    seen.add(k)
    out.push({
      star: Number(c?.star) || 0,
      content: content.slice(0, 300),
      time: String(c?.time_str || ''),
      user: String(c?.user?.nickname || ''),
    })
    if (out.length >= Math.max(1, max)) break
  }
  return out
}

/**
 * 游戏名。用户只填了 id 时，从游戏页 <title> 捞一个名字（一次读，进程内缓存）。
 * 拿不到就返回空串，调用方用 id 顶上去 —— 宁可显示 id，也不要编一个名字。
 */
const titleCache = new Map()
export async function gameTitle(id) {
  const key = String(id || '')
  if (!/^\d{1,10}$/.test(key)) return ''
  if (titleCache.has(key)) return titleCache.get(key)
  let name = ''
  try {
    const res = await guardedFetch(WEB + '/a/' + key + '.htm', { headers: { 'user-agent': UA } }, 'read')
    const html = await res.text()
    const t = (html.match(/<title>([^<]{1,80})<\/title>/i) || [])[1] || ''
    name = t.split(/[-_|]/)[0].trim()
  } catch { name = '' }
  titleCache.set(key, name)
  return name
}

/**
 * 这一轮看哪几个游戏：用户填的清单优先，没填才去榜单挑。
 * @returns {Promise<Array<{id:string, title:string, score?:number, from:string}>>}
 */
export async function resolveGames(cfg, { log = () => {} } = {}) {
  const G = cfg?.games || {}
  const mine = (G.items || [])
    .map((x) => (typeof x === 'string' ? { id: x, title: '' } : x))
    .filter((x) => x && /^\d{1,10}$/.test(String(x.id || '')))
    .map((x) => ({ id: String(x.id), title: String(x.title || ''), from: 'list' }))
  const cap = Math.max(1, Number(G.pick) || 3)
  if (mine.length) {
    if (mine.length > cap) log('[games] 清单里有 ' + mine.length + ' 个，本轮只看前 ' + cap + ' 个')
    const picked = mine.slice(0, cap)
    // 只填了 id 的时候补个名字（榜单那条路本来就有名字，不用补）
    for (const g of picked) {
      if (!g.title) g.title = await gameTitle(g.id)
    }
    return picked
  }
  const r = await rankGames(G.source)
  if (r.code !== 100) { log('[games] ' + (SOURCES[G.source] || '榜单') + '没拿到：' + (r.msg || r.code)); return [] }
  log('[games] 未指定游戏，用' + (SOURCES[r.source] || r.source) + '前 ' + cap + ' 个：' + r.games.slice(0, cap).map((g) => g.title).join(' / '))
  return r.games.slice(0, cap).map((g) => ({ ...g, from: 'rank' }))
}

/** 把一个游戏的评价压成一段材料的行（给模型读，不是给它看控件）。 */
export function gameBlock(g, comments) {
  const stars = comments.map((c) => c.star).filter((n) => n > 0)
  const avg = stars.length ? (stars.reduce((a, b) => a + b, 0) / stars.length).toFixed(1) : '—'
  const head = '【' + (g.title || g.id) + '】（id ' + g.id + (g.score ? '　平台 ' + g.score + ' 分' : '')
    + (g.star ? '　评价均分 ' + g.star : '') + '　本轮 ' + comments.length + ' 条评价，均 ' + avg + ' 分）'
  const body = comments.length
    ? comments.map((c) => '  ' + (c.star ? c.star + '分 ' : '') + (c.user || '') + '：' + tidy(c.content, 160)).join('\n')
    : '  （没读到评价）'
  return head + '\n' + body
}

/** 让模型写「玩家在这个游戏下面都在说什么」。 */
export function gamesPrompt({ blocks, persona, date }) {
  return [
    {
      role: 'system',
      content: [
        '你在给「' + (persona?.name || '小号') + '」写游戏社区日报里的一个固定栏目：游戏评价观察。',
        '读者是「' + (persona?.ownerTitle || '主人') + '」。',
        '硬规则：只写材料里出现过的评价；不编造分数、结论、玩家名；不替任何人打分；不写"建议购买"这种导购话术；不寒暄。',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        '日期：' + date,
        '下面是今天挑的几个游戏，以及玩家在这几个游戏下面的评价（只读，不发言）：',
        '',
        blocks.join('\n\n'),
        '',
        '用中文输出，严格按这个结构：',
        '## 游戏评价观察',
        '每个游戏一行，以「- 游戏名：」开头，说清三件事：好评在夸什么、差评在骂什么、争议点是什么。每行不超过 60 字。',
        '最后加一行「- 一句话：」，用一句不带倾向的话收尾。',
      ].join('\n'),
    },
  ]
}
