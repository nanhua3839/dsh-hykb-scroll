// 刷帖 dry-run / 覆盖写：不能因为 dry-run 落半份日报，也不能把同一天的日报叠成流水账。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hykb-digest-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSH_HOME = path.join(home, '.dsh')
fs.mkdirSync(path.join(home, '.dsh'), { recursive: true })
const digestDir = path.join(home, '.dsh', 'hykb-work')
fs.mkdirSync(digestDir, { recursive: true })

const NOW = new Date('2026-11-13T21:40:00+08:00')
const DAY0 = new Date('2026-11-13T00:00:00+08:00').getTime()
const H = 3600000
const fmt = (ms) => {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
}
const SECTIONS = [{ id: '23064', title: '生活区' }, { id: '3', title: '综合讨论区' }]

/** 每个板块 2 页：第 1 页 20 条（今天）、第 2 页 10 条（跨过 00:00 → 抓取到此为止）。 */
function page(sid, n) {
  const rows = []
  const count = n === 1 ? 20 : 10
  for (let i = 0; i < count; i++) {
    const t = n === 1 ? NOW.getTime() - i * 20 * 60000 : DAY0 - (i + 1) * 30 * 60000
    const hot = n === 1 && i < 2
    rows.push({
      id: String(Number(sid) * 10000 + n * 100 + i),
      uid: 'u' + ((i + 1) % 5),
      title: hot ? '热帖 ' + i + '（' + (sid === '23064' ? '自引测试' : '') + '）' : '帖子 ' + sid + '-' + n + '-' + i,
      content: '正文内容'.repeat(20),
      time: fmt(t), reply_time: fmt(t), edit_time: '0000-00-00 00:00:00',
      reply_count: hot ? 30 : i % 3, comment_count: hot ? 8 : 0,
      up_vote: hot ? 20 : 1, views: hot ? 500 : 20,
      is_essence: '-1', is_top: '-1', is_official: '-1',
      status: '1', del_status: '0', client_status: '0',
      user: { nickname: '用户' + i },
    })
  }
  // 自己的日报帖：标题命中日报模板 → 不能进日报（自引循环）
  if (n === 1) rows.push({
    id: '99999', uid: 'u0', title: '快爆论坛日报 2026-11-13', content: '今天的日报',
    time: fmt(NOW.getTime() - 5 * 60000), reply_time: fmt(NOW.getTime() - 5 * 60000), edit_time: '0000-00-00 00:00:00',
    reply_count: '100', comment_count: '10', up_vote: '50', views: '900',
    is_essence: '-1', is_top: '-1', is_official: '1', status: '1', del_status: '0', client_status: '0',
    user: { nickname: '小号' },
  })
  return { code: 100, result: { data: rows, last_id: n === 1 ? 'p1' : '0', cursor: n } }
}

let pageCalls = 0
const realFetch = globalThis.fetch
globalThis.fetch = async (url, init) => {
  const u = String(url)
  if (u.includes('m=section&ac=index')) {
    return new Response(JSON.stringify({ code: 100, result: { data: [{ type_name: 'g', list: SECTIONS.map((s) => ({ ...s, discuss_num: '1万', today_discuss_num: '50' })) }] } }), { status: 200 })
  }
  if (u.includes('section_topic')) {
    pageCalls++
    const sp = new URL(u).searchParams
    const n = sp.get('last_id') === '0' || !sp.get('last_id') ? 1 : 2
    return new Response(JSON.stringify(page(sp.get('section_id'), n)), { status: 200 })
  }
  if (u.includes('m=topic&ac=detail')) {
    const tid = new URL(u).searchParams.get('topic_id')
    return new Response(JSON.stringify({
      code: 100,
      result: {
        topic: { id: tid, content: '正文内容', is_up_voted: '-1' },
        reply: [
          { id: 'r' + tid, uid: 'u9', user: { nickname: '路人' }, content: '这条回复有点内容', position: 1, up_vote: '6' },
        ],
      },
    }), { status: 200 })
  }
  return new Response(JSON.stringify({ code: 100, result: {} }), { status: 200 })
}

const cfg = {
  self: { uid: 'u0', name: '小号' },
  owner: { uid: '', name: '' },
  ai: {},
  prompt: { rules: '', suffix: '' },
  persona: { name: '小号', ownerTitle: '主人', style: '简短' },
  summary: { enabled: true, maxComments: 20, style: '要点式' },
  browse: {
    sections: SECTIONS.map((s) => ({ id: s.id, title: s.title })),
    enabled: true, pick: 5, deep: 2, skipTop: true, muteTitles: [], excludeSelf: true,
    coverage: { crawlMaxRequests: 40, maxSections: 60 },
    perSectionMax: 2, perAuthorMax: 1, perAuthorMaxOfficial: 3, officialMax: 3, minScore: 0,
    lowSignal: { minViews: 30, minContent: 50 },
    autoReply: false, replyMax: 0, replyMinScore: 70,
  },
  like: {}, games: { enabled: false },
  post: { enabled: false, title: '快爆论坛日报 {date}', links: true, minPicks: 1, maxPerDay: 1, section: { id: '', title: '' } },
  risk: { minGapMs: 0, gapJitterMs: 0, readHourly: 1000, readDaily: 3000, writeHourly: 100, writeDaily: 100, writeGapSec: 0, backoffOnBlock: [1], dedupeDays: 14, dedupeSimilar: 0.86 },
  safety: { enabled: false, blockOutbound: false, blockInbound: false },
  emoji: { inComment: true },
  test: { enabled: false },
}

const { runDigest } = await import('../tools/lib/digest.mjs')
const { loadSeen } = await import('../tools/lib/state.mjs')

test('dry-run：扫到帖、打分选帖，但不写日报文件、不落证据包', async () => {
  const before = fs.readdirSync(digestDir).length
  const r = await runDigest(cfg, { dryRun: true, now: NOW })
  assert.ok(r.scanned >= 40, '两个板块今天至少 40 帖，实际 ' + r.scanned)
  assert.ok(r.picked.length >= 1, 'dry-run 也要选出帖来给预览')
  assert.equal(r.file, '', 'dry-run 不该有落盘路径')
  assert.equal(fs.readdirSync(digestDir).length, before, 'dry-run 不该产出任何文件')
  assert.equal(r.coverage.reachedCutoff, true, '两个板块都应该翻到当天 0 点')
})

test('真跑：一份日报 + 一份证据包，且不含自己的日报帖（自引循环）', async () => {
  const r = await runDigest(cfg, { dryRun: false, now: NOW })
  assert.ok(r.picked.length >= 1)
  const files = fs.readdirSync(digestDir)
  const mds = files.filter((f) => /^digest-\d{4}-\d{2}-\d{2}\.md$/.test(f))
  assert.equal(mds.length, 1, '真跑应当只有一份日报，实际 ' + files.join(','))
  assert.ok(files.some((f) => f.endsWith('.evidence.json')), '应当落一份证据包')
  const md = fs.readFileSync(path.join(digestDir, mds[0]), 'utf8')
  assert.ok(md.includes('# 好游快爆 · 日报 2026-11-13'))
  assert.ok(md.includes('覆盖：2 个板块'), '日报要写明覆盖了哪些板块')
  assert.ok(!md.includes('快爆论坛日报 2026-11-13'), '自己的日报帖不能进日报')
  assert.ok(!/undefined|NaN/.test(md), '日报里不能有 undefined / NaN')
  const seen = loadSeen()
  assert.ok(Object.keys(seen.replies || {}).length >= 0)
})

test('同一天跑第二轮是覆盖写，不是追加流水账', async () => {
  const r1 = await runDigest(cfg, { dryRun: false, now: NOW })
  const file = r1.file
  const first = fs.readFileSync(file, 'utf8')
  const r2 = await runDigest(cfg, { dryRun: false, now: new Date(NOW.getTime() + 30 * 60000) })
  const second = fs.readFileSync(file, 'utf8')
  const heads = (second.match(/^# 好游快爆 · 日报 2026-11-13$/gm) || []).length
  assert.equal(heads, 1, '一天只该有一个 H1（覆盖写）')
  assert.equal(fs.readdirSync(digestDir).filter((f) => /^digest-\d{4}-\d{2}-\d{2}\.md$/.test(f)).length, 1)
  assert.notEqual(first, second, '第二轮应当刷新内容（更新时间不同）')
})

test.after(() => { globalThis.fetch = realFetch; fs.rmSync(home, { recursive: true, force: true }) })
