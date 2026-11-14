// 日报层：今日全量池 → 四维分位数打分 → 多样性选帖 → 深读取证 → 模型只写软文字 → 逐句校验 → 落盘。
//
// 这条链路的三个承诺（改代码时守住）：
//   1. 覆盖：候选池是「今天全站目录里发过的帖」，不是「刚刷出来的几十条」。抓取按板块增量推进，
//      翻过本地当天 00:00 就算补齐（依据：列表按 reply_time 倒序，零回复帖的 reply_time = 发布时间）。
//   2. 评分：四维（热度/讨论度/质量/新鲜度）先在本日池内转成分位数再加权，分数是「当天同批帖子的相对位置」。
//      全程确定性计算，模型不参与打分，同一份池子跑两次结果一样。四维算完之后再叠一层
//      browse.interests 偏好标签加减分（命中标签 / 全不命中），标签为空或 weight<=0 时整层不启用、
//      分值与此前逐帖相同 —— 回退必须是真的回退，不是「差不多」。
//   3. 不编：标题、链接、数字、板块、作者、引用楼层全部由代码从证据包渲染；模型只写「概览 + 每题一句点评」，
//      写出来的每一句都要过 ground.mjs 的事实校验，过不了就整句丢掉、用确定性文案顶上。
import fs from 'node:fs'
import path from 'node:path'
import { crawlDay, coverageOf, loadPool } from './daypool.mjs'
import { scorePool, selectPicks, explainPick } from './rank.mjs'
import { buildEvidence, digestProsePrompt, parseProseJson, validateProse, renderReport } from './ground.mjs'
import { topicDetail, replyOperate } from './hykb-api.mjs'
import { chat, chatJudge, aiReady, browseReplyPrompt, topicGistPrompt, applySuffix, tidy, wellFormed } from './ai.mjs'
import { judge, gate } from './judge.mjs'
import { publishDigest } from './post.mjs'
import { loadSeen, saveSeen, seenReply, markReply, audit } from './state.mjs'
import { resolveGames, gameComments, pickComments, gameBlock, gamesPrompt } from './games.mjs'
import { record as recordHistory } from './history.mjs'
import { digestDir, digestPath, ensureDir, localDay } from './paths.mjs'
import { planLikes, likeTopic, likeReply, liked, judgePrompt, parseJudge } from './like.mjs'
import { finishReply, EMOJI_PROMPT_RULE } from './emoji.mjs'
import { screenOutbound, describeVerdict } from './safety.mjs'
import { gate as maskwordGate } from './maskword.mjs'
import { findRepeat, rememberSaid } from './dedupe.mjs'

/** 出站闸 + 复读查重（与 watch.mjs 同一套语义，日报这条线也要过）。 */
function gateOutbound(cfg, text, { log = () => {} } = {}) {
  const S = cfg.safety || {}
  if (S.enabled === false) return { allow: true }
  if (S.blockOutbound !== false) {
    const v = screenOutbound(text, cfg)
    if (!v.ok) { log('[safety] 写出' + describeVerdict(v) + '，拦下不发'); return { allow: false, why: 'outbound-' + (v.cat || '') } }
  }
  const rep = findRepeat({ text, cfg })
  if (rep) { log('[dedupe] 这段话之前说过，不重复发'); return { allow: false, why: 'repeat' } }
  return { allow: true }
}

const strip = (h) => String(h || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
const today = (now = new Date()) => localDay(now)

/** 深读一帖：拿楼层，挑出日报能引用的原话 + 参与人数。读失败不致命，返回 null。 */
async function deepRead(topicId, { maxFloors = 40, selfUid = '', quoteMax = 3 } = {}) {
  try {
    const j = await topicDetail(topicId, { sort: 2 })
    if (j.code !== 100) return null
    const t = j.result?.topic || {}
    const replies = j.result?.reply || []
    const floors = replies.slice(0, Math.max(1, maxFloors)).map((r) => ({
      id: String(r.id || ''),
      nickname: r.user?.nickname || String(r.uid || ''),
      uid: String(r.uid || ''),
      content: strip(r.content),
      position: r.position,
      upVote: Number(r.up_vote) || 0,
      isUpVoted: liked(r.is_up_voted),
    }))
    // 引文只取有内容、不是自己写的楼层；按赞数取前几条，没赞就按楼层顺序取前两条。
    const mine = floors.filter((f) => f.content && f.content.length >= 4 && !(selfUid && f.uid === selfUid))
    const byHeat = mine.slice().sort((a, b) => (Number(b.upVote) || 0) - (Number(a.upVote) || 0))
    const voted = byHeat.filter((f) => Number(f.upVote) > 0)
    // 截断后再修 UTF-16：120 个码元正好切在 emoji 中间时，整句会变成孤立代理项，
    // 发给模型会让对方 JSON 解析直接 400（实测踩过，见 ai.mjs wellFormed 注释）。
    const quotes = (voted.length ? voted : byHeat).slice(0, Math.max(0, quoteMax))
      .map((f) => {
        const cut = f.content.length > 120
        // 截断后修 UTF-16；末尾的 U+FFFD 是「被切掉的半个 emoji」，留着像乱码，删掉并补省略号
        let text = wellFormed(f.content.slice(0, 120)).replace(/\uFFFD+$/, '').trim()
        if (cut && text) text += '…'
        return { nickname: wellFormed(f.nickname), text, upVote: f.upVote }
      })
    const participants = new Set(floors.map((f) => f.uid).filter(Boolean)).size
    return { topic: t, floors, replyCount: replies.length, quotes, participants }
  } catch { return null }
}

/** 把表情用法接到 system 提示后面；on 为假时原样返回（模型就不会写 [表情:名]）。 */
function withEmojiRule(msgs, on) {
  if (!on) return msgs
  return msgs.map((m, i) => (i === 0 && m.role === 'system' ? { ...m, content: m.content + '\n\n' + EMOJI_PROMPT_RULE } : m))
}

/**
 * 自动点赞：三类对象（读过的帖 / 优质帖及其热评 / 评论区回复）由 like.planLikes 决策，这里只执行。
 * 写额度、写冷却、风控暂停全在 traffic.mjs；同一对象只赞一次（seen 留痕 + 平台 is_up_voted 双重判重）。
 */
export async function runLikes(cfg, picks, { seen, dryRun = false, log = () => {}, stats = null } = {}) {
  const LK = cfg.like || {}
  if (!(LK.browsed || LK.quality || LK.replies)) return 0
  const me = String(cfg.self?.uid || '')
  const hotN = Math.max(0, Number(LK.hotCommentsPerTopic) || 0)

  const items = []
  for (const p of picks) {
    const base = {
      topicId: p.topicId, score: p.score, isOwn: !!me && String(p.uid || '') === me,
      read: !!p.floors, alreadyLiked: p.isUpVoted === true || seenReply(seen, 'l:t:' + p.topicId),
      title: p.title,
    }
    items.push({ ...base, kind: 'topic', id: p.topicId, tag: 'browsed' })
    items.push({ ...base, kind: 'topic', id: p.topicId, tag: 'quality' })
    // 楼层分成两拨，各自挂在授权的开关上：
    //   ② 优质内容 → 该帖下面最热的几条评论（tag hotcomment，挂 like.quality）
    //   ③ 回复内容 → 读到的评论区 / 楼中楼回复（tag reply，挂 like.replies）
    // 同一层楼两拨都收时由 planLikes 去重（hotcomment 先到先得），不会赞两遍。
    const mine = (p.floors || []).filter((f) => f.id && !(me && String(f.uid) === me) && !f.isUpVoted && !seenReply(seen, 'l:r:' + f.id))
    const byHeat = mine.slice().sort((a, b) => (Number(b.upVote) || 0) - (Number(a.upVote) || 0))
    const floorItems = []
    if (LK.quality) floorItems.push(...byHeat.slice(0, hotN).map((f) => ({ f, tag: 'hotcomment' })))
    if (LK.replies) floorItems.push(...mine.map((f) => ({ f, tag: 'reply' })))
    for (const { f, tag } of floorItems) {
      items.push({
        kind: 'reply', id: f.id, topicId: p.topicId, fid: p.sectionId, replyId: f.id,
        score: f.upVote, isOwn: false, read: true, alreadyLiked: false,
        text: f.content, title: p.title, tag,
      })
    }
  }

  const plan = planLikes({ cfg, items })
  if (!plan.length) { log('[like] 本轮没有要赞的对象'); return 0 }

  let done = 0
  let judged = 0
  const judgeCap = Math.max(0, Number(LK.aiConfirmMax) || 0)
  for (const it of plan) {
    let go = true
    if (it.needsJudge) {
      if (judged >= judgeCap || !aiReady()) continue
      judged++
      // 判官开着就走判官（四组分数 + 引文自证），关着还是原来那句「是/否」。
      // 判官失手 = null，这里按「不放行」处理：写动作宁可少赞一条，也不瞎赞。
      if (cfg?.ai?.judge?.enabled) {
        const v = await judge(it, { cfg, chat: chatJudge })
        const vg = gate(v, 'like', cfg)
        if (!vg.ok) { log('[like] 判官不发 ' + it.id + '（' + vg.why + '）'); continue }
        go = true
      } else {
        try { go = parseJudge(await chat(judgePrompt(it), { maxTokens: 8, temperature: 0 })) }
        catch (e) { log('[like] 判定失败，跳过 ' + it.id + '：' + e.message); continue }
      }
    }
    if (!go) continue
    const key = 'l:' + (it.kind === 'topic' ? 't:' : 'r:') + it.id
    if (seenReply(seen, key)) continue
    if (dryRun) { log('[like] [dry-run] 会赞' + (it.kind === 'topic' ? '帖 ' : '楼层 ') + it.id + '（' + it.reason + '）'); continue }
    try {
      const out = it.kind === 'topic'
        ? await likeTopic({ tid: it.tid })
        : await likeReply({ fid: it.fid, tid: it.topicId, replyId: it.id })
      const ok = out.code === 100
      const meta = { action: 'like-' + it.kind, topicId: it.topicId, replyId: it.kind === 'reply' ? it.id : null, via: it.reason, ok }
      if (ok) {
        done++
        markReply(seen, key, { liked: true })
        audit({ ...meta })
        log('[like] ✓ 赞了' + (it.kind === 'topic' ? '帖 ' : '楼层 ') + it.id + '（' + it.reason + '）')
      } else {
        audit({ ...meta, msg: String(out.code) + ' ' + (out.msg || '') })
        log('[like] 失败 ' + it.kind + ' ' + it.id + '：code=' + out.code + ' ' + (out.msg || ''))
      }
    } catch (e) {
      audit({ action: 'like-' + it.kind, topicId: it.topicId, ok: false, msg: e.message })
      log('[like] 被拦（多半是写额度/冷却/风控）：' + e.message)
      break
    }
  }
  if (stats) stats.likes = done
  return done
}

/**
 * 日报里的「游戏评价观察」：挑几个游戏，读玩家评价，让模型压成一段。
 * **只读**：这里不发任何评价、不打分（写接口根本没接进来）。
 * @returns {Promise<{md:string, list:Array}>} md 为空 = 这一轮没有游戏可写
 */
async function buildGamesSection(cfg, { date, log = () => {} } = {}) {
  const G = cfg?.games || {}
  if (!G.enabled) return { md: '', list: [] }
  const games = await resolveGames(cfg, { log })
  if (!games.length) return { md: '', list: [] }

  const blocks = []
  const list = []
  for (const g of games) {
    let r
    try { r = await gameComments(g.id) } catch (e) { log('[games] ' + g.id + ' 评价读失败：' + e.message); continue }
    if (r.code !== 100) { log('[games] ' + g.id + ' 评价读失败 code=' + r.code + ' ' + (r.msg || '')); continue }
    const comments = pickComments(r.result?.data, { max: G.maxComments, minLen: G.minLen })
    const star = Number(r.result?.star_info?.star) || 0
    blocks.push(gameBlock({ ...g, star }, comments))
    list.push({ id: g.id, title: g.title, star, read: comments.length, total: Number(r.result?.count) || 0 })
    log('[games] ' + (g.title || g.id) + ' 读到 ' + comments.length + ' 条评价（平台 ' + (star || '—') + ' 分／共 ' + (Number(r.result?.count) || 0) + ' 条）')
  }
  if (!blocks.length) return { md: '', list }

  let md = ''
  if (aiReady()) {
    try { md = await chat(gamesPrompt({ blocks, persona: cfg.persona, date }), { maxTokens: 700, temperature: 0.3 }) } catch (e) { log('[games] 评价总结失败：' + e.message) }
  }
  if (!md) {
    // AI 没用上也不能丢数据：给一份能看的清单，明确说这是原始观察
    md = ['## 游戏评价观察', '']
      .concat(list.map((g) => '- ' + (g.title || g.id) + '：平台 ' + (g.star || '—') + ' 分，共 ' + (g.total || 0) + ' 条评价，本轮读到 ' + g.read + ' 条'))
      .join('\n')
  }
  return { md: String(md).trim(), list }
}

/** 日报帖标题模板转成正则：自己发的日报帖不能再进日报（自引循环）。 */
function digestTitleRe(cfg) {
  const tpl = String(cfg?.post?.title || '').replace(/\{date\}/g, '').trim()
  const bits = [tpl, '论坛日报', '快爆论坛日报'].filter(Boolean).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  if (!bits.length) return null
  return new RegExp(bits.join('|'))
}

/** 一份「本轮池子 + 本轮选帖」的完整上下文，runDigest 与 previewDigest 共用。 */
function buildCandidates(cfg, pool, { nowMs }) {
  const B = cfg.browse || {}
  const selfUid = String(cfg.self?.uid || '')
  const selfName = String(cfg.self?.name || '')
  const re = digestTitleRe(cfg)
  const all = Object.values(pool.posts || {})
  const banned = []
  const posts = all.filter((p) => {
    if (B.excludeSelf === false) return true
    if (re && re.test(String(p.title || ''))) { banned.push(p); return false }
    return true
  })
  // interests 走 cfg 传进来（不在这里读全局 config）：预览与正式跑必须用同一套标签，
  // 否则设置页预览的排序和真跑出来的日报能对不上。
  const scored = scorePool(posts, { now: nowMs, weights: B.weights, interests: B.interests })
  const sel = selectPicks(scored, {
    pick: Math.max(1, Number(B.pick) || 8),
    perSectionMax: Number(B.perSectionMax) || 2,
    perAuthorMax: Number(B.perAuthorMax) || 1,
    perAuthorMaxOfficial: Number(B.perAuthorMaxOfficial) || 3,
    officialMax: Number.isFinite(Number(B.officialMax)) ? Number(B.officialMax) : 3,
    minScore: Number(B.minScore) || 0,
    selfUid,
    selfName,
    mutedTitles: B.muteTitles,
    skipTop: B.skipTop !== false,
    now: nowMs,
  })
  return { ...sel, banned, scored }
}

/**
 * 跑一轮刷帖。
 * @returns {Promise<{date:string, scanned:number, picked:Array, file:string, text:string, replied:number, dryRun:boolean, mode:string, coverage:object}>}
 */
export async function runDigest(cfg, { dryRun = false, log = () => {}, now = new Date(), forcePost = false } = {}) {
  const B = cfg.browse || {}
  const date = today(now)
  const nowMs = now instanceof Date ? now.getTime() : Number(now) || Date.now()
  const stats = {
    date, scanned: 0, picked: [], file: '', text: '', replied: 0, dryRun,
    post: null, games: [], likes: 0, mode: 'fallback', coverage: null, crawl: null, grounding: null,
  }

  // 1) 今日池：按板块增量补全到当天 0 点。已经补过的板块只做一层前脸刷新。
  const crawled = await crawlDay(cfg, { date, log, now })
  const pool = crawled.pool
  const coverage = coverageOf(pool)
  stats.coverage = coverage
  stats.crawl = crawled.stats
  stats.scanned = Object.keys(pool.posts || {}).length
  if (!stats.scanned) { log('[digest] 今天还没抓到帖子（板块为空 / 全被过滤 / 预算用尽）'); return stats }
  log('[digest] 今日池 ' + stats.scanned + ' 帖 · ' + coverage.sections + ' 个板块 · 已翻到当日首帖=' + coverage.reachedCutoff)
  // 「只勾了一个板块」是日报不具代表性的头号原因（实测：配置里只留了爆友生活区，
  // 日报就永远只有生活区的帖）。这条警告让人一眼看出问题在哪。
  const pickedSections = Array.isArray(cfg.browse?.sections) ? cfg.browse.sections.filter((x) => x && (x.id || typeof x === 'string')).length : 0
  if (pickedSections > 0 && pickedSections < 10) {
    log('[digest] ⚠ 只选了 ' + pickedSections + ' 个板块，日报只覆盖这些板块。要全站就把「读哪些板块」清空（覆盖板块目录里全部公共板块）')
  }

  // 2) 打分 + 选帖（确定性，模型不参与）
  const { picks, ranked, excluded, banned } = buildCandidates(cfg, pool, { nowMs })
  if (banned.length) log('[digest] 跳过自己的日报帖 ' + banned.length + ' 条')
  if (!picks.length) { log('[digest] 打分后没有可写的帖（全被零信号/配额/排除规则挡下）'); return stats }

  // 3) 深读入选帖：拿真实楼层当引文、数参与人数（也是当天「讨论度」的实据）
  const maxFloors = Math.max(1, Number(cfg.summary?.maxComments) || 40)
  const deepN = Math.min(picks.length, Math.max(0, Number(B.deep) || 0))
  const selfUid = String(cfg.self?.uid || '')
  for (let i = 0; i < deepN; i++) {
    const d = await deepRead(picks[i].topicId, { maxFloors, selfUid })
    if (!d) { log('[digest] 深读失败 ' + picks[i].topicId + '（按无楼层处理）'); continue }
    picks[i].floors = d.floors
    picks[i].quotes = d.quotes
    picks[i].participants = d.participants
    picks[i].isUpVoted = liked(d.topic?.is_up_voted)
    if (!picks[i].content && d.topic.content) picks[i].content = wellFormed(strip(d.topic.content).slice(0, 600))
  }
  // 无标题帖在日报里没法读：用正文前 24 字当显示名，并明确标出「无标题」。
  // 标题字段只用于展示与证据包，不影响打分。
  for (const p of picks) {
    if (!String(p.title || '').trim()) {
      const head = String(p.content || '').replace(/\s+/g, ' ').slice(0, 24)
      p.title = head ? '（无标题）' + head : '（无标题）'
    }
    p.reason = explainPick(p, { total: ranked.length })
  }

  // 4) 证据包 + 模型只写软文字 + 逐句事实校验（全部由 ground.mjs 负责）
  const evidence = buildEvidence({ date, picks, coverage })
  let overview = []
  let postComments = {}
  let mode = 'fallback'
  if (aiReady()) {
    try {
      // interests 从 cfg 透传：与打分层用同一份标签（B 就是 cfg.browse），
      // 榜上被标签抬起来的帖和提示词里说的偏好不会是两套东西。
      const raw = await chat(digestProsePrompt(evidence, { persona: cfg.persona, style: cfg.summary?.style, interests: B.interests }), { maxTokens: 1200, temperature: 0.3 })
      const parsed = parseProseJson(raw)
      const ov = (parsed.overview || []).map((s) => String(s || '').trim()).filter(Boolean)
      const pc = parsed.posts && typeof parsed.posts === 'object' ? parsed.posts : {}
      if (ov.length || Object.keys(pc).length) { overview = ov; postComments = pc; mode = 'ai' }
      else log('[digest] 模型没返回可用的概览/点评，走确定性骨架')
    } catch (e) {
      log('[digest] AI 综述失败，走确定性骨架：' + e.message)
    }
  } else {
    log('[digest] AI 未配置，走确定性骨架')
  }
  // 校验统计：给设置页/日志一个「模型写的句子被丢了几个」的实数，而不是只说"已校验"
  let kept = 0
  let dropped = 0
  for (const t of overview) {
    const v = validateProse(t, evidence)
    if (v.ok && v.text) kept++
    else dropped += (v.dropped || []).length || 1
  }
  for (const [k, t] of Object.entries(postComments)) {
    const v = validateProse(String(t || ''), evidence)
    if (v.ok && v.text) kept++
    else dropped += (v.dropped || []).length || 1
  }
  stats.grounding = { mode, overview: overview.length, comments: Object.keys(postComments).length, kept, dropped }
  stats.mode = mode
  log('[digest] 生成方式=' + (mode === 'ai' ? 'AI 综述（逐句校验通过 ' + kept + ' 句，丢弃 ' + dropped + ' 句）' : '确定性骨架（无模型文字）'))

  // 5) 渲染：标题/链接/数字/板块/作者/引用全部代码写，模型文字只填「概览 + 点评」
  let body = renderReport(evidence, { overview, posts: postComments, mode })
  // 游戏评价观察：只读几个游戏的评价，压成日报里的一个固定栏目（开关在 games.enabled）
  const gs = await buildGamesSection(cfg, { date, log })
  stats.games = gs.list
  if (gs.md) body = String(body).trim() + '\n\n' + gs.md

  stats.text = body
  stats.picked = picks.map((p) => ({ topicId: p.topicId, title: p.title, score: p.score, sectionTitle: p.sectionTitle }))

  // 6) 落盘：**当天一份，覆盖写**。日报是「今日全量快照」，不是每小时叠一段的流水账；
  //    要翻历史快照看 digest-<date>.evidence.json（每轮的证据包与校验结果）。
  if (dryRun) {
    log('[digest] [dry-run] 备好 ' + picks.length + ' 帖的日报（不写文件、不进已读）')
  } else {
    ensureDir(digestDir())
    const file = digestPath(date)
    const head = '# 好游快爆 · 日报 ' + date + '\n\n' +
      '<!-- 更新于 ' + new Date(nowMs).toISOString() + ' · 扫 ' + stats.scanned + ' 帖 · 选 ' + picks.length +
      ' 帖 · 覆盖 ' + coverage.sections + ' 个板块 · 已翻到当日首帖=' + coverage.reachedCutoff +
      ' · 生成方式=' + mode + ' · 请求 ' + coverage.requests + ' -->\n'
    // renderReport 自己带 H1；这里只补一行机器可读的注释，然后把 H1 之后的正文接上
    const bodyNoH1 = String(body).replace(/^#[^\n]*\n+/, '')
    fs.writeFileSync(file, head + '\n' + bodyNoH1)
    stats.file = file
    // 证据包落盘：谁被选、为什么、模型写了什么、校验丢了哪些句子，都能事后追。
    try {
      const evFile = path.join(digestDir(), 'digest-' + date + '.evidence.json')
      fs.writeFileSync(evFile, JSON.stringify({ ...evidence, overview, postComments, grounding: stats.grounding, crawl: stats.crawl }, null, 1))
    } catch (e) { log('[digest] 证据包落盘失败（不影响日报）：' + e.message) }
    log('[digest] 写了 ' + picks.length + ' 帖 → ' + file)
  }

  // 7) 自动点赞：读过的 / 优质的 / 热评 / 复区回复，按开关来
  const seen = loadSeen()
  stats.likes = await runLikes(cfg, picks, { seen, dryRun, log, stats })

  // 8) 发帖：日报原样发成一篇新帖。放在自动回帖前面——写冷却期间后面的回帖会被拦，主产物优先。
  if (forcePost || cfg.post?.enabled) {
    try {
      stats.post = await publishDigest({ body, picks, cfg, date, dryRun, force: forcePost, log })
    } catch (e) {
      stats.post = { status: 'failed', reason: e.message }
    }
    if (stats.post.status === 'skipped') log('[post] 没发：' + stats.post.reason)
    else if (stats.post.status === 'failed') log('[post] 发帖失败：' + stats.post.reason)
  }

  // 9) 自动回帖：只对过线的高分帖，且受写预算与写冷却约束（traffic.mjs 会把关）
  const maxReply = Math.max(0, Number(B.replyMax) || 0)
  if (B.autoReply && maxReply > 0) {
    const minScore = Number(B.replyMinScore) || 0
    const targets = picks.filter((p) => p.score >= minScore).slice(0, maxReply)
    for (const p of targets) {
      if (seenReply(seen, 'r:' + p.topicId)) continue
      let text = ''
      try {
        const d = await deepRead(p.topicId, { maxFloors: 8, selfUid })
        const floors = d?.floors || []
        let gist = ''
        if (aiReady()) {
          try { gist = await chat(topicGistPrompt(d?.topic || p, floors), { maxTokens: 220, temperature: 0.3 }) } catch {}
        }
        text = await chat(withEmojiRule(browseReplyPrompt({
          topic: d?.topic || { title: p.title, content: p.content },
          floors,
          persona: cfg.persona,
          gist,
        }), true), { maxTokens: 200 })
      } catch (e) { log('[digest] 生成回帖失败 ' + p.topicId + '：' + e.message); continue }
      text = applySuffix(strip(text).slice(0, 200), { suffix: cfg.prompt?.suffix, max: 200 })
      // 表情要拼在 strip/slice/applySuffix 之后，否则标签会被削断或删光。表情没有总开关。
      text = finishReply(text)
      if (!text) continue
      if (dryRun) {
        log('[digest] [dry-run] 会回 ' + p.topicId + '：' + text)
        continue
      }
      // 出站闸 + 复读查重：日报这条链路同样是「写完才查」，但绝不能把脏内容发出去。
      const gate = gateOutbound(cfg, text, { log })
      if (!gate.allow) {
        log('[digest] ' + p.topicId + ' 被出站闸拦下：' + gate.why)
        markReply(seen, 'r:' + p.topicId, { skip: gate.why })
        recordHistory({ topicId: p.topicId, title: p.title, sectionId: p.sectionId, sectionTitle: p.sectionTitle, uid: p.uid, nickname: p.nickname, published: p.timeMs, edited: p.editMs, replied: p.replyMs, action: 'skip', why: gate.why })
        stats.skipped = (stats.skipped || 0) + 1
        continue
      }
      // 平台词表预检：本地闸过了再问一次快爆自己的词表（没配 appid / 密钥时自动跳过）
      const mw = await maskwordGate(text, { cfg, log })
      if (!mw.allow) {
        log('[digest] ' + p.topicId + ' 被平台词表拦下')
        markReply(seen, 'r:' + p.topicId, { skip: mw.why })
        recordHistory({ topicId: p.topicId, title: p.title, sectionId: p.sectionId, sectionTitle: p.sectionTitle, uid: p.uid, nickname: p.nickname, published: p.timeMs, edited: p.editMs, replied: p.replyMs, action: 'skip', why: mw.why })
        stats.skipped = (stats.skipped || 0) + 1
        continue
      }
      let out
      try { out = await replyOperate({ tid: p.topicId, content: text, type: 3, state: 1, mask: cfg?.safety?.forceMask !== false ? 1 : 0 }) }
      catch (e) { log('[digest] 回帖被拦 ' + p.topicId + '：' + e.message); audit({ action: 'browse-reply', topicId: p.topicId, ok: false, msg: e.message }); continue }
      if (out.code === 100) {
        log('[digest] ✓ 回了 ' + p.topicId + '：' + text)
        audit({ action: 'browse-reply', topicId: p.topicId, score: p.score, text, ok: true })
        try { rememberSaid({ text }) } catch {}
        markReply(seen, 'r:' + p.topicId, { replied: true })
        recordHistory({ topicId: p.topicId, title: p.title, sectionId: p.sectionId, sectionTitle: p.sectionTitle, uid: p.uid, nickname: p.nickname, published: p.timeMs, edited: p.editMs, replied: p.replyMs, action: 'reply', why: 'browse' })
        stats.replied++
      } else {
        log('[digest] ✗ ' + p.topicId + ' code=' + out.code + ' ' + (out.msg || ''))
        audit({ action: 'browse-reply', topicId: p.topicId, ok: false, code: out.code, msg: out.msg })
        markReply(seen, 'r:' + p.topicId, { fail: out.code })
        recordHistory({ topicId: p.topicId, title: p.title, sectionId: p.sectionId, sectionTitle: p.sectionTitle, uid: p.uid, nickname: p.nickname, published: p.timeMs, edited: p.editMs, replied: p.replyMs, action: 'skip', why: 'fail-' + out.code })
      }
    }
  }

  // 10) 只有真跑才落 seen（dry-run 写进去会毒化第二天的候选池）
  if (!dryRun) {
    saveSeen(seen)
    for (const p of picks) {
      recordHistory({
        topicId: p.topicId, title: p.title,
        sectionId: p.sectionId, sectionTitle: p.sectionTitle,
        uid: p.uid, nickname: p.nickname,
        published: p.timeMs, edited: p.editMs, replied: p.replyMs,
        action: 'digest', why: 'score-' + p.score,
      })
    }
  }
  return stats
}

/**
 * 只读一遍：不落盘、不回帖、不发帖，给设置页「预览选题」和 CLI browse --dry 用。
 * 已经有今日池就直接用（预览要快），没有才小预算抓一批并如实说「覆盖不全」。
 */
export async function previewDigest(cfg, { log = () => {}, now = new Date(), limit } = {}) {
  const date = today(now)
  const nowMs = now instanceof Date ? now.getTime() : Number(now) || Date.now()
  let pool = loadPool(date)
  let crawled = false
  if (!Object.keys(pool.posts || {}).length) {
    const B = cfg.browse || {}
    const quick = { ...cfg, browse: { ...B, coverage: { ...(B.coverage || {}), crawlMaxRequests: 60 } } }
    const r = await crawlDay(quick, { date, log, now })
    pool = r.pool
    crawled = true
  }
  const coverage = coverageOf(pool)
  const { picks, ranked } = buildCandidates(cfg, pool, { nowMs })
  const n = Math.max(1, Number(limit) || Number(cfg.browse?.pick) || 8)
  if (crawled && !coverage.reachedCutoff) log('[digest] 这次预览只抓了前 60 个请求，覆盖不全；正式跑会继续补到当日首帖')
  return {
    scanned: Object.keys(pool.posts || {}).length,
    coverage,
    top: ranked.slice(0, n).map((x) => ({
      topicId: x.topicId, title: x.title, sectionTitle: x.sectionTitle,
      score: x.score, replyCount: x.replyCount, upVote: x.upVote, views: x.views, timeStr: x.timeStr,
      dims: x.dims, excludedReason: x.excludedReason || '',
      // 命中标签带出去：设置页能直接看出「这条是被标签抬上来的还是本来就在前面」
      interestHits: x.interestHits || [], interestDelta: x.interestDelta || 0,
    })),
    picks: picks.slice(0, n).map((x) => ({
      topicId: x.topicId, title: x.title, score: x.score, sectionTitle: x.sectionTitle, dims: x.dims,
      interestHits: x.interestHits || [], interestDelta: x.interestDelta || 0,
    })),
  }
}
