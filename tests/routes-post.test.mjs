// 新增功能的路由：退出登录、板块对象落盘、提示词 / 发帖配置清洗、状态里的发帖记录。
// 全部在临时 HOME 里跑，不碰本机真实配置和凭据。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hykb-routes2-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSH_HOME = path.join(home, '.dsh')
process.env.HYKB_SCROLL_CONFIG = path.join(home, '.dsh', 'hykb-scroll.config.json')
fs.mkdirSync(path.join(home, '.dsh'), { recursive: true })
const { default: plugin } = await import('../lib/index.js')
// 多账号改造后，"本机凭据"跟着当前账号走：根目录那份是迁移留下的副本，
// 真正生效的是 accounts/<uid>/credentials.json，退出登录删的是它。
const { credentialsPath } = await import('../tools/lib/paths.mjs')

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
  return {
    out,
    setHeader() {}, writeHead(c) { out.code = c }, end(b) { out.body = String(b || '') },
    writableEnded: false,
  }
}
// readBody 要等 'end'，不喂 body 的请求会永远挂着 —— 所以这里必须真的把 data/end 发出去
function fakeReq(headers = LOOPBACK, body = '') {
  const handlers = {}
  const req = {
    method: 'GET', url: '/', headers, body,
    on(ev, fn) {
      handlers[ev] = fn
      // readBody 用 Buffer.concat 拼包，这里必须给 Buffer，给字符串会 TypeError
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

test('settings：板块存成 {id,title}，非法 ID 丢掉、去重', async () => {
  const routes = trusted()
  const r = await call(routes, '/settings', postReq({ config: { browse: { sections: [{ id: '23064', title: '综合' }, '134', { id: 'abc' }, { id: '134' }] } } }))
  assert.equal(r.code, 200, JSON.stringify(r.j))
  assert.deepEqual(r.j.config.browse.sections, [{ id: '23064', title: '综合' }, { id: '134', title: '' }])
})

test('settings：提示词后缀压成一行、限长；发帖板块 ID 只收数字', async () => {
  const routes = trusted()
  const r = await call(routes, '/settings', postReq({ config: {
    prompt: { rules: '不剧透', suffix: '内容由AI生成\n第二行' + 'x'.repeat(100) },
    post: { enabled: true, section: { id: '12a', title: 't' }, maxPerDay: 99 },
  } }))
  assert.equal(r.code, 200)
  assert.equal(r.j.config.prompt.rules, '不剧透')
  assert.ok(!/\n/.test(r.j.config.prompt.suffix))
  assert.ok(r.j.config.prompt.suffix.length <= 60)
  assert.equal(r.j.config.post.section.id, '')
  assert.ok(r.j.config.post.maxPerDay <= 5)
})

test('logout：删本机凭据，状态变成未登录；不受信任来源 403', async () => {
  const credDir = path.join(home, '.hykb-ai')
  fs.mkdirSync(credDir, { recursive: true })
  const cred = path.join(credDir, 'credentials.json')
  fs.writeFileSync(cred, JSON.stringify({ uid: '42', Pauth: 'p', Uauth: 'u', nickname: '小号' }))
  const { ctx, routes: bad } = makeCtx({ connection: { isTrusted: () => false, requestRejection: () => null } })
  plugin.apply(ctx)
  const denied = fakeRes()
  await find(bad, '/logout').handler(postReq({}, { host: 'evil.example.com' }), denied)
  assert.equal(denied.out.code, 403)
  assert.ok(fs.existsSync(credentialsPath()), '被拒的请求不该删凭据')

  const routes = trusted()
  const live = credentialsPath()
  assert.notEqual(path.resolve(live), path.resolve(cred), '迁移后凭据应落在 accounts/<uid>/ 下')
  const r = await call(routes, '/logout', postReq({}))
  assert.equal(r.code, 200, JSON.stringify(r.j))
  assert.ok(!fs.existsSync(live), '当前生效的凭据要被删掉')
  const s = await call(routes, '/status', fakeReq())
  assert.equal(s.j.credentials.present, false)
  assert.ok(s.j.post && typeof s.j.post.today === 'number', 'status 应带发帖记录')
})

test('logout 只收 POST', async () => {
  const r = await call(trusted(), '/logout', fakeReq())
  assert.ok(r.code === 405 || r.code === 400, '实际 ' + r.code)
})
