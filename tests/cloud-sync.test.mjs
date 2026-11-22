import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

// paths.mjs / config.mjs 在 import 时就把家目录算好，所以先指到临时目录再动态引入。
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hykb-cloud-'))
process.env.USERPROFILE = home
process.env.HOME = home
const CFG = path.join(home, '.dsh', 'hykb-scroll.config.json')
process.env.HYKB_SCROLL_CONFIG = CFG

const CRED = path.join(home, '.hykb-ai')
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'))

function seed() {
  fs.mkdirSync(path.dirname(CFG), { recursive: true })
  fs.mkdirSync(path.join(CRED, 'accounts', '1001'), { recursive: true })
  fs.mkdirSync(path.join(CRED, 'personas'), { recursive: true })
  fs.writeFileSync(CFG, JSON.stringify({
    listen: { enabled: true, intervalSec: 300 },
    ai: { baseUrl: 'https://relay.example.com', model: 'm1', apiKey: '' },
    profiles: {
      activePersona: 'p1',
      personas: [{ id: 'p1', label: '默认人设', name: '阿岚', ownerTitle: '姐姐', style: '短句' }],
      accounts: [{ id: '1001', label: '小号', lastPersona: 'p1' }],
    },
  }, null, 2))
  fs.writeFileSync(path.join(CRED, 'active-account'), '1001\n')
  fs.writeFileSync(path.join(CRED, 'ai-key'), 'SK-SECRET-AI\n')
  fs.writeFileSync(path.join(CRED, 'relay-keys.json'), JSON.stringify({ r1: 'SK-SECRET-RELAY' }))
  fs.writeFileSync(path.join(CRED, 'judge-key'), 'SK-SECRET-JUDGE\n')
  fs.writeFileSync(path.join(CRED, 'personas', 'p1.md'), '喜欢短句和克制的吐槽')
  fs.writeFileSync(path.join(CRED, 'accounts', '1001', 'credentials.json'), JSON.stringify({ uid: '1001', Pauth: 'p1|x', nickname: '小号' }))
  fs.writeFileSync(path.join(CRED, 'accounts', '1001', 'seen.json'), JSON.stringify({ replies: { t1: 1 } }))
  fs.writeFileSync(path.join(CRED, 'accounts', '1001', 'traffic-ledger.json'), JSON.stringify({ day: '2026-11-14', write: 2 }))
}

seed()
const CL = await import('../tools/lib/cloud.mjs')

test('载荷：设置/人设/凭据/已读/额度都在，密钥一个字都不在', () => {
  const snap = CL.snapshot()
  assert.equal(snap['cfg.listen.enabled'], true)
  assert.equal(snap['cfg.ai.model'], 'm1')
  assert.equal(snap['persona.p1.notes'], '喜欢短句和克制的吐槽')
  assert.equal(snap['acct.1001.cred'].Pauth, 'p1|x')
  assert.deepEqual(snap['seen.1001'], { replies: { t1: 1 } })
  assert.equal(snap['ledger.1001'].write, 2)
  assert.deepEqual(snap['meta.ptr'], { account: '1001', persona: 'p1' })

  const text = JSON.stringify(snap)
  for (const secret of ['SK-SECRET-AI', 'SK-SECRET-RELAY', 'SK-SECRET-JUDGE']) {
    assert.equal(text.includes(secret), false, '密钥不许进载荷：' + secret)
  }
  assert.equal(Object.keys(snap).some((k) => /said|browsed|fans|posts|audit|activity/.test(k)), false, '运行记录不该被带上去')
})

test('diffPaths：只报真正变了的路径', () => {
  const a = { 'cfg.a': 1, 'cfg.b': { x: 1 }, 'cfg.c': [1, 2] }
  const b = { 'cfg.a': 1, 'cfg.b': { x: 2 }, 'cfg.c': [1, 2], 'cfg.d': true }
  assert.deepEqual(CL.diffPaths(a, b).sort(), ['cfg.b', 'cfg.d'])
})

test('applyKV：写回远端值，本地密钥与没被点到的键原样保留', () => {
  CL.applyKV({
    'cfg.listen.enabled': { v: false },
    'persona.p1.notes': { v: '远端改过的人设' },
    'acct.1001.cred': { v: { uid: '1001', Pauth: 'p2|y', nickname: '小号新' } },
    'seen.1001': { v: { replies: { t1: 1, t2: 2 } } },
  })
  const cfg = readJson(CFG)
  assert.equal(cfg.listen.enabled, false)
  assert.equal(cfg.ai.model, 'm1', '没被点到的字段不许被动')
  assert.equal(fs.readFileSync(path.join(CRED, 'personas', 'p1.md'), 'utf8'), '远端改过的人设')
  assert.equal(readJson(path.join(CRED, 'accounts', '1001', 'credentials.json')).Pauth, 'p2|y')
  assert.deepEqual(readJson(path.join(CRED, 'accounts', '1001', 'seen.json')), { replies: { t1: 1, t2: 2 } })
  // 密钥文件不参与同步，必须还在
  assert.equal(fs.readFileSync(path.join(CRED, 'ai-key'), 'utf8').trim(), 'SK-SECRET-AI')
  assert.equal(readJson(path.join(CRED, 'relay-keys.json')).r1, 'SK-SECRET-RELAY')
  assert.equal(fs.readFileSync(path.join(CRED, 'judge-key'), 'utf8').trim(), 'SK-SECRET-JUDGE')
})

test('applyKV：ptr 指到不存在的账号时不动指针', () => {
  CL.applyKV({ 'meta.ptr': { v: { account: '9999', persona: 'p1' } } })
  assert.equal(fs.readFileSync(path.join(CRED, 'active-account'), 'utf8').trim(), '1001')
})

test('账号态：没登录就是没登录，密码太短不发网络请求', async () => {
  const s = CL.state()
  assert.deepEqual(s, { loggedIn: false, username: '', lastSyncAt: 0, lastSyncDir: '', cloudUpdatedAt: 0 })
  await assert.rejects(() => CL.auth({ action: 'login', username: 'abc', password: '1' }), /密码至少 6 位/)
  await assert.rejects(() => CL.auth({ action: 'login', username: 'ab', password: '123456' }), /3-20 个字符/)
})

test('版本不匹配的快照不许落地', async () => {
  await assert.rejects(() => CL.applyPayload({ schemaVersion: 1, kv: {} }), /版本不匹配/)
})

/* ── 云备份（方案）：收进本地缓存 / 应用 / 墓碑 ── */

const gz = (obj) => zlib.gzipSync(Buffer.from(JSON.stringify(obj), 'utf8')).toString('base64')

test('云备份：远端条目进本地缓存，墓碑删掉它', () => {
  const payload = { schemaVersion: 2, kv: { 'cfg.ai.model': { v: 'm-cloud', t: 1 } } }
  const entry = { n: '书房方案', a: 1000, dn: '书房台机', b: 999, z: gz(payload) }
  CL.ingestAux({ 'backup.b1': { v: entry, t: 1000 } })
  const list = CL.backupList()
  assert.equal(list.length, 1)
  assert.equal(list[0].name, '书房方案')
  assert.equal(list[0].byName, '书房台机')

  CL.ingestAux({ 'backup.b1': { v: { deleted: true, at: 2000 }, t: 2000 } })
  assert.deepEqual(CL.backupList(), [])
})

test('云备份：下载就是把方案里的值写回本地，密钥不动', () => {
  const payload = { schemaVersion: 2, kv: { 'cfg.ai.model': { v: 'm-restored', t: 1 } } }
  CL.ingestAux({ 'backup.b2': { v: { n: '要还原的方案', a: 3000, dn: '另一台', b: 1, z: gz(payload) }, t: 3000 } })
  const r = CL.backupApply('b2')
  assert.equal(r.name, '要还原的方案')
  assert.equal(readJson(CFG).ai.model, 'm-restored')
  assert.equal(fs.readFileSync(path.join(CRED, 'ai-key'), 'utf8').trim(), 'SK-SECRET-AI', '下载方案不该碰密钥文件')
  assert.throws(() => CL.backupApply('nope'), /本机没有这份方案/)
})

test('云备份：版本不对的方案拒绝应用', () => {
  const payload = { schemaVersion: 1, kv: { 'cfg.ai.model': { v: 'x', t: 1 } } }
  CL.ingestAux({ 'backup.b3': { v: { n: '旧版本', a: 4000, dn: '老机器', b: 1, z: gz(payload) }, t: 4000 } })
  assert.throws(() => CL.backupApply('b3'), /版本/)
})

test('下线标记：ack 之后同一个 at 不再生效，新标记仍然生效', () => {
  const dev0 = CL.readDevice()
  assert.equal(dev0.offAckAt, 0)
  CL.ackOffline(5000)
  assert.equal(CL.readDevice().offAckAt, 5000)
  CL.ackOffline(4000)                     // 旧的 at 不许把 ack 往回拨
  assert.equal(CL.readDevice().offAckAt, 5000)
  const mine = CL.readDevice()
  // 新装的机器（createdAt 比标记新）不该被历史标记影响：这里用 createdAt 本身做判据
  assert.ok(mine.createdAt > 0, '设备要记下出生时间，另一台才能判断标记是不是旧的')
})
