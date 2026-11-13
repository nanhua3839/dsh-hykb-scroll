/**
 * 复读查重的离线测试。
 *
 * 这条线的价值全在「窗口」和「阈值」两个参数上，所以两组都要有正反用例：
 * 窗口内命中、窗口外放行；阈值严了命中、阈值松了放行。
 * 台账落在临时家目录，跑完删掉，不碰真实 ~/.hykb-ai。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hykb-dedupe-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSH_HOME = path.join(home, '.dsh')
fs.mkdirSync(path.join(home, '.dsh'), { recursive: true })

const D = await import('../tools/lib/dedupe.mjs')

const DAY = 86400000
const cfgWith = (risk) => ({ risk: { dedupeDays: 14, dedupeSimilar: 0.86, ...risk } })

test('similarity：一模一样是 1，毫不相干接近 0，近似落在中间', () => {
  assert.equal(D.similarity('这个BOSS好难打啊', '这个BOSS好难打啊'), 1)
  const far = D.similarity('这个BOSS好难打啊', '今天天气不错适合出门')
  assert.ok(far < 0.2, '不相干的两句相似度太高：' + far)
  const near = D.similarity('这个BOSS好难打啊我在第3关死了十次', '这个BOSS太难打了我第3关卡了十次')
  assert.ok(near > 0.3 && near < 0.95, '近似句的相似度不在合理区间：' + near)
  assert.equal(D.similarity('', 'abc'), 0)
  assert.equal(D.similarity('abc', ''), 0)
})

test('说过一次的，第二次命中，返回值带 at 与正文', () => {
  D.clearSaid()
  const text = '这句是第一次出现的话'
  assert.equal(D.findRepeat({ text, cfg: cfgWith() }), null, '台账空的时候不该命中')
  const entry = D.rememberSaid({ text })
  assert.ok(entry && entry.at, 'rememberSaid 应该返回带 at 的记录')
  const hit = D.findRepeat({ text, cfg: cfgWith() })
  assert.ok(hit, '刚记过的同一句应该命中')
  assert.equal(hit.text, text)
  assert.ok(hit.at, '命中的记录要带时间，日志里要报「几分钟前说过」')
})

test('窗口外的老记录不参与判重', () => {
  D.clearSaid()
  const text = '一句会被时间冲掉的话'
  const long = Date.now() - 20 * DAY
  D.rememberSaid({ text, at: long })
  // 判重窗口是「now - dedupeDays 天」，now 默认取当下：20 天前的记录在 14 天窗口外
  assert.equal(D.findRepeat({ text, cfg: cfgWith({ dedupeDays: 14 }) }), null, '14 天窗口外的老记录不该命中')
  assert.ok(D.findRepeat({ text, cfg: cfgWith({ dedupeDays: 30 }) }), '30 天窗口内本该命中')
})

test('dedupeDays:0 等于关掉查重', () => {
  D.clearSaid()
  const text = '关掉查重之后这句可以重复发'
  D.rememberSaid({ text })
  assert.equal(D.findRepeat({ text, cfg: cfgWith({ dedupeDays: 0 }) }), null)
})

test('阈值决定近似句算不算复读（用同一对句子正反各验一次）', () => {
  D.clearSaid()
  // 挑一对相似度明确落在 (0.5, 1) 之间的句子，才能用合法阈值区分开
  const a = '这个BOSS真的好难打啊我在第3关死了十次求个打法'
  const b = '这个BOSS真的好难打啊我在第3关死了十次求个攻略'
  const sim = D.similarity(a, b)
  assert.ok(sim > 0.5 && sim < 1, '这对句子的相似度不适用：' + sim)
  D.rememberSaid({ text: a })
  const strictCfg = cfgWith({ dedupeSimilar: 0.99 })
  const looseCfg = cfgWith({ dedupeSimilar: 0.5 })
  assert.equal(D.findRepeat({ text: b, cfg: strictCfg }), null, '阈值 0.99 时该放过（sim=' + sim.toFixed(3) + '）')
  assert.ok(D.findRepeat({ text: b, cfg: looseCfg }), '阈值 0.5 时该命中（sim=' + sim.toFixed(3) + '）')
  // 长度差一倍的句子连比都不比 —— 性能预筛，不是误判（长度差过大不可能到 0.86）
  assert.equal(D.findRepeat({ text: '短句', cfg: looseCfg }), null, '长度差一倍的句子不该命中')
})

test('saidStats 的数字自洽，clearSaid 之后彻底清空', () => {
  D.clearSaid()
  const now = Date.now()
  D.rememberSaid({ text: '第一条', at: now })
  D.rememberSaid({ text: '第二条', at: now })
  D.rememberSaid({ text: '很老的一条', at: now - 30 * DAY })
  const s = D.saidStats({ cfg: cfgWith({ dedupeDays: 14 }) })
  assert.equal(s.total, 3)
  assert.equal(s.inWindow, 2)
  assert.equal(s.days, 14)
  D.clearSaid()
  const empty = D.saidStats({ cfg: cfgWith() })
  assert.equal(empty.total, 0)
  assert.equal(D.findRepeat({ text: '第一条', cfg: cfgWith() }), null, '清空后还能命中')
})

test('台账有上限：写在多也不会无限增长', () => {
  D.clearSaid()
  // 上限 2000，压缩留 20% 余量（避免每条都全量重写），所以峰值允许到 2400；
  // 写满 2600 必定已经压过至少一次，压完回落到 2000。
  for (let i = 0; i < 2600; i += 1) D.rememberSaid({ text: '这是第 ' + i + ' 条不一样的话，用来把台账撑满' })
  const s = D.saidStats({ cfg: cfgWith() })
  assert.ok(s.total <= 2400, '台账没截断，现在 ' + s.total + ' 条（上限 2000 + 20% 余量）')
  assert.ok(s.total > 1000, '台账被截得太狠了：' + s.total)
  // 压过之后最新的那条必须还在（不能把刚说的丢掉）
  assert.ok(D.findRepeat({ text: '这是第 2599 条不一样的话，用来把台账撑满', cfg: cfgWith({ dedupeDays: 14 }) }), '压缩把最新的记录丢了')
})

test('空文本不记，也不命中', () => {
  D.clearSaid()
  assert.equal(D.rememberSaid({ text: '   ' }), null)
  assert.equal(D.findRepeat({ text: '   ', cfg: cfgWith() }), null)
})

test.after(() => fs.rmSync(home, { recursive: true, force: true }))
