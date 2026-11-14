// 今日帖子池（daypool）：按天攒一份「今天发布过的帖子」全量池。
//
// 和 browse.mjs 的 gather 分工：
//   gather  = 每轮只看前几页、看完就丢；够当天选帖，但不保证「当天全量」
//   daypool = 把每个板块的翻页游标（last_id/cursor）跨轮存下来，
//             一轮只花有限请求，多轮把当天全量补齐；池子落盘，重启/换轮次都接着来
//
// 完整性判据（实测，别改成别的）：
//   板块流按 reply_time 倒序，且零回复帖的 reply_time 等于发布时间 time。
//   所以「扫到本页最老 reply_time < 本地当天 00:00」⇔「当天发布的帖子全扫到了」。
//   零回复帖的 reply_time 是 "0000-00-00 00:00:00"（parseKbTime 得 0），这类条目
//   统一用 time 兜底，否则一条没回复的老帖就会让翻页提前收工。
//
// 增量语义（每个板块两段）：
//   (a) 前脸刷新：从顶部（last_id=0,cursor=0）往下翻，停在「本页最老 reply_time <= frontWmMs」，
//       只收上一轮之后的新活动，通常 1 页。
//   (b) 补历史：从 backfill 存的 {lastId,cursor} 继续往下翻，直到跨过当天 0 点（done=true）。
//   第一轮 frontWmMs=0 时 (a) 没有意义，直接并进 (b)，不要重复请求。
import fs from 'node:fs'
import path from 'node:path'
import { credDir, ensureDir, harden, localDay } from './paths.mjs'
import { sectionTopics, sectionCatalog } from './forum.mjs'
import { parseKbTime, kbTimeText } from './timefmt.mjs'

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const DEFAULT_CRAWL_MAX_REQUESTS = 140
// 单板块单轮翻页硬上限：接口抽风/水位失效时不能无限往下翻
const MAX_PAGES_PER_SECTION = 400

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v)
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)

/** 与 browse.mjs 的 strip 同口径：去 HTML 标签、压空白。 */
const strip = (h) => String(h || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()

/**
 * 接口里的时间是 "YYYY-MM-DD HH:MM:SS" 字符串，不是时间戳。
 * 这里与 browse.mjs 的 timeMs 同口径：数字也认（老数据/别的接口可能给秒或毫秒）。
 */
function kbMs(v) {
  if (v == null) return 0
  const n = Number(v)
  if (Number.isFinite(n) && n > 0) return n < 1e12 ? n * 1000 : n
  return parseKbTime(v)
}

/** 一个列表项的「活动时间」：有回复算回复时间，零回复（0000-00-00）退回发布时间。 */
const activityMs = (t) => kbMs(t?.reply_time) || kbMs(t?.time)

/** 目录里的 discuss_num / today_discuss_num 是「23.8万」「1.2亿」这种字符串，Number() 会变 0。 */
function cnNum(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0
  const s = String(v ?? '').trim()
  const m = s.match(/^([\d.]+)\s*(万|亿)?/)
  if (!m) return 0
  const n = Number(m[1])
  if (!Number.isFinite(n)) return 0
  return m[2] === '亿' ? n * 1e8 : m[2] === '万' ? n * 1e4 : n
}

/** 列表项可见性：前端也是这么过滤的（status==='1' && client_status!=='4' && del_status==='0'）。 */
function visible(t) {
  if (String(t.status ?? '1') !== '1') return false
  if (String(t.client_status ?? '') === '4') return false
  if (String(t.del_status ?? '0') !== '0') return false
  return true
}

/** 标题命中静音词 = 活动/公告帖，池子里不留。 */
const muted = (title, list) => {
  const t = String(title || '')
  return (list || []).some((w) => w && t.includes(String(w)))
}

/** 本地当天 00:00 的毫秒值。坏日期返回 0（调用方自己挑兜底）。 */
function dayStartMs(date) {
  const m = DATE_RE.exec(String(date || ''))
  if (!m) return 0
  const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0).getTime()
  return Number.isFinite(t) ? t : 0
}

/** 池子落盘路径：一天一个文件，跟其他台账一样放在 credDir。 */
export function poolPath(date) {
  return path.join(credDir(), 'daypool-' + date + '.json')
}

/** 空池：结构和存盘 JSON 完全一致。 */
export function emptyPool(date) {
  const now = Date.now()
  return {
    date: String(date),
    createdAt: now,
    updatedAt: now,
    sections: {},
    posts: {},
    stats: { requests: 0, added: 0, updated: 0, skipped: 0 },
  }
}

function makeSection(id, title = '') {
  return {
    id: String(id),
    title: String(title || ''),
    frontWmMs: 0,
    backfill: { lastId: 0, cursor: 0, oldestMs: 0, done: false },
    pages: 0,
    requests: 0,
    lastRunAt: 0,
    error: '',
    // 板块目录里的「今日讨论数」（不是帖数，只当平台热度的参照，用来算 platformToday）
    today: 0,
  }
}

/** 池里的板块状态；不存在就按初始形态补一个。 */
function ensureSection(pool, id, title = '') {
  const sid = String(id)
  let sec = pool.sections[sid]
  if (!isObj(sec)) {
    sec = makeSection(sid, title)
    pool.sections[sid] = sec
    return sec
  }
  sec.id = sid
  if (title) sec.title = String(title)
  if (!isObj(sec.backfill)) sec.backfill = { lastId: 0, cursor: 0, oldestMs: 0, done: false }
  return sec
}

/**
 * 读当天池子。坏 JSON / 文件不存在一律当空池：
 * 池子是「可以重建的缓存」，读坏了不能让整轮抓取跟着崩。
 */
export function loadPool(date) {
  const day = String(date)
  let raw
  try { raw = JSON.parse(fs.readFileSync(poolPath(day), 'utf8')) } catch { return emptyPool(day) }
  if (!isObj(raw)) return emptyPool(day)

  const pool = emptyPool(day)
  // date 以「请求的那一天」为准：文件名就是日期，文件内字段被改坏也不该写到别的天去
  if (Number.isFinite(raw.createdAt)) pool.createdAt = raw.createdAt
  if (Number.isFinite(raw.updatedAt)) pool.updatedAt = raw.updatedAt

  if (isObj(raw.sections)) {
    for (const [sid, s] of Object.entries(raw.sections)) {
      if (!isObj(s)) continue
      const sec = makeSection(sid, s.title)
      sec.frontWmMs = num(s.frontWmMs)
      sec.pages = num(s.pages)
      sec.requests = num(s.requests)
      sec.lastRunAt = num(s.lastRunAt)
      sec.error = typeof s.error === 'string' ? s.error : ''
      if (isObj(s.backfill)) {
        sec.backfill.lastId = s.backfill.lastId ?? 0
        sec.backfill.cursor = s.backfill.cursor ?? 0
        sec.backfill.oldestMs = num(s.backfill.oldestMs)
        sec.backfill.done = !!s.backfill.done
      }
      sec.today = num(s.today)
      pool.sections[String(sid)] = sec
    }
  }

  if (isObj(raw.posts)) {
    for (const [id, p] of Object.entries(raw.posts)) if (isObj(p)) pool.posts[String(id)] = p
  }

  if (isObj(raw.stats)) {
    for (const k of ['requests', 'added', 'updated', 'skipped']) pool.stats[k] = num(raw.stats[k])
  }
  return pool
}

/**
 * 原子写池子：tmp + rename + harden，和 traffic.mjs 的 save 同一套。
 * 直接覆盖写一半就断电会留下坏 JSON；rename 是原子的，坏文件永远不会出现。
 */
export function savePool(pool) {
  if (!isObj(pool) || !pool.date) throw new Error('savePool 需要带 date 的池子')
  ensureDir(credDir())
  pool.updatedAt = Date.now()
  const file = poolPath(pool.date)
  const tmp = file + '.' + process.pid + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(pool, null, 2), { mode: 0o600 })
  harden(tmp)
  fs.renameSync(tmp, file)
  harden(file)
  return pool
}

/** 把配置/目录里的板块项统一成 {id,title,today}，并按 id 去重（目录里有重复 id）。 */
function normalizeSections(list) {
  const out = []
  const seen = new Set()
  for (const x of Array.isArray(list) ? list : []) {
    const id = String((typeof x === 'string' ? x : x?.id) ?? '').trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push({
      id,
      title: typeof x === 'string' ? '' : String(x?.title || ''),
      today: typeof x === 'string' ? 0 : cnNum(x?.today),
    })
  }
  return out
}

/**
 * 今天要扫哪些板块。
 * 用户配了 cfg.browse.sections 就照用（“只读选中板块”，不封顶不排序）；
 * 否则拉板块目录，按今日讨论量降序（先把热闹的扫完），并用 coverage.maxSections 封顶
 * （兼容旧字段 browse.maxSections，默认 60）；目录挂掉就退回 cfg.browse.defaultSections。
 * @returns {Promise<Array<{id:string,title:string,today:number}>>}
 */
export async function sectionsFor(cfg) {
  const B = (cfg && cfg.browse) || {}
  const C = isObj(B.coverage) ? B.coverage : {}
  const picked = normalizeSections(B.sections)
  if (picked.length) return picked

  let cat = { code: 0, sections: [] }
  try { cat = await sectionCatalog() } catch { cat = { code: -1, sections: [] } }
  if (cat.code !== 100 || !Array.isArray(cat.sections) || !cat.sections.length) {
    return normalizeSections(B.defaultSections)
  }
  const all = normalizeSections(cat.sections)
  // 今日讨论量高的先扫：一轮请求有限，先保证热闹板块当天全量
  all.sort((a, b) => b.today - a.today)
  // 全站目录 50+ 个板块，一轮扫不完；coverage.maxSections 是「今天覆盖多少个板块」的上限
  const cap = Math.max(1, num(C.maxSections) || num(B.maxSections) || 60)
  return all.slice(0, cap)
}

/** 把一个列表项归一化成池里的帖子。计数字段一律走 num（接口给的是字符串/数字混着来）。 */
function normalizePost(t, sec, nowMs) {
  const full = strip(t.content)
  return {
    topicId: String(t.id),
    title: strip(t.title),
    content: full.slice(0, 600),
    sectionId: String(sec.id),
    sectionTitle: sec.title || strip(t.c_subject || t.p_subject || ''),
    uid: String(t.uid ?? ''),
    nickname: t.user?.nickname || String(t.uid ?? ''),
    replyCount: num(t.reply_count),
    commentCount: num(t.comment_count),
    upVote: num(t.up_vote),
    views: num(t.views),
    // 这几个是数字 -1/1：必须 Number(x)>0 判真，!!x 会把 -1 也当真（踩过）
    isEssence: num(t.is_essence) > 0,
    isTop: num(t.is_top) > 0,
    isOfficial: num(t.is_official) > 0,
    isContribution: num(t.is_article_contribution) > 0,
    timeMs: kbMs(t.time),
    editMs: kbMs(t.edit_time),
    // 零回复帖这里是 0（接口给 0000-00-00）；要「最后活动时间」的调用方自己用 timeMs 兜底
    replyMs: kbMs(t.reply_time),
    timeStr: t.time_str || kbTimeText(t.time),
    contentLen: full.length,
    firstSeenAt: nowMs,
    lastSeenAt: nowMs,
  }
}

/**
 * 抓一轮：把 planned 里的板块按「前脸刷新 + 补历史」推进，最多花 crawlMaxRequests 个读请求。
 * 预算到顶立刻停，没扫完的板块把游标留在 backfill 里，下一轮接着来。
 * 单板块失败只记 error，不影响别的板块，也不让整轮抛错。
 * 完结时自己落盘（要 dry-run 的调用方自己别用它、或写完再覆盖）。
 *
 * 计数口径：pool.stats.{requests,added,updated,skipped} 是「当天累计」——
 * 每轮都从磁盘上的池子接着加（coverageOf 读的就是这个累计值），返回值里另外带
 * round.{requests,added,updated,skipped} 表示本轮增量。
 * @returns {Promise<{pool:object, stats:object}>}
 */
export async function crawlDay(cfg, { date, log = () => {}, now = new Date() } = {}) {
  const B = (cfg && cfg.browse) || {}
  const nowDate = now instanceof Date ? now : new Date(now)
  const nowMs = Number.isFinite(nowDate.getTime()) ? nowDate.getTime() : Date.now()
  const day = DATE_RE.test(String(date || '')) ? String(date) : localDay(nowDate)
  // 当天 00:00 用本地时区算：平台给的是北京时间，日报也是按本地日切
  const cutoff = dayStartMs(day) || dayStartMs(localDay(nowDate))
  const planned = await sectionsFor(cfg)
  const pool = loadPool(day)
  // 预算在 cfg.browse.coverage.crawlMaxRequests（默认 140）；旧配置写在顶层 browse.crawlMaxRequests 的也认
  const C = isObj(B.coverage) ? B.coverage : {}
  const maxRequests = Math.max(1, num(C.crawlMaxRequests) || num(B.crawlMaxRequests) || DEFAULT_CRAWL_MAX_REQUESTS)
  const budget = { used: 0, max: maxRequests }
  const round = { requests: 0, added: 0, updated: 0, skipped: 0 }
  const skipTop = B.skipTop !== false
  const muteTitles = Array.isArray(B.muteTitles) ? B.muteTitles : []

  // 先把计划里的板块全部登记进池：这一轮预算不够没轮到它们时，
  // 覆盖率也要如实体现为「未完成」，不能假装它们不在计划里。
  for (const item of planned) {
    const sec = ensureSection(pool, item.id, item.title)
    if (num(item.today) > 0) sec.today = num(item.today)
  }

  const atTop = (pos) => String(pos?.lastId ?? '0') === '0' && String(pos?.cursor ?? '0') === '0'
  let stopAll = false

  for (const item of planned) {
    if (stopAll) break
    if (budget.used >= budget.max) break
    const sec = pool.sections[String(item.id)]
    sec.lastRunAt = nowMs
    sec.error = ''
    let pagesThisRound = 0
    let accepted = 0

    // 把一页里的帖子并进池子。同 topicId 只留一份：计数/标题用新数据覆盖，firstSeenAt 保留。
    const ingest = (list) => {
      for (const t of list) {
        if (!visible(t)) { round.skipped++; pool.stats.skipped++; continue }
        if (skipTop && num(t.is_top) > 0) { round.skipped++; pool.stats.skipped++; continue }
        if (muted(t.title, muteTitles)) { round.skipped++; pool.stats.skipped++; continue }
        const post = normalizePost(t, sec, nowMs)
        const old = pool.posts[post.topicId]
        if (old) {
          pool.posts[post.topicId] = {
            ...old,
            ...post,
            sectionTitle: post.sectionTitle || old.sectionTitle || '',
            firstSeenAt: old.firstSeenAt || post.firstSeenAt,
          }
          round.updated++
          pool.stats.updated++
        } else {
          pool.posts[post.topicId] = post
          round.added++
          pool.stats.added++
        }
        accepted++
      }
    }

    /**
     * 从 start 位置往下翻页，吞掉的每页都 ingest 一遍。
     * 停止条件：跨过当天 0 点 / 跨过 stopWm（前脸水位）/ 本页为空 / 没有下一页游标 /
     *           预算用尽 / 单板块页数上限。
     * @returns {{end:string, pos:{lastId:any,cursor:any}, pages:number, topMax:number, error?:{msg:string,fatal:boolean}}}
     */
    const runPages = async (start, stopWm = 0) => {
      let pos = { lastId: start.lastId ?? 0, cursor: start.cursor ?? 0 }
      let pages = 0
      let topMax = 0
      while (true) {
        if (budget.used >= budget.max) return { end: 'budget', pos, pages, topMax }
        if (pagesThisRound >= MAX_PAGES_PER_SECTION) return { end: 'cap', pos, pages, topMax }
        // 先记账再发请求：被限流层拦下的尝试也占掉一次「预算」，不然到顶判不出来
        budget.used++
        round.requests++
        pool.stats.requests++
        sec.requests++
        let j
        try {
          j = await sectionTopics(sec.id, pos)
        } catch (e) {
          const msg = e && e.message ? e.message : String(e)
          // 读预算/风控/暂停是限流层的全局结论：这一轮别再拿下一个板块去撞墙
          return { end: 'error', error: { msg, fatal: /预算|风控|暂停/.test(msg) }, pos, pages, topMax }
        }
        if (!j || j.code !== 100) {
          const msg = 'code=' + (j ? j.code : '?') + (j && j.msg ? ' ' + j.msg : '')
          return { end: 'error', error: { msg, fatal: false }, pos, pages, topMax }
        }
        const list = Array.isArray(j.result?.data) ? j.result.data : []
        pages++
        pagesThisRound++
        sec.pages++
        // 只有第一页的「最新活动」能当水位（后面页面都更老）
        if (pages === 1) for (const t of list) topMax = Math.max(topMax, activityMs(t))
        ingest(list)

        // 本页最老的活动时间：两个时间都解析不出来的条目直接忽略（不能把 0 当「很老」）
        let oldest = 0
        for (const t of list) {
          const a = activityMs(t)
          if (a > 0 && (!oldest || a < oldest)) oldest = a
        }
        if (oldest > 0) {
          const prev = num(sec.backfill.oldestMs)
          if (!prev || oldest < prev) sec.backfill.oldestMs = oldest
        }
        if (!list.length) {
          // 空页 = 这个板块的流翻到底了，当天内容自然也都收齐了
          sec.backfill.done = true
          return { end: 'empty', pos, pages, topMax }
        }
        if (oldest > 0 && oldest < cutoff) { sec.backfill.done = true; return { end: 'cutoff', pos, pages, topMax } }
        if (stopWm > 0 && oldest > 0 && oldest <= stopWm) return { end: 'wm', pos, pages, topMax }
        const nextLast = j.result?.last_id
        const nextCur = j.result?.cursor
        if (nextLast == null || String(nextLast) === String(pos.lastId)) {
          // 没有下一页游标 = 这个板块的流到头了，当天内容自然也扫全了
          sec.backfill.done = true
          return { end: 'end', pos, pages, topMax }
        }
        pos = { lastId: nextLast, cursor: nextCur }
      }
    }

    if (!num(sec.frontWmMs) && atTop(sec.backfill)) {
      // 第一轮：前脸与补历史合并，从顶部一路翻到当天 0 点（或撞上预算/页数上限）
      const r = await runPages(sec.backfill)
      sec.backfill.lastId = r.pos.lastId
      sec.backfill.cursor = r.pos.cursor
      if (r.error && !sec.error) sec.error = r.error.msg
      if (r.error && r.error.fatal) stopAll = true
      // 这一段是从顶部连续扫下来的，第一页的最新活动就是前脸水位
      if (r.pages > 0) sec.frontWmMs = r.topMax || cutoff
      if (!sec.frontWmMs && sec.backfill.done) sec.frontWmMs = cutoff
    } else {
      // (a) 前脸刷新
      if (!num(sec.frontWmMs)) {
        // 老池迁移：没有水位但有补历史进度 → 拿补历史前沿当水位，只扫它上面的新活动
        sec.frontWmMs = num(sec.backfill.oldestMs) || cutoff
      }
      let frontFailed = false
      const front = await runPages({ lastId: 0, cursor: 0 }, sec.frontWmMs)
      if (front.error) {
        frontFailed = true
        if (!sec.error) sec.error = front.error.msg
        if (front.error.fatal) stopAll = true
      } else if (front.end === 'wm' || front.end === 'cutoff' || front.end === 'empty' || front.end === 'end' || front.end === 'cap') {
        // 从顶部连续扫到这里，可以推进水位。'cap' 也认：没扫到的部分在补历史游标之下，
        // 由 (b) 继续接（不认的话每轮都重扫 400 页，水位永远不动）。
        // 只有 'budget' 不推进 —— 省下来的额度留给补历史更划算。
        if (front.topMax > sec.frontWmMs) sec.frontWmMs = front.topMax
      }
      // (b) 补历史：前脸失败/预算用尽就留到下一轮
      if (!frontFailed && !stopAll && !sec.backfill.done && budget.used < budget.max) {
        const back = await runPages(sec.backfill, 0)
        sec.backfill.lastId = back.pos.lastId
        sec.backfill.cursor = back.pos.cursor
        if (back.error && !sec.error) sec.error = back.error.msg
        if (back.error && back.error.fatal) stopAll = true
      }
    }

    if (sec.error) log('[daypool] ' + (sec.title || sec.id) + ' 失败：' + sec.error)
    else log('[daypool] ' + (sec.title || sec.id) + ' 扫到 ' + accepted + ' 帖' + (sec.backfill.done ? '（已到当天 0 点）' : ''))
  }

  savePool(pool)
  const cov = coverageOf(pool)
  const done = Object.values(pool.sections).filter((s) => s.backfill && s.backfill.done).length
  log('[daypool] 本轮 ' + round.requests + ' 请求，' + done + '/' + cov.sections + ' 板块已扫到当天 0 点')
  return {
    pool,
    stats: { ...pool.stats, sections: cov.sections, doneSections: done, reachedCutoff: cov.reachedCutoff, round },
  }
}

/**
 * 覆盖率快照：给日志/日报判断「今天的池子够不够全」。
 *
 * oldestCoveredMs 的口径：各板块里「最浅」的那个前沿（done 的板块算作已经覆盖到当天 0 点）。
 * 也就是说「reply_time > oldestCoveredMs 的帖子一定都在池子里」—— 取 max 而不是 min，
 * 因为一个板块只扫到半路，整池的保证就只到它那里。全部 done 时它就等于当天 00:00。
 *
 * platformToday 是各板块目录里「今日讨论数」之和（平台口径的热度参照，不是帖数）；
 * 目录拿不到（例如手配了 sections）时是 0。
 *
 * bySection 是每个板块的池内帖数与「今天发布」的帖数（按帖子 timeMs 和本地当天 00:00 比，
 * 不是按 reply_time）：日报的「今日板块分布」要拿它当代码算出来的证据，不经过模型。
 */
export function coverageOf(pool) {
  const cut = dayStartMs(pool?.date)
  const sections = Object.values(pool?.sections || {}).filter(isObj)
  const gaps = []
  let oldest = 0
  for (const sec of sections) {
    const done = !!(sec.backfill && sec.backfill.done)
    if (!done || sec.error) {
      gaps.push({ id: String(sec.id), title: sec.title || '', reason: sec.error || 'backfill' })
    }
    const frontier = done ? cut : num(sec.backfill?.oldestMs)
    if (frontier > oldest) oldest = frontier
  }

  let postsToday = 0
  const counts = new Map()
  for (const p of Object.values(pool?.posts || {})) {
    const today = !!(cut && num(p?.timeMs) >= cut)
    if (today) postsToday++
    const sid = String(p?.sectionId ?? '')
    if (!sid) continue
    const c = counts.get(sid) || { posts: 0, todayPosts: 0 }
    c.posts++
    if (today) c.todayPosts++
    counts.set(sid, c)
  }
  const bySection = sections.map((sec) => {
    const c = counts.get(String(sec.id)) || { posts: 0, todayPosts: 0 }
    return { id: String(sec.id), title: sec.title || '', posts: c.posts, todayPosts: c.todayPosts }
  })

  return {
    sections: sections.length,
    reachedCutoff: sections.length > 0 && sections.every((s) => !!(s.backfill && s.backfill.done)),
    postsToday,
    oldestCoveredMs: oldest,
    requests: num(pool?.stats?.requests),
    gaps,
    platformToday: sections.reduce((sum, s) => sum + num(s.today), 0),
    bySection,
  }
}
