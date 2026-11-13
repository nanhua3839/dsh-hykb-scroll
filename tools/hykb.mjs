#!/usr/bin/env node
// 好游快爆 · AI 小号 —— 命令行入口
//
//   hykb.mjs login                扫码登录（打印二维码块字符 + 存 cookie）
//   hykb.mjs whoami               打印当前登录账号
//   hykb.mjs read <topicId>       读帖子（标题 + 楼层）
//   hykb.mjs reply <topicId> <文本>   发主回复
//   hykb.mjs comment <topicId> <楼层id> <文本>   楼中楼
//   hykb.mjs del <楼层id>         删自己的楼层
//   hykb.mjs summary <topicId>     AI 总结
//   hykb.mjs listen               常驻监听（大号@小号 → AI 回复）
//   hykb.mjs traffic              看限流状态
//   hykb.mjs history [条数]       浏览记录（她读过/回过/跳过的帖，带发布/修改/最近回复时间）
//   hykb.mjs games                试读一批游戏评价（只读，不发任何评价）
import { createRequire } from 'node:module'
import { loadCred, missingForWrite, writeFailText, cookieHeader } from './lib/cred.mjs'
import { config, writeConfig, configPath } from './lib/config.mjs'
import { login } from './lib/login.mjs'
import { topicDetail, replyOperate, commentOperate, msgInfo, topicPage } from './lib/hykb-api.mjs'
import { chat, aiReady, summarizePrompt, replyPrompt } from './lib/ai.mjs'
import { trafficState } from './lib/traffic.mjs'
import { audit } from './lib/state.mjs'
import { tick as watchTick, resetPrimed, inWindow } from './lib/watch.mjs'
import { sectionTopics, sectionCatalog, parseSectionId, parseTopicId } from './lib/forum.mjs'
import { previewDigest, runDigest } from './lib/digest.mjs'
import { resolveSections } from './lib/browse.mjs'
import { list as listHistory, counts as historyCounts, clear as clearHistory } from './lib/history.mjs'
import { resolveGames, gameComments, pickComments, gameBlock } from './lib/games.mjs'
import { digestPath, digestDir } from './lib/paths.mjs'
import { scan as scanFans, dueList, pendingList, remaining, todayCount, loadFans, saveFans } from './lib/fans.mjs'
import { runOnce as runFollowback, status as followStatus } from './lib/followback.mjs'

const [cmd, ...args] = process.argv.slice(2)
const fail = (m) => { console.error('✗ ' + m); process.exit(1) }
const strip = (h) => String(h || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()

/* ─────────── 二维码块字符 ─────────── */
const requireLocal = createRequire(import.meta.url)

function qrBlock(content) {
  let QR
  // 本地没装 qrcode 就退回只打印内容串，不阻断登录
  try { QR = requireLocal('qrcode') } catch { return null }
  const q = QR.create(content, { errorCorrectionLevel: 'L' })
  const n = q.modules.size
  const g = (r, c) => (r >= 0 && r < n && c >= 0 && c < n) ? q.modules.data[r * n + c] : 0
  const Q = 2, rows = []
  for (let r = -Q; r < n + Q; r += 2) {
    let line = ''
    for (let c = -Q; c < n + Q; c++) {
      const t = g(r, c), b = g(r + 1, c)
      line += t && b ? '██' : t ? '▀▀' : b ? '▄▄' : '  '
    }
    rows.push(line)
  }
  return rows
}

/* ─────────── 子命令 ─────────── */
async function cmdLogin() {
  const r = await login({
    onQr: (c) => {
      console.log('二维码内容：' + c)
      const rows = qrBlock(c)
      if (rows) { console.log(''); rows.forEach((x) => console.log(x)); console.log('') }
      console.log('用快爆 APP 扫码 → 手机上确认。' + (rows ? '' : '（本地没装 qrcode 包，只能看到上面的内容串）'))
    },
    onPhase: (p) => console.log('  状态：' + p),
    timeoutSec: 300,
  })
  console.log('✓ 登录成功 uid=' + r.uid + ' nickname=' + r.nickname)
  console.log('  cookie 已存：' + '~/.hykb-ai/credentials.json')
}

async function cmdWhoami() {
  const c = loadCred()
  const miss = missingForWrite(c)
  if (miss.length) fail('凭据缺字段：' + miss.join('、') + '（重跑 login）')
  const m = await msgInfo()
  console.log('uid=' + c.uid + '  nickname=' + c.nickname)
  console.log('未读：' + JSON.stringify(m.data || m))
}

async function cmdRead() {
  const topicId = args[0] || fail('用法：hykb.mjs read <topicId>')
  const j = await topicDetail(topicId, { sort: 1 })
  if (j.code !== 100) fail('读帖子失败：' + JSON.stringify(j).slice(0, 200))
  const t = j.result.topic
  console.log('标题：' + t.title)
  console.log('作者：' + (t.user?.nickname || t.uid) + '　板块：' + (t.section?.title || t.sid) + '　回复：' + t.reply_count)
  console.log('正文：' + strip(t.content).slice(0, 400))
  const rl = j.result.reply || []
  console.log('--- 楼层（' + rl.length + '）---')
  for (const r of rl) {
    console.log(r.position + ' [' + r.id + '] ' + (r.user?.nickname || r.uid) + '：' + strip(r.content).slice(0, 80))
  }
}

async function cmdReply() {
  const topicId = args[0] || fail('用法：hykb.mjs reply <topicId> <文本>')
  const text = args.slice(1).join(' ')
  if (!text) fail('缺文本')
  const c = loadCred()
  const miss = missingForWrite(c)
  if (miss.length) fail('凭据缺字段：' + miss.join('、'))
  const j = await replyOperate({ tid: topicId, content: text, type: 3, state: 1 })
  if (j.code !== 100) fail(writeFailText(j.code, j.msg))
  audit({ action: 'reply', topicId, ok: true })
  console.log('✓ ' + j.msg)
}

async function cmdComment() {
  const topicId = args[0], floorId = args[1], text = args.slice(2).join(' ')
  if (!topicId || !floorId || !text) fail('用法：hykb.mjs comment <topicId> <楼层id> <文本>')
  const c = loadCred()
  const miss = missingForWrite(c)
  if (miss.length) fail('凭据缺字段：' + miss.join('、'))
  const jd = await topicDetail(topicId, { sort: 1 })
  if (jd.code !== 100) fail('拿不到帖子的 fid：' + JSON.stringify(jd).slice(0, 150))
  const fid = jd.result.topic.sid
  const j = await commentOperate({ fid, replyId: floorId, commentId: 0, content: text })
  if (j.code !== 100) fail(writeFailText(j.code, j.msg))
  audit({ action: 'comment', topicId, floorId, ok: true })
  console.log('✓ ' + j.msg)
}

async function cmdDel() {
  const floorId = args[0] || fail('用法：hykb.mjs del <楼层id>')
  const tid = args[1]
  const c = loadCred()
  const miss = missingForWrite(c)
  if (miss.length) fail('凭据缺字段：' + miss.join('、'))
  const j = await replyOperate({ tid: tid || 0, replyId: floorId, type: 4, state: 1 })
  if (j.code !== 100) fail(writeFailText(j.code, j.msg))
  audit({ action: 'delete', floorId, ok: true })
  console.log('✓ ' + j.msg)
}

async function cmdSummary() {
  const topicId = args[0] || fail('用法：hykb.mjs summary <topicId>')
  if (!aiReady()) fail('AI 未配置：去设置页填 baseUrl / model / apiKey')
  const j = await topicDetail(topicId, { sort: 2 })
  if (j.code !== 100) fail('读帖子失败：' + JSON.stringify(j).slice(0, 150))
  const t = j.result.topic
  const rl = (j.result.reply || []).map((r) => ({ ...r, user: r.user || { nickname: r.uid } }))
  console.log('【' + t.title + '】共 ' + rl.length + ' 层\n')
  // 楼层上限跟着配置走：这帖几百层时不能让一次总结把读额度和 token 全吃掉。
  const maxFloors = config().summary?.maxComments ?? 60
  const out = await chat(summarizePrompt(t, rl, { maxFloors }), { maxTokens: 900 })
  console.log(out)
}

async function cmdTraffic() {
  const s = trafficState()
  console.log('读：本小时 ' + s.readHour + '　今天 ' + s.readDay)
  const gap = s.lastWriteAt ? Math.max(0, Math.round((Date.now() - s.lastWriteAt) / 1000)) : -1
  console.log('写：本小时 ' + s.writeHour + '　今天 ' + s.writeDay + '　' + (gap < 0 ? '冷却 无（还没写过）' : '上次写 ' + gap + 's 前'))
  if (s.pausedForSec) console.log('⚠ 风控暂停中，还需 ' + s.pausedForSec + ' 秒')
}

function describeSources(cfg) {
  const L = cfg.listen
  const parts = []
  if (L.forum?.enabled) parts.push('论坛[' + (L.forum.items || []).map((x) => x.title || x.id).join(',') + ']')
  if (L.topic?.enabled) parts.push('帖子[' + (L.topic.items || []).map((x) => x.title || x.id).join(',') + ']')
  if (L.at?.enabled) parts.push('@我')
  return parts.length ? parts.join(' + ') : '（没有启用任何监听源）'
}

async function cmdListen() {
  const cfg = config()
  const dryRun = args.includes('--dry-run')
  const once = args.includes('--once')
  if (!aiReady()) fail('AI 未配置：去设置页填 baseUrl / model / apiKey')
  const src = describeSources(cfg)
  if (src.startsWith('（')) fail('没有启用任何监听源：去设置页勾选「监听论坛 / 监听帖子 / 有人@我」')
  console.log('[listen] ' + src + '  间隔=' + cfg.listen.intervalSec + 's  我的 uid=' + loadCred().uid + (dryRun ? '  [dry-run]' : ''))
  for (;;) {
    try {
      const s = await watchTick(cfg, { dryRun })
      if (s.bootstrapped) console.log('[listen] 已登记历史内容，下一轮开始真正监听')
      else if (s.scanned) console.log('[listen] 扫 ' + s.scanned + ' 条，回 ' + s.replied + '，跳过 ' + s.skipped)
    } catch (e) { console.error('[listen] ' + e.message) }
    if (once) return
    await new Promise((r) => setTimeout(r, Math.max(20, cfg.listen.intervalSec) * 1000))
  }
}

async function cmdWatch() {
  // watch：手动跑一轮，默认 dry-run，确认没问题再加 --send
  const cfg = config()
  const send = args.includes('--send')
  const reset = args.includes('--reset')
  if (reset) { resetPrimed(); console.log('已清空 bootstrap 标记，下一轮会重新登记历史内容') }
  const s = await watchTick(cfg, { dryRun: !send })
  console.log('\n扫到 ' + s.scanned + ' 条，回复 ' + s.replied + ' 条，跳过 ' + s.skipped + ' 条' + (s.bootstrapped ? '（首次扫描，只登记）' : '') + (send ? '' : '（dry-run，未真发）'))
}

async function cmdForum() {
  const sub = args[0]
  if (sub === 'list' || !sub) {
    const r = await sectionCatalog()
    if (r.code !== 100) fail('拉板块目录失败：' + r.msg)
    console.log('共 ' + r.sections.length + ' 个板块：')
    for (const s of r.sections) console.log('  ' + s.id.padStart(6) + '  ' + s.title + '  （' + s.group + '，讨论 ' + s.discuss + '）')
    return
  }
  if (sub === 'topics') {
    const sid = parseSectionId(args[1]) || fail('用法：hykb.mjs forum topics <板块id>')
    const j = await sectionTopics(sid, {})
    if (j.code !== 100) fail('读板块失败：' + j.code + ' ' + (j.msg || ''))
    const list = j.result?.data || []
    console.log('板块 ' + sid + ' 最新 ' + list.length + ' 帖（按最后回复时间）：')
    for (const t of list) {
      console.log('  ' + t.id + '  ' + String(t.title || '(无标题)').slice(0, 30).padEnd(32) + ' 回复' + String(t.reply_count).padStart(3) + '  ' + (t.time_str || t.time))
    }
    return
  }
  fail('用法：hykb.mjs forum list | forum topics <板块id>')
}


/* ─────────── 刷帖 / 日报 ─────────── */
async function cmdBrowse() {
  const cfg = config()
  const sub = args[0]
  if (sub === 'sections' || sub === 'list') {
    const picked = await resolveSections(cfg, { log: (m) => console.log(m) })
    console.log('本轮会扫这些板块：')
    for (const s of picked) console.log('  ' + String(s.id).padStart(6) + '  ' + (s.title || '(未命名)'))
    if (!picked.length) console.log('  （空：板块目录没拉到，或 browse.sections 被名单全过滤）')
    return
  }
  const dry = args.includes('--dry') || !args.includes('--send')
  const r = await previewDigest(cfg, { log: (m) => console.log(m) })
  const cov = r.coverage || {}
  if (cov.sections != null) {
    console.log('\n覆盖：' + cov.sections + ' 个板块 · 今日抓到 ' + (cov.postsToday ?? r.scanned) + ' 帖 · ' +
      (cov.requests ?? '?') + ' 次请求 · ' + (cov.reachedCutoff === true ? '已翻到当日首帖' : '未翻到当日首帖（下一轮继续补）'))
    if (Array.isArray(cov.gaps) && cov.gaps.length) console.log('缺口：' + cov.gaps.slice(0, 5).map((g) => g.title || g.id || g).join('、'))
  }
  console.log('\n扫到 ' + r.scanned + ' 帖，前 ' + r.top.length + ' 名：')
  for (const t of r.top) {
    console.log('  ' + String(t.score).padStart(6) + ' 分  ' + t.topicId + '  ' + String(t.title || '(无标题)').slice(0, 34).padEnd(36) + '  ' + (t.sectionTitle || '') + '  回复' + t.replyCount)
  }
  if (dry) console.log('\n（只读预览，未写日报、未回帖。要真跑：hykb.mjs digest）')
}

async function cmdDigest() {
  const cfg = config()
  const dry = args.includes('--dry')
  if (!aiReady()) console.log('⚠ AI 未配置：日报会退回原始清单（去设置页填 baseUrl / model / apiKey）')
  const r = await runDigest(cfg, { dryRun: dry, log: (m) => console.log(m) })
  console.log('\n扫 ' + r.scanned + ' 帖，选 ' + r.picked.length + ' 帖' + (r.replied ? '，回 ' + r.replied + ' 帖' : '') + (dry ? '（dry-run，未发写请求）' : ''))
  if (r.file) console.log('日报：' + r.file)
  else console.log('日报目录：' + digestDir())
  if (r.text) { console.log('\n--- 日报正文 ---\n'); console.log(r.text) }
}

/* ─────────── 粉丝 / 回关 ─────────── */
// 只读：拉一轮关注通知、看台账、看今天还剩多少额度。回关写入在 App 网关，尚未接入。
async function cmdFans() {
  const cfg = config()
  const fb = cfg.followback || {}
  const dry = args.includes('--dry')
  const json = args.includes('--json')
  const reset = args.includes('--reset-baseline')

  if (reset) {
    const st = loadFans()
    st.baselineAt = ''
    st.seen = {}
    saveFans(st)
    console.log('已清空基线：下一轮会把当前可见的粉丝当成历史登记，不再回关')
    return
  }

  if (dry) {
    // 只看不发：不碰网络，只读台账
    const state = loadFans()
    const pend = pendingList(state, { cfg: fb })
    const due = dueList(state, { cfg: fb })
    console.log('基线：' + (state.baselineAt || '（还没建）'))
    console.log('待回关 ' + pend.length + ' 个　今天已回关 ' + todayCount(state) + '/' + (fb.dailyCap ?? 0) +
      '　本批可做 ' + due.length + ' 个' + (fb.enabled ? '' : '（开关关着）'))
    for (const p of pend.slice(0, 30)) console.log('  ' + p.uid + '  ' + (p.nickname || '(无昵称)') + '  relation=' + p.relation)
    if (pend.length > 30) console.log('  …共 ' + pend.length + ' 个')
    return
  }

  const r = await scanFans({ cfg: fb })
  if (!r.ok) fail('读关注通知失败：' + (r.msg || r.code))
  if (json) { console.log(JSON.stringify({ items: r.items, added: r.added, pending: pendingList(r.state, { cfg: fb }), daily: todayCount(r.state), cap: fb.dailyCap ?? 0 }, null, 2)); return }
  console.log('粉丝 ' + r.items + ' 个，其中新来的 ' + r.added + ' 个' + (r.first ? '（首次运行，只登记基线）' : ''))
  if (r.pending.length) {
    console.log('本轮新增待回关：')
    for (const p of r.pending) console.log('  + ' + p.uid + '  ' + (p.nickname || '(无昵称)') + '  relation=' + p.relation)
  }
  const pend = pendingList(r.state, { cfg: fb })
  console.log('累计待回关 ' + pend.length + ' 个　今天额度 ' + todayCount(r.state) + '/' + (fb.dailyCap ?? 0) + '（剩 ' + remaining(r.state, fb) + '）')
  console.log('回关写入需要 App 网关 client token，尚未接入；本命令只读。')
}

async function cmdFollowback() {
  const cfg = config()
  const send = args.includes('--send')
  const r = await runFollowback({ cfg, dryRun: !send })
  console.log('粉丝 ' + r.scanned + ' 个，其中新来的 ' + r.added + ' 个，本批该回关 ' + r.due + ' 个')
  for (const x of r.results || []) console.log('  ' + (x.ok ? '✓ ' : '✗ ') + x.uid + '  ' + (x.nickname || '') + '  code=' + x.code)
  console.log((send ? '' : '（dry-run，未真的关注）') + (r.skipped ? '　跳过原因：' + r.skipped : '') + '　剩 ' + (r.remaining ?? '?') + ' 个额度')
}

/** 浏览记录：她读过/回过/跳过的帖（含三个时间）。 */
async function cmdHistory() {
  if (args.includes('--clear')) { clearHistory(); console.log('✓ 浏览记录已清空'); return }
  const limit = Math.max(1, Math.min(500, Number(args[0]) || 30))
  const items = listHistory({ limit })
  const c = historyCounts()
  console.log('今天：回过 ' + c.reply + '　写进日报 ' + c.digest + '　跳过 ' + c.skip + '　合计 ' + c.total)
  if (!items.length) { console.log('（没有记录）'); return }
  const pad = (s, n) => String(s).padEnd(n).slice(0, n)
  for (const it of items) {
    const when = (it.at || '').replace('T', ' ').slice(0, 19)
    console.log(when + '  ' + pad(it.actionText || it.action, 6) + '  ' + (it.title || '(无标题)').slice(0, 40))
    console.log('           ' + (it.sectionTitle || it.sectionId || '—') + ' · ' + (it.nickname || it.uid || '—')
      + ' · 发布 ' + (it.publishedText || '—') + ' · 修改 ' + (it.editedText || '无') + ' · 最近回复 ' + (it.repliedText || '—')
      + (it.why ? ' · ' + it.why : ''))
  }
}

/** 内容安全：查词表 / 试一句话 / 看复读库 / 清复读库。与设置页走同一个 safety.mjs。 */
async function cmdSafety() {
  const S = await import('./lib/safety.mjs')
  const cfg = config()
  const sub = args[0] || 'status'
  if (sub === 'list') {
    for (const c of S.CATEGORIES) {
      console.log('')
      console.log('【' + c.label + '】共 ' + (S.BUILTIN[c.key] || []).length + ' 条' + (cfg.safety?.[c.key] === false ? '（当前已关）' : ''))
      console.log('  ' + (S.BUILTIN[c.key] || []).join('、'))
    }
    console.log('')
    console.log('【破甲提示词】共 ' + S.JAILBREAK.length + ' 条')
    console.log('  ' + S.JAILBREAK.join('、'))
    console.log('')
    console.log('【破甲模型特征】共 ' + S.JAILBREAK_MODEL.length + ' 条')
    console.log('  ' + S.JAILBREAK_MODEL.join('、'))
    return
  }
  if (sub === 'test') {
    const text = args.slice(1).join(' ')
    if (!text) fail('用法：hykb.mjs safety test <一段文本>')
    const inb = S.screenInbound(text, cfg)
    const outb = S.screenOutbound(text, cfg)
    const jb = S.scanJailbreak(text)
    console.log('入站闸：' + (inb.ok ? '放行' : '拦下（' + S.describeVerdict(inb) + '）'))
    console.log('出站闸：' + (outb.ok ? '放行' : '拦下（' + S.describeVerdict(outb) + '）'))
    console.log('破甲词：' + (jb.ok ? '没有' : '命中 ' + jb.hits.join('、')))
    return
  }
  if (sub === 'said') {
    const D = await import('./lib/dedupe.mjs')
    if (args[1] === '--clear') { D.clearSaid(); console.log('✓ 复读台账已清空'); return }
    const s = D.saidStats({ cfg })
    console.log('复读台账：共 ' + s.total + ' 条，' + s.days + ' 天窗口内 ' + s.inWindow + ' 条')
    console.log('查重窗口 ' + (cfg.risk?.dedupeDays ?? 14) + ' 天，近似阈值 ' + (cfg.risk?.dedupeSimilar ?? 0.86))
    return
  }
  // status
  const on = (k) => (cfg.safety?.[k] === false ? '关' : '开')
  console.log('内容安全总闸：' + on('enabled'))
  console.log('  国家/政治 ' + on('politics') + '　色情 ' + on('sexual') + '　血腥暴力 ' + on('violence'))
  console.log('  入站（别人写的，命中不接话、不调模型）：' + on('blockInbound'))
  console.log('  出站（模型写的，命中不发）：' + on('blockOutbound'))
  console.log('  命中话术：' + (cfg.safety?.refuseText || '（留空 = 静默跳过）'))
  console.log('  自加词 ' + (cfg.safety?.extraWords || []).length + ' 条，例外词 ' + (cfg.safety?.allowWords || []).length + ' 条')
  const D = await import('./lib/dedupe.mjs')
  const s = D.saidStats({ cfg })
  console.log('复读台账：' + s.total + ' 条（' + s.days + ' 天窗口内 ' + s.inWindow + ' 条）')
}

/** 中转站：列线路 / 看当前走哪条 / 清某条密钥。 */
async function cmdRelays() {
  const A = await import('./lib/ai.mjs')
  const cfg = config()
  const sub = args[0] || 'list'
  const ai = cfg.ai || {}
  if (sub === 'clear') {
    const id = String(args[1] || '').trim().toLowerCase()
    if (!id) fail('用法：hykb.mjs relays clear <线路id>')
    const keys = (await import('./lib/config.mjs')).loadRelayKeys()
    delete keys[id]
    ;(await import('./lib/config.mjs')).saveRelayKeys(keys)
    console.log('✓ 已清掉「' + id + '」的密钥')
    return
  }
  console.log('当前线路：' + (ai.activeRelay || 'direct') + (ai.fallback === false ? '（关掉了失败回退）' : ''))
  const usable = A.lines(cfg).map((x) => x.id)
  console.log('可用线路 ' + usable.length + ' 条' + (usable.length ? '：' + usable.join('、') : '（一条都不可用）'))
  const rows = [{ id: 'direct', name: '直连', baseUrl: ai.baseUrl, model: ai.model }].concat(ai.relays || [])
  for (const r of rows) {
    const hasKey = usable.includes(r.id) || (r.id === 'direct' ? Boolean(ai.apiKey) : false)
    const v = (await import('./lib/safety.mjs')).modelVerdict({ model: r.model, baseUrl: r.baseUrl, name: r.name })
    console.log('  ' + (usable.includes(r.id) ? '✓' : '·') + ' ' + r.id.padEnd(12) + (r.name || '').padEnd(14)
      + ' ' + (r.baseUrl || '（没填地址）') + '  ' + (r.model || '（没填模型）')
      + '  密钥:' + (hasKey ? '有' : '无') + (v.ok ? '' : '  ⛔ 破甲模型特征：' + v.hits.join('、')))
  }
}

async function cmdGames() {
  const cfg = config()
  const games = await resolveGames(cfg, { log: console.log })
  if (!games.length) { console.log('（没拿到游戏：清单为空且榜单没解析出来）'); return }
  for (const g of games) {
    const j = await gameComments(g.id)
    if (j.code !== 100) { console.log('✗ ' + g.id + ' code=' + j.code + ' ' + (j.msg || '')); continue }
    const cs = pickComments(j.result?.data, { max: cfg.games?.maxComments, minLen: cfg.games?.minLen })
    console.log('')
    console.log(gameBlock({ ...g, star: Number(j.result?.star_info?.star) || 0 }, cs.slice(0, 5)))
  }
}

const TABLE = { login: cmdLogin, fans: cmdFans, followback: cmdFollowback, whoami: cmdWhoami, read: cmdRead, reply: cmdReply, comment: cmdComment, del: cmdDel, summary: cmdSummary, traffic: cmdTraffic, listen: cmdListen, watch: cmdWatch, forum: cmdForum, browse: cmdBrowse, digest: cmdDigest, history: cmdHistory, games: cmdGames, safety: cmdSafety, relays: cmdRelays, config: async () => console.log(configPath()) }
const fn = TABLE[cmd]
if (!fn) { console.log('用法: hykb.mjs <' + Object.keys(TABLE).join('|') + '>'); process.exit(1) }
fn().catch((e) => fail(e.message))