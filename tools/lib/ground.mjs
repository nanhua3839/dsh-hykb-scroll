// 证据层（ground）：把日报里的「事实」变成代码拥有的、可校验的东西。
//
// 日报分两半：
//   · 硬事实（标题 / 链接 / 板块 / 作者 / 统计 / 覆盖情况）——从 picks / coverage 里取，
//     由 renderReport 原样渲染；模型写的一概不采用。
//   · 软文字（一段今日概览 + 每帖一句点评）——只让模型写这块，且必须过 validateProse：
//     链接只能等于证据里的链接；≥2 位数字必须出现在证据的数字集合里；≥6 字引文必须是
//     语料子串；【n】必须指向今天的帖子。任何一句不合规就整句丢掉；整段没过就退回
//     fallbackWhy() 的确定性文案。
//
// mode='fallback' 时整份日报不含任何模型文字，但结构完整、可读、能直接落盘或发帖。
// 报告里任何一个字段都不允许出现 undefined / NaN / null。
import { threadUrl, tidy } from './ai.mjs'

/* ───────────── 常量 ───────────── */

const MAX_QUOTES = 3
const MAX_OVERVIEW = 5
const MAX_BY_SECTION = 8
const FALLBACK_OVERVIEW = '本轮没有可用的综述（AI 未参与，或模型写的内容没通过事实校验），下面直接列帖。'
const RUBRIC = '热度/讨论度/质量/活跃度四维打分：每维先在本日全部候选帖里转成 0–100 的分位数，再按 30/35/22/13 加权'
const RUBRIC_NOTE = '分数=当天同批帖子的相对位置，不是绝对量纲，跨天不可直接比；官方内容总量、单作者、单板块另设上限，保证日报不被单一来源占满'

/* ───────────── 小工具：全部防御式，绝不把 undefined / NaN 带进输出 ───────────── */

const pad2 = (n) => String(n).padStart(2, '0')

/** 有限数字 → number，否则 null。注意 null / 空串 / 布尔不能变成 0（那是「缺失」，不是「零」）。 */
function fin(v) {
  if (v == null || v === '' || typeof v === 'boolean') return null
  if (typeof v === 'string' && !v.trim()) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** 计数类字段：取整；空串 / null / 非数字 → null。 */
function intOrNull(v) {
  const n = fin(v)
  return n == null ? null : Math.round(n)
}

/** 第一个能取到整数的值（用来兜字段缺失，比如 replyCount 和 stats.reply 二选一）。 */
function firstInt(...vals) {
  for (const v of vals) {
    const n = intOrNull(v)
    if (n != null) return n
  }
  return null
}

/** 分数显示：整数原样，小数留一位。 */
function trimNum(n) {
  const v = fin(n)
  if (v == null) return '0'
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 10) / 10)
}

/** 文本字段：只认字符串，统一过 tidy（去标签 / 折叠重复 / 限长）。 */
function text(v, max = 120) {
  if (v == null) return ''
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : ''
  if (typeof v !== 'string') return ''
  return tidy(v, max)
}

/** 日期归一成 YYYY-MM-DD（本地日；只给 YYYY-MM-DD 时不再过 Date，避免时区挪一天）。 */
function fmtDay(v) {
  const local = (d) => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? local(new Date()) : local(v)
  if (typeof v === 'number' && Number.isFinite(v)) {
    const d = new Date(v)
    return Number.isNaN(d.getTime()) ? local(new Date()) : local(d)
  }
  const s = String(v ?? '').trim()
  const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/)
  if (m) return m[1] + '-' + pad2(Number(m[2])) + '-' + pad2(Number(m[3]))
  return local(new Date())
}

/** 时间戳 → 本地「YYYY-MM-DD HH:MM」；取不到就给空串。 */
function timeText(v) {
  const n = fin(v)
  if (n == null || n <= 0) return ''
  const d = new Date(n < 1e12 ? n * 1000 : n)
  if (Number.isNaN(d.getTime())) return ''
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
    + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes())
}

/* ───────────── URL：识别 + 归一（链接校验用） ───────────── */

/** 认 http(s)://、www.、以及「baidu.com/x」这种裸域名带路径的写法。 */
const URL_LIKE_RE = /(?:https?:\/\/|www\.)[^\s，。；、！？）)】」』"'“”«»]+|(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}\/[^\s，。；、！？）)】」』"'“”«»]+/g

/** 去掉协议 / www / 结尾标点与斜杠，只留可比对的 host+path。 */
function normalizeUrl(u) {
  return String(u || '').trim().toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/[.,;:!?。，；、！？）)】」』'"”…]+$/g, '')
    .replace(/\/+$/, '')
}

/* ───────────── picks / coverage 归一 ───────────── */

function normDims(d) {
  const dim = (v) => {
    const n = fin(v)
    if (n == null) return null
    return Math.min(1, Math.max(0, n))
  }
  const src = d && typeof d === 'object' ? d : {}
  return {
    heat: dim(src.heat),
    discussion: dim(src.discussion),
    quality: dim(src.quality),
    freshness: dim(src.freshness),
  }
}

function normQuotes(p) {
  const out = []
  const push = (nickname, body, upVote) => {
    const t = text(body, 120)
    if (!t) return
    out.push({ nickname: text(nickname, 20) || '匿名', text: t, upVote: intOrNull(upVote) })
  }
  const list = Array.isArray(p.quotes) ? p.quotes : []
  for (const q of list) {
    if (out.length >= MAX_QUOTES) break
    push(q?.nickname, q?.text ?? q?.content, q?.upVote)
  }
  // 上游没给 quotes 时退回 browse 深读留下的 floors，字段名不同但数据一样
  if (!out.length && Array.isArray(p.floors)) {
    for (const f of p.floors) {
      if (out.length >= MAX_QUOTES) break
      push(f?.nickname, f?.content, f?.upVote)
    }
  }
  return out
}

function pickUrl(p, topicId) {
  const raw = typeof p.url === 'string' ? p.url.trim() : ''
  if (/^https?:\/\/[^\s]+$/i.test(raw)) return raw
  return topicId ? threadUrl(topicId) : ''
}

/** 把上游一个 pick 压成证据里固定的形状（字段缺就缺，不编）。 */
function normPick(src, i) {
  const p = src && typeof src === 'object' ? src : {}
  const stats = p.stats && typeof p.stats === 'object' ? p.stats : {}
  const topicId = p.topicId != null ? String(p.topicId) : (p.id != null ? String(p.id) : '')
  const sectionId = p.sectionId != null ? String(p.sectionId) : ''
  const sectionTitle = text(p.sectionTitle, 40) || (sectionId ? '板块 ' + sectionId : '') || '未标板块'
  const time = text(p.timeStr, 40) || timeText(p.timeMs) || text(stats.created, 40) || text(p.created, 40)
  const lastReply = text(stats.lastReply, 40) || text(p.lastReply, 40) || text(p.replyStr, 40) || timeText(p.replyMs)
  return {
    idx: i + 1,
    topicId,
    url: pickUrl(p, topicId),
    title: text(p.title, 120) || '(无标题)',
    content: text(p.content, 600),
    sectionId,
    sectionTitle,
    uid: p.uid != null ? String(p.uid) : '',
    nickname: text(p.nickname, 30) || (p.uid != null ? String(p.uid) : '匿名'),
    reply: firstInt(p.replyCount, stats.reply),
    comment: firstInt(p.commentCount, stats.comment),
    upVote: firstInt(p.upVote, stats.upVote),
    views: firstInt(p.views, stats.views),
    participants: firstInt(p.participants, stats.participants),
    contentLen: firstInt(p.contentLen),
    lastReply,
    time,
    score: fin(p.score),
    dims: normDims(p.dims),
    quotes: normQuotes(p),
    gist: text(p.gist, 300),
    reason: text(p.reason, 160),
  }
}

function normSection(s) {
  if (s == null) return null
  if (typeof s === 'string' || typeof s === 'number') {
    const id = String(s)
    return { id, title: id ? '板块 ' + id : '', posts: null, todayPosts: null }
  }
  if (typeof s !== 'object') return null
  const id = s.id != null ? String(s.id) : ''
  const title = text(s.title, 40) || text(s.sectionTitle, 40) || (id ? '板块 ' + id : '')
  const posts = firstInt(s.posts, s.poolPosts, s.total)
  const todayPosts = firstInt(s.todayPosts, s.postsToday, s.today)
  if (!title && posts == null && todayPosts == null) return null
  return { id, title: title || '未标板块', posts, todayPosts }
}

function normGaps(v) {
  if (v == null) return []
  if (typeof v === 'string') { const t = text(v, 60); return t ? [t] : [] }
  if (typeof v === 'number') return v > 0 ? [v + ' 个板块'] : []
  if (!Array.isArray(v)) return []
  const out = []
  for (const x of v) {
    if (x == null) continue
    if (typeof x === 'string') { const t = text(x, 60); if (t) out.push(t); continue }
    if (typeof x === 'object') {
      const t = text(x.title, 40) || text(x.sectionTitle, 40) || (x.id != null ? '板块 ' + String(x.id) : '')
      if (t) out.push(t)
    }
  }
  return out
}

/** coverage 归一。上游字段名可能不同，这里认多种写法；缺的字段保持 null，不猜。 */
function normalizeCoverage(coverage) {
  const co = coverage && typeof coverage === 'object' ? coverage : {}
  const sectionsRaw = co.sections
  let sections = intOrNull(sectionsRaw)
  if (sections == null && Array.isArray(sectionsRaw)) sections = sectionsRaw.length
  if (sections == null) sections = intOrNull(co.sectionCount ?? co.sectionTotal)
  const bySection = (Array.isArray(co.bySection) ? co.bySection : []).map(normSection).filter(Boolean)
  if (sections == null && bySection.length) sections = bySection.length
  const postsToday = firstInt(co.postsToday, co.posts, co.topics, co.topicCount, co.totalPosts, co.scanned)
  const requests = firstInt(co.requests, co.requestCount, co.fetches, co.apiCalls)
  const platformToday = firstInt(co.platformToday, co.platformPosts, co.platformTotal)
  const reachedCutoff = co.reachedCutoff === true ? true : co.reachedCutoff === false ? false : null
  return {
    sections,
    postsToday,
    requests,
    platformToday,
    reachedCutoff,
    gaps: normGaps(co.gaps ?? co.missing ?? co.failedSections),
    bySection,
  }
}

/* ───────────── 证据包 ───────────── */

/** 语料：标题 + 正文 + 板块 + 作者 + quotes + gist + reason + 统计事实。引文校验只问「材料里有没有」，多放真材料不会放过假话。 */
function corpusOf(p) {
  const parts = [p.title, p.content, p.sectionTitle, p.nickname, p.gist, p.reason]
  for (const q of Array.isArray(p.quotes) ? p.quotes : []) parts.push(q.nickname + '：' + q.text)
  for (const v of [p.reply, p.comment, p.upVote, p.views, p.participants, p.contentLen, p.score, p.time, p.lastReply]) {
    if (v != null) parts.push(String(v))
  }
  return parts.filter(Boolean).join('\n')
}

function pushPickNumbers(p, add) {
  for (const v of [p.reply, p.comment, p.upVote, p.views, p.participants, p.contentLen]) add(v)
  if (p.score != null) { add(Math.round(p.score)); add(Math.floor(p.score)) }
  for (const k of ['heat', 'discussion', 'quality', 'freshness']) {
    const d = fin(p.dims?.[k])
    if (d == null) continue
    add(Math.round(d * 100))
    add(Math.round((1 - d) * 100))
  }
}

/**
 * 建证据包：日报里所有可校验的事实都从这里来。
 * @param {{date?: string|Date, picks?: Array, coverage?: object}} input
 * @returns {{date:string, generatedAt:string, coverage:object, picks:Array, urls:string[], corpus:string, numbers:number[]}}
 */
export function buildEvidence({ date, picks, coverage } = {}) {
  const day = fmtDay(date)
  const list = (Array.isArray(picks) ? picks : []).map((p, i) => normPick(p, i))
  const urls = list.map((p) => p.url).filter(Boolean)
  const corpus = list.map(corpusOf).filter(Boolean).join('\n')

  const nums = []
  const add = (v) => {
    const n = fin(v)
    if (n != null) nums.push(Math.round(n))
  }
  for (const p of list) pushPickNumbers(p, add)
  const dm = day.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (dm) { add(Number(dm[1])); add(Number(dm[2])); add(Number(dm[3])) }
  add(list.length)
  const cov = normalizeCoverage(coverage)
  for (const v of [cov.sections, cov.postsToday, cov.requests, cov.platformToday]) add(v)
  for (const s of cov.bySection) { add(s.posts); add(s.todayPosts) }

  const numbers = [...new Set(nums)].sort((a, b) => a - b)
  return { date: day, generatedAt: new Date().toISOString(), coverage: cov, picks: list, urls, corpus, numbers }
}

/* ───────────── 覆盖情况 ───────────── */

/** 一行覆盖说明。缺什么就不写什么，绝不出现 undefined。 */
export function renderCoverageLine(coverage) {
  const co = normalizeCoverage(coverage)
  const parts = []
  if (co.sections != null) parts.push(co.sections + ' 个板块')
  if (co.postsToday != null) parts.push('今日抓到 ' + co.postsToday + ' 帖')
  if (co.requests != null) parts.push(co.requests + ' 次请求')
  const tail = []
  if (co.reachedCutoff === true) tail.push('已翻到当日首帖')
  if (co.reachedCutoff === false) tail.push('未翻到当日首帖')
  if (co.gaps.length) tail.push('缺口：' + co.gaps.slice(0, 3).join('、'))
  if (!parts.length) return tail.length ? '覆盖：' + tail.join(' · ') : '覆盖：本轮没有覆盖数据'
  const head = '覆盖：' + parts.join(' · ')
  return tail.length ? head + ' · ' + tail.join(' · ') : head
}

/* ───────────── 提示词：模型只写「概览 + 点评」，且必须带 JSON ───────────── */

function topPct(d) {
  const v = fin(d)
  if (v == null) return null
  return Math.max(1, Math.round((1 - Math.min(1, Math.max(0, v))) * 100))
}

function dimText(p) {
  const dims = p.dims || {}
  const bits = []
  for (const [key, label] of [['discussion', '讨论度'], ['heat', '热度'], ['quality', '质量'], ['freshness', '新鲜度']]) {
    const pc = topPct(dims[key])
    if (pc != null) bits.push(label + '前 ' + pc + '%')
  }
  return bits.join(' · ')
}

function statText(p) {
  const bits = []
  if (p.reply != null) bits.push('回复 ' + p.reply)
  if (p.comment != null) bits.push('评论 ' + p.comment)
  if (p.upVote != null) bits.push('赞 ' + p.upVote)
  if (p.views != null) bits.push('浏览 ' + p.views)
  if (p.participants != null) bits.push(p.participants + ' 人参与')
  if (p.contentLen != null) bits.push('正文 ' + p.contentLen + ' 字')
  return bits.join(' · ') || '互动数据缺失'
}

function postMaterial(p) {
  const out = []
  if (p.gist) out.push('  速读：' + p.gist)
  if (p.quotes.length) out.push('  楼层摘录：' + p.quotes.map((q) => q.nickname + '：' + q.text).join(' ／ '))
  else if (p.content) out.push('  正文摘录：' + text(p.content, 200))
  return out
}

/**
 * 生成「模型只写软文字」的提示词。messages 直接喂给 ai.mjs 的 chat()。
 * @param {object} evidence buildEvidence 的产物
 * @param {{persona?: object, style?: string}} opts
 */
export function digestProsePrompt(evidence, { persona, style } = {}) {
  const ev = evidence && typeof evidence === 'object' ? evidence : {}
  const picks = Array.isArray(ev.picks) ? ev.picks : []
  const who = persona && typeof persona === 'object' ? persona : {}
  const name = text(who.name, 20) || '小号'
  const owner = text(who.ownerTitle, 20) || '主人'
  const st = String(style ?? who.style ?? '').trim() || '要点式，口语，不客套'

  const sys = [
    '你在给「' + name + '」写一份游戏社区论坛的日报，读者是「' + owner + '」。',
    '风格：' + st,
    '',
    '硬规则（违反任何一条，那句话会被代码整句丢掉）：',
    '1. 只写材料里出现过的内容，不补常识、不猜动机、不编造分歧。',
    '2. 指代帖子只用【n】这种编号，例如【1】【2】；不要复述标题。',
    '3. 不写链接，任何 URL 都不要出现在正文里。',
    '4. 不写数字：回复数、评论数、赞数、浏览量、分数、日期、百分比全部由程序填。',
    '5. 不写楼层号，不编造楼层，也不要引用材料里没有的原话。',
    '6. 不用「作为一个AI」这类措辞，不寒暄，不加免责声明。',
    '7. 只输出 JSON，JSON 之外不要有任何文字，不要加代码块。',
  ].join('\n')

  const blocks = picks.map((p) => {
    const dims = dimText(p)
    const head = '【' + p.idx + '】' + p.title + '｜板块：' + p.sectionTitle + '｜' + statText(p)
      + (dims ? '｜' + dims : '')
    return [head, ...postMaterial(p)].join('\n')
  }).join('\n\n')

  const postKeys = {}
  for (const p of picks) postKeys[String(p.idx)] = '…'
  const schema = '{"overview":["…","…"],"posts":' + JSON.stringify(postKeys) + '}'

  const user = [
    '日期：' + (ev.date || fmtDay(undefined)),
    '今天入选的帖子（编号｜标题｜板块｜统计｜分位数｜材料；编号范围 1 - ' + Math.max(1, picks.length) + '）：',
    '',
    blocks || '（今天没有入选的帖子）',
    '',
    '请严格输出这一个 JSON 对象（不要代码块、不要解释、不要前后缀）：',
    schema,
    '',
    '要求：',
    '- overview：3 到 5 条，每条一句，概括今天这批帖子在聊什么；',
    '- posts：每个编号一条点评，一句话，说清这帖在讲什么 + 一句判断；',
    '- 只用【1】这种编号指代帖子；不写链接、不写数字、不写楼层号。',
  ].join('\n')

  return [
    { role: 'system', content: sys },
    { role: 'user', content: user },
  ]
}

/* ───────────── 解析模型输出（容忍围栏与前后废话） ───────────── */

function cleanProse(v, max) {
  if (typeof v !== 'string') {
    if (v && typeof v === 'object' && typeof v.text === 'string') return cleanProse(v.text, max)
    return ''
  }
  return v.replace(/\s+/g, ' ').trim().slice(0, max)
}

function normalizeProse(obj) {
  const out = { overview: [], posts: {} }
  if (!obj || typeof obj !== 'object') return out
  const ov = Array.isArray(obj.overview)
    ? obj.overview
    : (typeof obj.overview === 'string' ? obj.overview.split(/\r?\n/) : [])
  for (const x of ov) {
    const t = cleanProse(typeof x === 'string' ? x.replace(/^\s*[-*·]\s*/, '') : x, 200)
    if (!t) continue
    out.overview.push(t)
    if (out.overview.length >= 6) break
  }
  const posts = obj.posts
  if (Array.isArray(posts)) {
    posts.forEach((v, i) => {
      const t = cleanProse(v, 240)
      if (t) out.posts[String(i + 1)] = t
    })
  } else if (posts && typeof posts === 'object') {
    for (const [k, v] of Object.entries(posts)) {
      const key = String(k).trim()
      if (!/^\d+$/.test(key)) continue
      const t = cleanProse(v, 240)
      if (t) out.posts[key] = t
    }
  }
  return out
}

/**
 * 解析模型返回的 JSON。容忍 ```json 围栏、前后废话；坏 JSON 返回空结构，不抛错。
 * @returns {{overview: string[], posts: Object<string,string>}}
 */
export function parseProseJson(input) {
  const empty = () => ({ overview: [], posts: {} })
  if (input && typeof input === 'object') return normalizeProse(input)
  let raw = String(input ?? '').trim()
  if (!raw) return empty()
  const fence = raw.match(/```[a-zA-Z]*\s*([\s\S]*?)```/)
  if (fence) raw = fence[1].trim()
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return empty()
  let obj
  try { obj = JSON.parse(raw.slice(start, end + 1)) } catch { return empty() }
  return normalizeProse(obj)
}

/* ───────────── 校验：逐句查链接 / 数字 / 引文 / 引用编号 ───────────── */

function numbersFromEvidence(ev) {
  if (ev.numbers instanceof Set) return new Set([...ev.numbers].map(Number).filter(Number.isFinite))
  if (Array.isArray(ev.numbers)) return new Set(ev.numbers.map(Number).filter(Number.isFinite))
  // 调用方漏传 numbers 时按同一套规则现算，避免校验静默失效
  const set = new Set()
  const add = (v) => { const n = fin(v); if (n != null) set.add(Math.round(n)) }
  for (const p of Array.isArray(ev.picks) ? ev.picks : []) pushPickNumbers(p, add)
  const dm = String(ev.date || '').match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
  if (dm) { add(Number(dm[1])); add(Number(dm[2])); add(Number(dm[3])) }
  return set
}

function evidenceCorpus(ev) {
  if (typeof ev.corpus === 'string' && ev.corpus) return ev.corpus
  const picks = Array.isArray(ev.picks) ? ev.picks : []
  return picks.map(corpusOf).join('\n')
}

function corpusHas(corpus, s) {
  if (!s || !corpus) return false
  if (corpus.includes(s)) return true
  const norm = (x) => String(x).replace(/\s+/g, '')
  return norm(corpus).includes(norm(s))
}

function numberOk(token, set) {
  const n = Number(token)
  if (!Number.isFinite(n)) return false
  return set.has(n) || set.has(Math.round(n)) || set.has(Math.trunc(n))
}

function splitSentences(line) {
  const out = []
  let cur = ''
  for (const ch of line) {
    cur += ch
    if ('。！？!?；;'.includes(ch)) {
      if (cur.trim()) out.push(cur.trim())
      cur = ''
    }
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

/** 校验一句话；返回命中的违规原因（按 url > number > quote > cite 的优先级收集）。 */
function checkSentence(sentence, ctx) {
  const reasons = []

  const urlHits = sentence.match(URL_LIKE_RE) || []
  for (const u of urlHits) {
    if (!ctx.urlSet.has(normalizeUrl(u))) { reasons.push('url'); break }
  }
  // 数字检查要把链接和【n】引用挖掉：URL 里的编号、引用编号都不是模型编的数字
  const noUrl = sentence.replace(URL_LIKE_RE, ' ')
  const noRef = noUrl.replace(/【\s*\d{1,4}\s*】/g, ' ')
  const numAll = noRef.match(/\d+(?:\.\d+)?/g) || []
  for (const token of numAll) {
    if (token.replace(/\D/g, '').length < 2) continue
    if (!numberOk(token, ctx.numbers)) { reasons.push('number'); break }
  }

  const quoteHits = []
  for (const m of sentence.matchAll(/「([^」]{1,400})」|“([^”]{1,400})”|『([^』]{1,400})』/g)) {
    const inner = (m[1] || m[2] || m[3] || '').trim()
    if (!inner) continue
    quoteHits.push(inner)
    if (inner.length >= 6 && !ctx.corpusHas(inner)) { reasons.push('quote'); break }
  }

  const citeHits = []
  for (const m of sentence.matchAll(/【\s*(\d{1,4})\s*】/g)) {
    const n = Number(m[1])
    citeHits.push(n)
    if (!(Number.isFinite(n) && n >= 1 && n <= ctx.maxIdx)) { reasons.push('cite'); break }
  }

  return { reasons, urlHits, numAll, quoteHits, citeHits }
}

/**
 * 逐句校验模型写的文字。违规的整句丢弃，记进 dropped。
 * @param {string} text
 * @param {object} evidence
 * @returns {{ok:boolean, text:string, dropped:Array<{reason:string,sentence:string}>, stats:{sentences:number,kept:number,numbers:number,urls:number,quotes:number,citations:number}}}
 */
export function validateProse(input, evidence) {
  const ev = evidence && typeof evidence === 'object' ? evidence : {}
  const picks = Array.isArray(ev.picks) ? ev.picks : []
  const corpus = evidenceCorpus(ev)
  const ctx = {
    maxIdx: picks.length,
    numbers: numbersFromEvidence(ev),
    urlSet: new Set((Array.isArray(ev.urls) ? ev.urls : picks.map((p) => p.url)).map(normalizeUrl).filter(Boolean)),
    corpusHas: (s) => corpusHas(corpus, s),
  }
  const stats = { sentences: 0, kept: 0, numbers: 0, urls: 0, quotes: 0, citations: 0 }
  const dropped = []
  if (typeof input !== 'string') return { ok: false, text: '', dropped, stats }

  const outLines = []
  for (const rawLine of input.split(/\r?\n/)) {
    const isBullet = /^\s*[-*·]\s+/.test(rawLine)
    const line = rawLine.replace(/^\s*[-*·]\s+/, '')
    if (!line.trim()) continue
    const kept = []
    for (const sentence of splitSentences(line)) {
      stats.sentences++
      const hit = checkSentence(sentence, ctx)
      stats.numbers += hit.numAll.length
      stats.urls += hit.urlHits.length
      stats.quotes += hit.quoteHits.length
      stats.citations += hit.citeHits.length
      if (hit.reasons.length) { dropped.push({ reason: hit.reasons[0], sentence }); continue }
      kept.push(sentence)
      stats.kept++
    }
    if (kept.length) outLines.push((isBullet ? '- ' : '') + kept.join(''))
  }
  const keptText = outLines.join('\n')
  return { ok: dropped.length === 0 && keptText.trim() !== '', text: keptText, dropped, stats }
}

/* ───────────── 确定性兜底文案 ───────────── */

/**
 * 一句确定性的中文入选理由：只由数字和分位数拼出来，不含形容词。
 * 有参与人数时优先写「回复 N · M 人参与」；没有就退回回复 / 赞 / 浏览。
 */
export function fallbackWhy(pick) {
  const p = pick && typeof pick === 'object' ? pick : {}
  const stats = p.stats && typeof p.stats === 'object' ? p.stats : {}
  const reply = firstInt(p.reply, p.replyCount, stats.reply)
  const upVote = firstInt(p.upVote, stats.upVote)
  const views = firstInt(p.views, stats.views)
  const participants = firstInt(p.participants, stats.participants)
  const dims = p.dims && typeof p.dims === 'object' ? p.dims : {}

  const parts = []
  if (reply != null) parts.push('回复 ' + reply)
  if (participants != null && participants > 0) {
    parts.push(participants + ' 人参与')
    if (upVote != null && views != null && views > 0) parts.push('赞/看 ' + Math.round((upVote / views) * 100) + '%')
  } else {
    if (upVote != null) parts.push('赞 ' + upVote)
    // 浏览 0 一律不写：接口对部分帖子（尤其活动帖）本来就不给 views，
    // 写成「浏览 0」是假事实 —— 一个 5000 回复的帖不可能 0 浏览。
    if (views != null && views > 0) parts.push('浏览 ' + views)
  }

  const tail = []
  const disc = topPct(dims.discussion)
  const heat = topPct(dims.heat)
  if (disc != null) tail.push('讨论度今日前 ' + disc + '%')
  else if (heat != null) tail.push('热度今日前 ' + heat + '%')
  else {
    const quality = topPct(dims.quality)
    const fresh = topPct(dims.freshness)
    if (quality != null) tail.push('质量今日前 ' + quality + '%')
    else if (fresh != null) tail.push('新鲜度今日前 ' + fresh + '%')
  }

  const head = parts.join(' · ')
  if (head && tail.length) return head + '，' + tail.join('，')
  if (head) return head
  if (tail.length) return tail.join('，')
  const score = fin(p.score)
  return score != null ? '本轮打分 ' + trimNum(score) + '，按分数排序入选' : '按今日打分排序入选'
}

/* ───────────── 渲染整份日报 ───────────── */

function overviewItems(overview) {
  if (Array.isArray(overview)) return overview.flatMap(overviewItems)
  if (typeof overview !== 'string') return []
  return overview.split(/\r?\n/)
    .map((s) => s.replace(/^\s*[-*·]\s*/, '').trim())
    .filter(Boolean)
}

/** 把【n】展开成《标题》：只在 validateProse 通过之后调用，展开用的标题来自证据，不引入新事实。 */
function expandRefs(s, picks) {
  const list = Array.isArray(picks) ? picks : []
  return String(s || '').replace(/【\s*(\d{1,4})\s*】/g, (m, d) => {
    const n = Number(d)
    const target = list[n - 1] || list.find((x) => Number(x && x.idx) === n)
    if (!target) return m
    return '《' + (target.title || '(无标题)') + '》'
  })
}

/** 概览：只留通过校验的句子，再把【n】展开成标题；一条都没有就返回空数组（渲染时写确定性提示）。 */
function sanitizeOverview(overview, ev, picks) {
  const out = []
  for (const item of overviewItems(overview)) {
    const v = validateProse(item, ev)
    if (v.ok && v.text) out.push(expandRefs(v.text, picks))
    if (out.length >= MAX_OVERVIEW) break
  }
  return out
}

function postComment(posts, p, idx) {
  if (!posts || typeof posts !== 'object') return ''
  const candidates = [posts[String(idx)], posts[idx]]
  if (p.topicId) candidates.push(posts[String(p.topicId)])
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim()
  }
  return ''
}

function pickBlock(p, i, { aiMode, posts, ev, picks }) {
  const idx = Number.isFinite(Number(p.idx)) && Number(p.idx) > 0 ? Number(p.idx) : i + 1
  const out = []
  out.push('### ' + idx + '. ' + (p.title || '(无标题)'))

  const meta = []
  if (p.sectionTitle) meta.push(p.sectionTitle)
  meta.push('作者 ' + (p.nickname || '匿名'))
  if (p.time) meta.push(p.time)
  meta.push(p.score != null ? trimNum(p.score) + ' 分' : '未打分')
  out.push(meta.join(' · '))
  out.push(statText(p))
  if (p.url) out.push('链接：' + p.url)

  const raw = aiMode ? postComment(posts, p, idx) : ''
  const v = raw ? validateProse(raw, ev) : null
  if (v && v.ok && v.text) out.push('点评：' + expandRefs(v.text, picks))
  else {
    // 上游 explainPick 已经给了一句确定性理由就优先用（它同样只由可观测事实拼成），否则本地兜底
    const given = typeof p.reason === 'string' ? p.reason.trim() : ''
    out.push('入选理由：' + (given || fallbackWhy(p)))
  }

  if (p.quotes && p.quotes.length) {
    out.push('引用楼层：')
    for (const q of p.quotes) {
      const up = q.upVote != null ? '（赞 ' + q.upVote + '）' : ''
      out.push('> ' + (q.nickname || '匿名') + '：' + (q.text || '') + up)
    }
  }
  return out
}

function distributionLines(cov) {
  const rows = cov.bySection
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => s.todayPosts != null || s.posts != null)
    .sort((a, b) => {
      const d = (b.s.todayPosts ?? -1) - (a.s.todayPosts ?? -1)
      return d !== 0 ? d : a.i - b.i
    })
    .slice(0, MAX_BY_SECTION)
    .map(({ s }) => s)
  if (!rows.length) return []
  const out = ['## 今日板块分布', '']
  for (const s of rows) {
    const bits = []
    if (s.todayPosts != null) bits.push('今日 ' + s.todayPosts + ' 帖')
    if (s.posts != null) bits.push('池内 ' + s.posts + ' 帖')
    out.push('- ' + (s.title || '未标板块') + '：' + bits.join(' / '))
  }
  out.push('')
  return out
}

function methodLines(cov, picks) {
  const out = ['## 这期怎么排的', '']
  out.push('- 评分口径：' + RUBRIC + '；' + RUBRIC_NOTE + '。')
  out.push('- ' + renderCoverageLine(cov))
  if (cov.platformToday != null) out.push('- 平台今日：' + cov.platformToday + ' 帖')
  if (cov.reachedCutoff === true) out.push('- 抓取截止：已翻到当日首帖')
  else if (cov.reachedCutoff === false) out.push('- 抓取截止：未翻到当日首帖')
  out.push('- 抓取缺口：' + (cov.gaps.length ? cov.gaps.slice(0, 6).join('、') : '无'))
  out.push('- 本轮入选：' + picks.length + ' 帖（按分数从高到低）')
  out.push('')
  return out
}

function linksLines(picks) {
  const out = ['## 原帖链接', '']
  if (!picks.length) { out.push('（本轮没有选出帖子。）', ''); return out }
  picks.forEach((p, i) => {
    const idx = Number.isFinite(Number(p.idx)) && Number(p.idx) > 0 ? Number(p.idx) : i + 1
    out.push(idx + '. ' + (p.title || '(无标题)') + (p.url ? ' — ' + p.url : ''))
  })
  out.push('')
  return out
}

/**
 * 渲染整份 markdown 日报。标题 / 链接 / 板块 / 作者 / 统计 / 覆盖全部由代码写；
 * 模型文字只有 overview 与 posts，且逐句校验，没过就用 fallbackWhy 顶上。
 * @param {object} evidence
 * @param {{overview?: string[], posts?: Object, mode?: 'ai'|'fallback'}} opts
 */
export function renderReport(evidence, { overview = [], posts = {}, mode = 'ai' } = {}) {
  const ev = evidence && typeof evidence === 'object' ? evidence : {}
  const picks = Array.isArray(ev.picks) ? ev.picks : []
  const cov = normalizeCoverage(ev.coverage)
  const aiMode = mode !== 'fallback'
  const lines = []

  lines.push('# 好游快爆 · 日报 ' + (ev.date || fmtDay(undefined)), '')
  lines.push('> ' + renderCoverageLine(cov))
  lines.push('> 口径：' + RUBRIC + '；' + RUBRIC_NOTE + '。', '')

  lines.push('## 今天论坛在聊什么')
  const ov = aiMode ? sanitizeOverview(overview, ev, picks) : []
  if (ov.length) for (const t of ov) lines.push('- ' + t)
  else lines.push('- ' + FALLBACK_OVERVIEW)
  lines.push('')

  lines.push('## 值得看的 ' + picks.length + ' 帖', '')
  if (!picks.length) {
    lines.push('（本轮没有选出帖子。）', '')
  } else {
    picks.forEach((p, i) => {
      lines.push(...pickBlock(p, i, { aiMode, posts, ev, picks }), '')
    })
  }

  lines.push(...distributionLines(cov))
  lines.push(...methodLines(cov, picks))
  lines.push(...linksLines(picks))

  const md = lines.join('\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return md + '\n'
}
