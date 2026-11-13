/**
 * 中转站（多线路）的离线测试。
 *
 * 这条线最容易出的错是「静默降级」：用户以为在走中转站，其实一直走直连；
 * 或者密钥没写进去，线路被悄悄丢掉却不报错。所以每一组都要断言「少一项就不进 lines()」。
 *
 * 全程离线：fetch 一律打桩，home 指到临时目录。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hykb-relay-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSH_HOME = path.join(home, '.dsh')
fs.mkdirSync(path.join(home, '.dsh'), { recursive: true })

const A = await import('../tools/lib/ai.mjs')
const C = await import('../tools/lib/config.mjs')

const relay = (id, over = {}) => ({ id, name: id, baseUrl: 'https://relay.example/v1', model: 'gpt-4o-mini', enabled: true, ...over })
const cfgWith = (ai) => ({ ai: { temperature: 0.7, maxTokens: 100, activeRelay: 'direct', fallback: true, relays: [], ...ai } })

/** 打桩 fetch：按顺序返回预设响应，并记下每次请求的 URL。 */
function stubFetch(responses) {
  const calls = []
  const real = globalThis.fetch
  let i = 0
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init && init.body })
    const r = responses[Math.min(i, responses.length - 1)]
    i += 1
    if (r instanceof Error) throw r
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      text: async () => JSON.stringify(r.body),
    }
  }
  return { calls, restore: () => { globalThis.fetch = real } }
}
const okBody = (text) => ({ status: 200, body: { choices: [{ message: { content: text } }] } })

test.afterEach(() => { try { fs.rmSync(path.join(home, '.hykb-ai'), { recursive: true, force: true }) } catch {} })
test.after(() => fs.rmSync(home, { recursive: true, force: true }))

test('直连三项齐全时 lines() 就返回它，且排在第一个', () => {
  const L = A.lines(cfgWith({ baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: 'sk-x' }))
  assert.equal(L.length, 1)
  assert.equal(L[0].id, 'direct')
  assert.equal(L[0].model, 'deepseek-chat')
})

test('破甲模型被剔除：直连和中转站都不许', () => {
  assert.equal(A.lines(cfgWith({ baseUrl: 'https://x.example/v1', model: 'dolphin-uncensored', apiKey: 'k' })).length, 0)
  C.saveRelayKeys({ r1: 'k1' })
  const L = A.lines(cfgWith({
    baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: 'sk-x',
    relays: [relay('r1', { model: 'llama3-abliterated' })],
  }))
  assert.deepEqual(L.map((x) => x.id), ['direct'], '破甲的 relay 不该出现在候选里')
})

test('中转站少一项（密钥 / 地址 / 模型）就不进 lines()', () => {
  const base = { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: 'sk-x' }
  // 没密钥
  assert.deepEqual(A.lines(cfgWith({ ...base, relays: [relay('r1')] })).map((x) => x.id), ['direct'])
  // 有密钥但没地址
  C.saveRelayKeys({ r1: 'k1' })
  assert.deepEqual(A.lines(cfgWith({ ...base, relays: [relay('r1', { baseUrl: '' })] })).map((x) => x.id), ['direct'])
  // 有密钥但没模型
  assert.deepEqual(A.lines(cfgWith({ ...base, relays: [relay('r1', { model: '' })] })).map((x) => x.id), ['direct'])
  // 三项齐全 → 出现
  assert.deepEqual(A.lines(cfgWith({ ...base, relays: [relay('r1')] })).map((x) => x.id), ['direct', 'r1'])
})

test('address 协议不合法的一律剔除（密钥会跟着请求跑出去）', () => {
  C.saveRelayKeys({ r1: 'k1' })
  for (const bad of ['ftp://x.example/v1', 'file:///c:/x', 'not-a-url']) {
    const L = A.lines(cfgWith({ relays: [relay('r1', { baseUrl: bad })] }))
    assert.equal(L.length, 0, bad + ' 竟然通过了：' + JSON.stringify(L))
  }
})

test('enabled:false 的线路不参与，即使三项齐全', () => {
  C.saveRelayKeys({ r1: 'k1' })
  const L = A.lines(cfgWith({ relays: [relay('r1', { enabled: false })] }))
  assert.equal(L.length, 0)
})

test('activeRelay 指定的线路排最前', () => {
  C.saveRelayKeys({ r1: 'k1' })
  const base = { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: 'sk-x' }
  const L = A.lines(cfgWith({ ...base, relays: [relay('r1')], activeRelay: 'r1' }))
  assert.deepEqual(L.map((x) => x.id), ['r1', 'direct'], '指定了主线却没排第一')
  // activeRelay 指向不存在的线路 → 保持原序，不报错、也不清空
  const L2 = A.lines(cfgWith({ ...base, relays: [relay('r1')], activeRelay: 'nope' }))
  assert.equal(L2.length, 2)
})

test('fallback:false 时只留第一条', () => {
  C.saveRelayKeys({ r1: 'k1' })
  const base = { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: 'sk-x' }
  const L = A.lines(cfgWith({ ...base, relays: [relay('r1')], fallback: false }))
  assert.equal(L.length, 1)
  assert.equal(L[0].id, 'direct', '不该跳到第二条')
})

test('chat() 主线路失败会自动换下一条，并真的用了第二条的模型', async () => {
  C.saveRelayKeys({ r1: 'k1' })
  const base = { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: 'sk-x' }
  const cfg = cfgWith({ ...base, relays: [relay('r1', { model: 'backup-model' })], activeRelay: 'direct' })
  const stub = stubFetch([{ status: 500, body: { error: { message: 'boom' } } }, okBody('第二条线路的回答')])
  try {
    const text = await A.chat([{ role: 'user', content: 'hi' }], { cfg })
    assert.equal(text, '第二条线路的回答')
    assert.equal(stub.calls.length, 2, '应该试了两条')
    assert.match(stub.calls[0].url, /api\.deepseek\.com/)
    assert.match(stub.calls[1].url, /relay\.example/)
    assert.match(String(stub.calls[1].body), /backup-model/, '第二条用的模型不对：' + stub.calls[1].body)
  } finally { stub.restore() }
})

test('chat() 全失败时把每条线路的名字都报出来', async () => {
  C.saveRelayKeys({ r1: 'k1' })
  const base = { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: 'sk-x' }
  const cfg = cfgWith({ ...base, relays: [relay('r1')] })
  const stub = stubFetch([{ status: 500, body: { error: { message: 'boom' } } }])
  try {
    await assert.rejects(() => A.chat([{ role: 'user', content: 'hi' }], { cfg }), (e) => {
      assert.match(e.message, /所有线路都失败/, '错误没说明是全失败：' + e.message)
      assert.match(e.message, /直连/, '错误里缺线路名：' + e.message)
      assert.match(e.message, /r1/, '错误里缺中转站名：' + e.message)
      return true
    })
  } finally { stub.restore() }
})

test('一条线路都没有时，错误说清是没配还是被破甲拦下', async () => {
  await assert.rejects(() => A.chat([{ role: 'user', content: 'hi' }], { cfg: cfgWith({}) }), /AI 未配置/)
  // 配了但模型是破甲的 → 提示被拦，而不是"未配置"
  const cfg = cfgWith({ baseUrl: 'https://x.example/v1', model: 'dolphin-uncensored', apiKey: 'k' })
  await assert.rejects(() => A.chat([{ role: 'user', content: 'hi' }], { cfg }), /破甲|没有可用线路/)
})

test('aiEndpoint 只认 http/https，并去掉尾斜杠', () => {
  assert.equal(A.aiEndpoint('https://a.example/v1/'), 'https://a.example/v1')
  assert.equal(A.aiEndpoint('http://127.0.0.1:8080/v1'), 'http://127.0.0.1:8080/v1')
  assert.throws(() => A.aiEndpoint('ftp://x'), /http\/https/)
  assert.throws(() => A.aiEndpoint(''), /未配置/)
})

test('中转站密钥读写往返，清空后线路就不见了', () => {
  assert.deepEqual(C.saveRelayKeys({ r1: 'k1', r2: 'k2' }), { r1: 'k1', r2: 'k2' })
  assert.deepEqual(C.loadRelayKeys(), { r1: 'k1', r2: 'k2' })
  assert.equal(C.relayKey('r1'), 'k1')
  // 空表把文件删掉，不留空对象
  assert.deepEqual(C.saveRelayKeys({}), {})
  assert.deepEqual(C.loadRelayKeys(), {})
  const base = { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: 'sk-x' }
  assert.deepEqual(A.lines(cfgWith({ ...base, relays: [relay('r1')] })).map((x) => x.id), ['direct'])
})

test('直连密钥仍走 ai-key 文件，不进 relay-keys 表', () => {
  C.saveAiKey('sk-direct')
  assert.equal(C.loadAiKey(), 'sk-direct')
  assert.equal(C.relayKey('direct'), 'sk-direct', 'direct 应该回落到 ai-key')
  assert.equal(Object.prototype.hasOwnProperty.call(C.loadRelayKeys(), 'direct'), false, 'direct 不该进中转站密钥表')
})
