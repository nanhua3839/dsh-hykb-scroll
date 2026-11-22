/**
 * 设置页静态渲染测试 —— 没有浏览器也要能验：
 *   1. FIELDS 里每个 path 都真的存在于配置默认值（写错路径 = 界面上是个空框，不报错）
 *   2. 每张卡都能渲染出来，不出现 undefined / NaN / [object Object] 漏到文本里
 *   3. 卡片序号连续、不重号
 *
 * 做法：假 window.__ModuleLoader__ + 假 react（hooks 按调用顺序返回预设值），
 *      递归展开函数组件拿到完整元素树，再遍历取文本。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLIENT = path.join(HERE, '..', 'lib', 'client.js')

/** 假 react：createElement 造朴素节点，hooks 按顺序取值 */
function makeReact(overrides = {}) {
  let i = 0
  const take = (init) => (i - 1 in overrides ? overrides[i - 1] : init)
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter((c) => c != null && c !== false && c !== true) }),
    useState(init) { i += 1; const v = take(init); return [v, () => {}] },
    useCallback(fn) { i += 1; take(fn); return fn },
    useMemo(fn) { i += 1; take(fn); return fn() },
    useEffect() { i += 1 },
    useRef(v) { i += 1; take(v); return { current: v } },
    __reset() { i = 0 },
  }
  return React
}

/** 递归展开：函数组件直接调用，返回元素树 */
function expand(node, depth = 0) {
  if (node == null || node === false) return null
  if (typeof node === 'string' || typeof node === 'number') return node
  if (Array.isArray(node)) return node.map((n) => expand(n, depth))
  if (typeof node.type === 'function') {
    if (depth > 40) throw new Error('组件递归过深：' + (node.type.name || '?'))
    return expand(node.type({ ...node.props, children: node.children }), depth + 1)
  }
  return { ...node, children: (node.children || []).map((c) => expand(c, depth + 1)) }
}

function texts(node, out = []) {
  if (node == null || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const n of node) texts(n, out); return out }
  for (const c of node.children || []) texts(c, out)
  return out
}

function collect(node, pred, out = []) {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const n of node) collect(n, pred, out); return out }
  if (pred(node)) out.push(node)
  for (const c of node.children || []) collect(c, pred, out)
  return out
}

/** 从磁盘读默认配置（工具链那份，最全） */
async function defaults() {
  const mod = await import(pathToFileURL(path.join(HERE, '..', 'tools', 'lib', 'config.mjs')).href)
  return mod.DEFAULTS || mod.default || null
}

async function loadClient(overrides) {
  const src = fs.readFileSync(CLIENT, 'utf8')
  let factory = null
  const React = makeReact(overrides)
  const sandbox = {
    window: { __ModuleLoader__: { load: ({ factory: f }) => { factory = f } } },
    document: { querySelector: () => null, createElement: () => ({ setAttribute() {}, textContent: '' }), head: { appendChild() {} } },
  }
  const fn = new Function('window', 'document', src)
  fn(sandbox.window, sandbox.document)
  assert.ok(factory, 'client.js 没有调用 window.__ModuleLoader__.load')
  const mod = factory((name) => {
    if (name !== 'react') throw new Error('未知依赖：' + name)
    return React
  })
  return { mod, React }
}

test('FIELDS 里每个 path 都存在于默认配置', async () => {
  const { mod } = await loadClient()
  const D = await defaults()
  assert.ok(D, '读不到 tools/lib/config.mjs 的 DEFAULTS')
  const missing = []
  for (const f of mod.FIELDS) {
    const v = f.path.reduce((o, k) => (o == null ? undefined : o[k]), D)
    if (v === undefined) missing.push(f.path.join('.'))
  }
  assert.deepEqual(missing, [], '这些字段路径在配置里不存在：' + missing.join(', '))
})

test('FIELDS 的 sec 都有对应卡片、字段不重复', async () => {
  const { mod } = await loadClient()
  const secs = new Set(mod.FIELDS.map((f) => f.sec))
  // emoji 已没有开关（楼中楼带表情改为默认能力），所以这一组里不再有它
  assert.deepEqual([...secs].sort(), ['ai', 'browse', 'focus', 'games', 'like', 'post', 'prompt', 'reply', 'risk', 'who'])
  const seen = new Set()
  for (const f of mod.FIELDS) {
    const k = f.path.join('.')
    assert.ok(!seen.has(k), '字段重复定义：' + k)
    seen.add(k)
  }
})

test('整页能渲染：卡片序号连续、无 undefined / NaN 漏进文本', async () => {
  const D = await defaults()
  const status = {
    ok: true,
    credentials: { present: true, uid: '123', nickname: '大肥鱼', hasPauth: true },
    aiReady: true,
    traffic: { readHour: 1, readDay: 2, writeHour: 3, writeDay: 4 },
    listen: { running: false, lastTickAt: null, lastError: null },
    browse: { enabled: true, hasSession: true, lastRunAt: null, lastError: null, lastResult: { scanned: 115, picked: 8, replied: 0 } },
  }
  const { mod, React } = await loadClient({ 0: D, 1: status })
  React.__reset()
  const tree = expand(React.createElement(mod.HykbScrollSection, {}))
  const all = texts(tree).join(' ')
  // 页头标题与副标题已按需求删掉，只留「刷新状态」。用页面必有的骨架断言渲染成功：
  // 没有页头标题，但状态条 + 卡片必须出来。
  assert.ok(all.includes('刷新状态'), '页头没渲染出来')
  assert.ok(all.includes('账号'), '状态条没渲染出来')
  for (const bad of ['undefined', 'NaN', '[object Object]']) {
    assert.ok(!all.includes(bad), '文本里漏出了 ' + bad)
  }

  const cards = collect(tree, (n) => n.props && typeof n.props.className === 'string' && n.props.className === 'hks-card')
  assert.ok(cards.length >= 6, '卡片数不对：' + cards.length)
  const nos = collect(tree, (n) => n.props && n.props.className === 'hks-no').map((n) => texts(n).join(''))
  assert.deepEqual(nos, ['1', '2', '3', '4', '5', '6', '7', '8', '9'])
})

test('必做步骤缺一项时状态条会标红', async () => {
  const D = await defaults()
  const status = { ok: true, credentials: { present: false }, aiReady: false, traffic: { readHour: 0, readDay: 0, writeHour: 0, writeDay: 0 }, listen: { running: false }, browse: { enabled: false, hasSession: false } }
  const { mod, React } = await loadClient({ 0: D, 1: status })
  React.__reset()
  const tree = expand(React.createElement(mod.HykbScrollSection, {}))
  const dots = collect(tree, (n) => n.props && typeof n.props.className === 'string' && n.props.className === 'hks-dot')
    .map((n) => n.props['data-s'])
  assert.ok(dots.includes('bad'), '未登录 / 未接 AI 时应该有红灯')
  const all = texts(tree).join(' ')
  assert.ok(all.includes('未登录') && all.includes('未配置'), '状态文字不对')
  assert.ok(all.includes('宿主无会话能力'), '没有会话能力时应该显式提示')
})

test('收尾只有保存状态、没有保存按钮（改动仍会自动保存）', async () => {
  const D = await defaults()
  const status = { ok: true, credentials: { present: true, uid: '1', nickname: 'n', hasPauth: true }, aiReady: true, traffic: { readHour: 0, readDay: 0, writeHour: 0, writeDay: 0 }, listen: { running: false }, browse: { enabled: true, hasSession: true } }
  const { mod, React } = await loadClient({ 0: D, 1: status })
  React.__reset()
  const tree = expand(React.createElement(mod.HykbScrollSection, {}))

  // 用户要求去掉页尾那颗「保存」按钮：只剩状态行，改动照样自动存
  const saveBtns = collect(tree, (n) => n.type === 'button' && texts(n).join('').trim() === '保存')
  assert.equal(saveBtns.length, 0, '页尾不该再有保存按钮')
  assert.equal(collect(tree, (n) => n.props && n.props.className === 'hks-bar').length, 0, '浮动保存条不该存在')

  const rows = collect(tree, (n) => n.props && n.props.className === 'hks-saverow')
  assert.equal(rows.length, 1, '应该有一行保存状态')
  assert.match(texts(rows[0]).join(''), /自动保存/, '仍要说明改动会自动存')
})

test('账号 / 云同步 / 云备份 合成一块：未登录也看得见三个入口', async () => {
  const D = await defaults()
  const status = { ok: true, credentials: { present: false }, aiReady: false, traffic: { readHour: 0, readDay: 0, writeHour: 0, writeDay: 0 }, listen: { running: false }, browse: { enabled: false, hasSession: false } }
  const { mod, React } = await loadClient({ 0: D, 1: status })
  React.__reset()
  const tree = expand(React.createElement(mod.HykbScrollSection, {}))
  const all = texts(tree).join(' ')

  // 一个区域：账号 + 云同步 + 云备份（用户要求合并，不许再拆成两块）
  const bars = collect(tree, (n) => n.props && typeof n.props.className === 'string' && n.props.className.includes('hks-acctbar'))
  assert.equal(bars.length, 1, '账号区域应该只有一块')
  for (const t of ['快爆Pro账号', '云同步', '云备份', '登录后才能选本机角色、手动同步。', '登录后才能上传 / 下载方案。']) {
    assert.ok(all.includes(t), '缺少：' + t)
  }
  assert.ok(!/undefined|NaN|\[object Object\]/.test(all), '文本里漏出了脏值')
})

test('点一下开关就自动 POST 配置，不用再点保存', async () => {
  const D = await defaults()
  const status = { ok: true, credentials: { present: true, uid: '1', nickname: 'n', hasPauth: true }, aiReady: true, traffic: { readHour: 0, readDay: 0, writeHour: 0, writeDay: 0 }, listen: { running: false }, browse: { enabled: true, hasSession: true } }
  const calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, opt) => {
    const method = (opt && opt.method) || 'GET'
    calls.push({ url, method, body: opt && opt.body })
    const payload = String(url).endsWith('/status') ? status : { ok: true, config: D }
    return { json: async () => payload }
  }
  try {
    const { mod, React } = await loadClient({ 0: D, 1: status })
    React.__reset()
    const tree = expand(React.createElement(mod.HykbScrollSection, {}))
    const switches = collect(tree, (n) => n.type === 'button' && n.props.role === 'switch')
    assert.ok(switches.length > 0, '页面上应该有关关')
    switches[0].props.onClick()
    assert.equal(calls.length, 0, '点完不该立刻发请求，要先去抖')
    await new Promise((r) => setTimeout(r, 500))
    const posts = calls.filter((c) => c.method === 'POST' && String(c.url).endsWith('/settings'))
    assert.equal(posts.length, 1, '去抖结束后应该自动提交一次配置')
    assert.ok(JSON.parse(posts[0].body).config, 'POST 体里应该带整份配置')
  } finally {
    globalThis.fetch = realFetch
  }
})


test('卡片不再标注词元消耗', async () => {
  const D = await defaults()
  const status = { ok: true, credentials: { present: true, uid: '1', nickname: 'n', hasPauth: true }, aiReady: true, traffic: { readHour: 0, readDay: 0, writeHour: 0, writeDay: 0 }, listen: { running: false }, browse: { enabled: true, hasSession: true } }
  const { mod, React } = await loadClient({ 0: D, 1: status })
  React.__reset()
  const tree = expand(React.createElement(mod.HykbScrollSection, {}))

  const cards = collect(tree, (n) => n.props && n.props.className === 'hks-card')
  const costCards = []
  for (const c of cards) {
    const h4 = collect(c, (n) => n.type === 'h4')
    if (!h4.length) continue
    const icons = collect(h4[0], (n) => n.props && n.props['aria-label'] === '此功能消耗词元。')
    // 裸 ⓘ 会把自己的字形 "i" 算进 h4 文本，徽章文字也在里面：先剥徽章，再剥 ⓘ 字形
    if (icons.length) costCards.push(texts(h4[0]).join('').replace(/(已接|开)$/, '').replace(/i$/, ''))
  }
  assert.deepEqual(costCards, [], '用户要求去掉「此功能消耗词元」提示，任何卡片都不该再带')

  // 文字只在气泡里，不占版面：卡片标题行本身不该出现这句话
  const heads = collect(tree, (n) => n.type === 'h4').map((n) => texts(n).join(''))
  assert.ok(heads.every((t) => !t.includes('此功能消耗词元。')), '标题行不该把这句话画出来')
})


test('创作/官方不回复 + 抖动 + 浏览记录 都真的画出来了', async () => {
  const D = await defaults()
  // 这些控件住在卡片④/⑤的正文里：卡片的约定是「开关关着就不渲染正文」，所以要先把两个开关打开
  D.listen = { ...(D.listen || {}), enabled: true }
  D.browse = { ...(D.browse || {}), enabled: true }
  const status = { ok: true, credentials: { present: true, uid: '1', nickname: 'n', hasPauth: true }, aiReady: true, traffic: { readHour: 0, readDay: 0, writeHour: 0, writeDay: 0 }, listen: { running: true }, browse: { enabled: true, hasSession: true } }
  const { mod, React } = await loadClient({ 0: D, 1: status })
  React.__reset()
  const tree = expand(React.createElement(mod.HykbScrollSection, {}))
  const all = texts(tree).join(' ')

  assert.ok(all.includes('创作 / 官方内容不回复'), '缺少创作/官方那一段的标题')
  for (const t of ['精华帖不接话', '官方发布不接话', '长文投稿不接话', '官方白名单', '官方黑名单']) {
    assert.ok(all.includes(t), '缺少控件：' + t)
  }
  assert.ok(all.includes('扫描抖动（±秒）'), '回帖轮的抖动字段没渲染（tier-1 字段漏了？）')
  assert.ok(all.includes('刷帖抖动（±秒）'), '刷帖轮的抖动字段没渲染')
  assert.ok(all.includes('浏览记录'), '缺少浏览记录卡片')
  assert.ok(all.includes('游戏评价观察（只读）'), '缺少游戏评价那一段')
  // games 默认关着 → 只留开关和说明，不展开榜单/清单
  assert.ok(!all.includes('从哪个榜单挑'), 'games 关着时不该展开榜单选择')
})

test('个性化题材的选项与 config.mjs 的 INTEREST_TAGS 逐字一致', async () => {
  const { mod } = await loadClient()
  const cfgMod = await import(pathToFileURL(path.join(HERE, '..', 'tools', 'lib', 'config.mjs')).href)
  const field = mod.FIELDS.find((f) => f.path.join('.') === 'browse.interests.tags')
  assert.ok(field, 'FIELDS 里没有个性化题材这一项')
  // 浏览器半边不能 import 工具链，清单是抄的一份 ⇒ 这里对账，抄漏了立刻红
  assert.deepEqual(field.opts, cfgMod.INTEREST_TAGS,
    'client.js 的题材清单与 tools/lib/config.mjs 的 INTEREST_TAGS 不一致')
})

test('「回复我的」三类开关与假 @ 兜底都真的画出来了', async () => {
  const D = await defaults()
  D.listen = { ...(D.listen || {}), enabled: true }
  const status = { ok: true, credentials: { present: true, uid: '1', nickname: 'n', hasPauth: true }, aiReady: true, traffic: { readHour: 0, readDay: 0, writeHour: 0, writeDay: 0 }, listen: { running: true }, browse: { enabled: false, hasSession: true } }
  const { mod, React } = await loadClient({ 0: D, 1: status })
  React.__reset()
  const tree = expand(React.createElement(mod.HykbScrollSection, {}))
  const all = texts(tree).join(' ')
  for (const t of ['接「回复我的」通知', '有人回你的回复时接话', '有人回你的回帖时接话', '你帖子下的新回复也接话', '扫我参与过的帖，认纯文本 @']) {
    assert.ok(all.includes(t), '缺少控件：' + t)
  }
  assert.ok(!/undefined|NaN/.test(all), '漏出了 undefined / NaN')
})

test('打开游戏评价后才展开榜单 / 清单 / 试读按钮', async () => {
  const D = await defaults()
  D.browse = { ...(D.browse || {}), enabled: true }
  D.games = { ...(D.games || {}), enabled: true }
  const status = { ok: true, credentials: { present: true, uid: '1', nickname: 'n', hasPauth: true }, aiReady: true, traffic: { readHour: 0, readDay: 0, writeHour: 0, writeDay: 0 }, listen: { running: false }, browse: { enabled: true, hasSession: true } }
  const { mod, React } = await loadClient({ 0: D, 1: status })
  React.__reset()
  const tree = expand(React.createElement(mod.HykbScrollSection, {}))
  const all = texts(tree).join(' ')
  for (const t of ['从哪个榜单挑', '指定游戏 id', '每轮看几个游戏', '试读一批评价']) {
    assert.ok(all.includes(t), '缺少控件：' + t)
  }
  assert.ok(!/undefined|NaN/.test(all), '展开后漏出了 undefined / NaN')
})
