// 打分与选帖层：同一池子里的帖子用同一套规则打分，各维度先转池内分位数再加权。
//
// 为什么不再用 browse.mjs 里的线性叠加（回复×3 + 赞×2 + 浏览×0.01 + 精华 8 + 置顶 2 + 新鲜度）：
//   1) 绝对量纲被大帖碾压：一条 1148 回复的帖子会让当天其它 374 条全变成噪声，
//      可「今天还有什么值得看」要的是相对排序，不是绝对总量；
//   2) 只有量、没有质：回复多不等于讨论热（可能是抽奖跟帖），浏览多不等于内容好；
//      线性叠加里也没有「内容本身值不值得读」这一维；
//   3) 阈值跨天不可比：昨天的 500 分和今天的 500 分不是一个意思，minScore 固定不下来。
// 现在四个维度各自先在「本池内」化成 0..1 的分位数（pctRank），再加权成 0–100：
//   · 量纲统一 —— 分值永远表示「在本池里排这个位置」，换一天/换一批帖子阈值含义不变；
//   · 长尾被压住 —— 375 条里 64% 零回复，midrank 会把一大片零回复并列在低分位，
//     长尾噪声不会被绝对数值放大；
//   · 可解释 —— 每帖都能报出四维分位，为什么入选一目了然（explainPick）。
//
// 确定性：除了 now 与输入数值、固定常数，这里没有任何随机数；同分按 topicId 字符串升序，
// 同一输入两次跑出来的结果逐字段相同。

const HOUR = 3600000

/** 统一转有限数字；字符串/空值/NaN 一律当 0（平台接口字段经常缺，Number() 直接使用会产生 NaN 传播）。 */
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)
/** 布尔字段在列表接口里有 true/false 也有 0/1，两种都认。 */
const flag = (v) => v === true || num(v) > 0
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)

/** now 允许 Date / 毫秒数；非法值退回当前时间（只有这一处依赖系统时钟，且可被调用方覆盖）。 */
const toNow = (v) => {
  const t = v instanceof Date ? v.getTime() : Number(v)
  return Number.isFinite(t) && t > 0 ? t : Date.now()
}

/**
 * 正文长度：gather() 产出的帖子没有 contentLen（只有截断到 600 字的 content），
 * probe 数据里是现成的 contentLen。两边都认：优先现成字段，缺了就用正文长度兜底。
 */
function contentLenOf(p) {
  const n = num(p?.contentLen)
  if (n > 0) return n
  return String(p?.content || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().length
}

/** 默认权重：讨论度最重（日报的价值是「今天大家在聊什么」），新鲜度只是加分项。 */
export const DEFAULT_WEIGHTS = Object.freeze({ heat: 0.30, discussion: 0.35, quality: 0.22, freshness: 0.13 })
export const DIMENSIONS = Object.freeze(['heat', 'discussion', 'quality', 'freshness'])
const DIM_LABELS = { heat: '热度', discussion: '讨论度', quality: '质量', freshness: '新鲜度' }

/** 权重按和归一化；缺省字段用默认值（显式传 0 才是「不要这一维」）。 */
function normalizeWeights(weights) {
  const src = weights && typeof weights === 'object' ? weights : {}
  const w = {}
  let sum = 0
  for (const d of DIMENSIONS) {
    const v = Number(src[d])
    w[d] = Number.isFinite(v) && v >= 0 ? v : DEFAULT_WEIGHTS[d]
    sum += w[d]
  }
  // 四个都传 0 会除零；这种「什么都不要」的输入没有意义，退回默认权重。
  if (!(sum > 0)) return { ...DEFAULT_WEIGHTS }
  for (const d of DIMENSIONS) w[d] /= sum
  return w
}

/**
 * 四个维度的原始分（非负、未归一化）。常数都取「让当天分布铺得开」的粗粒度值，
 * 量级不重要 —— 后面会转成池内分位数，这里只决定帖与帖之间的相对次序。
 *
 * @returns {{heat:number, discussion:number, quality:number, freshness:number}}
 */
export function rawDims(post, { now = Date.now() } = {}) {
  const p = post || {}
  const nowMs = toNow(now)
  const timeMs = num(p.timeMs)
  const replyMs = num(p.replyMs)
  const views = num(p.views)
  const upVote = num(p.upVote)
  const replyCount = num(p.replyCount)
  const commentCount = num(p.commentCount)
  const contentLen = contentLenOf(p)

  // 帖子年龄：下限 0.1h，避免「刚发帖 1 秒」在 0.5**(age/12) 里拿到 >1 的新鲜度，
  // 也让极端时间戳（未来/缺失）不会把 spanH 算成 0 或负数。
  const ageH = Math.max(0.1, (nowMs - timeMs) / HOUR)
  // 活跃时长：发帖 → 最近一次回复。没人回（replyMs 缺）就按自身算，下限 1h：
  // 「刚发 1 分钟就 1 个回复」不该被当成 60 倍讨论速度，1h 是个保守的观测窗。
  const spanH = Math.max(1, ((replyMs || timeMs) - timeMs) / HOUR)

  // 热度：浏览是「路过」（权重 0.6），点赞要动手（权重 1.0）；log1p 压住长尾绝对值，
  // 2909 赞 ≈ 7.98、7935 浏览 ≈ 8.99，同级量纲，不会让一个大帖把其它维度淹掉。
  const heat = 0.6 * Math.log1p(views) + 1.0 * Math.log1p(upVote)

  // 讨论度：主楼回复量最重（1.0），楼中楼次之（0.5）；
  // 第三项是「讨论速度」—— 按 6 小时折算的回复率，让「2 小时 30 回复」压过「一周 30 回复」；
  // 最后 0.5 是「2 小时内还被回复过」的在用信号：今天还在被顶的帖，才是今天还在被讨论的。
  const replyRate6h = (replyCount / spanH) * 6
  const discussion =
    1.0 * Math.log1p(replyCount) +
    0.5 * Math.log1p(commentCount) +
    0.6 * Math.log1p(replyRate6h) +
    (replyMs > 0 && nowMs - replyMs < 2 * HOUR ? 0.5 : 0)

  // 质量：正文信息量（80 字算 1 个单位，长文有额外分量，但 log1p 不让长度直接决定一切）；
  // 精华 +0.8、投稿长文 +0.6、官方 +0.25 是人工/平台的信号，权重低于「正文 + 认可度」；
  // 认可度 = 赞 / (浏览/10)，十次浏览一个赞算满分，防「只有浏览量没有点赞的水帖」。
  const likeRatio = Math.min(1, upVote / Math.max(1, views / 10))
  const quality =
    0.45 * Math.log1p(contentLen / 80) +
    0.8 * (flag(p.isEssence) ? 1 : 0) +
    0.6 * (flag(p.isContribution) ? 1 : 0) +
    0.25 * (flag(p.isOfficial) ? 1 : 0) +
    0.5 * likeRatio

  // 新鲜度 = 「这帖现在还在动吗」：最后活动（最后回复，没人回就用发布时间）距今，6 小时半衰。
  // 不用「发布时间」算，是因为日报是当天全量池：早上发的帖攒了 1000 条回复，比十分钟前发的
  // 0 回复帖更代表「今天在聊什么」；用发布时间当新鲜度会把它一脚踹出日报（实测踩过这个坑）。
  const lastActMs = Math.max(timeMs, replyMs || 0)
  const idleH = Math.max(0.1, (nowMs - lastActMs) / HOUR)
  const freshness = 0.5 ** (idleH / 6)

  return { heat, discussion, quality, freshness }
}

/**
 * 池内分位数（0..1）：
 *   n >= 8：midrank —— (#{v<x} + 0.5*#{v==x}) / n，并列值取并列区间中点，长尾并列不会被算成极端值；
 *   n < 8 ：min-max —— 小样本里 midrank 区分度太差（4 条时最好也只有 0.875），退回线性拉伸；
 *   n == 1：一律 0.5（没有池子就没有相对位置）；n == 0：返回空数组。
 * 越界 clamp 到 0..1；全同值时给 0.5，保证永远不出现 NaN。
 */
export function pctRank(values) {
  const vals = (Array.isArray(values) ? values : []).map(num)
  const n = vals.length
  if (n === 0) return []
  if (n === 1) return [0.5]

  if (n < 8) {
    const min = Math.min(...vals)
    const max = Math.max(...vals)
    if (!(max > min)) return vals.map(() => 0.5)
    return vals.map((v) => clamp01((v - min) / (max - min)))
  }

  const sorted = vals.slice().sort((a, b) => a - b)
  const rankOf = new Map()
  let i = 0
  while (i < n) {
    let j = i + 1
    while (j < n && sorted[j] === sorted[i]) j++
    rankOf.set(sorted[i], clamp01((i + 0.5 * (j - i)) / n))
    i = j
  }
  return vals.map((v) => rankOf.get(v))
}

/** 同分排序：score 降序 → topicId 字符串升序（probe 数据用 id，两者都认），保证确定性。 */
const keyOf = (p) => String(p?.topicId ?? p?.id ?? '')
const compareScore = (a, b) => b.score - a.score || (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0)

/**
 * 给整个池子打分：每维先转池内分位数，再按归一化权重加权成 0–100（一位小数）。
 * 返回按 score 降序（同分 topicId 升序）排好、rank 从 1 开始的列表；不修改入参。
 *
 * @returns {Array<object>} [{...post, dims:{heat,discussion,quality,freshness}, rawDims:{...}, score, rank}]
 */
export function scorePool(posts, { now = Date.now(), weights } = {}) {
  const list = Array.isArray(posts) ? posts : []
  if (!list.length) return []
  const nowMs = toNow(now)
  const w = normalizeWeights(weights)

  const raws = list.map((p) => rawDims(p, { now: nowMs }))
  const pcts = DIMENSIONS.map((d) => pctRank(raws.map((r) => r[d])))

  const out = list.map((p, i) => {
    const dims = {}
    const raw = {}
    let sum = 0
    DIMENSIONS.forEach((d, k) => {
      dims[d] = pcts[k][i]
      raw[d] = raws[i][d]
      sum += w[d] * dims[d]
    })
    // 四舍五入到一位小数：100 * Σw·pct
    return { ...(p || {}), dims, rawDims: raw, score: Math.round(sum * 1000) / 10, rank: 0 }
  })
  out.sort(compareScore)
  for (let i = 0; i < out.length; i++) out[i].rank = i + 1
  return out
}

/**
 * 一句话解释「为什么入选」，给日报兜底文案用。只由帖子自己的数字拼出来，
 * 不出现 undefined / NaN（缺字段按 0，缺 dims 就不报分位）。
 */
export function explainPick(pick, { total = 0 } = {}) {
  const p = pick || {}
  const head = `回复 ${Math.round(num(p.replyCount))} · 赞 ${Math.round(num(p.upVote))} · 浏览 ${Math.round(num(p.views))}`
  const tags = []
  if (flag(p.isEssence)) tags.push('精华')
  if (flag(p.isContribution)) tags.push('长文投稿')
  if (flag(p.isOfficial)) tags.push('官方')
  const tagTxt = tags.length ? `（${tags.join('/')}）` : ''

  const dims = p.dims && typeof p.dims === 'object' ? p.dims : null
  const topPct = (d) => {
    const v = Number(d)
    if (!Number.isFinite(v)) return null
    return Math.max(1, Math.min(100, Math.round((1 - clamp01(v)) * 100)))
  }
  const bits = []
  if (dims) {
    const disc = topPct(dims.discussion)
    if (disc != null) bits.push(`讨论度今日前 ${disc}%`)
    for (const d of ['heat', 'quality', 'freshness']) {
      const t = topPct(dims[d])
      if (t != null) bits.push(`${DIM_LABELS[d]}前 ${t}%`)
    }
  }
  const pool = num(total) > 0 ? `（今日 ${Math.round(num(total))} 帖池内）` : ''
  if (!bits.length) return `${head}${tagTxt}，按互动量入选`
  const [first, ...rest] = bits
  return `${head}${tagTxt}，${first}${rest.length ? ' · ' + rest.join(' · ') : ''}${pool}`
}

/* ── 选帖 ─────────────────────────────────────────────────────────────── */

const normTitle = (t) => String(t || '').replace(/\s+/g, '').trim()

/**
 * 从打分后的池子里挑日报用帖（顺序执行，结果可解释）：
 *   1. 先排除：自己发的 / 自引（self）、标题命中静音词（muted）、置顶（top）、
 *      零信号短帖（lowSignal）、外部 recentTitles 里最近 24h 同作者同标题（dupeTitle）、
 *      低于 minScore（belowMin）；
 *   1.5 池内同作者同标题去重：剩下的候选按 score 降序扫一遍，同一个「规范化标题 + uid」
 *      只留分最高的一条，后出现的那条标记 excludedReason='dupeTitle' 并剔除
 *      （同一个人一天连发几条一样标题的帖子，日报只写一条）；
 *   1.6 保送位：当天 replyCount 最大的那 1 帖直接入选（reserveTopDiscussion）——
 *      「今天讨论最多」是日报必须回答的问题，不能因为综合分里活跃度权重吃满就被挤掉；它照样占配额；
 *   2. 剩下的按 score 降序逐个接受，直到 pick 满：受 perSectionMax / perAuthorMax 约束；
 *      官方/编辑部账号（isOfficial）单独用 perAuthorMaxOfficial（默认 3）计作者配额，
 *      另有官方总量上限 officialMax（默认 3）—— 官方号一天会发好几条高质量帖，单作者上限挡不住
 *      「多个官方号合计占满日报」（实测 8 帖里 6 条官方），所以总量再封一道；
 *   3. 配额没选满 pick 时，先放宽板块配额（作者配额保留，官方号仍用官方上限），仍不满再放宽作者配额；
 *      无论怎么放宽都不放宽零信号下限（第 1 步已永久排除），也不放宽池内标题去重；
 *   4. 任何情况下不超过 pick 条。
 *
 * @param {Array} scored scorePool() 的输出（本函数会自己再排一次序，不依赖入参顺序）
 * @returns {{picks:Array, ranked:Array, excluded:{self:Array,lowSignal:Array,muted:Array,top:Array,dupeTitle:Array,belowMin:Array}}}
 */
export function selectPicks(scored, {
  pick = 8,
  perSectionMax = 2,
  perAuthorMax = 1,
  perAuthorMaxOfficial = 3,
  officialMax = 3,
  reserveTopDiscussion = true,
  minScore = 0,
  selfUid = '',
  selfName = '',
  mutedTitles = [],
  skipTop = true,
  recentTitles = [],
  now = 0,
} = {}) {
  const list = (Array.isArray(scored) ? scored : []).slice().sort(compareScore)
  const total = list.length
  const maxPick = Math.max(0, Math.floor(num(pick)))
  const floor = num(minScore)

  // recentTitles 的「最近 24h」以池内最新帖时间为参考（本函数不接外部时钟，才能复现）；
  // 调用方显式传 now 时以它为准。
  const refNow = num(now) > 0 ? num(now) : list.reduce((m, x) => Math.max(m, num(x?.timeMs)), 0)

  const selfUidStr = String(selfUid || '').trim()
  const selfNameStr = String(selfName || '').trim()
  const isSelf = (p) =>
    (selfUidStr !== '' && String(p.uid || '').trim() === selfUidStr) ||
    (selfNameStr !== '' && String(p.nickname || '').trim() === selfNameStr)

  const mutes = (Array.isArray(mutedTitles) ? mutedTitles : []).map((w) => String(w || '').trim()).filter(Boolean)
  const isMuted = (p) => {
    const t = String(p.title || '')
    return mutes.some((w) => t.includes(w))
  }

  const recentSet = new Set()
  for (const r of Array.isArray(recentTitles) ? recentTitles : []) {
    if (!r || typeof r !== 'object') continue
    const uid = String(r.uid || '').trim()
    if (!uid) continue
    const t = num(r.timeMs)
    if (t > 0 && refNow > 0 && refNow - t > 24 * HOUR) continue // 超过 24h 不算「最近」
    recentSet.add(normTitle(r.title) + '\u0000' + uid)
  }
  const isDupeTitle = (p) => {
    const uid = String(p.uid || '').trim()
    return uid !== '' && recentSet.has(normTitle(p.title) + '\u0000' + uid)
  }

  // 零信号：没人回、没人赞、没几个人看、正文也短 —— 这种帖哪怕新鲜度满分也不进日报。
  // 阈值故意定得宽：只要有一项越线（比如浏览过 30 或正文超过 50 字）就还是候选。
  const isLowSignal = (p) =>
    num(p.replyCount) === 0 && num(p.upVote) === 0 && num(p.views) < 30 && contentLenOf(p) < 50

  const ranked = []
  const eligible = []
  const excluded = { self: [], lowSignal: [], muted: [], top: [], dupeTitle: [], belowMin: [] }
  for (const s of list) {
    const p = s || {}
    let reason = ''
    if (isSelf(p)) reason = 'self'
    else if (isMuted(p)) reason = 'muted'
    else if (skipTop && flag(p.isTop)) reason = 'top'
    else if (isLowSignal(p)) reason = 'lowSignal'
    else if (isDupeTitle(p)) reason = 'dupeTitle'
    else if (num(p.score) < floor) reason = 'belowMin'
    const row = reason ? { ...p, excludedReason: reason } : { ...p }
    ranked.push(row)
    if (reason) excluded[reason].push(row)
    else eligible.push(row)
  }

  // 池内同作者同标题去重：eligible 已经按 score 降序（list 排过序），所以先遇到的就是分高的。
  // 空标题 / 空 uid 不参与去重：无标题的投票帖、匿名帖不算「重复发帖」。
  // 去重对象和 ranked 里是同一个引用，标记 excludedReason 后面板/调试能看到为什么被剔掉。
  const seenPoolTitle = new Set()
  const deduped = []
  for (const p of eligible) {
    const uid = String(p.uid || '').trim()
    const title = normTitle(p.title)
    if (uid === '' || title === '') { deduped.push(p); continue }
    const k = title + '\u0000' + uid
    if (seenPoolTitle.has(k)) {
      p.excludedReason = 'dupeTitle'
      excluded.dupeTitle.push(p)
      continue
    }
    seenPoolTitle.add(k)
    deduped.push(p)
  }

  const capOf = (v, dflt) => (v === Infinity ? Infinity : Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.floor(Number(v)) : dflt)
  const secCap = capOf(perSectionMax, 2)
  const authCap = capOf(perAuthorMax, 1)
  const officialCap = capOf(perAuthorMaxOfficial, 3)
  // 官方内容总量上限：官方/编辑部一天能发很多条高质量帖，单作者上限挡不住（多个官方号合计），
  // 不封顶的话日报会变成编辑部专栏（实测 8 帖里 6 条官方）。默认 3。
  const officialTotalCap = capOf(officialMax, 3)
  const postKey = (p) => String(p.topicId ?? p.id ?? '')
  const secKey = (p) => String(p.sectionId ?? p.sectionTitle ?? '').trim()
  const authKey = (p) => String(p.uid ?? p.nickname ?? '').trim()

  const picked = []
  const usedIds = new Set()
  const secUsed = new Map()
  const authUsed = new Map()
  let officialUsed = 0

  // 保送：当天讨论最多的那帖（replyCount 最大）永远在日报里。
  // 理由：四维加权是「综合分」，会让「早上发的、一天攒了上千回复」的帖子被「十分钟前发的新帖」
  // 挤掉；而「今天讨论最多」本身就是日报最该回答的问题之一。只保送 1 帖，且它照样占配额。
  if (reserveTopDiscussion && maxPick > 0) {
    let top = null
    for (const p of deduped) if (!top || num(p.replyCount) > num(top.replyCount)) top = p
    if (top) {
      picked.push(top)
      usedIds.add(postKey(top))
      const sk = secKey(top)
      const ak = authKey(top)
      if (sk !== '') secUsed.set(sk, (secUsed.get(sk) || 0) + 1)
      if (ak !== '') authUsed.set(ak, (authUsed.get(ak) || 0) + 1)
      if (flag(top.isOfficial)) officialUsed++
    }
  }

  // 三轮配额：默认配额 → 放宽板块（作者/官方总量保留）→ 全部放宽。
  // 「零信号」在第 1 步就出局了，永远不会被放宽放回来；池内同标题去重也不放宽。
  // 作者配额按帖子取：官方号用 officialCap，普通作者用 authCap；官方总量另有 officialTotalCap。
  const rounds = [
    { sec: secCap, relaxAuth: false, official: officialTotalCap },
    { sec: Infinity, relaxAuth: false, official: officialTotalCap },
    { sec: Infinity, relaxAuth: true, official: Infinity },
  ]
  for (const cap of rounds) {
    if (picked.length >= maxPick) break
    for (const p of deduped) {
      if (picked.length >= maxPick) break
      const id = postKey(p)
      if (usedIds.has(id)) continue
      const sk = secKey(p)
      const ak = authKey(p)
      const isOff = flag(p.isOfficial)
      const aCap = cap.relaxAuth ? Infinity : isOff ? officialCap : authCap
      if (cap.sec !== Infinity && sk !== '' && (secUsed.get(sk) || 0) >= cap.sec) continue
      if (aCap !== Infinity && ak !== '' && (authUsed.get(ak) || 0) >= aCap) continue
      if (isOff && cap.official !== Infinity && officialUsed >= cap.official) continue
      picked.push(p)
      usedIds.add(id)
      if (sk !== '') secUsed.set(sk, (secUsed.get(sk) || 0) + 1)
      if (ak !== '') authUsed.set(ak, (authUsed.get(ak) || 0) + 1)
      if (isOff) officialUsed++
    }
  }

  // 展示顺序按分数降序：保送帖可能名次很靠后（它是「讨论最多」不是「综合最高」），
  // 排在它该在的位置，别因为保送就顶到第一位。
  const picks = picked.slice().sort(compareScore).map((p) => ({ ...p, why: explainPick(p, { total }) }))
  return { picks, ranked, excluded }
}
