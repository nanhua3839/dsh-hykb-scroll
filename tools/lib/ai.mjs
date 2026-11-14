// AI 层：OpenAI 兼容 /v1/chat/completions。没有 baseUrl/model/key 就直接抛错，不假装跑通。
//
// 线路（line）：直连那条 + 若干个中转站。
//   · direct  用 ai.baseUrl / ai.model，密钥在 ~/.hykb-ai/ai-key
//   · relay   用 relays[] 里的某一条，密钥在 ~/.hykb-ai/relay-keys.json
//   activeRelay 决定先走谁；fallback 开着时，主线路失败就按顺序试下一个可用的。
//   所有线路在进模型之前都要过「破甲模型」判定 —— 中转站里挂的无审查权重一律不接。
import fs from 'node:fs'
import { config, relayKey, loadRelayKeys, resolveSuffix } from './config.mjs'
import { withTimeout, TIMEOUT_MS } from './traffic.mjs'
import { personaPath } from './paths.mjs'
// 偏好标签的合并去重规则只写在 rank.mjs 一处：提示词里的题材名和打分用的标签必须是同一份，
// 否则会出现「加了分但提示词没提」这种对不上的现象。rank.mjs 不 import 任何模块，没有循环依赖。
import { interestLabels } from './rank.mjs'
import { modelVerdict } from './safety.mjs'

/**
 * baseUrl 只允许 http(s)：它会被拼成 `baseUrl + '/chat/completions'` 再带上 Bearer 密钥发出去，
 * 填成 file:// 或别的协议时密钥会跟着请求跑到不该去的地方。
 * @returns {string} 归一化后的地址（去掉尾部斜杠）
 * @throws 协议或形态不合法
 */
export function aiEndpoint(baseUrl) {
  const raw = String(baseUrl || '').trim()
  if (!raw) throw new Error('AI 未配置：去设置页填 baseUrl / model / apiKey')
  let u
  try { u = new URL(raw) } catch { throw new Error('AI baseUrl 不是合法地址：' + raw) }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('AI baseUrl 只支持 http/https，当前是 ' + u.protocol)
  }
  if (!u.hostname) throw new Error('AI baseUrl 缺少域名：' + raw)
  return raw.replace(/\/+$/, '')
}

/**
 * 把字符串修成「合法 UTF-16」：孤立代理项一律换成 U+FFFD。
 *
 * 为什么必须有这一层：论坛楼层里全是 emoji，正文按「码元」截断（slice(0,120)）很容易把一对代理项切成一半。
 * 这串东西在 JS 里合法、JSON.stringify 也合法，但发给 DeepSeek 会被它自己的解析器拒掉：
 *   HTTP 400 Failed to parse the request body as JSON: messages[1].content: unexpected end of hex escape
 * （实测踩过：一条带 🌽 的楼层被截在半路，整份日报的 AI 综述直接掉回骨架）。
 * Node 20+ 有 String.prototype.toWellFormed，没有就原样返回。
 */
export const wellFormed = (s) => (typeof s === 'string' && typeof s.toWellFormed === 'function' ? s.toWellFormed() : String(s ?? ''))

export function aiReady() {
  const { ai } = config()
  if (!(ai.baseUrl && ai.model && ai.apiKey)) return false
  try { aiEndpoint(ai.baseUrl); return true } catch { return false }
}

/* ───────────── 线路：直连 + 中转站 ───────────── */

/**
 * 把一整套线路摊平成数组，activeRelay 指定的排最前。
 * 只保留「三项齐全 + 地址合法 + 没被破甲判定拦下」的线路。
 * @returns {Array<{id:string, name:string, baseUrl:string, model:string, apiKey:string}>}
 */
export function lines(cfg = config()) {
  const ai = cfg?.ai || {}
  const all = []
  const push = (id, name, baseUrl, model, key) => {
    const b = String(baseUrl || '').trim()
    const m = String(model || '').trim()
    const k = String(key || '').trim()
    if (!b || !m || !k) return
    try { aiEndpoint(b) } catch { return }
    // 破甲模型：模型名 / 地址 / 站名任意一处命中就不接这条线路
    if (!modelVerdict({ model: m, baseUrl: b, name }).ok) return
    all.push({ id, name, baseUrl: b.replace(/\/+$/, ''), model: m, apiKey: k })
  }
  push('direct', '直连', ai.baseUrl, ai.model, ai.apiKey)
  const keys = loadRelayKeys()
  for (const r of Array.isArray(ai.relays) ? ai.relays : []) {
    if (!r || r.enabled === false) continue
    const id = String(r.id || '').trim()
    if (!id) continue
    push(id, String(r.name || id), r.baseUrl, r.model, keys[id])
  }
  const active = String(ai.activeRelay || 'direct')
  const first = all.findIndex((x) => x.id === active)
  if (first > 0) all.unshift(...all.splice(first, 1))
  return ai.fallback === false ? all.slice(0, 1) : all
}

/** 线路是否就绪（任意一条可用即真）。 */
export function aiReadyAny(cfg = config()) {
  return lines(cfg).length > 0
}

export async function chat(messages, { temperature, maxTokens, cfg = config() } = {}) {
  const L = lines(cfg)
  if (!L.length) throw new Error(emptyReason(cfg))
  const errs = []
  for (const line of L) {
    try {
      return await chatOnce(line, messages, { temperature, maxTokens, cfg })
    } catch (e) {
      // 安全拒答不许回退：同一段输入换个线路还是同一套审核，回退只会白烧 token。
      // 直接抛给上层，让它按「命中」处理（回固定话术或不发）。
      if (e.safetyBlocked) throw e
      errs.push((line.name || line.id) + '：' + e.message)
      if (cfg?.ai?.fallback === false) break
    }
  }
  throw new Error(errs.length > 1 ? ('所有线路都失败 → ' + errs.join(' ｜ ')) : errs[0])
}

/* ───────────── 判官线路（决策模型） ───────────── */

/**
 * 判官要走的线路。顺序：ai.judge 那条（三项齐全才收）→ 主线路兜底。
 * 兜底是故意的：判官挂了会让「自动点赞 / 回帖 / 发帖」全部停摆，
 * 与其因为没另配线路就停摆，不如先用主线路判，日志里能看出来走的是哪条。
 * @returns {Array<{id:string, name:string, baseUrl:string, model:string, apiKey:string}>}
 */
export function judgeLines(cfg = config()) {
  const j = cfg?.ai?.judge || {}
  const out = []
  const b = String(j.baseUrl || '').trim()
  const m = String(j.model || '').trim()
  const k = String(j.apiKey || '').trim()
  if (b && m && k) {
    try {
      aiEndpoint(b)
      if (modelVerdict({ model: m, baseUrl: b, name: 'judge' }).ok) {
        out.push({ id: 'judge', name: '判官', baseUrl: b.replace(/\/+$/, ''), model: m, apiKey: k })
      }
    } catch { /* 地址不合法就不收这条，下面还有主线兜底 */ }
  }
  return out.concat(lines(cfg))
}

/**
 * 判官专用 chat：温度默认取 ai.judge.temperature（0.1）。
 * 走 judgeLines，所以主线路挂了判官也能用；判官那条挂了会掉到主线，不额外报错。
 */
export async function chatJudge(messages, { temperature, maxTokens, cfg = config() } = {}) {
  const j = cfg?.ai?.judge || {}
  const L = judgeLines(cfg)
  if (!L.length) throw new Error(emptyReason(cfg))
  const temp = Number.isFinite(temperature) ? temperature : (Number.isFinite(Number(j.temperature)) ? Number(j.temperature) : 0.1)
  const mt = Number.isFinite(maxTokens) ? maxTokens : 400
  const errs = []
  for (const line of L) {
    try {
      return await chatOnce(line, messages, { temperature: temp, maxTokens: mt, cfg })
    } catch (e) {
      if (e.safetyBlocked) throw e
      errs.push((line.name || line.id) + '：' + e.message)
      if (cfg?.ai?.fallback === false) break
    }
  }
  throw new Error('判官线路都失败 → ' + errs.join(' ｜ '))
}

/**
 * 「一条线路都没有」时说清楚到底是哪种没有。
 * 三种情况用户要做的事完全不同：
 *   三项没填 → 去填；填了但密钥空 → 补密钥；填了但被破甲判定拦 → 换模型。
 * 混成一句「AI 未配置」会让人以为没保存成功。
 */
function emptyReason(cfg) {
  const ai = cfg?.ai || {}
  const relays = (Array.isArray(ai.relays) ? ai.relays : []).filter((r) => r && r.enabled !== false)
  const directFilled = Boolean(ai.baseUrl && ai.model)
  const directHasKey = Boolean(ai.apiKey)
  const relayWithKey = (() => {
    try { const keys = loadRelayKeys(); return relays.filter((r) => r.baseUrl && r.model && keys[r.id]).length } catch { return 0 }
  })()
  const anyFilled = directFilled || relays.some((r) => r.baseUrl && r.model)

  if (!anyFilled) return 'AI 未配置：去设置页填 baseUrl / model / apiKey'
  // 填了地址和模型，但没有可用的密钥
  if ((directFilled && !directHasKey) && !relayWithKey) {
    return 'AI 缺密钥：地址和模型填好了，但直连和所有中转站都还没有密钥'
  }
  // 填全了却没有一条进 lines() → 只可能是被破甲判定拦下（或地址协议不对）
  const blocked = []
  const chk = (label, o) => {
    const v = modelVerdict(o)
    if (!v.ok) blocked.push(label + '（' + v.hits.join('、') + '）')
    else {
      try { aiEndpoint(o.baseUrl) } catch { blocked.push(label + '（接口地址不是 http/https 或不是合法地址）') }
    }
  }
  if (directFilled) chk('直连', { model: ai.model, baseUrl: ai.baseUrl, name: '直连' })
  for (const r of relays) if (r.baseUrl && r.model) chk(r.name || r.id, { model: r.model, baseUrl: r.baseUrl, name: r.name })
  if (blocked.length) return 'AI 没有可用线路：这些被拦下了 → ' + blocked.join('；') + '。破甲模型请换成正经营业的模型'
  return 'AI 没有可用线路：检查接口地址、模型名与密钥三项是否齐全'
}

/** 真发一次请求。线路参数由 lines() 给，这里不读配置。 */
/**
 * DeepSeek 官方接口才认 `safety_check`。
 * 官方文档里它只在 api.deepseek.com 上有效，中转站收到未知字段可能直接 400，
 * 所以按 hostname 精确判断，而不是「看着像 DeepSeek」就塞。
 */
export function isDeepSeekOfficial(baseUrl) {
  try {
    const h = new URL(String(baseUrl)).hostname.toLowerCase()
    return h === 'api.deepseek.com' || h.endsWith('.deepseek.com')
  } catch { return false }
}

/**
 * 这条线路该带什么 safety_check。
 * **强制 high，没有关闭档位**：官方接口必须带，这是合规底线（对外发帖的机器人）。
 * 非官方接口不带，因为那会让中转站 400 —— 这不是"关掉"，是"服务器不认识这个字段"。
 * @returns {'high'|null} null 仅表示"本条线路不是官方接口"
 */
export function safetyCheckFor(line, cfg) {
  if (!isDeepSeekOfficial(line?.baseUrl)) return null
  return 'high'
}

/** 最近一次成功请求的安全审核旁路信息（给 /status 与日志用）。 */
let lastSafety = null
export function takeLastSafety() { const v = lastSafety; lastSafety = null; return v }

async function chatOnce(line, messages, { temperature, maxTokens, cfg } = {}) {
  const ai = cfg?.ai || {}
  const url = aiEndpoint(line.baseUrl) + '/chat/completions'
  const level = safetyCheckFor(line, cfg)
  const body = {
    model: line.model,
    // 出网前最后一道：孤立代理项会让对方的 JSON 解析器 400（见 wellFormed 的注释）
    messages: (Array.isArray(messages) ? messages : []).map((m) => ({ ...m, content: wellFormed(m?.content) })),
    temperature: temperature ?? ai.temperature ?? 0.7,
    max_tokens: maxTokens ?? ai.maxTokens ?? 800,
  }
  // 官方文档：level 只能是 low / high；开了之后连接不会提前关，
  // 服务端还要对完整输出再审一遍，之后响应才可能以拒答结束。
  if (level) body.safety_check = { level }

  const res = await fetch(url, withTimeout({
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + line.apiKey },
    body: JSON.stringify(body),
  }))
  const text = await res.text()
  let data
  try { data = JSON.parse(text) } catch { throw new Error('AI 返回非 JSON：' + text.slice(0, 200)) }

  // 输入未通过审核 → 400 Content Exists Risk（官方文档明确写的就是这个）。
  // 这不是"线路坏了"：换线路是同一段输入、同一个服务，重试只会白烧 token，
  // 所以标成 safetyBlocked 让上层直接按"命中"处理，不要走线路回退。
  if (res.status === 400) {
    const msg = String(data?.error?.message || text || '')
    if (/content exists risk/i.test(msg)) {
      const e = new Error('输入未通过 DeepSeek 内容审核（Content Exists Risk）')
      e.safetyBlocked = true
      throw e
    }
    if (/safety_check/i.test(msg)) {
      const e = new Error('这条线路不认 safety_check 参数：' + msg.slice(0, 120))
      e.safetyUnsupported = true
      throw e
    }
  }
  if (!res.ok) throw new Error('AI HTTP ' + res.status + '：' + (data.error?.message || text.slice(0, 200)))

  // 输出未通过审核 → 非流式时 content 被清空，并给 refusal 标识。
  // 同样不重试：同一段输入重发一遍只会再被拒一次。
  const usage = data.usage || {}
  const meta = {
    safetyCheck: level,
    safetyTokens: usage.completion_tokens_details?.safety_tokens ?? usage.output_tokens_details?.safety_tokens ?? null,
    refusal: data.choices?.[0]?.message?.refusal ?? null,
    line: line.id,
  }
  const content = data.choices?.[0]?.message?.content
  if (!content) {
    if (meta.refusal) {
      const e = new Error('模型拒答（DeepSeek 内容审核）：' + String(meta.refusal).slice(0, 120))
      e.safetyBlocked = true
      throw e
    }
    throw new Error('AI 返回空内容：' + JSON.stringify(data).slice(0, 300))
  }
  lastSafety = meta
  return content.trim()
}

/**
 * 清洗一段论坛文本：去 HTML、压空白、折叠重复 emoji / 重复短语、限长。
 * 论坛楼层里常有「恭喜🎉🎉🎉…」这种重复串，直接喂给模型会让它跟着退化成乱码。
 */
export function tidy(s, max = 140) {
  let t = String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  // 单字符重复（🎉🎉🎉、哈哈哈哈、！！！！）先折成一次，再折多字短语的重复（「恭喜恭喜恭喜」）
  for (let i = 0; i < 3; i += 1) {
    const before = t
    t = t.replace(/(.)\1{2,}/gu, '$1')
    t = t.replace(/(.{2,8}?)\1{2,}/gu, '$1')
    if (t === before) break
  }
  t = t.replace(/\s+/g, ' ').trim()
  // 截断可能把 emoji 的代理对切成一半 → 出网前必须修成合法 UTF-16（否则 DeepSeek 直接 400）
  if (t.length > max) t = wellFormed(t.slice(0, max)) + '…'
  return wellFormed(t)
}

/** 楼层去重：同一句话刷很多遍只留一条，纯 emoji / 过短的丢掉。 */
export function tidyFloors(floors, { max = 8, len = 90 } = {}) {
  const out = []
  const seen = new Set()
  for (const f of floors || []) {
    const text = tidy(f.content, len)
    const key = text.replace(/\s/g, '').replace(/[…。！!？?~～]+$/g, '').slice(0, 8)
    if (!key || key.length < 3) continue
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ nickname: tidy(f.nickname, 20) || '匿名', content: text })
    if (out.length >= max) break
  }
  return out
}

/** 把一整个帖子压成要点。maxFloors 来自配置里的 summary.maxComments（默认 60 层）。 */
export function summarizePrompt(topic, replies, { maxFloors = 60 } = {}) {
  const floors = replies.slice(0, Math.max(1, Number(maxFloors) || 60)).map((r, i) =>
    '#' + (r.position || i + 1) + ' ' + (r.user?.nickname || '匿名') + '：' + String(r.content || '').replace(/\s+/g, ' ').slice(0, 300)
  ).join('\n')
  return [
    { role: 'system', content: '你是一个论坛内容的总结助手。只输出要点，不评论、不寒暄、不加免责声明。' },
    {
      role: 'user',
      content: [
        '标题：' + (topic.title || ''),
        '正文：' + String(topic.content || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 1500),
        '',
        '楼层：',
        floors || '（无回复）',
        '',
        '请用中文输出：',
        '1) 三到五条核心要点（每条一行，以 - 开头）',
        '2) 一句话结论',
        '3) 争议点或未解决的问题（没有就写"无"）',
      ].join('\n'),
    },
  ]
}

/** 帖子的 PC 地址。日报里的「原帖链接」都用这个。 */
export const threadUrl = (id) => 'https://bbs.3839.com/thread-' + encodeURIComponent(String(id)) + '.htm'

/* ───────────── 提示词：发出去之前先过一遍的规则 ───────────── */

/**
 * 设置页「人设补充」落在 ~/.hykb-ai/personas/<当前人设>.md。读不到就当没写。
 * 改造前的单号布局没有清单（当前人设 id 为空）时仍是老那份 persona.md；
 * 第一份人设的文件缺失时也回落到它 —— 迁移之外的路径不该让用户写过的字凭空消失。
 */
export function personaNotes(cfg = config()) {
  const id = cfg?.__activePersona?.id || ''
  const read = (f) => { try { return fs.readFileSync(f, 'utf8').trim().slice(0, 20000) } catch { return '' } }
  const mine = read(personaPath(id))
  if (mine || id !== 'p1') return mine
  return read(personaPath())
}

/**
 * 用户自己写的规则：人设补充 + 提示词规则。
 * 拼在系统提示最后，并明确告诉模型冲突时以这里为准——
 * 否则「不说自己是 AI」这类内置硬规则会把用户要的「注明 AI 生成」压掉。
 */
export function extraRules(cfg = config()) {
  const persona = personaNotes(cfg)
  const rules = String(cfg?.prompt?.rules || '').trim()
  const parts = []
  if (persona) parts.push('人设补充：\n' + persona)
  if (rules) parts.push('写之前先按这些要求想一遍，写出来的话必须满足它们：\n' + rules)
  if (!parts.length) return ''
  return '\n\n【用户规则——和上面任何一条冲突时，以这里为准】\n' + parts.join('\n\n')
}

/** 把用户规则接到第一条 system 消息后面。只用于「要发出去的话」，不用于内部速读。 */
export function withRules(messages, cfg) {
  const extra = extraRules(cfg)
  if (!extra) return messages
  return messages.map((m, i) => (i === 0 && m.role === 'system' ? { ...m, content: m.content + extra } : m))
}

/**
 * 在要发出去的文字末尾追加固定后缀（比如「内容由AI生成」）。
 * 不靠模型自觉：模型可能漏写、改写、写在开头，所以由代码兜底。
 * 模型已经自己写了同一句就先去掉，避免重复；总长超过 max 时截正文、保后缀。
 */
export function applySuffix(text, { suffix, max = Infinity, sep = ' ' } = {}) {
  const body0 = String(text || '').trim()
  // 后缀由 config.resolveSuffix 定：用户填了用他的，没填强制用默认的「-内容由AI生成」。
  // 这里不再有"留空 = 不加"这条路 —— AI 生成的内容必须带标识。
  const tail = typeof suffix === 'string' && suffix ? resolveSuffix({ prompt: { suffix } }) : resolveSuffix()
  if (!body0) return body0
  if (!tail) return body0
  const esc = tail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // 去掉模型自己加的同一句（允许包着括号、前面有标点）
  const re = new RegExp('[\\s（(【\\[—-]*' + esc + '[\\s）)】\\]。.！!]*$')
  let body = body0.replace(re, '').trim()
  if (!body) return body0.slice(0, max)
  const room = max - tail.length - sep.length
  if (Number.isFinite(max) && room <= 0) return tail.slice(0, max)
  if (body.length > room) body = body.slice(0, room)
  return body + sep + tail
}

/**
 * 「帮我总结这帖」的回复版：要能直接当楼中楼发出去。
 * 和 summarizePrompt 的区别：那个是给自己看的报告（要点 + 结论 + 争议点），
 * 这个是发在论坛里的一段人话，不能带「结论：」「争议点：无」这类格式。
 */
export function replySummaryPrompt(topic, replies, persona) {
  const floors = tidyFloors(
    (replies || []).map((r) => ({ nickname: r.user?.nickname, content: r.content })),
    { max: 14, len: 110 },
  )
  const title = tidy(topic?.title, 120)
  const body = tidy(topic?.content, 400)
  return withRules([
    {
      role: 'system',
      content: [
        '你要在一个游戏论坛的楼中楼里，替人把这帖讲清楚。',
        '像真人说话，不要报告腔：不要出现「结论」「争议点」「核心要点」这类小标题。',
        '不加客套开场，不说自己是AI，不提「根据楼层」这种措辞。',
        '3 到 5 句，总长不超过 200 字。',
        persona?.style ? '说话风格：' + persona.style : '',
      ].filter(Boolean).join('\n'),
    },
    {
      role: 'user',
      content: [
        '帖子标题：' + (title || '（无）'),
        '帖子正文：' + (body || '（无）'),
        '',
        '楼层：',
        floors.length ? floors.map((f) => f.nickname + '：' + f.content).join('\n') : '（还没人回复）',
        '',
        '用中文说清楚：这帖在讲什么、大家在聊什么、有没有结论。直接给能发出去的那段话。',
      ].join('\n'),
    },
  ])
}

/** 生成一条回复。触发者是被回复的人。 */
export function replyPrompt({ topic, floors, trigger, persona, triggerText }) {
  return withRules([
    {
      role: 'system',
      content: [
        '你在一个游戏社区论坛里以「' + persona.name + '」的身份回帖。',
        '称呼对方为「' + persona.ownerTitle + '」。',
        '风格：' + persona.style,
        '硬规则：不超过 100 字；不承诺任何事情；不问隐私；不吵架；不用「作为一个AI」这类措辞；不输出解释，只输出要发的那段话。',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        '帖子标题：' + (topic.title || ''),
        '帖子正文（截断）：' + String(topic.content || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 1200),
        '',
        '最近的楼层：',
        floors.slice(-10).map((r) => (r.user?.nickname || '匿名') + '：' + String(r.content || '').replace(/\s+/g, ' ').slice(0, 200)).join('\n') || '（无）',
        '',
        '现在 ' + (trigger.nickname || '对方') + ' 对你说：' + triggerText,
        '',
        '写一条回复。只输出正文。',
      ].join('\n'),
    },
  ])
}

/**
 * 多帖综述：把一轮刷到的帖子压成一份日报。picks 里每项含 title/content/replyCount/score/摘录楼层。
 * interests = cfg.browse.interests：非空时在材料顶部点一句他的题材偏好，
 * 并当场写明「不要为了凑标签硬写」—— 只给偏好不设边界，模型会拿题材当结论硬套。
 * 标签为空时这一行整行不出现，提示词与没有这个功能时逐字一致。
 */
export function digestPrompt({ picks, persona, date, style, interests }) {
  const prefs = interestLabels(interests)
  const prefLine = prefs.length ? '他常年偏好的题材：' + prefs.join('、') + ' —— 同等条件下优先写这些，但不要为了凑标签硬写。' : ''
  const blocks = picks.map((p, i) => {
    const head = '【' + (i + 1) + '】' + (p.title || '(无标题)') + '　（' + (p.sectionTitle || p.sectionId) + '　' + p.score + ' 分　回复 ' + p.replyCount + '　赞 ' + p.upVote + '）'
      + (p.topicId ? '\n链接：' + threadUrl(p.topicId) : '')
    if (p.gist) return [head, '速读：' + tidy(p.gist, 300)].join('\n')
    const fl = tidyFloors(p.floors, { max: 6, len: 70 })
    return [
      head,
      '正文：' + tidy(p.content, 400),
      fl.length ? '楼层摘录：\n' + fl.map((f) => '  ' + f.nickname + '：' + f.content).join('\n') : '楼层摘录：（无）',
    ].join('\n')
  }).join('\n\n')
  return withRules([
    {
      role: 'system',
      content: [
        '你在给「' + persona.name + '」写一份游戏社区论坛的日报，读者是「' + persona.ownerTitle + '」。',
        '风格：' + (style || '要点式，口语，不客套，不加免责声明'),
        '硬规则：只写看到的内容；不编造楼层、数字、结论、链接；不输出"作为一个AI"；不寒暄。',
        '提到某一帖时，在那一段末尾照抄它的链接（只用材料里给的链接）。',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        '日期：' + date,
        ...(prefLine ? [prefLine] : []),
        '下面是今天扫到并打分排序后的帖子（分数越高越值得看）：',
        '',
        blocks,
        '',
        '请用中文输出，严格按这个结构：',
        '## 今天论坛在聊什么',
        '（三到五条，每条一行，以 - 开头，概括这批帖子共同在讨论什么）',
        '',
        '## 值得看的',
        '（挑 3 帖以内，每帖一段：标题 + 一句为什么值得看 + 一句你自己的判断）',
        '',
        '## 一句话',
        '（整份日报收尾一句，别煽情）',
      ].join('\n'),
    },
  ])
}

/** 单帖速读：给一帖写「这帖在说什么」，用于日报里补细节。 */
export function topicGistPrompt(topic, floors) {
  return [
    { role: 'system', content: '你是一个论坛速读助手。只输出要点，不评论、不寒暄。' },
    {
      role: 'user',
      content: [
        '标题：' + (topic.title || ''),
        '正文：' + tidy(topic.content, 800),
        '楼层：',
        tidyFloors(floors, { max: 10, len: 90 }).map((f) => f.nickname + '：' + f.content).join('\n') || '（无）',
        '',
        '用两句中文说清：1) 楼主在问什么/说什么 2) 楼下给出的关键信息或分歧。只输出这两句。',
      ].join('\n'),
    },
  ]
}

/** 主动回帖：不是回某个人，是对一个帖子本身留一句话。 */
export function browseReplyPrompt({ topic, floors, persona, gist }) {
  return withRules([
    {
      role: 'system',
      content: [
        '你在游戏社区论坛里以「' + persona.name + '」的身份回帖。',
        '称呼别人为「' + persona.ownerTitle + '」。',
        '风格：' + persona.style,
        '硬规则：不超过 80 字；不承诺任何事；不问隐私；不引战；不复制楼主原话；不出现"作为一个AI"；不输出解释，只输出要发的那一段话。',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        '帖子标题：' + (topic.title || ''),
        '正文（截断）：' + tidy(topic.content, 800),
        gist ? '这帖在说什么：' + tidy(gist, 200) : '',
        '',
        '最近的楼层：',
        tidyFloors(floors, { max: 6, len: 70 }).map((f) => f.nickname + '：' + f.content).join('\n') || '（无）',
        '',
        '写一条自然的回帖。只输出正文。',
      ].filter(Boolean).join('\n'),
    },
  ])
}

/* ───────────── 表情：门面导出 ───────────── */

/**
 * 表情层的入口放在这儿，上层只 import ai.mjs 就够。
 * ⚠️ 顺序契约：tidy() / digest 的 strip() 都用 /<[^>]+>/g 剥标签，会把 <kb-emoji …/> 整块吃掉；
 *    render 之后再 slice / 截断会把标签砍断成碎片。所以顺序只能是「清洗 → 截断 → render()」，
 *    render 之后不许再 tidy / slice。
 */
export {
  EMOJI_SET,
  EMOJI_SETS,
  emojiNames,
  render,
  stripEmoji,
  hasEmoji,
  EMOJI_PROMPT_RULE,
} from './emoji.mjs'
