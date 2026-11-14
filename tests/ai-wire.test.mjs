// 出网文本必须是合法 UTF-16：论坛 emoji 被截半会产生孤立代理项，DeepSeek 的 JSON 解析器会直接 400。
// 回归用例来自一次真实事故：日报综述整份掉回骨架，报错 "unexpected end of hex escape"。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hykb-aiwire-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSH_HOME = path.join(home, '.dsh')
fs.mkdirSync(path.join(home, '.dsh'), { recursive: true })
fs.mkdirSync(path.join(home, '.hykb-ai'), { recursive: true })

const { tidy, wellFormed, chat } = await import('../tools/lib/ai.mjs')

/** 找出字符串里的孤立代理项（合法 UTF-16 里一个都不该有）。 */
function loneSurrogates(s) {
  const out = []
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = s.charCodeAt(i + 1)
      if (!(n >= 0xdc00 && n <= 0xdfff)) out.push(i)
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      const p = s.charCodeAt(i - 1)
      if (!(p >= 0xd800 && p <= 0xdbff)) out.push(i)
    }
  }
  return out
}

test('wellFormed 把孤立代理项换成 U+FFFD，成对的不动', () => {
  const broken = 'a\ud83cb'
  assert.equal(loneSurrogates(broken).length, 1)
  assert.equal(loneSurrogates(wellFormed(broken)).length, 0)
  const good = '玉米🌽种玉米'
  assert.equal(wellFormed(good), good)
  assert.equal(loneSurrogates(wellFormed(good)).length, 0)
})

test('tidy 按 max 截断时不会把 emoji 切成半个', () => {
  // 第 4 个码元正好是 emoji 的高位代理项，截到 4 就会切半
  const s = '玉米🌽种玉米'
  for (const max of [1, 2, 3, 4, 5, 6]) {
    const t = tidy(s, max)
    assert.equal(loneSurrogates(t).length, 0, 'max=' + max + ' 截出了孤立代理项：' + JSON.stringify(t))
  }
})

test('chat 出网前把 messages 修成合法 UTF-16（请求体必须能被 JSON.parse）', async () => {
  const realFetch = globalThis.fetch
  let sent = ''
  globalThis.fetch = async (url, init) => {
    sent = String(init?.body || '')
    return new Response(JSON.stringify({ choices: [{ message: { content: '好的' } }] }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  try {
    const cfg = {
      ai: { baseUrl: 'https://ai.example/v1', model: 'm', apiKey: 'k', relays: [], activeRelay: 'direct', fallback: false, temperature: 0.3, maxTokens: 100 },
      prompt: { suffix: '' },
    }
    const text = await chat([
      { role: 'system', content: '系统提示' },
      { role: 'user', content: '楼层：玉米🌽种玉米'.slice(0, 0) + '楼层：玉米🌽'.slice(0, 4) },
    ], { cfg })
    assert.equal(text, '好的')
    assert.ok(sent.length > 0, '应当真的发出了请求')
    const body = JSON.parse(sent) // 只要是合法 JSON 就不会抛
    for (const m of body.messages) assert.equal(loneSurrogates(m.content).length, 0, '请求体里还有孤立代理项')
  } finally { globalThis.fetch = realFetch }
})

test.after(() => { fs.rmSync(home, { recursive: true, force: true }) })
