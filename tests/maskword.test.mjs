/**
 * 快爆平台词表预检（maskword）的离线测试。
 *
 * 这一层的失误方式和本地词表不同：
 *   1. 签名/编码算错 → 每条都被 1004 拒，等于这道闸永远不生效（而日志里只是「接口不可用」）
 *   2. 返回体解析错 → 命中被当成通过，脏话照发
 *   3. 接口挂了 → 不能把整条回帖链路带下水（默认放行，本地闸还在）
 * 所以这里既不联网，也不依赖真实 appid：用注入的 fetch 把请求和响应都钉死。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hykb-maskword-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSH_HOME = path.join(home, '.dsh')
fs.mkdirSync(path.join(home, '.dsh'), { recursive: true })

const M = await import('../tools/lib/maskword.mjs')
const C = await import('../tools/lib/config.mjs')
// gate() 自己会去读密钥文件，所以先往临时 HOME 里放一把
C.saveMaskwordKey('test-key')

const cfgOn = (extra = {}) => ({
  safety: { enabled: true, blockOutbound: true, maskword: { enabled: true, appid: 'kbtest', url: 'https://example.test/matchService.do', level: 1, byPinyin: false, simpleMatch: true, timeoutMs: 1000, blockOnError: false, ...extra } },
})

/** 记下请求、回一个固定响应 */
function stubFetch(body = '{}', { status = 200, throwError = null } = {}) {
  const calls = []
  const fn = async (url, init) => {
    calls.push({ url, init })
    if (throwError) throw throwError
    return { ok: status >= 200 && status < 300, status, text: async () => body }
  }
  return { fn, calls }
}

test('phpUrlencode 与 PHP 的 urlencode 对齐：空格变 +，!\'()*~ 要转义', () => {
  assert.equal(M.phpUrlencode('a b'), 'a+b')
  assert.equal(M.phpUrlencode("a!b'c(d)e*f~g"), 'a%21b%27c%28d%29e%2Af%7Eg')
  assert.equal(M.phpUrlencode('中文'), '%E4%B8%AD%E6%96%87')
})

test('签名 = md5("appid=…&ts=…" + "&" + key)，32 位小写', () => {
  const want = createHash('md5').update('appid=kbtest&ts=1585811094&sekret', 'utf8').digest('hex')
  assert.equal(M.sign({ appid: 'kbtest', ts: 1585811094, key: 'sekret' }), want)
  assert.match(M.sign({ appid: 'kbtest', ts: 1, key: 'k' }), /^[0-9a-f]{32}$/)
  // 换个 key / 换个 ts 都必须变：签名要是恒定的，这道闸就成了摆设
  assert.notEqual(M.sign({ appid: 'kbtest', ts: 1, key: 'k' }), M.sign({ appid: 'kbtest', ts: 1, key: 'k2' }))
  assert.notEqual(M.sign({ appid: 'kbtest', ts: 1, key: 'k' }), M.sign({ appid: 'kbtest', ts: 2, key: 'k' }))
})

test('buildUrl：appid、ts、sign 顺序固定，sign 在最后', () => {
  const url = M.buildUrl({ url: 'https://example.test/matchService.do', appid: 'kbtest', ts: 1585811094, key: 'k' })
  assert.ok(url.startsWith('https://example.test/matchService.do?appid=kbtest&ts=1585811094&sign='), url)
})

test('解析正常返回：命中的字、位置、级别都要在', () => {
  const doc = '{"13:15":{"app":"","level":1,"startPos":13,"endPos":15,"maskWord":"共产"},"11:12":{"app":"","level":1,"startPos":11,"endPos":12,"maskWord":"中国"}}'
  const r = M.parse(doc)
  assert.equal(r.ok, false)
  assert.equal(r.hits.length, 2)
  assert.deepEqual(r.hits.map((h) => h.word).sort(), ['中国', '共产'])
  assert.equal(r.hits[0].start, 13)
  assert.equal(r.hits[0].end, 15)
  assert.equal(r.hits[0].level, 1)
})

test('解析通过：空对象 / 空数组 / 空响应都算放行', () => {
  for (const body of ['{}', '[]', '   ']) {
    const r = M.parse(body)
    assert.equal(r.ok, true, 'body=' + JSON.stringify(body))
    assert.equal(r.hits.length, 0)
  }
})

test('解析接口错误：1001–1004 各自有中文说明，且不带命中词', () => {
  for (const code of [1001, 1002, 1003, 1004]) {
    const r = M.parse(code + ':链接过期(1794634866-1585811094)')
    assert.equal(r.ok, false)
    assert.equal(r.code, code)
    assert.equal(r.hits.length, 0)
    assert.ok(M.ERRORS[code], code + ' 缺说明')
    assert.ok(r.error.includes(M.ERRORS[code]))
  }
})

test('解析垃圾返回：不当成通过，也不炸', () => {
  const r = M.parse('<html>502</html>')
  assert.equal(r.ok, false)
  assert.ok(r.error)
})

test('没启用 / 没配 appid 或密钥 → 跳过，不请求', async () => {
  const { fn, calls } = stubFetch('{}')
  const off = await M.checkText('hi', { cfg: { safety: { maskword: { enabled: false } } }, fetchImpl: fn })
  assert.equal(off.skipped, 'off')
  assert.equal(calls.length, 0)

  const noApp = await M.checkText('hi', { cfg: cfgOn({ appid: '' }), fetchImpl: fn, key: 'k' })
  assert.equal(noApp.skipped, 'no-credential')
  assert.equal(calls.length, 0)
})

test('启用后请求形状对：POST + 表单体 + toCheck/level/byPinyin/simpleMatch', async () => {
  const { fn, calls } = stubFetch('{}')
  await M.checkText('测试一句话', { cfg: cfgOn(), fetchImpl: fn, key: 'k', now: 1585811094000 })
  assert.equal(calls.length, 1)
  const { url, init } = calls[0]
  assert.equal(init.method, 'POST')
  assert.equal(init.headers['content-type'], 'application/x-www-form-urlencoded')
  assert.match(url, /appid=kbtest/)
  assert.match(url, /ts=1585811094/)
  const body = new URLSearchParams(init.body)
  assert.equal(body.get('toCheck'), '测试一句话')
  assert.equal(body.get('level'), '1')
  assert.equal(body.get('byPinyin'), 'false')
  assert.equal(body.get('simpleMatch'), 'true')
})

test('命中返回 → ok=false 且带条数；接口 500 / 超时 → 带 error', async () => {
  const hit = stubFetch('{"1:3":{"level":1,"startPos":1,"endPos":3,"maskWord":"违禁词"}}')
  const r = await M.checkText('x违禁词y', { cfg: cfgOn(), fetchImpl: hit.fn, key: 'k' })
  assert.equal(r.ok, false)
  assert.equal(r.hits.length, 1)

  const boom = stubFetch('', { status: 500 })
  const e1 = await M.checkText('x', { cfg: cfgOn(), fetchImpl: boom.fn, key: 'k' })
  assert.equal(e1.ok, false)
  assert.match(e1.error, /HTTP 500/)

  const slow = { name: 'TimeoutError', message: 'timed out' }
  const e2 = await M.checkText('x', { cfg: cfgOn(), fetchImpl: stubFetch('{}', { throwError: slow }).fn, key: 'k' })
  assert.equal(e2.ok, false)
  assert.match(e2.error, /超时/)
})

test('闸门：总闸关 / 平台闸关 → 放行且不请求；命中 → 拦下且不回显命中词', async () => {
  const { fn, calls } = stubFetch('{"1:3":{"level":1,"startPos":1,"endPos":3,"maskWord":"违禁词"}}')

  const offAll = await M.gate('违禁词', { cfg: { safety: { enabled: false, maskword: { enabled: true, appid: 'a' } } }, fetchImpl: fn })
  assert.equal(offAll.allow, true)

  const offMw = await M.gate('违禁词', { cfg: cfgOn({ enabled: false }), fetchImpl: fn })
  assert.equal(offMw.allow, true)
  assert.equal(calls.length, 0)

  const logs = []
  const blocked = await M.gate('违禁词', { cfg: cfgOn(), fetchImpl: fn, log: (s) => logs.push(s) })
  assert.equal(blocked.allow, false)
  assert.equal(blocked.why, 'platform-word')
  assert.equal(blocked.count, 1)
  // 日志里不能出现命中的字本身（出现一次就是扩散一次）
  assert.ok(!logs.join('').includes('违禁词'), logs.join(''))
})

test('接口不可用：默认放行（本地闸还在）；blockOnError 打开才拦', async () => {
  const boom = stubFetch('', { status: 502 })
  const r1 = await M.gate('一句话', { cfg: cfgOn(), fetchImpl: boom.fn })
  assert.equal(r1.allow, true)
  assert.ok(r1.error)

  const r2 = await M.gate('一句话', { cfg: cfgOn({ blockOnError: true }), fetchImpl: boom.fn })
  assert.equal(r2.allow, false)
  assert.equal(r2.why, 'platform-error')
})
