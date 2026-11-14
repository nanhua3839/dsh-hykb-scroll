import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// paths.mjs 在 import 时就读 USERPROFILE，所以先把 HOME 指到临时目录再动态引入
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hykb-history-'))
process.env.USERPROFILE = tmp
process.env.DSH_HOME = path.join(tmp, '.dsh')

const lib = (n) => pathToFileURL(path.resolve('tools/lib', n)).href
const H = await import(lib('history.mjs'))
const P = await import(lib('paths.mjs'))

test.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {} })

test('record 写进 JSONL，三个时间从字符串转成毫秒', () => {
  H._reset()
  const e = H.record({ topicId: '1', title: 't', published: '2026-11-13 19:44:04', edited: '0000-00-00 00:00:00', replied: '2026-11-13 20:00:00', action: 'digest', why: 'score-21' })
  assert.ok(e)
  assert.equal(e.published > 0, true)
  assert.equal(e.edited, 0)
  assert.equal(e.replied > 0, true)
  const raw = fs.readFileSync(P.historyPath(), 'utf8').trim().split('\n')
  assert.equal(raw.length, 1)
  assert.equal(JSON.parse(raw[0]).topicId, '1')
})

test('同一天同一帖同一动作只记一次，换动作照记', () => {
  H._reset(); H.clear()
  assert.ok(H.record({ topicId: '2', action: 'skip', why: 'essence' }))
  assert.equal(H.record({ topicId: '2', action: 'skip', why: 'essence' }), null)
  assert.ok(H.record({ topicId: '2', action: 'reply' }))
  assert.equal(H.list({}).length, 2)
})

test('list 新的在前，counts 只数今天', () => {
  H._reset(); H.clear()
  H.record({ topicId: 'a', action: 'reply' })
  H.record({ topicId: 'b', action: 'digest' })
  const items = H.list({ limit: 10 })
  assert.deepEqual(items.map((x) => x.topicId), ['b', 'a'])
  assert.ok(items[0].actionText)
  const c = H.counts()
  assert.equal(c.reply, 1)
  assert.equal(c.digest, 1)
  assert.equal(c.total, 2)
})

test('超过上限截掉最老的', () => {
  H._reset(); H.clear()
  for (let i = 0; i < H.MAX_KEEP + 20; i++) H.record({ topicId: 't' + i, action: 'read' })
  const lines = fs.readFileSync(P.historyPath(), 'utf8').split('\n').filter(Boolean)
  assert.ok(lines.length <= H.MAX_KEEP, '文件没截断：' + lines.length)
  // 最新的那条一定还在
  assert.equal(JSON.parse(lines[lines.length - 1]).topicId, 't' + (H.MAX_KEEP + 19))
})

test('没有 topicId 的记录直接丢掉（不写半条）', () => {
  H._reset(); H.clear()
  assert.equal(H.record({ title: '没有 id' }), null)
  assert.equal(H.list({}).length, 0)
})
