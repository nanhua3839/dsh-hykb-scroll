import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

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
