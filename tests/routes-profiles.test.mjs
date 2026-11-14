// /api/profiles：三张清单 + 三向切换。在临时 HOME 里跑，不碰本机配置与凭据。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hykb-profiles-api-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSH_HOME = path.join(home, '.dsh')
process.env.HYKB_SCROLL_CONFIG = path.join(home, '.dsh', 'hykb-scroll.config.json')
fs.mkdirSync(path.join(home, '.dsh'), { recursive: true })

const { default: plugin } = await import('../lib/index.js')
const PR = await import('../tools/lib/profiles.mjs')
const C = await import('../tools/lib/cred.mjs')
const K = await import('../tools/lib/config.mjs')

const LOOPBACK = { host: '127.0.0.1:51548' }
function makeCtx({ connection } = {}) {
  const routes = []
  const ctx = {
    effect: (fn) => { fn() },
    get: (n) => (n === 'connection' ? connection : undefined),
    webServer: { register: (o) => { routes.push(o); return () => {} } },
  }
  return { ctx, routes }
}
function fakeRes() {
  const out = { code: 0, body: '' }
  return { out, setHeader() {}, writeHead(c) { out.code = c }, end(b) { out.body = String(b || '') }, writableEnded: false }
}
function fakeReq(headers = LOOPBACK, body = '') {
  const handlers = {}
  const req = {
    method: 'GET', url: '/', headers, body,
    on(ev, fn) {
      handlers[ev] = fn
      if (ev === 'data' && body) queueMicrotask(() => fn(Buffer.from(body, 'utf8')))
      if (ev === 'end') queueMicrotask(() => fn())
      return req
    },
    resume() {}, destroy() {},
    socket: { remoteAddress: '127.0.0.1' },
  }
  return req
}
const postReq = (body, headers = LOOPBACK) => {
  const r = fakeReq(headers, typeof body === 'string' ? body : JSON.stringify(body))
  r.method = 'POST'
  return r
}
const find = (routes, suffix) => routes.find((x) => String(x.path || x.pathname).endsWith(suffix))
const trusted = () => {
  const { ctx, routes } = makeCtx({ connection: { isTrusted: () => true, requestRejection: () => null } })
  plugin.apply(ctx)
  return routes
}
const call = async (routes, suffix, req) => {
  const res = fakeRes()
  await find(routes, suffix).handler(req, res)
  return { code: res.out.code, j: JSON.parse(res.out.body || '{}') }
}

test('GET /profiles：两个号 + 人设清单 + 线路清单，且不回显任何密钥', async () => {
  C.saveCredFor('5005', { uid: '5005', Pauth: 'p5', nickname: '阿岚' })
  C.saveCredFor('6006', { uid: '6006', Pauth: 'p6', nickname: '小海' })
  PR.registerAccount({ uid: '5005', nickname: '阿岚' })
  PR.registerAccount({ uid: '6006', nickname: '小海' })
  PR.switchAccount('5005')
  K.writeConfig({ ai: { baseUrl: 'https://api.example.com', model: 'm', relays: [{ id: 'r1', name: '中转一', baseUrl: 'https://r.example.com', model: 'mm', enabled: true }] } })

  const routes = trusted()
  const r = await call(routes, '/profiles', fakeReq())
  assert.equal(r.code, 200)
  assert.equal(r.j.accounts.length, 2)
  assert.deepEqual(r.j.accounts.map((a) => a.id).sort(), ['5005', '6006'])
  assert.equal(r.j.accounts.find((a) => a.active).id, '5005')
  assert.ok(r.j.personas.length >= 1)
  assert.equal(r.j.lines[0].id, 'direct')
  assert.equal(r.j.lines.find((l) => l.id === 'r1').name, '中转一')
  assert.equal(r.j.active.account, '5005')
  assert.equal(r.j.active.line, 'direct')

  const dump = JSON.stringify(r.j)
  assert.equal(dump.includes('p5'), false, '凭据不进接口')
  assert.equal(dump.includes('"apiKey"'), false, '密钥不进接口')
})

test('POST /profiles：切人设、切线路、切号立刻反映到 config 与 active', async () => {
  const routes = trusted()
  const added = await call(routes, '/profiles', postReq({ action: 'addPersona', label: '毒舌' }))
  assert.equal(added.code, 200, JSON.stringify(added.j))
  const pid = added.j.created.id

  const sw = await call(routes, '/profiles', postReq({ action: 'switchPersona', id: pid }))
  assert.equal(sw.code, 200)
  assert.equal(sw.j.active.persona, pid)
  assert.equal(K.config().__activePersona.id, pid)
  assert.equal(K.config().persona.name, '毒舌')

  const line = await call(routes, '/profiles', postReq({ action: 'switchLine', id: 'r1' }))
  assert.equal(line.code, 200)
  assert.equal(line.j.active.line, 'r1')
  assert.equal(K.config().ai.activeRelay, 'r1')

  const bad = await call(routes, '/profiles', postReq({ action: 'switchLine', id: 'nope' }))
  assert.equal(bad.code, 400)

  const acc = await call(routes, '/profiles', postReq({ action: 'switchAccount', id: '6006' }))
  assert.equal(acc.code, 200, JSON.stringify(acc.j))
  assert.equal(acc.j.active.account, '6006')
  assert.equal(K.config().self.uid, '6006')
  assert.equal(K.config().self.name, '小海')
  assert.equal(PR.accounts().find((a) => a.id === '5005').lastPersona, pid, '旧号要记住人设')
})

test('POST /profiles：人设增删改与账号备注、移除', async () => {
  const routes = trusted()
  const dup = await call(routes, '/profiles', postReq({ action: 'duplicatePersona', id: PR.activePersonaId() }))
  assert.equal(dup.code, 200)
  const copyId = dup.j.created.id
  const ren = await call(routes, '/profiles', postReq({ action: 'renamePersona', id: copyId, label: '副本改名' }))
  assert.equal(ren.code, 200)
  assert.equal(PR.personas().find((p) => p.id === copyId).label, '副本改名')
  const del = await call(routes, '/profiles', postReq({ action: 'removePersona', id: copyId }))
  assert.equal(del.code, 200)
  assert.equal(PR.personas().some((p) => p.id === copyId), false)

  const label = await call(routes, '/profiles', postReq({ action: 'labelAccount', id: '5005', label: '大号阿岚' }))
  assert.equal(label.code, 200)
  assert.equal(PR.accounts().find((a) => a.id === '5005').label, '大号阿岚')

  const cur = PR.activeAccountId()
  const refuse = await call(routes, '/profiles', postReq({ action: 'retireAccount', id: cur }))
  assert.equal(refuse.code, 400, '当前号不许移除')

  const other = PR.accounts().find((a) => a.id !== cur).id
  const gone = await call(routes, '/profiles', postReq({ action: 'retireAccount', id: other }))
  assert.equal(gone.code, 200)
  assert.equal(PR.accounts().some((a) => a.id === other), false)
  assert.ok(fs.existsSync(path.join(home, '.hykb-ai', 'accounts', '.trash')), '移除是可逆的：进回收目录')
})

test('不受信任来源的 POST 被 403 挡住；GET 只读', async () => {
  const { ctx, routes } = makeCtx({ connection: { isTrusted: () => false, requestRejection: () => 403 } })
  plugin.apply(ctx)
  const res = fakeRes()
  await find(routes, '/profiles').handler(postReq({ action: 'switchPersona', id: 'p1' }, { host: 'evil.example.com' }), res)
  assert.equal(res.out.code, 403)
})
