import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 宿主侧云路由的端到端测试：不联网，云函数用 fetch 桩顶掉。
// 覆盖：未登录态 → 登录 → 自动同步（push/pull）→ 退出登录。
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hykb-cloud-routes-'))
process.env.USERPROFILE = home
process.env.HOME = home
const CFG = path.join(home, '.dsh', 'hykb-scroll.config.json')
process.env.HYKB_SCROLL_CONFIG = CFG
fs.mkdirSync(path.dirname(CFG), { recursive: true })
fs.mkdirSync(path.join(home, '.hykb-ai', 'accounts', '1001'), { recursive: true })
fs.writeFileSync(CFG, JSON.stringify({
  listen: { enabled: false },
  profiles: { activePersona: 'p1', personas: [{ id: 'p1', label: '默认人设' }], accounts: [{ id: '1001', label: '小号' }] },
}, null, 2))
fs.writeFileSync(path.join(home, '.hykb-ai', 'active-account'), '1001\n')
fs.writeFileSync(path.join(home, '.hykb-ai', 'accounts', '1001', 'credentials.json'), JSON.stringify({ uid: '1001', Pauth: 'p1|x' }))

// 云函数桩：路由 → 响应；调用记录留着断言
const calls = []
let stateKv = {}
let leaseOwner = ''
globalThis.fetch = async (url, opt = {}) => {
  const u = new URL(String(url))
  const p = u.pathname.replace(/^.*\/nanhua-api/, '')
  const body = opt.body ? JSON.parse(opt.body) : null
  calls.push({ path: p + (u.search || ''), method: opt.method || 'GET' })
  const reply = (obj) => ({ ok: true, status: 200, json: async () => obj })
  if (p === '/login') return reply({ ok: true, username: 'probe_user', token: 'tok-1' })
  if (p === '/plugin/state' && (opt.method || 'GET') === 'POST') {
    let applied = 0
    for (const [k, cell] of Object.entries(body.kv || {})) {
      if (!stateKv[k] || Number(cell.t) > Number(stateKv[k].t)) { stateKv[k] = cell; applied += 1 }
    }
    return reply({ ok: true, now: Date.now(), applied })
  }
  if (p === '/plugin/state') {
    const since = Number(u.searchParams.get('since') || 0)
    const kv = {}
    for (const [k, cell] of Object.entries(stateKv)) if (!since || Number(cell.t) > since) kv[k] = cell
    return reply({ ok: true, now: Date.now(), kv })
  }
  if (p === '/plugin/lease') {
    const mine = !leaseOwner || leaseOwner === body.deviceId
    if (mine) leaseOwner = body.action === 'release' ? '' : body.deviceId
    return reply({ ok: true, mine, holder: leaseOwner ? { deviceId: leaseOwner, deviceName: '台式机', until: Date.now() + 90000 } : null, ttl: 90000 })
  }
  if (p === '/plugin/qr/start') return reply({ ok: true, code: 'a'.repeat(32), expiresAt: Date.now() + 300000, url: 'https://example.invalid/link?code=x' })
  return reply({ ok: false, error: 'unexpected ' + p })
}

const plugin = (await import('../lib/index.js')).default

const ROUTES = []
const ctx = {
  effect: (fn) => { fn() },
  get: (n) => (n === 'connection' ? { isTrusted: () => true, requestRejection: () => null } : undefined),
  webServer: { register: (o) => { ROUTES.push(o); return () => {} } },
}
plugin.apply(ctx)

const call = async (pathname, { method = 'GET', body } = {}) => {
  const route = ROUTES.find((r) => r.path === pathname)
  assert.ok(route, '缺路由 ' + pathname)
  return new Promise((resolve) => {
    const out = { code: 0, body: '' }
    const res = { writeHead(c) { out.code = c }, end(b) { out.body = String(b || ''); resolve({ code: out.code, json: out.body ? JSON.parse(out.body) : null }) }, writableEnded: false, setHeader() {} }
    const req = {
      method, url: pathname, headers: { host: '127.0.0.1:51548' },
      on(ev, fn) { if (ev === 'data' && body !== undefined) queueMicrotask(() => fn(Buffer.from(JSON.stringify(body), 'utf8'))); if (ev === 'end') queueMicrotask(fn); return req },
      resume() {}, destroy() {}, socket: { remoteAddress: '127.0.0.1' },
    }
    route.handler(req, res)
  })
}

test('未登录：账号条只看得到「没登录」', async () => {
  const r = await call('/dsh-hykb/api/cloud')
  assert.equal(r.code, 200)
  assert.equal(r.json.account.loggedIn, false)
  assert.equal(r.json.sync.lastPushAt, 0)
  assert.equal(r.json.lease.mine, false)
})

test('登录后拿到本地令牌，界面立刻变已登录', async () => {
  const r = await call('/dsh-hykb/api/cloud/auth', { method: 'POST', body: { action: 'login', username: 'probe_user', password: 'secret123' } })
  assert.equal(r.code, 200)
  assert.equal(r.json.account.loggedIn, true)
  assert.equal(r.json.account.username, 'probe_user')
  assert.equal(r.json.account.token, undefined, '令牌不许回给前端')
  const st = await call('/dsh-hykb/api/cloud')
  assert.equal(st.json.account.loggedIn, true)
})

test('手动同步 push：把本地配置推到云端，且不推密钥', async () => {
  fs.writeFileSync(path.join(home, '.hykb-ai', 'ai-key'), 'SK-MUST-NOT-LEAVE\n')
  const r = await call('/dsh-hykb/api/cloud/sync', { method: 'POST', body: { direction: 'push' } })
  assert.equal(r.code, 200)
  assert.match(r.json.summary, /已上传/)
  const pushed = calls.filter((c) => c.path === '/plugin/state' && c.method === 'POST')
  assert.ok(pushed.length >= 1)
  assert.equal(JSON.stringify(stateKv).includes('SK-MUST-NOT-LEAVE'), false, '密钥不许上云')
  assert.equal(Object.keys(stateKv).some((k) => k === 'cfg.listen.enabled'), true)
})

test('手动同步 pull：远端改动落回本地配置', async () => {
  // 造一个「另一台机器」的改动：更新的 t，值不同
  stateKv['cfg.listen.enabled'] = { v: true, t: Date.now() + 1000 }
  stateKv['cfg.browse.perDay'] = { v: 9, t: Date.now() + 1000 }
  const r = await call('/dsh-hykb/api/cloud/sync', { method: 'POST', body: { direction: 'pull' } })
  assert.equal(r.code, 200)
  assert.match(r.json.summary, /已下载/)
  const cfg = JSON.parse(fs.readFileSync(CFG, 'utf8'))
  assert.equal(cfg.listen.enabled, true, '远端更新的值要盖回来')
  assert.equal(cfg.browse.perDay, 9)
})

test('扫码登录：服务端出二维码，编码不变形', async () => {
  const r = await call('/dsh-hykb/api/cloud/qr/start', { method: 'POST', body: {} })
  assert.equal(r.code, 200)
  assert.equal(r.json.code, 'a'.repeat(32))
  assert.match(r.json.qrDataUrl, /^data:image\/png;base64,/)
})

test('退出登录：清本地令牌，账号条回到未登录', async () => {
  const r = await call('/dsh-hykb/api/cloud/logout', { method: 'POST', body: {} })
  assert.equal(r.code, 200)
  assert.equal(r.json.account.loggedIn, false)
  assert.equal(fs.existsSync(path.join(home, '.hykb-ai', 'plugin-account.json')), false)
})
