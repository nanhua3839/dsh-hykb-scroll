// 日报发帖：正文格式、原帖链接、固定后缀、每日上限、真发时的请求体。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hykb-post-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSH_HOME = path.join(home, '.dsh')
process.env.HYKB_SCROLL_CONFIG = path.join(home, '.dsh', 'hykb-scroll.config.json')
fs.mkdirSync(path.join(home, '.dsh'), { recursive: true })
// 写冷却设 0，否则同一进程里连发两次会被 traffic.mjs 挡住
fs.writeFileSync(process.env.HYKB_SCROLL_CONFIG, JSON.stringify({ risk: { writeGapSec: 0, minGapMs: 0, writeHourly: 100, writeDaily: 100 } }))

const { toThreadHtml, postMarkdown, postTitle, publishDigest, loadPostLog, TITLE_MAX } = await import('../tools/lib/post.mjs')
const { applySuffix, threadUrl } = await import('../tools/lib/ai.mjs')

const picks = [{ topicId: '111', title: 'A 帖' }, { topicId: '222', title: 'B 帖' }, { topicId: '333', title: 'C 帖' }]
const baseCfg = (post = {}, prompt = {}) => ({
  post: { enabled: true, section: { id: '23064', title: '综合讨论' }, title: '日报 {date}', maxPerDay: 1, minPicks: 3, links: true, ...post },
  prompt: { rules: '', suffix: '', ...prompt },
})

test('Markdown 转成编辑器 HTML：丢一级标题、h2、粗体、转义、空行', () => {
  const html = toThreadHtml('<!-- x -->\n# 日报 2026\n\n## 今天\n**重点** a<b>\n\n\n第二段\n')
  assert.equal(html, '<h2>今天</h2><div><b>重点</b> a&lt;b&gt;</div><div><br></div><div>第二段</div>')
})

test('正文末尾附原帖链接，链接由程序拼', () => {
  const md = postMarkdown('正文', picks, baseCfg())
  for (const p of picks) assert.ok(md.includes(threadUrl(p.topicId)), '缺 ' + p.topicId)
  assert.match(md, /## 原帖链接/)
})

test('关掉链接开关就不附', () => {
  assert.doesNotMatch(postMarkdown('正文', picks, baseCfg({ links: false })), /原帖链接/)
})

test('正文已经带全链接时不重复附', () => {
  const body = picks.map((p) => p.title + ' ' + threadUrl(p.topicId)).join('\n')
  assert.doesNotMatch(postMarkdown(body, picks, baseCfg()), /原帖链接/)
})

test('固定后缀：程序追加、去掉模型自己写的重复、截断时保住后缀', () => {
  assert.equal(applySuffix('你好', { suffix: '内容由AI生成' }), '你好 内容由AI生成')
  assert.equal(applySuffix('你好（内容由AI生成）', { suffix: '内容由AI生成' }), '你好 内容由AI生成')
  const long = applySuffix('字'.repeat(300), { suffix: '内容由AI生成', max: 200 })
  assert.ok(long.length <= 200, '超长了：' + long.length)
  assert.ok(long.endsWith('内容由AI生成'))
  assert.equal(applySuffix('你好', { suffix: '' }), '你好')
  assert.match(postMarkdown('正文', picks, baseCfg({}, { suffix: '内容由AI生成' })), /\n\n内容由AI生成$/)
})

test('标题模板替换日期并按平台上限截断', () => {
  assert.equal(postTitle('日报 {date}', { date: '2026-11-01' }), '日报 2026-11-01')
  assert.equal(postTitle('长'.repeat(80), {}).length, TITLE_MAX)
})

test('没开、没选板块、帖子太少时不发；手动发不看开关和帖数', async () => {
  const d = '2026-11-01'
  assert.equal((await publishDigest({ body: 'x', picks, cfg: baseCfg({ enabled: false }), date: d, dryRun: true })).status, 'skipped')
  assert.equal((await publishDigest({ body: 'x', picks, cfg: baseCfg({ section: { id: '' } }), date: d, dryRun: true, force: true })).status, 'skipped')
  assert.equal((await publishDigest({ body: 'x', picks: picks.slice(0, 1), cfg: baseCfg(), date: d, dryRun: true })).status, 'skipped')
  const r = await publishDigest({ body: 'x', picks: picks.slice(0, 1), cfg: baseCfg({ enabled: false }), date: d, dryRun: true, force: true })
  assert.equal(r.status, 'preview')
  assert.equal(r.title, '日报 2026-11-01')
})

test('没登录时真发直接失败，不出网', async () => {
  const real = globalThis.fetch
  let hit = 0
  globalThis.fetch = async () => { hit++; return new Response('{}') }
  try {
    const r = await publishDigest({ body: 'x', picks, cfg: baseCfg(), date: '2026-11-02' })
    assert.equal(r.status, 'failed')
    assert.equal(hit, 0)
  } finally { globalThis.fetch = real }
})

test('真发：请求体带板块和 HTML，记台账；超过每日上限不再发', async () => {
  fs.mkdirSync(path.join(home, '.hykb-ai'), { recursive: true })
  fs.writeFileSync(path.join(home, '.hykb-ai', 'credentials.json'), JSON.stringify({ uid: '42', Pauth: 'p', Uauth: 'u', nickname: '小号' }))
  const real = globalThis.fetch
  const sent = []
  globalThis.fetch = async (url, init) => {
    sent.push({ url: String(url), body: new URLSearchParams(String(init?.body || '')) })
    return new Response(JSON.stringify({ code: 100, msg: '发布成功' }), { status: 200 })
  }
  try {
    const d = '2026-11-03'
    const r = await publishDigest({ body: '## 今天\n聊得挺多', picks, cfg: baseCfg(), date: d })
    assert.equal(r.status, 'posted', JSON.stringify(r))
    const req = sent.find((x) => x.url.includes('a=setThread'))
    assert.ok(req, '没打到 setThread')
    assert.equal(req.body.get('fid'), '23064')
    assert.equal(req.body.get('title'), '日报 2026-11-03')
    assert.match(req.body.get('content'), /<h2>今天<\/h2>/)
    assert.ok(req.body.get('content').includes(threadUrl('111')))
    assert.equal(loadPostLog().filter((x) => x.date === d && x.ok).length, 1)

    const again = await publishDigest({ body: 'x', picks, cfg: baseCfg(), date: d, force: true })
    assert.equal(again.status, 'skipped', '每日上限对手动发也生效')
    const n = sent.filter((x) => x.url.includes('a=setThread')).length
    assert.equal(n, 1)

    const second = await publishDigest({ body: 'x', picks, cfg: baseCfg({ maxPerDay: 2 }), date: d })
    assert.equal(second.status, 'posted')
    assert.equal(second.title, '日报 2026-11-03 · 2')
  } finally { globalThis.fetch = real }
})
