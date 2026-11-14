// 一键自检：把插件的每个功能都跑一遍「只读 / 预演」，告诉你哪一项能用、哪一项不能用。
//
// 跟测试模式不冲突：
//   - 自检用自己的一份内存配置（testmode.probeConfig：最宽、但每类只读一点点），
//     不改配置文件、不开关测试模式、不启停调度器；
//   - 全程 dry-run：不发帖、不回帖、不写日报文件、不写已读（seen.json）；
//   - 记录都打上 src='selftest'，运行日志里能单独筛出来，也不算进「今日统计」；
//   - 同一时间只跑一个（自检进行中再点会被拒绝）。
// 唯一会消耗的是读额度（十来次请求）和一次很短的 AI 调用。
import * as A from './activity.mjs'
import { probeConfig, isTestMode } from './testmode.mjs'

let running = false
export const selfTestRunning = () => running

/**
 * @param {object} cfg 当前配置（readConfig() 的结果）
 * @param {{load?:(name:string)=>Promise<any>, host?:{credState?:()=>any, listenRunning?:()=>boolean, browseStatus?:()=>any}}} [opt]
 * @returns {Promise<{ok:boolean, startedAt:string, ms:number, steps:Array, summary:{pass:number,warn:number,fail:number,skip:number}}>}
 */
export async function runSelfTest(cfg, { load, host = {} } = {}) {
  if (running) throw new Error('自检正在进行中')
  running = true
  const t0 = Date.now()
  const startedAt = new Date().toISOString()
  const steps = []
  const L = load || ((n) => import('./' + n))
  const pc = probeConfig(cfg)
  const log = (m) => { try { A.fromLog(m, { src: 'selftest' }) } catch {} }

  const step = async (name, fn) => {
    const s0 = Date.now()
    let r
    try { r = await fn() } catch (e) { r = { level: 'fail', detail: String(e?.message || e).split('\n')[0] } }
    const s = { name, level: r?.level || 'pass', detail: String(r?.detail || ''), ms: Date.now() - s0 }
    steps.push(s)
    A.add({ kind: 'test', src: 'selftest', ok: s.level !== 'fail', level: s.level, text: name + '：' + (s.detail || LEVEL[s.level]), meta: { step: name, ms: s.ms } })
    return s
  }
  const LEVEL = { pass: '正常', warn: '能用，但有提醒', fail: '不能用', skip: '跳过' }

  try {
    A.add({ kind: 'test', src: 'selftest', level: 'info', text: '开始一键自检（只读 / 预演，不发任何内容）' + (isTestMode(cfg) ? '；测试模式开着，调度照常跑' : '') })

    const [C, cred, api, forum, ai, trig, watch, digest, traffic] = await Promise.all([
      L('config.mjs'), L('cred.mjs'), L('hykb-api.mjs'), L('forum.mjs'), L('ai.mjs'), L('trigger.mjs'), L('watch.mjs'), L('digest.mjs'), L('traffic.mjs'),
    ])

    await step('配置文件', async () => {
      const c = C.config()
      if (!c || typeof c !== 'object') return { level: 'fail', detail: '读不到配置' }
      return { detail: '读取正常' }
    })

    await step('运行日志', async () => {
      const before = A.list({ limit: 1, src: 'selftest' })[0]
      return before ? { detail: '能写能读：' + A.activityPath() } : { level: 'fail', detail: '写入后读不到' }
    })

    let me = { uid: '', nickname: '' }
    let loggedIn = false
    let writeMiss = []
    await step('登录状态', async () => {
      let c
      try { c = cred.loadCred() } catch { return { level: 'fail', detail: '还没登录快爆（去 ① 扫码）' } }
      c = cred.deriveCred ? cred.deriveCred(c) : c
      me = { uid: cfg.self?.uid || c.uid || '', nickname: cfg.self?.name || c.nickname || '' }
      writeMiss = cred.missingForWrite(c)
      loggedIn = !!(c.uid || c.Pauth)
      if (writeMiss.length) return { level: 'warn', detail: '能读，但不能写：缺 ' + writeMiss.join('、') }
      return { detail: '已登录：' + (c.nickname || c.uid) }
    })

    await step('读 @我 通知', async () => {
      if (!loggedIn) return { level: 'skip', detail: '没登录，读不了通知' }
      const j = await api.atList({ mode: 3 })
      if (j?.code !== 100) return { level: 'fail', detail: '接口返回 code=' + j?.code + ' ' + (j?.msg || '') }
      return { detail: '通知接口正常，最近 ' + (j.result?.data || []).length + ' 条' }
    })

    await step('@ 识别', async () => {
      const name = me.nickname || '测试号'
      const uid = me.uid || '1'
      const a = trig.matchTrigger('你好 @' + name + ' 帮看下', { uid, nickname: name }, 'both')
      const b = trig.matchTrigger('今天天气不错', { uid, nickname: name }, 'both')
      if (!a.hit) return { level: 'fail', detail: '正文里的「@' + name + '」没认出来' }
      if (b.hit) return { level: 'fail', detail: '没 @ 的内容被误认成 @' }
      return { detail: '能认出「@' + name + '」' + (me.nickname ? '' : '（还没拿到昵称，用占位名测的）') }
    })

    let aiOk = false
    await step('AI 接口', async () => {
      if (!ai.aiReady()) return { level: 'fail', detail: '还没接 AI（去 ② 填地址、模型、密钥）' }
      const t = await ai.chat([{ role: 'user', content: '只回复两个字：收到' }], { maxTokens: 8, temperature: 0 })
      aiOk = true
      return { detail: '能回话：' + String(t).slice(0, 20) }
    })

    const sec = pc.listen.forum.items[0]
    let sampleTid = pc.listen.topic.items[0]?.id || ''
    await step('扫描论坛', async () => {
      const j = await forum.sectionTopics(sec.id)
      if (j?.code !== 100) return { level: 'fail', detail: (sec.title || sec.id) + ' 返回 code=' + j?.code + ' ' + (j?.msg || '') }
      const list = j.result?.data || []
      if (!sampleTid) sampleTid = String(list.find((x) => x?.id)?.id || '')
      return list.length ? { detail: (sec.title || sec.id) + ' 扫到 ' + list.length + ' 帖' } : { level: 'warn', detail: (sec.title || sec.id) + ' 能读，但没有帖子' }
    })

    await step('读帖子楼层', async () => {
      if (!sampleTid) return { level: 'skip', detail: '没有可读的帖子 id' }
      const j = await api.topicDetail(sampleTid)
      if (j?.code !== 100) return { level: 'fail', detail: '帖子 ' + sampleTid + ' 返回 code=' + j?.code + ' ' + (j?.msg || '') }
      return { detail: '帖子 ' + sampleTid + '：' + String(j.result?.topic?.title || '').slice(0, 30) + '，楼层 ' + (j.result?.reply || []).length }
    })

    await step('自动回帖（预演）', async () => {
      const r = await watch.tick(pc, { dryRun: true, log })
      const d = '扫 ' + (r?.scanned ?? 0) + ' 条，会回 ' + (r?.replied ?? 0) + ' 条，跳过 ' + (r?.skipped ?? 0) + ' 条'
      if (r?.blocked) return { level: 'warn', detail: d + '；被安全阀拦了' }
      return { detail: d + '（没真发）' }
    })

    await step('自动刷帖 + 日报 + 发帖（预演）', async () => {
      const r = await digest.runDigest(pc, { dryRun: true, forcePost: true, log })
      const d = '扫 ' + (r?.scanned ?? 0) + ' 帖，选 ' + (r?.picked?.length ?? 0) + ' 帖'
      if (!r?.scanned) return { level: 'fail', detail: '一个帖子都没扫到' }
      const p = r.post
      const pd = !p ? '' : p.status === 'preview' ? '；发帖预演正常' : '；发帖：' + (p.reason || p.status)
      const lvl = p && p.status !== 'preview' ? 'warn' : (aiOk ? 'pass' : 'warn')
      return { level: lvl, detail: d + pd + (aiOk ? '' : '；AI 没接，日报只有原始清单') + '（没写文件、没真发）' }
    })

    await step('写权限 / 写额度', async () => {
      if (!loggedIn) return { level: 'fail', detail: '没登录，不能回帖发帖' }
      if (writeMiss.length) return { level: 'fail', detail: '缺 ' + writeMiss.join('、') }
      const t = traffic.trafficState()
      const R = C.config().risk || {}
      if ((t.writeHour || 0) >= R.writeHourly) return { level: 'warn', detail: '本小时写额度用完（' + t.writeHour + '/' + R.writeHourly + '）' }
      if ((t.writeDay || 0) >= R.writeDaily) return { level: 'warn', detail: '今天写额度用完（' + t.writeDay + '/' + R.writeDaily + '）' }
      const gap = Math.max(0, Math.ceil(((t.lastWriteAt || 0) + (R.writeGapSec || 0) * 1000 - Date.now()) / 1000))
      return { detail: '可写：本小时 ' + (t.writeHour || 0) + '/' + R.writeHourly + '，今天 ' + (t.writeDay || 0) + '/' + R.writeDaily + (gap ? '，冷却还剩 ' + gap + ' 秒' : '') }
    })

    await step('安全阀', async () => {
      const t = traffic.trafficState()
      const R = C.config().risk || {}
      if (t.pausedForSec > 0) return { level: 'warn', detail: '被平台拦过，暂停中，还剩 ' + t.pausedForSec + ' 秒' }
      return { detail: '读 ' + (t.readHour || 0) + '/' + R.readHourly + '（本小时）、' + (t.readDay || 0) + '/' + R.readDaily + '（今天）' }
    })

    await step('叫醒会话', async () => {
      const b = host.browseStatus ? host.browseStatus() : null
      if (!b) return { level: 'skip', detail: '宿主没提供会话接口' }
      if (b.hasSession) return { detail: '会话「' + (b.sessionId || '') + '」在，刷完能叫醒' }
      return { level: 'warn', detail: '会话「' + (b.sessionId || '') + '」现在不在，刷完叫不醒（不影响刷帖）' }
    })

    await step('调度器', async () => {
      const lr = host.listenRunning ? host.listenRunning() : false
      const b = host.browseStatus ? host.browseStatus() : null
      const parts = ['自动回帖' + (lr ? '在跑' : '没开'), '自动刷帖' + (b?.enabled ? '在跑' : '没开')]
      if (isTestMode(cfg)) parts.push('测试模式开着')
      return { level: 'pass', detail: parts.join('，') }
    })
  } finally {
    running = false
  }

  const summary = { pass: 0, warn: 0, fail: 0, skip: 0 }
  for (const s of steps) summary[s.level] = (summary[s.level] || 0) + 1
  const ms = Date.now() - t0
  A.add({
    kind: 'test', src: 'selftest', ok: summary.fail === 0, level: summary.fail ? 'fail' : summary.warn ? 'warn' : 'pass',
    text: '自检完成：' + summary.pass + ' 项正常，' + summary.warn + ' 项提醒，' + summary.fail + ' 项不能用，' + summary.skip + ' 项跳过（' + Math.round(ms / 1000) + ' 秒）',
  })
  return { ok: summary.fail === 0, startedAt, ms, steps, summary }
}
