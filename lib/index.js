/**
 * dsh-hykb-scroll —— 宿主侧插件（设置壳 + 监听调度）
 *
 * 挂三条东西：
 *   1. 设置页 API：/dsh-hykb/api/settings → 读写 ~/.dsh/hykb-scroll.config.json
 *   2. 扫码登录：/dsh-hykb/api/auth/qr/{start,poll} → 复刻 QRLogin 状态机
 *   3. 监听循环：按 listen.intervalSec 读帖子 → 找 @我 的楼层 → AI 生成回复 → 发楼中楼
 *
 * 所有出网请求都过 tools/lib/traffic.mjs（读写分桶预算 + 写冷却 + 撞风控退避），
 * 所有写操作都追加到 ~/.hykb-ai/audit.jsonl。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { startBrowseClock } from './browse-clock.js'
import { withJitter } from './jitter.js'
// 静态引入工具链的路径层与配置层：配置/凭据位置、默认值、密钥落盘口径都只有那一份实现。
import * as P from '../tools/lib/paths.mjs'
import * as C from '../tools/lib/config.mjs'
// 运行日志 / 测试模式 / 一键自检：插件自己的东西，不随 toolsPath 漂移
import * as A from '../tools/lib/activity.mjs'
import * as T from '../tools/lib/testmode.mjs'
import * as S from '../tools/lib/selftest.mjs'
// 身份层：多账号 / 多人设的清单与指针。与 P/C 同源（静态引入），不加进延迟加载，免得迁移在错误的 toolsPath 上跑。
import * as PR from '../tools/lib/profiles.mjs'
// 快爆Pro账号（自建账号，与快爆官方无关）+ 云同步：契约见 CLOUD-CONTRACT.md
import * as CL from '../tools/lib/cloud.mjs'
// 扫码登录的二维码图由服务端生成（qrcode 是既有依赖），前端只负责 <img src>。
import QRCode from 'qrcode'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const HOME = process.env.USERPROFILE || os.homedir()
const DSH_HOME = process.env.DSH_HOME || path.join(HOME, '.dsh')
// 配置/凭据路径统一走 tools/lib/paths.mjs —— 那边认 HYKB_SCROLL_CONFIG 覆盖，这里别再硬编码一份。
const CFG_FILE = P.configPath()
// 凭据与人设都跟着「当前账号 / 当前人设」变，所以只能现算 ——
// 缓存成模块级常量的话，切完号这两个路径还指着上一个号。
const credFile = () => P.credentialsPath()
const personaFile = () => P.personaPath(PR.activePersonaId())
const MASK = '••••••••'

const FILTER = () => Object.fromEntries(C.FILTER_KEYS.map((k) => [k, []]))
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v)
const merge = C.merge

/** 默认配置只有一份（tools/lib/config.mjs 的 DEFAULTS），这里不再抄第二份。 */
function readConfig() {
  const cfg = C.config()
  let hasUser = false
  try { hasUser = Object.keys(C.readRaw()).length > 0 } catch {}
  return { ...cfg, __hasUserFile: hasUser }
}
/** 实际跑的配置：测试模式下在内存里放宽到最小限制（不写盘、不动安全阀），关掉测试模式即恢复原配置。 */
function runtimeConfig() {
  return T.effective(readConfig())
}
/** 一行运行日志：控制台照打，同时归类进运行日志（activity.jsonl）。 */
const logRun = (src) => (m) => {
  try { console.log('[hykb-scroll] ' + m) } catch {}
  try { A.fromLog(m, { src }) } catch {}
}
const MODE_NAME = (c) => (T.isTestMode(c) ? '测试模式' : c.listen?.enabled && c.browse?.enabled ? '两个都要' : c.listen?.enabled ? '只回 @' : c.browse?.enabled ? '只刷不发' : '先关着')
/** 写盘交给 config.mjs：apiKey 会被搬进 ~/.hykb-ai/ai-key，配置里不留明文。 */
function writeConfig(next) {
  const patch = { ...next }
  delete patch.__hasUserFile
  return C.writeConfig(patch)
}
const listOf = (v) => (Array.isArray(v) ? v : String(v ?? '').split(/[\s,，]+/)).map((x) => String(x).trim()).filter(Boolean)

/** items / forums 统一成 [{ id, title }]。必须在 String() 之前判对象，否则全部烤成 "[object Object]"。 */
const toIdTitle = (v) => {
  const arr = Array.isArray(v) ? v : String(v ?? '').split(/[\s,，]+/)
  const out = []
  for (const x of arr) {
    if (isObj(x) || typeof x === 'object' && x !== null) {
      const id = String(x.id ?? x.value ?? '').trim()
      if (id) out.push({ id, title: String(x.title ?? x.label ?? '').trim() })
    } else {
      const id = String(x ?? '').trim()
      if (id) out.push({ id, title: '' })
    }
  }
  return out
}

/** 请求体 JSON 解析：畸形返回 null，由调用方回 400，不抛成 500。 */
const parseBody = (raw) => {
  const t = String(raw || '').trim()
  if (!t) return {}
  try {
    const v = JSON.parse(t)
    return v && typeof v === 'object' ? v : null
  } catch { return null }
}

/** 布尔型数字字段：0 是合法值，不能用 || 兜底（否则 replyMax:0 会变成 3）。 */
const numOr = (v, def, lo, hi) => {
  const n = Number(v)
  if (!Number.isFinite(n)) return def
  return Math.min(hi, Math.max(lo, n))
}

/** 设置页可能传来字符串或数组，统一成数组；数字字段卡范围 */
function normalizeListen(l) {
  l.intervalSec = numOr(l.intervalSec, 60, 20, 3600)
  l.maxTopicsPerTick = numOr(l.maxTopicsPerTick, 6, 1, 20)
  l.maxRepliesPerTick = numOr(l.maxRepliesPerTick, 3, 1, 20)
  // 抖动：0 = 不抖；上限卡 300 秒，抖得比间隔还宽就成了随机扫
  l.jitterSec = numOr(l.jitterSec, 3, 0, 300)
  // 创作/官方内容不回复：三个开关默认开，官方还带白/黑名单
  const sk = isObj(l.skip) ? l.skip : (l.skip = {})
  for (const k of ['essence', 'official', 'contribution']) sk[k] = sk[k] !== false
  sk.officialAllow = listOf(sk.officialAllow)
  sk.officialDeny = listOf(sk.officialDeny)
  l.allDay = l.allDay !== false
  // @ 触发口径：非法值一律回 both，不然设置页传个拼错的字符串就变成"永远不回"
  l.triggerMode = ['both', 'rich', 'plain'].includes(l.triggerMode) ? l.triggerMode : 'both'
  if (!Array.isArray(l.windows) || !l.windows.length) l.windows = [{ start: '08:00', end: '24:00' }]
  l.windows = l.windows.map((w) => ({ start: String(w?.start || '08:00'), end: String(w?.end || '24:00') }))
  for (const key of ['forum', 'topic', 'at', 'atme']) {
    const src = isObj(l[key]) ? l[key] : (l[key] = {})
    // atme 是唯一「不填任何 id 也能干活」的源，默认开着；其余三个默认关着
    src.enabled = key === 'atme' ? src.enabled !== false : src.enabled === true
    // items 统一成 [{id,title}]：纯字符串（板块 id / 帖子链接）也认
    src.items = toIdTitle(src.items)
    for (const k of Object.keys(FILTER())) src[k] = listOf(src[k])
    if (key === 'at') src.forums = toIdTitle(src.forums)
  }
  l.topic.floors = l.topic.floors !== false
  l.topic.comments = l.topic.comments !== false

  // ⑤ 回复我的：三类通知各一个开关。enabled / onFloor / onComment 默认开，
  //    onPost（自己帖子下的新回复）默认关 —— 默认不让它在自己楼里跟每个人各聊一句。
  const rp = isObj(l.replies) ? l.replies : (l.replies = {})
  for (const k of ['enabled', 'onFloor', 'onComment']) rp[k] = rp[k] !== false
  rp.onPost = rp.onPost === true
  rp.maxAgeMin = numOr(rp.maxAgeMin, 720, 30, 20160)   // 30 分钟 ~ 14 天
  for (const k of Object.keys(FILTER())) rp[k] = listOf(rp[k])

  // ⑥ 假 @ 兜底：每轮最多扫几帖。上限卡 10：再多就是拿读额度换覆盖面，不值。
  const sm = isObj(l.scanMine) ? l.scanMine : (l.scanMine = {})
  sm.enabled = sm.enabled !== false
  sm.maxTopicsPerTick = numOr(sm.maxTopicsPerTick, 2, 1, 10)
  return l
}

/**
 * 内容安全：三类开关 + 两张词表 + 命中话术。
 * 三类开关只有「显式 false」才关 —— 别的写法（缺字段、undefined、字符串 "false"）一律当开，
 * 默认不拦才叫漏洞。
 */
function normalizeSafety(s) {
  // 内容安全是硬开关：总闸、三类违禁词、两道闸一律强制开启，配置里写 false 也不生效（设置页已无关闭档位）。
  for (const k of ['enabled', 'politics', 'sexual', 'violence', 'blockInbound', 'blockOutbound']) s[k] = true
  // 发帖走平台的 mask=1（命中敏感词也照发）。这是可关的真开关，所以放在上面的强制列表之外。
  s.forceMask = s.forceMask !== false
  s.notifyOwner = s.notifyOwner !== false
  // 出站命中后要不要也回一句话术：这个默认关（那种情况宁可不发）
  s.replyOnOutbound = s.replyOnOutbound === true
  s.extraWords = listOf(s.extraWords).slice(0, 200)
  s.allowWords = listOf(s.allowWords).slice(0, 200)
  // 话术是直接发到论坛的死文本，必须单行、限长；全角标点保留，只压换行
  // 命中话术是固定文本：上面那行注释还写着「全角标点保留」，这里直接钉死成常量，改配置也不生效。
  s.refuseText = C.FIXED_REFUSE_TEXT
  // 平台侧敏感词预检。appid / 地址 / 参数都在这里清洗；密钥只透传，
  // 由上面保存流程搬进 ~/.hykb-ai/maskword-key（配置里永远留空）。
  const mw = isObj(s.maskword) ? s.maskword : {}
  mw.enabled = mw.enabled === true
  mw.appid = String(mw.appid ?? '').trim().slice(0, 64)
  mw.url = String(mw.url ?? '').trim().slice(0, 300) || 'https://w.mobayx.com/test/matchService.do'
  mw.level = numOr(mw.level, 1, 0, 9)
  mw.byPinyin = mw.byPinyin === true
  mw.simpleMatch = mw.simpleMatch !== false
  mw.timeoutMs = numOr(mw.timeoutMs, 3000, 500, 10000)
  mw.blockOnError = mw.blockOnError === true
  mw.key = typeof mw.key === 'string' ? mw.key : ''
  s.maskword = mw
  return s
}

/**
 * 中转站线路：每条 { id, name, baseUrl, model, enabled }。
 * 密钥不在这里（会被整份回写），按 id 存 relay-keys.json。
 * id 只允许 [a-z0-9_-]，因为它同时是密钥表的键，脏 id 会把密钥表写成一团。
 */
function normalizeRelays(ai) {
  const seen = new Set(['direct'])
  const out = []
  for (const r of Array.isArray(ai.relays) ? ai.relays : []) {
    if (!r || typeof r !== 'object') continue
    const id = String(r.id ?? '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32)
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push({
      id,
      name: String(r.name ?? '').trim().slice(0, 40) || id,
      baseUrl: String(r.baseUrl ?? '').trim().slice(0, 300),
      model: String(r.model ?? '').trim().slice(0, 120),
      enabled: r.enabled !== false,
    })
  }
  ai.relays = out.slice(0, 12)
  // activeRelay 指向不存在的线路就回落 direct，不然会变成「一条都不走」
  const active = String(ai.activeRelay ?? 'direct').trim().toLowerCase()
  ai.activeRelay = active === 'direct' || ai.relays.some((r) => r.id === active) ? (active || 'direct') : 'direct'
  ai.fallback = ai.fallback !== false
  // DeepSeek 官方 safety_check：强制 high，不接受前端传别的值。
  // 官方接口是必须带的合规项，"能关掉"本身就不该存在。
  ai.safetyCheck = 'high'
  return ai
}

/**
 * 四维权重归一化：和必须为 1，否则「分数」的量纲会跟着配置漂。
 * 四项全给 0 / 给错类型 → 退回默认权重（不报错，避免设置页一次误输入把日报搞停）。
 */
function normalizeWeights(w) {
  const DEF = { heat: 0.3, discussion: 0.35, quality: 0.22, freshness: 0.13 }
  const src = w && typeof w === 'object' ? w : {}
  const out = {}
  let sum = 0
  for (const k of Object.keys(DEF)) {
    const v = Number(src[k])
    out[k] = Number.isFinite(v) && v >= 0 ? v : DEF[k]
    sum += out[k]
  }
  if (!(sum > 0)) return { ...DEF }
  for (const k of Object.keys(out)) out[k] = Math.round((out[k] / sum) * 1000) / 1000
  return out
}

/** 游戏评价观察的归一化：只读功能，但「一轮读几个游戏 / 每游戏读几条」照样要卡住。 */
function normalizeGames(g) {
  g.enabled = g.enabled === true
  g.source = ['hot', 'sugar', 'expect', 'down'].includes(String(g.source)) ? String(g.source) : 'hot'
  g.pick = numOr(g.pick, 3, 1, 10)
  g.maxComments = numOr(g.maxComments, 20, 1, 50)
  g.minLen = numOr(g.minLen, 12, 1, 200)
  g.items = (Array.isArray(g.items) ? g.items : listOf(g.items))
    .map((x) => (x && typeof x === 'object'
      ? { id: String(x.id ?? '').trim(), title: String(x.title ?? '').trim().slice(0, 40) }
      : { id: String(x ?? '').trim(), title: '' }))
    .filter((x) => /^\d{1,10}$/.test(x.id))
    .filter((x, i, a) => a.findIndex((y) => y.id === x.id) === i)
    .slice(0, 50)
  return g
}

/**
 * 只回"能不能用"，不回显任何凭据内容。
 * 重点：hasPauth 为假时 present 也算假 —— 只有 uid 没有 Pauth 是半张票，
 * 读帖能跑但写操作一律 5001，界面上不该显示成"已登录"。
 */
function credState() {
  try {
    const c = JSON.parse(fs.readFileSync(credFile(), 'utf8'))
    const hasPauth = !!c.Pauth
    return {
      present: !!(c.uid && hasPauth),
      uid: c.uid || '',
      nickname: c.nickname || '',
      hasPauth,
      needLogin: !(c.uid && hasPauth),
      why: !c.uid ? '没有登录态' : (!hasPauth ? '只有 uid 没有 Pauth（半张票）：能读不能写，重新扫码登录一次' : ''),
    }
  } catch { return { present: false, uid: '', nickname: '', hasPauth: false, needLogin: true, why: '没有凭据文件' } }
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(obj))
}
function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('body too large')); req.destroy(); return } chunks.push(c) })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

// 归一化函数单独导出：它们在保存设置时把关，值得被单测直接打（不然只能靠点设置页试）
export { normalizeListen, normalizeGames, normalizeSafety }

export default {
  name: 'dsh-hykb-scroll',
  // 注意：inject 只能写一个数组。写成两个对象键会互相覆盖 → sessionController 拿不到 → 生物钟静默不干活。
  inject: ['webServer', 'connection', 'sessionController'],
  apply(ctx) {
    function isLoopbackReq(req) {
      const host = String(req.headers?.host ?? '').toLowerCase()
      const h = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]
      return h === '127.0.0.1' || h === 'localhost' || h === '[::1]' || h === '::1'
    }
    function isTrustedReq(req) {
      if (isLoopbackReq(req)) return true
      try {
        const conn = ctx.get('connection') || ctx.connection
        if (conn && typeof conn.isTrusted === 'function') return conn.isTrusted(req) === true
      } catch {}
      return false
    }
    /** 安全组件默认值必须是"关"：栅栏不可用 → 拒绝 */
    function rejected(req, res) {
      if (isTrustedReq(req) === false) { json(res, 403, { ok: false, error: '不受信任的访问来源' }); return true }
      try {
        const conn = ctx.get('connection') || ctx.connection
        if (!conn || typeof conn.requestRejection !== 'function') {
          if (!rejected.warned) { rejected.warned = true; console.warn('[hykb-scroll] 信任栅栏不可用 → fail-closed') }
          json(res, 503, { ok: false, error: '信任栅栏不可用，拒绝访问（fail-closed）' }); return true
        }
        const code = conn.requestRejection(req)
        if (code === undefined || code === null || code === false) return false
        res.statusCode = typeof code === 'number' ? code : 403
        res.end()
        return true
      } catch {
        json(res, 503, { ok: false, error: '信任栅栏异常，拒绝访问（fail-closed）' }); return true
      }
    }

    const disposers = []
    function route(kind, pathname, handler) {
      disposers.push(ctx.webServer.register({
        kind, path: pathname,
        handler: async (req, res) => {
          if (rejected(req, res)) return
          try { await handler(req, res) } catch (err) {
            try { json(res, 500, { ok: false, error: String(err?.message ?? err) }) } catch {}
          }
        },
      }))
    }
    ctx.effect(() => () => { for (const d of disposers) { try { d() } catch {} } })

    /** 延迟加载工具链模块（插件加载失败不能拖垮整个 DSH）；Windows 绝对路径必须转成 file:// URL 才能 import */
    const toolsDir = () => readConfig().toolsPath || path.join(HERE, '..', 'tools')
    const L = (name) => import(pathToFileURL(path.join(toolsDir(), 'lib', name)).href)

    // 一次性迁移：把改造前的单号布局搬成「多账号 + 多人设」。幂等，只复制不删除，
    // 失败也不拦插件启动 —— 原因折进 /status.migration 让设置页看得见。
    let migration = { migrated: false, accountId: '', personaId: '', error: '' }
    try { migration = { ...PR.migrate() } } catch (e) { migration = { migrated: false, error: String(e?.message ?? e) } }
    if (migration.migrated) { try { console.log('[hykb-scroll] 身份迁移完成：账号 ' + (migration.accountId || '（无）') + ' / 人设 ' + migration.personaId) } catch {} }
    if (migration.error) { try { console.warn('[hykb-scroll] 身份迁移有问题：' + migration.error) } catch {} }

    /** 账号 / 人设 / 线路的统一视图：设置页与状态栏都读这一份。 */
    function profilesView() {
      let accs = []
      try { accs = PR.accounts() } catch (e) { accs = [] }
      let ps = []
      try { ps = PR.personas() } catch (e) { ps = [] }
      const cfg = C.config()
      const keys = C.loadRelayKeys()
      const linesList = [{ id: 'direct', name: '直连', model: cfg.ai?.model || '', hasKey: Boolean(cfg.ai?.apiKey), enabled: true }]
      for (const r of Array.isArray(cfg.ai?.relays) ? cfg.ai.relays : []) {
        linesList.push({ id: r.id, name: r.name || r.id, model: r.model || '', hasKey: Boolean(keys[r.id]), enabled: r.enabled !== false })
      }
      return {
        accounts: accs,
        personas: ps,
        lines: linesList,
        active: { account: PR.activeAccountId(), persona: PR.activePersonaId(), line: cfg.ai?.activeRelay || 'direct' },
      }
    }

    /**
     * 等当前这一轮跑完再切身份。
     * 轮内换号的后果是具体的：前半轮用 A 的 cookie 读到了 A 的通知，
     * 后半轮 loadCred() 已经拿到 B 的票，就会用 B 的身份去回 A 收到的消息。
     */
    async function awaitIdle(ms = 60000) {
      const t0 = Date.now()
      while (sched.busy) {
        if (Date.now() - t0 > ms) return false
        await new Promise((r) => setTimeout(r, 200))
      }
      return true
    }
    /** 切完身份让调度按新配置重算：正在跑的那轮不会被撕开，只是下一轮按新身份排。 */
    function reschedule() {
      try {
        sched.stop()
        const rc = runtimeConfig()
        if ((rc.listen?.enabled || rc.followback?.enabled)) sched.start()
      } catch {}
    }

    /* ───────────────── 设置 ───────────────── */
    const KNOWN = new Set(['owner', 'self', 'ai', 'persona', 'prompt', 'listen', 'browse', 'games', 'risk', 'summary', 'post', 'followback', 'test', 'toolsPath', 'safety', 'like', 'emoji'])
    route('exact', '/dsh-hykb/api/settings', async (req, res) => {
      if (req.method === 'GET') {
        const cfg = readConfig()
        // 密钥永不回显：只告诉前端"填过没"，回一个掩码占位。
        // 中转站密钥同理：每条线路只说「有没有」，真值不出这个进程。
        const relayKeys = C.loadRelayKeys()
        cfg.ai = {
          ...cfg.ai,
          apiKey: cfg.ai?.apiKey ? MASK : '',
          relays: (cfg.ai?.relays || []).map((r) => ({ ...r, hasKey: Boolean(relayKeys[r.id]) })),
        }
        // 平台预检密钥同理：只告诉前端「填过没」，真值不出这个进程
        cfg.safety = { ...(cfg.safety || {}) }
        cfg.safety.maskword = { ...(cfg.safety.maskword || {}), key: C.loadMaskwordKey() ? MASK : '' }
        let profiles = null
        try { profiles = profilesView() } catch {}
        json(res, 200, { ok: true, config: cfg, credentials: credState(), profiles, configPath: CFG_FILE, credPath: credFile(), interestTags: C.INTEREST_TAGS })
        return
      }
      if (!isTrustedReq(req)) { json(res, 403, { ok: false, error: '不受信任的访问来源' }); return }
      if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
      const body = parseBody(await readBody(req))
      if (!body) { json(res, 400, { ok: false, error: '请求体不是合法 JSON' }); return }
      const cur = readConfig(); delete cur.__hasUserFile
      const prevListen = JSON.parse(JSON.stringify(cur.listen || {}))
      const incoming = isObj(body.config) ? body.config : (isObj(body) ? body : {})
      const filtered = {}
      for (const [k, v] of Object.entries(incoming)) if (KNOWN.has(k)) filtered[k] = v
      const next = merge(cur, filtered)
      // 外层键即使传成 null / 字符串也要变成对象，否则下面 next.risk.writeGapSec 直接 TypeError
      for (const k of ['owner', 'self', 'ai', 'prompt', 'listen', 'browse', 'games', 'risk', 'summary', 'post', 'followback', 'safety']) {
        if (!isObj(next[k])) next[k] = isObj(cur[k]) ? { ...cur[k] } : {}
      }
      // summary.maxComments 是深读楼层上限：设置页能改就也得卡范围，否则 1e9 会把整帖拉下来
      next.summary.maxComments = numOr(next.summary.maxComments, 50, 1, 500)
      next.ai.temperature = numOr(next.ai.temperature, 0.7, 0, 2)
      next.ai.maxTokens = numOr(next.ai.maxTokens, 800, 50, 4000)
      // 掩码原样回传 = 没改密钥，保住原来的
      if (next.ai && next.ai.apiKey === MASK) next.ai.apiKey = cur.ai?.apiKey || ''
      if (next.ai && typeof next.ai.apiKey === 'string') next.ai.apiKey = next.ai.apiKey.trim()
      // 中转站密钥：前端单独送一张 { relayId: key } 的表进来，只在这里落盘，
      // 掩码原样回来 = 那条没改，保住原值。空串 = 用户明确清掉这条的密钥。
      if (isObj(body.keys) || isObj(body.relayKeys)) {
        const incomingKeys = isObj(body.keys) ? body.keys : body.relayKeys
        const old = C.loadRelayKeys()
        const merged = { ...old }
        for (const [id0, v] of Object.entries(incomingKeys)) {
          const id = String(id0 || '').trim().toLowerCase()
          if (!id || id === 'direct') continue          // 直连的密钥仍走 ai-key，不进这张表
          const key = String(v ?? '')
          if (key === MASK) continue                     // 没改
          if (!key.trim()) delete merged[id]
          else merged[id] = key.trim()
        }
        C.saveRelayKeys(merged)
      }
      // 范围校验：别让设置页写负数或离谱值
      next.listen.intervalSec = numOr(next.listen.intervalSec, 60, 20, 3600)
      next.risk.writeGapSec = numOr(next.risk.writeGapSec, 120, 30, 3600)
      next.risk.writeHourly = numOr(next.risk.writeHourly, 12, 1, 60)
      next.risk.writeDaily = numOr(next.risk.writeDaily, 30, 1, 300)
      next.risk.readHourly = numOr(next.risk.readHourly, 600, 60, 6000)
      next.risk.readDaily = numOr(next.risk.readDaily, 3000, 300, 50000)
      next.risk.minGapMs = numOr(next.risk.minGapMs, 1500, 500, 10000)
      normalizeListen(next.listen)
      // 刷帖范围钳制：间隔太短会白烧读额度，pick 太大会让 AI 开始编
      const B = next.browse || (next.browse = {})
      B.intervalSec = numOr(B.intervalSec, 3600, 300, 86400)
      B.jitterSec = numOr(B.jitterSec, 60, 0, 1800)
      B.pages = numOr(B.pages, 1, 1, 5)
      // 今日全量覆盖：板块数上限从「6 个精选」放宽到「目录全部」，否则又变回抽样。
      B.maxSections = numOr(B.maxSections, 60, 1, 200)
      B.pick = numOr(B.pick, 8, 1, 20)
      B.deep = numOr(B.deep, 8, 0, 8)
      B.replyMax = numOr(B.replyMax, 3, 0, 10)
      B.replyMinScore = numOr(B.replyMinScore, 70, 0, 100)
      B.minScore = numOr(B.minScore, 0, 0, 100)
      if (!B.coverage || typeof B.coverage !== 'object') B.coverage = {}
      B.coverage.crawlMaxRequests = numOr(B.coverage.crawlMaxRequests, 140, 20, 600)
      B.coverage.maxSections = numOr(B.coverage.maxSections ?? B.maxSections, 60, 1, 200)
      B.weights = normalizeWeights(B.weights)
      // 个性化题材：tags 只认内置清单（设置页就是点这个清单），custom 是自由文本。
      // weight=0 表示关掉这套加权 —— 那时打分与没有这个功能时逐帖相等。
      const IT = isObj(B.interests) ? B.interests : (B.interests = {})
      IT.tags = listOf(IT.tags).filter((t) => C.INTEREST_TAGS.includes(t)).slice(0, 20)
      IT.custom = listOf(IT.custom).slice(0, 20)
      IT.weight = numOr(IT.weight, 10, 0, 30)
      B.perSectionMax = numOr(B.perSectionMax, 2, 1, 20)
      B.perAuthorMax = numOr(B.perAuthorMax, 1, 1, 20)
      B.perAuthorMaxOfficial = numOr(B.perAuthorMaxOfficial, 3, 1, 20)
      B.officialMax = numOr(B.officialMax, 3, 0, 20)
      B.lowSignal = B.lowSignal && typeof B.lowSignal === 'object' ? B.lowSignal : {}
      B.lowSignal.minViews = numOr(B.lowSignal.minViews, 30, 0, 1e6)
      B.lowSignal.minContent = numOr(B.lowSignal.minContent, 50, 0, 1e5)
      B.excludeSelf = B.excludeSelf !== false
      if (!Array.isArray(B.windows) || !B.windows.length) B.windows = [{ start: '08:00', end: '24:00' }]
      B.windows = B.windows.map((w) => ({ start: String(w?.start || '08:00'), end: String(w?.end || '24:00') }))
      // 设置页的 list 字段在输入过程中是字符串（"23064,3"），不转成数组 browse.mjs 的 .map 会炸
      // 板块可以是纯 id 字符串（老配置），也可以是 {id,title}（界面选择器存的）
      B.sections = (Array.isArray(B.sections) ? B.sections : listOf(B.sections))
        .map((x) => (x && typeof x === 'object'
          ? { id: String(x.id ?? '').trim(), title: String(x.title ?? '').trim().slice(0, 40) }
          : { id: String(x ?? '').trim(), title: '' }))
        .filter((x) => /^\d{1,12}$/.test(x.id))
        .filter((x, i, a) => a.findIndex((y) => y.id === x.id) === i)
        .slice(0, 30)
      B.muteTitles = listOf(B.muteTitles)
      B.defaultSections = listOf(B.defaultSections)
      for (const k of Object.keys(FILTER())) B[k] = listOf(B[k])
      B.allDay = B.allDay !== false
      B.skipTop = B.skipTop !== false
      B.autoReply = B.autoReply === true
      B.wake = B.wake !== false
      B.sessionId = String(B.sessionId || 'hykb-scroll').trim() || 'hykb-scroll'
      if (!Array.isArray(B.defaultSections) || !B.defaultSections.length) {
        B.defaultSections = ['23064', '3', '134', '31959', '41278', '58124']
      }
      normalizeGames(next.games)
      normalizeSafety(next.safety)
      // 平台预检的密钥：掩码原样回来 = 没改（真值在 maskword-key 文件里，不动）；
      // 输入框清空 = 明确要删；真填了新的就交给 writeConfig 搬进文件，配置里不留明文。
      {
        const km = next.safety && next.safety.maskword
        if (km && typeof km.key === 'string') {
          if (km.key === MASK) km.key = ''
          else if (!km.key.trim()) C.saveMaskwordKey('')
        }
      }
      // 表情没有总开关了（小表情/表情包都由 emoji.mjs 决定），老配置里的 emoji.enabled 顺手清掉，
      // 免得留一个永远不生效的键，让人以为关掉它就真能关表情。
      if (!next.emoji || typeof next.emoji !== 'object') next.emoji = {}
      delete next.emoji.enabled
      // 楼中楼带表情改成默认能力，不再给开关：配置里写 false 也不生效。
      next.emoji.inComment = true
      normalizeRelays(next.ai)
      next.risk.gapJitterMs = numOr(next.risk.gapJitterMs, 400, 0, 3000)
      next.risk.dedupeDays = numOr(next.risk.dedupeDays, 14, 0, 365)
      next.risk.dedupeSimilar = Math.min(1, Math.max(0.5, Number(next.risk.dedupeSimilar) || 0.86))

      // 提示词：规则是自由文本，后缀会原样贴在每条发出去的话后面，卡长度
      next.prompt.rules = String(next.prompt.rules ?? '').slice(0, 4000)
      // 后缀：用户填了就用他的，没填就强制用「-内容由AI生成」（AI 内容必须带标识，不给关）。
      // 只允许常见标点 / 汉字 / 英文 / 数字，别的字符（换行、零宽、花哨符号）在这里清掉，
      // 免得贴到论坛上显示错乱，也免得被当成绕过手段。
      next.prompt.suffix = C.cleanSuffix(next.prompt.suffix)
      // 发帖：板块只认 {id,title}；每日上限卡死，日报每小时一轮，不卡就刷屏
      const Po = next.post
      Po.enabled = Po.enabled === true
      Po.links = Po.links !== false
      const sec = isObj(Po.section) ? Po.section : { id: typeof Po.section === 'string' ? Po.section : '' }
      // 板块 ID 不合法就清空，不去「修」它：12a 修成 12 可能发到完全不相干的板块
      const sid = String(sec.id ?? '').trim()
      Po.section = /^\d{1,12}$/.test(sid) ? { id: sid, title: String(sec.title ?? '').trim().slice(0, 40) } : { id: '', title: '' }
      Po.title = String(Po.title ?? '').trim().slice(0, 60) || '快爆论坛日报 {date}'
      Po.maxPerDay = numOr(Po.maxPerDay, 1, 1, 5)
      Po.minPicks = numOr(Po.minPicks, 3, 1, 20)
      // 自动回关：写操作，日限与翻页都要卡住；开关只认 true
      const Fb = next.followback
      Fb.enabled = Fb.enabled === true
      Fb.onlyNonMutual = Fb.onlyNonMutual !== false
      Fb.dailyCap = numOr(Fb.dailyCap, 20, 1, 100)
      Fb.maxPages = numOr(Fb.maxPages, 3, 1, 10)
      next.test = { enabled: isObj(next.test) && next.test.enabled === true }

      /* ───── 保存闸：所有「用户自己写的文本」逐项过审核 ─────
         放在归一化之后、写盘之前：审的是**即将落盘的那份值**，不是原始输入。
         覆盖：角色名 / 称呼 / 说话风格 / 提示词规则 / 末尾一句 / 帖子标题 /
              命中话术 / 中转站名称与模型名，以及人设补充。
         命中就整份拒绝，`blocked` 里带上分组与逐项位置，前端据此高亮。

         ⚠️ 只回位置与类目，**不回命中词** —— 回显等于递给想绕的人一份换词清单。 */
      // 人设是否在本次请求里被改动 + 它的内容（供保存闸与写盘共用，声明在 try 之外）
      const personaTouched = Object.prototype.hasOwnProperty.call(incoming, 'personaText')
      const personaText = personaTouched ? String(incoming.personaText ?? '') : ''
      try {
        const SAFE = await L('safety.mjs')
        // 人设补充落在 persona.md，不在配置文件里。它只该在**本次提交动了它**时才参与审核：
        // 否则文件里一个早就存在的词会把之后每一次保存（连改个开关）全部挡死，
        // 用户会看到"什么都没改却存不进去"，完全无从下手。


        const hits = []
        const reviewed = SAFE.reviewTexts(next)
        if (!reviewed.ok) hits.push(...reviewed.hits)
        if (personaTouched && personaText) {
          const bad = SAFE.screenOutbound(personaText, next)
          if (!bad.ok) hits.push({ label: '人设补充', group: 'voice', why: bad.why, cat: bad.cat })
          else {
            const jb = SAFE.scanJailbreak(personaText)
            if (!jb.ok) hits.push({ label: '人设补充', group: 'voice', why: 'jailbreak', cat: 'jailbreak' })
          }
        }

        // 破甲模型：直连和每条中转站都要过。命中的那条直接拒存，不静默丢弃。
        const badLines = []
        if (!SAFE.modelVerdict({ model: next.ai.model, baseUrl: next.ai.baseUrl, name: '直连' }).ok) badLines.push('直连')
        for (const r of next.ai.relays) {
          if (!SAFE.modelVerdict({ model: r.model, baseUrl: r.baseUrl, name: r.name }).ok) badLines.push(r.name || r.id)
        }

        if (hits.length || badLines.length) {
          const groups = [...new Set(hits.map((x) => x.group))]
          const parts = []
          if (hits.length) {
            parts.push('这些地方有不合适的内容，拒绝保存：')
            for (const h of hits) parts.push('　· ' + h.label + '（' + (SAFE.describeVerdict({ ok: false, cat: h.cat }) || '不合规') + '）')
          }
          if (badLines.length) parts.push('严禁接入破甲模型：' + badLines.join('、') + ' 的模型名 / 地址有被拆掉安全对齐的特征')
          parts.push('改完会自动重试保存。')
          json(res, 400, {
            ok: false,
            blocked: badLines.length && !hits.length ? 'jailbreak-model' : 'content',
            groups,
            fields: hits.map((x) => ({ label: x.label, group: x.group, cat: x.cat, why: x.why })),
            lines: badLines,
            error: parts.join('\n'),
          })
          return
        }
      } catch (e) {
        // safety.mjs 加载失败不能变成「谁都能存」——fail-closed
        json(res, 503, { ok: false, error: '安全模块不可用，拒绝保存（fail-closed）：' + String(e?.message ?? e) })
        return
      }

      writeConfig(next)
      // 人设随同一次提交写盘（前端把 personaText 一起带上）。
      // 只有本次真的带了才写：不带 = 没动它，不要去覆盖磁盘上已有的内容。
      if (personaTouched) {
        try {
          const file = personaFile()
          fs.mkdirSync(path.dirname(file), { recursive: true })
          const tmp = file + '.' + process.pid + '.tmp'
          fs.writeFileSync(tmp, String(personaText).slice(0, 20000), { mode: 0o600 })
          P.harden(tmp)
          fs.renameSync(tmp, file)
          P.harden(file)
        } catch (e) {
          json(res, 500, { ok: false, error: '配置已保存，但人设写盘失败：' + String(e?.message ?? e) })
          return
        }
      }
      // 模式切换记进运行日志
      try {
        const was = MODE_NAME(cur), now = MODE_NAME(next)
        if (was !== now) A.add({ kind: 'system', text: '切换模式：' + was + ' → ' + now, src: 'run' })
      } catch {}
      // 监听范围变了就清掉旧帖的去重记录，否则换完帖子它永远显示"已回"
      let forgot = 0
      try { const w = await L('watch.mjs'); forgot = w.syncScope(next.listen || {}, prevListen) } catch {}
      // 改完立刻生效：让调度按新配置重算
      try { sched.invalidate() } catch {}
      // 测试模式会在内存里打开回帖：调度没跑就拉起来；切走后 tick 自己会按原配置停车
      try { const rc = runtimeConfig(); if ((rc.listen.enabled || rc.followback?.enabled) && !sched.running) sched.start() } catch {}
      const rk = C.loadRelayKeys()
      const shown = {
        ...next,
        ai: {
          ...next.ai,
          apiKey: next.ai?.apiKey ? MASK : '',
          relays: (next.ai?.relays || []).map((r) => ({ ...r, hasKey: Boolean(rk[r.id]) })),
        },
        // 平台预检密钥：写盘时已经搬进 maskword-key，但 next 在内存里还带着明文，
        // 回包必须换回掩码，否则密钥会顺着保存成功的响应又回到前端
        safety: {
          ...(next.safety || {}),
          maskword: { ...(next.safety?.maskword || {}), key: C.loadMaskwordKey() ? MASK : '' },
        },
      }
      json(res, 200, { ok: true, config: shown, forgot, warn: next.risk.writeDaily > 50 ? '每天 >50 条：看起来像刷量，平台可能限流' : null })
    })

    /* ───────────────── 身份：账号 / 人设 / 线路 三向切换 ───────────────── */
    // GET  → 三张清单 + 当前选择（密钥只报"有没有"，真值不出这个进程）
    // POST → { action, id?, label? }。三个 switch 都先等当前轮跑完；超时回 409，绝不半轮换号。
    route('exact', '/dsh-hykb/api/profiles', async (req, res) => {
      if (req.method === 'GET') { json(res, 200, { ok: true, ...profilesView() }); return }
      if (!isTrustedReq(req)) { json(res, 403, { ok: false, error: '不受信任的访问来源' }); return }
      if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
      const body = parseBody(await readBody(req))
      if (!body) { json(res, 400, { ok: false, error: '请求体不是合法 JSON' }); return }
      const action = String(body.action || '')
      const busy = { ok: false, error: '正在跑一轮，稍后再切（最多等 60 秒）' }
      try {
        if (action === 'switchAccount') {
          const id = String(body.id || '').trim()
          if (!/^\d+$/.test(id)) { json(res, 400, { ok: false, error: '账号 id 不合法' }); return }
          if (!(await awaitIdle())) { json(res, 409, busy); return }
          const switched = PR.switchAccount(id, { personaId: PR.activePersonaId() })
          reschedule()
          try { A.add({ kind: 'system', text: '切换账号：' + id + '（人设 ' + switched.persona + '）', src: 'run' }) } catch {}
          json(res, 200, { ok: true, switched, ...profilesView() })
          return
        }
        if (action === 'switchPersona') {
          if (!(await awaitIdle())) { json(res, 409, busy); return }
          const id = PR.setActivePersona(String(body.id || ''))
          try { A.add({ kind: 'system', text: '切换人设：' + id, src: 'run' }) } catch {}
          json(res, 200, { ok: true, switched: { persona: id }, ...profilesView() })
          return
        }
        if (action === 'switchLine') {
          const id = String(body.id || 'direct').trim().toLowerCase()
          const cfg = C.config()
          const ids = ['direct'].concat((cfg.ai?.relays || []).map((r) => r.id))
          if (!ids.includes(id)) { json(res, 400, { ok: false, error: '没有这条线路：' + id }); return }
          if (!(await awaitIdle())) { json(res, 409, busy); return }
          writeConfig({ ai: { activeRelay: id } })
          try { A.add({ kind: 'system', text: '切换 AI 线路：' + id, src: 'run' }) } catch {}
          json(res, 200, { ok: true, switched: { line: id }, ...profilesView() })
          return
        }
        if (action === 'addPersona') {
          const rec = PR.addPersona(String(body.label || ''))
          json(res, 200, { ok: true, created: rec, ...profilesView() })
          return
        }
        if (action === 'renamePersona') {
          const rec = PR.updatePersona(String(body.id || ''), { label: String(body.label || '') })
          json(res, 200, { ok: true, created: rec, ...profilesView() })
          return
        }
        if (action === 'duplicatePersona') {
          const rec = PR.duplicatePersona(String(body.id || ''))
          json(res, 200, { ok: true, created: rec, ...profilesView() })
          return
        }
        if (action === 'removePersona') {
          const list = PR.removePersona(String(body.id || ''))
          json(res, 200, { ok: true, personas: list, ...profilesView() })
          return
        }
        if (action === 'labelAccount') {
          const acc = PR.labelAccount(String(body.id || ''), String(body.label || ''))
          json(res, 200, { ok: true, account: acc, ...profilesView() })
          return
        }
        if (action === 'retireAccount') {
          PR.retireAccount(String(body.id || ''))
          json(res, 200, { ok: true, ...profilesView() })
          return
        }
        json(res, 400, { ok: false, error: '未知动作：' + action })
      } catch (e) { json(res, 400, { ok: false, error: String(e?.message ?? e) }) }
    })

    /* ───────────────── 快爆Pro账号 · 多端同步 + 主备租约 ───────────────── */
    // 同步与租约跑在宿主里：设置页关掉也照样同步、照样守租约（否则「另一台接替」根本无从成立）。
    // 本机身份（id / 名字 / 主机副机）由 cloud.mjs 统一管：租约靠 id 认人，角色由用户在账号条里选
    const DEVICE = CL.ensureDevice()
    const DEVICE_ID = DEVICE.id
    const DEVICE_NAME = DEVICE.name

    const cloudEngine = {
      syncTimer: null, leaseTimer: null, since: 0, baseline: null, busy: false,
      mine: false, holderName: '', holderUntil: 0, holderRole: '',
      lastSyncAt: 0, lastPushAt: 0, lastPullAt: 0, error: '',
      loggedIn() { return CL.state().loggedIn },
      /** 没登录就没有租约概念：本机照旧跑。登录之后只有主设备跑，备机待命。 */
      running() { return !this.loggedIn() || this.mine },
      status() {
        return {
          lastSyncAt: this.lastSyncAt, lastPushAt: this.lastPushAt, lastPullAt: this.lastPullAt,
          pending: this.busy, error: this.error,
          lease: { mine: this.mine, holderName: this.holderName, until: this.holderUntil, holderRole: this.mine ? 'primary' : this.holderRole },
        }
      },
      /** 一次 reconcile：本地 diff 推上去，再把远端比我新的键拉下来。字段级后写覆盖由云侧合并保证。
       *  定时轮和「立即同步」按钮走的是同一个函数——按钮不是「全量覆盖」，是「立刻对一次账」。 */
      async reconcile() {
        if (this.busy || !this.loggedIn()) return { pushed: 0, pulled: 0 }
        this.busy = true
        const res = { pushed: 0, pulled: 0 }
        try {
          if (this.baseline === null) {
            // 首次同步：先看云端有没有。空的就把本地整份上云；有的就以云端为基线，不拿本地覆盖对方。
            const first = await CL.pullAll(0)
            this.since = first.since
            this.baseline = CL.snapshot()
            res.pulled = first.count
            if (first.count === 0) {
              const now = Date.now(); const kv = {}
              for (const [p, v] of Object.entries(this.baseline)) kv[p] = { v, t: now }
              if (Object.keys(kv).length) { await CL.pushKv(kv); this.lastPushAt = now; res.pushed = Object.keys(kv).length }
            }
            this.lastSyncAt = Date.now(); this.error = ''
            return res
          }
          const cur = CL.snapshot()
          const changed = CL.diffPaths(this.baseline, cur)
          if (changed.length) {
            const now = Date.now(); const kv = {}
            for (const p of changed) kv[p] = { v: cur[p], t: now }
            await CL.pushKv(kv)
            this.lastPushAt = now
            res.pushed = changed.length
          }
          const pulled = await CL.pullAll(this.since)
          if (pulled.count) { this.since = pulled.since; this.lastPullAt = Date.now(); res.pulled = pulled.count }
          this.baseline = CL.snapshot()
          this.lastSyncAt = Date.now(); this.error = ''
        } catch (e) { this.error = String(e?.message ?? e) } finally { this.busy = false }
        return res
      },
      async syncOnce() { await this.reconcile() },
      async heartbeat() {
        if (!this.loggedIn()) { this.setLeader(false, '', 0); return }
        // 关闭：只做云同步，不抢租约；原来握着的先放掉（否则别人一直等它过期）
        if (CL.readDevice().role === 'off') {
          try { if (this.mine) await CL.leaseCall('release', DEVICE_ID, DEVICE_NAME) } catch {}
          this.setLeader(false, '', 0)
          return
        }
        try {
          const r = await CL.leaseCall('claim', DEVICE_ID, DEVICE_NAME)
          this.setLeader(r.mine, r.holder ? String(r.holder.deviceName || r.holder.deviceId || '') : '', r.holder ? Number(r.holder.until) || 0 : 0,
            r.holder ? String(r.holder.role || '') : '')
        } catch (e) { this.error = String(e?.message ?? e) }
      },
      /** 主备切换只做一件事：把跑与不跑换过来，并留一条运行日志。 */
      setLeader(mine, holderName, until, holderRole) {
        const was = this.mine
        this.mine = Boolean(mine)
        this.holderName = this.mine ? '' : holderName
        this.holderUntil = until || 0
        this.holderRole = this.mine ? '' : String(holderRole || '')
        if (was === this.mine) return
        try { A.add({ kind: 'system', src: 'run', text: this.mine ? '拿到主设备租约，本机负责运行' : '主设备在 ' + (holderName || '另一台') + '，本机转待命' }) } catch {}
        try {
          if (!this.mine) sched.stop()
          else if (runtimeConfig().listen?.enabled) sched.start()
        } catch {}
      },
      async release() {
        try { if (this.mine) await CL.leaseCall('release', DEVICE_ID, DEVICE_NAME) } catch {}
      },
      start() {
        if (!this.loggedIn()) return
        this.stop(true)
        this.syncOnce()
        this.heartbeat()
        this.syncTimer = setInterval(() => { this.syncOnce() }, CL.CLOUD.syncMs)
        this.leaseTimer = setInterval(() => { this.heartbeat() }, CL.CLOUD.leaseMs)
        try { this.syncTimer.unref?.() ; this.leaseTimer.unref?.() } catch {}
      },
      stop(keepState) {
        if (this.syncTimer) clearInterval(this.syncTimer)
        if (this.leaseTimer) clearInterval(this.leaseTimer)
        this.syncTimer = null; this.leaseTimer = null
        if (!keepState) { this.since = 0; this.baseline = null; this.setLeader(false, '', 0) }
      },
    }
    /** 待命时把「跑」相关开关在内存里关掉：刷帖时钟读的就是这一份，不用重启时钟。 */
    function syncGatedConfig() {
      const c = runtimeConfig()
      if (cloudEngine.running()) return c
      return { ...c, browse: { ...(c.browse || {}), enabled: false }, listen: { ...(c.listen || {}), enabled: false } }
    }

    /** 备机上手动触发会被抢跑：直接拒绝，别让两台同时回帖。 */
    const standbyReject = (res) => {
      if (cloudEngine.running()) return false
      json(res, 409, { ok: false, error: '这台在待命，主设备正在跑（等它停下，或关掉那台再试）' })
      return true
    }

    route('exact', '/dsh-hykb/api/cloud', async (req, res) => {
      if (req.method !== 'GET') { json(res, 405, { ok: false }); return }
      const st = cloudEngine.status()
      json(res, 200, {
        ok: true,
        account: CL.state(),
        sync: { lastSyncAt: st.lastSyncAt, lastPushAt: st.lastPushAt, lastPullAt: st.lastPullAt, pending: st.pending, error: st.error },
        lease: st.lease,
        device: CL.readDevice(),
        cloud: { baseUrl: CL.CLOUD.baseUrl, schemaVersion: CL.CLOUD.schemaVersion },
      })
    })

    route('exact', '/dsh-hykb/api/cloud/auth', async (req, res) => {
      if (!isTrustedReq(req)) { json(res, 403, { ok: false, error: '不受信任的访问来源' }); return }
      if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
      const body = parseBody(await readBody(req))
      if (!body) { json(res, 400, { ok: false, error: '请求体不是合法 JSON' }); return }
      try {
        const account = await CL.auth({ action: String(body.action || 'login'), username: body.username, password: body.password })
        cloudEngine.start()
        json(res, 200, { ok: true, account })
      } catch (e) { json(res, 400, { ok: false, error: String(e.message) }) }
    })

    route('exact', '/dsh-hykb/api/cloud/logout', async (req, res) => {
      if (!isTrustedReq(req)) { json(res, 403, { ok: false, error: '不受信任的访问来源' }); return }
      if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
      await cloudEngine.release()
      cloudEngine.stop()
      const account = CL.logout()
      json(res, 200, { ok: true, account })
    })

    route('exact', '/dsh-hykb/api/cloud/sync', async (req, res) => {
      if (!isTrustedReq(req)) { json(res, 403, { ok: false, error: '不受信任的访问来源' }); return }
      if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
      const body = parseBody(await readBody(req))
      if (!body) { json(res, 400, { ok: false, error: '请求体不是合法 JSON' }); return }
      const direction = String(body.direction || '')
      if (direction !== 'push' && direction !== 'pull') { json(res, 400, { ok: false, error: 'direction 只能是 push 或 pull' }); return }
      try {
        let summary = ''
        if (direction === 'push') {
          // 「立即同步」= 立刻对一次账（推本地改动 + 拉对方改动），不是拿本机全量盖掉云端
          const r = await cloudEngine.reconcile()
          if (cloudEngine.error) throw new Error(cloudEngine.error)
          summary = '已上传 ' + r.pushed + ' 项 · 已下载 ' + r.pulled + ' 项'
        } else {
          const r = await CL.pullAll(0)
          cloudEngine.since = 0; cloudEngine.baseline = null
          cloudEngine.lastSyncAt = Date.now(); cloudEngine.lastPullAt = Date.now()
          summary = '已下载 ' + (r.count || 0) + ' 项'
        }
        logRun('run')('云同步（' + direction + '）：' + summary)
        json(res, 200, { ok: true, direction, sync: cloudEngine.status(), account: CL.state(), summary })
      } catch (e) { json(res, 500, { ok: false, error: String(e.message) }) }
    })

    // 主机 / 副机：用户在这台机器上选，选完立刻心跳一次，抢占即时生效
    route('exact', '/dsh-hykb/api/cloud/role', async (req, res) => {
      if (!isTrustedReq(req)) { json(res, 403, { ok: false, error: '不受信任的访问来源' }); return }
      if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
      const body = parseBody(await readBody(req))
      const role = String((body && body.role) || '')
      if (role !== 'primary' && role !== 'secondary' && role !== 'off') { json(res, 400, { ok: false, error: 'role 只能是 primary / secondary / off' }); return }
      try {
        CL.writeDeviceRole(role)
        await cloudEngine.heartbeat()   // 关闭时 heartbeat 会先把租约放掉再转待命
        const st = cloudEngine.status()
        const label = role === 'primary' ? '主机' : (role === 'off' ? '关闭（只同步）' : '副机')
        logRun('run')('本机角色改为' + label + (st.lease.mine ? '（正在运行）' : '（待命）'))
        json(res, 200, {
          ok: true,
          account: CL.state(),
          sync: { lastSyncAt: st.lastSyncAt, lastPushAt: st.lastPushAt, lastPullAt: st.lastPullAt, pending: st.pending, error: st.error },
          lease: st.lease,
          device: CL.readDevice(),
        })
      } catch (e) { json(res, 500, { ok: false, error: String(e.message) }) }
    })

    route('exact', '/dsh-hykb/api/cloud/qr/start', async (req, res) => {
      if (!isTrustedReq(req)) { json(res, 403, { ok: false, error: '不受信任的访问来源' }); return }
      if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
      try {
        const r = await CL.qrStart(DEVICE_NAME)
        const qrDataUrl = await QRCode.toDataURL(String(r.url || ''), { margin: 1, width: 220 })
        json(res, 200, { ok: true, code: r.code, expiresAt: r.expiresAt, url: r.url, qrDataUrl })
      } catch (e) { json(res, 500, { ok: false, error: String(e.message) }) }
    })

    route('exact', '/dsh-hykb/api/cloud/qr/poll', async (req, res) => {
      if (!isTrustedReq(req)) { json(res, 403, { ok: false, error: '不受信任的访问来源' }); return }
      if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
      const body = parseBody(await readBody(req))
      if (!body || !body.code) { json(res, 400, { ok: false, error: '缺少 code' }); return }
      try {
        const r = await CL.qrPoll(String(body.code))
        if (r.status === 'ok') cloudEngine.start()
        json(res, 200, { ok: true, status: r.status, account: CL.state() })
      } catch (e) { json(res, 500, { ok: false, error: String(e.message) }) }
    })

    /* ───────────────── 扫码登录 ───────────────── */
    // 扫码会话：给个 TTL（平台二维码本身也就几分钟有效），过期就当没这回事，
    // 别再拿一个几小时前的 qrcode 去轮询；顺便记下轮询次数避免无限转。
    const LOGIN_TTL_MS = 5 * 60 * 1000
    let pendingLogin = null
    const loginAlive = () => {
      if (!pendingLogin) return null
      if (Date.now() - pendingLogin.at > LOGIN_TTL_MS) { pendingLogin = null; return null }
      return pendingLogin
    }
    route('exact', '/dsh-hykb/api/auth/qr/start', async (req, res) => {
      if (!isTrustedReq(req)) { json(res, 403, { ok: false, error: '不受信任的访问来源' }); return }
      if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
      try {
        const { qrCreate } = await L('hykb-api.mjs')
        // 上一次没扫完就作废，但要在响应里说清楚，不然用户以为自己的码被换了很奇怪
        const replaced = Boolean(loginAlive())
        const jar = {}
        const first = await qrCreate()
        if (first.data?.code !== 100 || !first.data?.result?.qrcode) {
          json(res, 503, { ok: false, error: '取二维码失败：' + JSON.stringify(first.data).slice(0, 200) }); return
        }
        Object.assign(jar, first.cookies)
        pendingLogin = { qrcode: first.data.result.qrcode, jar, at: Date.now() }
        // 客户端只拿 dataURL 画 img：服务端 HTML 里没有二维码图像，纯文本抓包看不到
        let image = ''
        try {
          const QR = (await import('qrcode')).default
          image = await QR.toDataURL(pendingLogin.qrcode, { width: 220, margin: 2, errorCorrectionLevel: 'M' })
        } catch (e) { console.warn('[hykb-scroll] 二维码渲染失败：' + e.message) }
        json(res, 200, { ok: true, qrcode: pendingLogin.qrcode, content: pendingLogin.qrcode, image, replaced, expiresInSec: Math.round(LOGIN_TTL_MS / 1000) })
      } catch (e) { json(res, 503, { ok: false, error: String(e.message) }) }
    })
    route('exact', '/dsh-hykb/api/auth/qr/poll', async (req, res) => {
      if (!isTrustedReq(req)) { json(res, 403, { ok: false, error: '不受信任的访问来源' }); return }
      if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
      if (!loginAlive()) { json(res, 400, { ok: false, error: '没有进行中的扫码会话（或已过期），先 start' }); return }
      try {
        const { qrPoll, qrAuthCallback } = await L('hykb-api.mjs')
        const jarMap = new Map(Object.entries(pendingLogin.jar))
        const { data, cookies } = await qrPoll(pendingLogin.qrcode, jarMap)
        for (const [k, v] of Object.entries(cookies)) pendingLogin.jar[k] = v
        const r = data.result || {}
        let phase = 'UNKNOWN'
        // 快爆不下发独立的 uid cookie，uid 藏在 Pauth 第 1 段里，所以判据只看 Pauth。
        // 之前要求 jar.uid && jar.Pauth，uid 永远不来，前端就一直卡在"正在写入登录态"。
        if (pendingLogin.jar.Pauth) phase = 'LOGIN'
        else if (data.code === 102) phase = 'EXPIRED'
        else if (typeof r.status === 'number') phase = ['WAIT', 'SCANNED', 'CONFIRMED', 'CANCELLED'][r.status] || ('STATUS_' + r.status)
        else if (r.uid) phase = 'AUTH'

        // 轮询回 uid 只代表手机端确认了；Pauth 要再调一次 AuthCallBack 才下发。
        // 少了这一步会落出 uid 有、Pauth 空的凭据 —— 页面上看着"登录了"，写操作全是 5001。
        if (phase === 'AUTH') {
          // 手机确认后要再调一次 AuthCallBack 才下发 Pauth。这一步不能无限重试：
          // 之前没有上限，服务端迟迟不给 Pauth 时前端就永远停在"正在写入登录态"。
          pendingLogin.authTries = (pendingLogin.authTries || 0) + 1
          const back = await qrAuthCallback(r, jarMap)
          for (const [k, v] of Object.entries(back.cookies)) pendingLogin.jar[k] = v
          if (back.data?.status === -2) {
            json(res, 200, { ok: true, phase: 'NEED_IDCARD', done: false, error: '这个账号还没实名认证，去网页端补完再扫一次' })
            return
          }
          if (pendingLogin.jar.Pauth) {
            phase = 'LOGIN'
          } else if (pendingLogin.authTries >= 3) {
            const why = '扫码已确认，但服务端 3 次都没下发 Pauth（回包：' + JSON.stringify(back.data).slice(0, 160) + '）'
            pendingLogin = null
            json(res, 200, { ok: true, phase: 'AUTH_FAILED', done: false, error: why })
            return
          } else {
            phase = 'CONFIRMED'
          }
        }

        if (phase === 'LOGIN') {
          const { saveCredFor, deriveCred } = await L('cred.mjs')
          // deriveCred 会把 uid / nickname 从 Pauth 里解出来；解不出来就别写半个文件。
          const raw = deriveCred({
            uid: String(r.uid || ''),
            Pauth: pendingLogin.jar.Pauth || '',
            Uauth: pendingLogin.jar.Uauth || '',
            nickname: pendingLogin.jar.nickname || '',
          })
          pendingLogin = null
          if (!raw.uid) {
            json(res, 200, { ok: true, phase: 'AUTH_FAILED', done: false, error: '扫码已确认，但 uid 解不出来（Pauth 形态变了？），没有写入任何凭据' })
            return
          }
          const cred = saveCredFor(raw.uid, raw)
          PR.registerAccount({ uid: cred.uid, nickname: cred.nickname })
          // 扫码 = 新增/刷新一个号并切到它；先等这一轮跑完，别出现半轮换号。
          await awaitIdle()
          PR.switchAccount(cred.uid, { personaId: PR.activePersonaId() })
          reschedule()
          json(res, 200, { ok: true, phase: 'LOGIN', done: true, uid: cred.uid, nickname: cred.nickname, profiles: profilesView() })
          return
        }
        json(res, 200, { ok: true, phase, done: false })
      } catch (e) { json(res, 503, { ok: false, error: String(e.message) }) }
    })

    /** 手动贴 cookie（扫码不方便时的退路） */
    route('exact', '/dsh-hykb/api/cookie', async (req, res) => {
      if (!isTrustedReq(req)) { json(res, 403, { ok: false, error: '不受信任的访问来源' }); return }
      if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
      try {
        const body = parseBody(await readBody(req))
        if (!body) { json(res, 400, { ok: false, error: '请求体不是合法 JSON' }); return }
        const raw = String(body.cookie || body.text || '')
        const grab = (k) => (raw.match(new RegExp('(?:^|;\\s*)' + k + '=([^;]+)')) || [])[1] || ''
        const { saveCredFor, deriveCred } = await L('cred.mjs')
        // uid 不必单独给：快爆的 uid 就在 Pauth 第 1 段里，deriveCred 会补。
        const cred = deriveCred({
          uid: body.uid || grab('uid'),
          Pauth: body.Pauth || grab('Pauth'),
          Uauth: body.Uauth || grab('Uauth'),
          nickname: body.nickname || grab('nickname'),
        })
        if (!cred.Pauth) { json(res, 400, { ok: false, error: '没找到 Pauth —— 至少要把 Pauth 这一条复制全' }); return }
        if (!cred.uid) { json(res, 400, { ok: false, error: 'Pauth 看着不对（第 1 段应该是纯数字 uid），检查有没有复制全' }); return }
        const saved = saveCredFor(cred.uid, cred)
        PR.registerAccount({ uid: saved.uid, nickname: saved.nickname })
        await awaitIdle()
        PR.switchAccount(saved.uid, { personaId: PR.activePersonaId() })
        reschedule()
        json(res, 200, { ok: true, uid: saved.uid, nickname: saved.nickname, profiles: profilesView() })
      } catch (e) { json(res, 400, { ok: false, error: String(e.message) }) }
    })

    /** 退出登录：删掉本地凭据。不调平台的登出接口——那会把同一账号在别处的网页登录也踢掉。 */
    route('exact', '/dsh-hykb/api/logout', async (req, res) => {
      if (!isTrustedReq(req)) { json(res, 403, { ok: false, error: '不受信任的访问来源' }); return }
      if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
      try {
        // 只登出当前这号：别的号的凭据、台账、人设设置一概不动。
        try { fs.unlinkSync(credFile()) } catch (e) { if (e.code !== 'ENOENT') throw e }
        const cur = readConfig(); delete cur.__hasUserFile
        writeConfig({ ...cur, self: { uid: '', name: '' } })
        try { sched.invalidate() } catch {}
        json(res, 200, { ok: true, credentials: credState(), profiles: profilesView() })
      } catch (e) { json(res, 500, { ok: false, error: String(e.message) }) }
    })

    /* ───────────────── 人设 ───────────────── */
    route('exact', '/dsh-hykb/api/persona', async (req, res) => {
      if (!isTrustedReq(req)) { json(res, 403, { ok: false, error: '不受信任的访问来源' }); return }
      if (req.method === 'GET') {
        let text = ''
        const file = personaFile()
        try { text = fs.readFileSync(file, 'utf8') } catch {}
        // 第一份人设的文件缺失时回落到改造前那份 persona.md（迁移之外的路径不该让写过的字消失）
        if (!text && PR.activePersonaId() === 'p1') { try { text = fs.readFileSync(P.personaPath(), 'utf8') } catch {} }
        let persona = null
        try { persona = C.activePersona() } catch {}
        json(res, 200, { ok: true, text, bytes: Buffer.byteLength(text, 'utf8'), persona })
        return
      }
      if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
      const body = parseBody(await readBody(req))
      if (!body) { json(res, 400, { ok: false, error: '请求体不是合法 JSON' }); return }
      const text = String(body.text ?? '')
      if (text.length > 20000) { json(res, 400, { ok: false, error: '人设太长（上限 20000 字符）' }); return }
      // 人设补充同样直接拼进系统提示 —— 破甲话术在这里也必须拒。同样不回显命中词。
      try {
        const SAFE = await L('safety.mjs')
        const jb = SAFE.scanJailbreak(text)
        if (!jb.ok) {
          json(res, 400, { ok: false, blocked: 'jailbreak', field: '「人设补充」', error: '人设里有疑似「破甲」的话术，拒绝保存。这里会直接拼进系统提示，请删掉那段再存。' })
          return
        }
      } catch (e) {
        json(res, 503, { ok: false, error: '安全模块不可用，拒绝保存（fail-closed）：' + String(e?.message ?? e) })
        return
      }
      const file = personaFile()
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const tmp = file + '.' + process.pid + '.tmp'
      fs.writeFileSync(tmp, text, { mode: 0o600 })
      P.harden(tmp)
      fs.renameSync(tmp, file)
      P.harden(file)
      json(res, 200, { ok: true, bytes: Buffer.byteLength(text, 'utf8') })
    })

    /* ───────────────── 拉模型清单（设置页点选用） ───────────────── */
    route('exact', '/dsh-hykb/api/models', async (req, res) => {
      if (!isTrustedReq(req)) { json(res, 403, { ok: false, error: '不受信任的访问来源' }); return }
      if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
      const body = parseBody(await readBody(req))
      if (!body) { json(res, 400, { ok: false, error: '请求体不是合法 JSON' }); return }
      const cfgM = readConfig()
      const relayId = String(body.relayId || '').trim()
      const relay = relayId ? (cfgM.ai.relays || []).find((r) => r && r.id === relayId) : null
      const baseUrl = String(body.baseUrl || (relay && relay.baseUrl) || cfgM.ai.baseUrl || '').trim()
      // 密钥优先用这次请求里带的（页面上刚敲进去还没保存），否则用已存的那份。
      // 掩码兜底：GET /settings 把已存的密钥回显成 MASK，前端可能把它原样 POST 回来；
      // 这类字符串拼进 Authorization 会让 fetch 抛 ByteString（非 ASCII）。
      // 所以「等于掩码」和「含任何非 ASCII 字符」一律当没传密钥，回退到已存的那份。
      const sent = String(body.apiKey || '').trim()
      const sentKey = sent === MASK || /[^\x20-\x7e]/.test(sent) ? '' : sent
      const key = sentKey
        || (relayId ? (C.relayKey(relayId) || '') : (C.loadAiKey() || ''))
      try {
        const A = await L('ai.mjs')
        const models = await A.listModels({ baseUrl, apiKey: key })
        json(res, 200, { ok: true, models, count: models.length, baseUrl })
      } catch (e) {
        json(res, 400, { ok: false, error: String(e?.message ?? e) })
      }
    })

    /* ───────────────── 状态 / 限流 ───────────────── */
    async function postState() {
      try {
        const { loadPostLog, postedToday } = await L('post.mjs')
        const book = loadPostLog()
        const last = book[book.length - 1] || null
        return { today: postedToday(P.localDay(), book), last: last && { at: last.at, title: last.title, section: last.section, ok: last.ok, msg: last.msg } }
      } catch { return { today: 0, last: null } }
    }
    async function followState() {
      try { const F = await L('followback.mjs'); return F.status({ cfg: readConfig() }) } catch (e) { return { error: String(e.message) } }
    }
    route('exact', '/dsh-hykb/api/status', async (req, res) => {
      try {
        const cfgForStatus = readConfig()
        const { trafficState } = await L('traffic.mjs')
        const { aiReady } = await L('ai.mjs')
        // 线路清单：给设置页显示「现在走哪条、几条可用」。只有 id/name/model，不带密钥。
        let aiLines = []
        try {
          const A2 = await L('ai.mjs')
          aiLines = A2.lines(cfgForStatus).map((x) => ({ id: x.id, name: x.name, model: x.model }))
        } catch {}
        // 复读库概况：让用户能看到「查重现在有多少条底账」
        let dedupe = { total: 0, inWindow: 0, days: 0 }
        try { const D = await L('dedupe.mjs'); dedupe = D.saidStats({ cfg: cfgForStatus }) } catch {}
        json(res, 200, {
          ok: true,
          credentials: credState(),
          aiReady: aiReady() || aiLines.length > 0,
          aiLines,
          dedupe,
          safety: {
            enabled: cfgForStatus.safety?.enabled !== false,
            politics: cfgForStatus.safety?.politics !== false,
            sexual: cfgForStatus.safety?.sexual !== false,
            violence: cfgForStatus.safety?.violence !== false,
            blockInbound: cfgForStatus.safety?.blockInbound !== false,
            blockOutbound: cfgForStatus.safety?.blockOutbound !== false,
          },
          traffic: trafficState(),
          listen: { running: sched.running, lastTickAt: sched.lastTickAt, lastError: sched.lastError, lastResult: sched.lastResult },
          browse: browseClock ? browseClock.status() : { enabled: false, reason: '时钟未启动' },
          post: await postState(),
          follow: await followState(),
          test: { enabled: T.isTestMode(readConfig()), selfTestRunning: S.selfTestRunning() },
          activity: A.counts(),
          // 浏览记录：帖粒度的账。counts 只给今天的条数，列表走 /history
          history: await (async () => { try { const h = await L('history.mjs'); return h.counts() } catch { return { total: 0 } } })(),
          configPath: CFG_FILE,
          migration,
          identity: (() => { try { const v = profilesView(); return v.active } catch { return null } })(),
        })
      } catch (e) { json(res, 500, { ok: false, error: String(e.message) }) }
    })

    /* ───────────────── 内容安全：试词 / 词表 / 清复读库 ───────────────── */
    // POST { action:'test', text }  → 这段文本会被哪一类拦下（设置页「试一句」用）
    // GET  ?list=1                  → 三类内置词表全文（用户要看清楚到底拦什么）
    // POST { action:'clearSaid' }   → 清空复读台账
    route('exact', '/dsh-hykb/api/safety', async (req, res) => {
      if (!isTrustedReq(req)) { json(res, 403, { ok: false, error: '不受信任的访问来源' }); return }
      try {
        const S = await L('safety.mjs')
        if (req.method === 'GET') {
          const url = new URL(req.url, 'http://x')
          if (url.searchParams.get('list')) {
            json(res, 200, {
              ok: true,
              categories: S.CATEGORIES,
              builtin: S.BUILTIN,
              jailbreak: S.JAILBREAK,
              jailbreakModel: S.JAILBREAK_MODEL,
            })
            return
          }
          json(res, 200, { ok: true, categories: S.CATEGORIES })
          return
        }
        if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
        const body = parseBody(await readBody(req))
        if (!body) { json(res, 400, { ok: false, error: '请求体不是合法 JSON' }); return }
        if (body.action === 'clearSaid') {
          const D = await L('dedupe.mjs')
          D.clearSaid()
          json(res, 200, { ok: true, cleared: true })
          return
        }
        if (body.action !== 'test') { json(res, 400, { ok: false, error: '未知 action：' + String(body.action) }); return }
        const cfg = readConfig()
        const text = String(body.text ?? '').slice(0, 4000)
        const inb = S.screenInbound(text, cfg)
        const outb = S.screenOutbound(text, cfg)
        const jb = S.scanJailbreak(text)
        // 平台闸（快爆自己的词表）：没配 appid / 密钥时自动跳过，不报错
        let platform = { configured: false, skipped: 'off', blocked: false, count: 0, error: '' }
        try {
          const M = await L('maskword.mjs')
          const r = await M.checkText(text, { cfg })
          platform = {
            configured: r.configured === true,
            skipped: r.skipped || '',
            // 接口报错不算「命中」，单独给一个字段，界面才能说清是「词表拦了」还是「接口挂了」
            blocked: r.ok === false && !r.error,
            count: (r.hits || []).length,
            error: r.error || '',
          }
        } catch (e) { platform = { configured: false, skipped: '', blocked: false, count: 0, error: String(e.message || e) } }
        json(res, 200, {
          ok: true,
          platform,
          inbound: { blocked: !inb.ok, cat: inb.cat || '', why: inb.why || '', count: inb.count || 0 },
          outbound: { blocked: !outb.ok, cat: outb.cat || '', why: outb.why || '', count: outb.count || 0 },
          // 只回条数，不回命中词：试词框里本来就看得见原文，
          // 再列出"是哪个词命中的"就等于给了绕过清单。
          jailbreak: { blocked: !jb.ok, count: jb.hits.length },
          // 只回类目和条数，不回显命中的原文 —— 试词框里本来就看得见
          label: S.describeVerdict(inb.ok ? outb : inb),
        })
      } catch (e) { json(res, 500, { ok: false, error: String(e.message) }) }
    })

    /* ───────────────── 监听调度 ───────────────── */
    const sched = {
      running: false,
      lastTickAt: 0,
      lastError: null,
      lastResult: null,
      timer: null,
      busy: false,
      again: false,
      // 改了设置不必立刻跑：设置页边打字边自动保存，每存一次就跑一轮会白烧读额度。
      // 3 秒内的多次保存合并成一次；正在跑的那轮不打断，跑完再按新配置排下一轮。
      invalidate() {
        if (!this.running) return
        if (this.busy) { this.again = true; return }
        this.schedule(3000)
      },
      schedule(delayMs) {
        clearTimeout(this.timer)
        const cfg = runtimeConfig()
        // 抖动只加在「按间隔排下一轮」上：启动的 1.5 秒和改配置后的 3 秒是即时动作，抖它就是拖时间
        const wait = delayMs ?? withJitter(cfg.listen.intervalSec * 1000, cfg.listen.jitterSec)
        this.nextDueAt = Date.now() + wait
        this.timer = setTimeout(() => this.tick().catch(() => {}), wait)
        if (this.timer.unref) this.timer.unref()
      },
      async start() {
        if (this.running) return { already: true }
        this.running = true
        this.schedule(1500)
        return { started: true }
      },
      stop() { this.running = false; clearTimeout(this.timer); return { stopped: true } },
      async tick() {
        if (!this.running) return
        // 同一时间只跑一轮，防止两轮并发、读额度翻倍
        if (this.busy) { this.again = true; return }
        this.busy = true
        this.again = false
        try { await this._tick() } finally {
          this.busy = false
          if (this.running) this.schedule(this.again ? 3000 : undefined)
          this.again = false
        }
      },
      async _tick() {
        const cfg = runtimeConfig()
        this.lastTickAt = Date.now()
        // 监听关掉就直接停车，不再每分钟空转一次 readConfig + 动态 import。
        // 重新开始靠 /listen 的 start（或插件重载）。
        const wantListen = !!cfg.listen?.enabled
        const wantFollow = !!cfg.followback?.enabled
        // 回帖和回关都关着就停车，不再每分钟空转一次 readConfig + 动态 import。
        if (!wantListen && !wantFollow) {
          this.running = false
          clearTimeout(this.timer)
          this.lastError = null
          return
        }
        // 自动回关：跟回帖共用同一个节拍（listen.intervalSec），受 followback.enabled / 日限约束。
        if (wantFollow) {
          try {
            const F = await L('followback.mjs')
            const rf = await F.runOnce({ cfg })
            if (rf.due) {
              A.add({ kind: 'focus', src: 'run', ok: !rf.failed, text: '回关一轮：本批 ' + rf.due + ' 个，成功 ' + rf.ok + '，失败 ' + rf.failed + (rf.skipped ? '（' + rf.skipped + '）' : '') })
            }
          } catch (e) {
            try { A.add({ kind: 'focus', src: 'run', ok: false, text: '回关一轮失败：' + String(e.message ?? e) }) } catch {}
          }
        }
        if (!wantListen) return
        try {
          // 监听逻辑全在 tools/lib/watch.mjs，与 CLI 共用同一份实现，避免两边漂移
          const w = await L('watch.mjs')
          const res = await w.tick(cfg, { dryRun: false, log: logRun('run') })
          this.lastError = null
          this.lastResult = res
          try {
            const r = res || {}
            A.add({ kind: 'listen', src: 'run', ok: !r.blocked, text: '回帖一轮：扫 ' + (r.scanned ?? 0) + ' 条，回 ' + (r.replied ?? 0) + ' 条' + (r.refused ? '，违禁拦下 ' + r.refused + ' 条（未调模型）' : '') + (r.skipped ? '，跳过 ' + r.skipped : '') + (r.bootstrapped ? '，首次登记 ' + r.bootstrapped : '') + (r.blocked ? '，被拦 ' + r.blocked : ''), meta: r })
          } catch {}
        } catch (e) {
          this.lastError = String(e.message ?? e)
          try { A.add({ kind: 'listen', src: 'run', ok: false, text: '回帖一轮失败：' + this.lastError }) } catch {}
        }
      },
    }
    // 插件卸载 / 重载时停掉回帖调度，否则旧实例的定时器会在后台继续跑、继续耗额度
    ctx.effect(() => () => { try { sched.stop() } catch {} })

    route('exact', '/dsh-hykb/api/listen', async (req, res) => {
      if (!isTrustedReq(req)) { json(res, 403, { ok: false, error: '不受信任的访问来源' }); return }
      if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
      const body = parseBody(await readBody(req))
      if (!body) { json(res, 400, { ok: false, error: '请求体不是合法 JSON' }); return }
      if (body.action !== 'stop' && standbyReject(res)) return
      try {
        if (body.action === 'stop') {
          const was = sched.running
          const r = sched.stop()
          if (was) try { A.add({ kind: 'system', src: 'run', text: '自动回帖已停止' }) } catch {}
          json(res, 200, { ok: true, ...r }); return
        }
        const r = await sched.start()
        if (r.started) try { A.add({ kind: 'system', src: 'run', text: '自动回帖已启动' + (T.isTestMode(readConfig()) ? '（测试模式）' : '') }) } catch {}
        json(res, 200, { ok: true, ...r })
      } catch (e) { json(res, 500, { ok: false, error: String(e.message) }) }
    })

    /* ───────────────── 自动回关 ───────────────── */
    route('exact', '/dsh-hykb/api/followback', async (req, res) => {
      if (!isTrustedReq(req)) { json(res, 403, { ok: false, error: '不受信任的访问来源' }); return }
      if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
      const body = parseBody(await readBody(req))
      if (!body) { json(res, 400, { ok: false, error: '请求体不是合法 JSON' }); return }
      if (body.action === 'run' && standbyReject(res)) return
      try {
        const F = await L('followback.mjs')
        // action=run：默认只统计不发，send=true 才真的关注
        const r = await F.runOnce({ cfg: readConfig(), dryRun: body.send !== true })
        json(res, 200, { ok: true, result: r, follow: F.status({ cfg: readConfig() }) })
      } catch (e) { json(res, 500, { ok: false, error: String(e.message) }) }
    })

    /* ───────────────── 监听预览（不真发） ───────────────── */
    route('exact', '/dsh-hykb/api/watch', async (req, res) => {
      if (!isTrustedReq(req)) { json(res, 403, { ok: false, error: '不受信任的访问来源' }); return }
      if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
      try {
        const body = parseBody(await readBody(req))
        if (!body) { json(res, 400, { ok: false, error: '请求体不是合法 JSON' }); return }
        const w = await L('watch.mjs')
        if (body.action === 'reset') { w.resetPrimed(); json(res, 200, { ok: true, reset: true }); return }
        const cfg = runtimeConfig()
        const lines = []
        const result = await w.tick(cfg, { dryRun: true, log: (m) => { lines.push(m); try { A.fromLog(m, { src: 'manual' }) } catch {} } })
        json(res, 200, { ok: true, result, log: lines })
      } catch (e) { json(res, 500, { ok: false, error: String(e.message) }) }
    })

    /* ───────────────── 刷帖（日报 / 预览 / 立即跑一轮） ───────────────── */
    route('exact', '/dsh-hykb/api/browse', async (req, res) => {
      if (!isTrustedReq(req)) { json(res, 403, { ok: false, error: '不受信任的访问来源' }); return }
      if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
      try {
        const body = parseBody(await readBody(req))
        if (!body) { json(res, 400, { ok: false, error: '请求体不是合法 JSON' }); return }
        const cfg = runtimeConfig()
        const lines = []
        const log = (m) => { lines.push(m); try { A.fromLog(m, { src: 'manual' }) } catch {} }

        if (body.action === 'preview') {
          const d = await L('digest.mjs')
          const out = await d.previewDigest(cfg, { log, limit: body.limit })
          json(res, 200, { ok: true, ...out, log: lines })
          return
        }
        if (body.action === 'run') {
          // 备机不许真跑：两台同时刷帖等于双倍风控暴露面
          if (standbyReject(res)) return
          const d = await L('digest.mjs')
          // post:true = 手动「发一篇」：不看 post.enabled，但每日上限照算
          const stats = await d.runDigest(cfg, { dryRun: body.dry !== false, log, forcePost: body.post === true })
          json(res, 200, { ok: true, stats, log: lines })
          return
        }
        if (body.action === 'catalog') {
          // 全站板块目录，给设置页的板块选择器用（读一次网络）
          const f = await L('forum.mjs')
          const cat = await f.sectionCatalog()
          if (cat.code !== 100) { json(res, 502, { ok: false, error: '板块目录没拉到（code=' + cat.code + '）' }); return }
          json(res, 200, { ok: true, sections: cat.sections })
          return
        }
        if (body.action === 'games') {
          // 只读试读：挑几个游戏 → 读几条评价 → 回个摘要。不写日报、不进 seen、不改变任何状态。
          const g = await L('games.mjs')
          const list = await g.resolveGames(cfg, { log })
          const games = []
          for (const gm of list) {
            let gr
            try { gr = await g.gameComments(gm.id) } catch (e) { log('[games] ' + gm.id + ' 读失败：' + e.message); continue }
            if (gr.code !== 100) { log('[games] ' + gm.id + ' code=' + gr.code + ' ' + (gr.msg || '')); continue }
            const cs = g.pickComments(gr.result?.data, { max: cfg.games?.maxComments, minLen: cfg.games?.minLen })
            games.push({
              id: gm.id, title: gm.title,
              star: Number(gr.result?.star_info?.star) || 0,
              total: Number(gr.result?.count) || 0,
              read: cs.length,
              sample: cs[0] ? cs[0].content.slice(0, 40) : '',
            })
          }
          json(res, 200, { ok: true, games, log: lines })
          return
        }
        if (body.action === 'sections') {
          const b = await L('browse.mjs')
          const secs = await b.resolveSections(cfg, { log })
          json(res, 200, { ok: true, sections: secs, log: lines })
          return
        }
        json(res, 400, { ok: false, error: '未知 action：' + String(body.action) })
      } catch (e) { json(res, 500, { ok: false, error: String(e.message) }) }
    })

    // 日报文件：GET 列表 / GET ?date= 取正文
    route('exact', '/dsh-hykb/api/digest', async (req, res) => {
      if (!isTrustedReq(req)) { json(res, 403, { ok: false, error: '不受信任的访问来源' }); return }
      try {
        const { digestDir, digestPath } = await L('paths.mjs')
        const url = new URL(req.url, 'http://x')
        const date = url.searchParams.get('date')
        if (date) {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { json(res, 400, { ok: false, error: '日期格式应为 YYYY-MM-DD' }); return }
          let text = ''
          try { text = fs.readFileSync(digestPath(date), 'utf8') } catch {}
          json(res, 200, { ok: true, date, text })
          return
        }
        let files = []
        try {
          files = fs.readdirSync(digestDir())
            .filter((f) => /^digest-\d{4}-\d{2}-\d{2}\.md$/.test(f))
            .map((f) => ({ date: f.slice(7, 17), bytes: fs.statSync(path.join(digestDir(), f)).size }))
            .sort((a, b) => (a.date < b.date ? 1 : -1))
            .slice(0, 60)
        } catch {}
        json(res, 200, { ok: true, dir: digestDir(), files })
      } catch (e) { json(res, 500, { ok: false, error: String(e.message) }) }
    })

    /* ───────────────── 运行日志 ───────────────── */
    // GET ?limit=&src=&kind= 取最近记录 + 今日计数；POST {action:'clear'} 清空
    route('exact', '/dsh-hykb/api/activity', async (req, res) => {
      if (!isTrustedReq(req)) { json(res, 403, { ok: false, error: '不受信任的访问来源' }); return }
      try {
        if (req.method === 'GET') {
          const url = new URL(req.url, 'http://x')
          const limit = numOr(url.searchParams.get('limit'), 100, 1, 500)
          const items = A.list({ limit, src: url.searchParams.get('src') || '', kind: url.searchParams.get('kind') || '' })
          json(res, 200, { ok: true, items, counts: A.counts(), kinds: A.KINDS })
          return
        }
        if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
        const body = parseBody(await readBody(req))
        if (!body) { json(res, 400, { ok: false, error: '请求体不是合法 JSON' }); return }
        if (body.action === 'clear') { A.clear(); json(res, 200, { ok: true, cleared: true }); return }
        json(res, 400, { ok: false, error: '未知 action：' + String(body.action) })
      } catch (e) { json(res, 500, { ok: false, error: String(e.message) }) }
    })

    /* ───────────────── 一键自检（全部预演，不真发） ───────────────── */
    // 与测试模式互不干扰：自检用自己的内存配置，不改 test.enabled、不碰调度器和已读记录
    /* ───────────────── 浏览记录（她读过/回过/跳过的帖） ───────────────── */
    route('exact', '/dsh-hykb/api/history', async (req, res) => {
      if (!isTrustedReq(req)) { json(res, 403, { ok: false, error: '不受信任的访问来源' }); return }
      try {
        const h = await L('history.mjs')
        if (req.method === 'GET') {
          const url = new URL(req.url, 'http://x')
          const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit')) || 100))
          json(res, 200, { ok: true, limit, counts: h.counts(), items: h.list({ limit }) })
          return
        }
        if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
        const body = parseBody(await readBody(req)) || {}
        if (body.action !== 'clear') { json(res, 400, { ok: false, error: '未知 action：' + String(body.action) }); return }
        h.clear()
        json(res, 200, { ok: true, cleared: true, items: [] })
      } catch (e) { json(res, 500, { ok: false, error: String(e.message) }) }
    })

    route('exact', '/dsh-hykb/api/selftest', async (req, res) => {
      if (!isTrustedReq(req)) { json(res, 403, { ok: false, error: '不受信任的访问来源' }); return }
      if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
      if (S.selfTestRunning()) { json(res, 409, { ok: false, error: '自检正在进行中' }); return }
      try {
        const report = await S.runSelfTest(readConfig(), {
          load: L,
          host: {
            credState,
            listenRunning: () => sched.running,
            browseStatus: () => (browseClock ? browseClock.status() : { enabled: false, hasSession: false }),
          },
        })
        json(res, 200, { ok: true, report })
      } catch (e) { json(res, 500, { ok: false, error: String(e.message) }) }
    })

    // 插件加载时如果配置里已经开了监听（或开着测试模式），自动起来
    try { if (runtimeConfig().listen.enabled && cloudEngine.running()) sched.start() } catch {}

    // 刷帖时钟：与监听各自独立，互不影响
    let browseClock = null
    try {
      browseClock = startBrowseClock(ctx, {
        dshHome: DSH_HOME,
        cwd: path.join(DSH_HOME, 'hykb-work'),
        // 测试模式的放宽在这里生效（内存里，不写盘）；待命时关掉刷帖，免得两台一起跑
        readConfig: syncGatedConfig,
        loadTool: L,
        log: logRun('run'),
      })
      if (!browseClock.status().hasSession) console.warn('[hykb-scroll] 没有 sessionController：日报照写，但不会叫醒会话（headless 模式下属正常）')
    } catch (e) {
      console.warn('[hykb-scroll] 刷帖时钟启动失败：' + e.message)
    }

    ctx.effect(() => () => { try { browseClock?.stop() } catch {} })

    // 已登录就直接跑起来：同步 + 守租约与设置页开不开无关（关掉浏览器另一台照样能接替）
    try { cloudEngine.start() } catch {}
    ctx.effect(() => () => { try { cloudEngine.stop() } catch {} })

    console.log('[hykb-scroll] 设置页已挂载：/dsh-hykb/ · 配置 ' + CFG_FILE)
  },
}
