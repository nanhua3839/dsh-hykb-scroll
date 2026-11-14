import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hykb-switch-'))
process.env.USERPROFILE = home
process.env.HOME = home
process.env.HYKB_SCROLL_CONFIG = path.join(home, '.dsh', 'hykb-scroll.config.json')

const L = (f) => import('../tools/lib/' + f)
const credRoot = () => path.join(home, '.hykb-ai')
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''))

async function seed() {
  const P = await L('profiles.mjs')
  const C = await L('cred.mjs')
  const K = await L('config.mjs')
  P.migrate()
  C.saveCredFor('2002', { uid: '2002', Pauth: 'p2|y', nickname: '小海' })
  C.saveCredFor('3003', { uid: '3003', Pauth: 'p3|z', nickname: '小满' })
  P.registerAccount({ uid: '2002', nickname: '小海' })
  P.registerAccount({ uid: '3003', nickname: '小满' })
  return { P, C, K }
}

test('切号：凭据路径 / 当前账号 / self 三处一起变，旧号记住人设', async () => {
  const { P, C, K } = await seed()
  const paths = await L('paths.mjs')

  const second = P.addPersona('毒舌')
  P.setActivePersona(second.id)
  const r = P.switchAccount('2002', { personaId: second.id })

  assert.equal(paths.currentAccountId(), '2002')
  assert.equal(paths.credentialsPath(), path.join(credRoot(), 'accounts', '2002', 'credentials.json'))
  assert.equal(C.loadCred().uid, '2002')
  assert.equal(C.loadCred().nickname, '小海')
  assert.equal(K.config().self.uid, '2002')
  assert.equal(K.config().self.name, '小海')
  assert.equal(r.persona, second.id, '新号没记过人设时保持现状')

  // 切到 3003 之前，2002 用的就是 second
  const third = P.switchAccount('3003', { personaId: second.id })
  assert.equal(third.account, '3003')
  const two = P.accounts().find((a) => a.id === '2002')
  assert.equal(two.lastPersona, second.id, '旧号要记住刚才用的人设')
  const three = P.accounts().find((a) => a.id === '3003')
  assert.equal(three.active, true)
  assert.equal(two.active, false)

  // 切回 2002：人设自动带回 second
  const back = P.switchAccount('2002', { personaId: P.activePersonaId() })
  assert.equal(back.persona, second.id)
  assert.equal(K.config().__activePersona.id, second.id)
  assert.equal(K.config().self.uid, '2002')
})

test('台账按账号隔离：seen / said 路径跟着当前账号走', async () => {
  const paths = await L('paths.mjs')
  const { P } = await seed()
  P.switchAccount('3003')
  assert.equal(paths.seenPath(), path.join(credRoot(), 'accounts', '3003', 'seen.json'))
  assert.equal(paths.saidPath(), path.join(credRoot(), 'accounts', '3003', 'said.jsonl'))
  assert.equal(paths.fansPath(), path.join(credRoot(), 'accounts', '3003', 'fans.json'))
  assert.equal(paths.ledgerPath(), path.join(credRoot(), 'accounts', '3003', 'traffic-ledger.json'))
  assert.equal(paths.auditPath(), path.join(credRoot(), 'audit.jsonl'), '审计日志保持全局')
})

test('人设：增删改、复制、删到最后一个被拒', async () => {
  const { P, K } = await seed()
  const before = K.personas().length
  const a = P.addPersona('温柔')
  assert.equal(P.personas().length, before + 1)
  P.updatePersona(a.id, { style: '更软一点' })
  assert.equal(P.personas().find((p) => p.id === a.id).style, '更软一点')
  const b = P.duplicatePersona(a.id)
  assert.ok(P.personas().some((p) => p.id === b.id))
  P.removePersona(b.id)
  assert.equal(P.personas().some((p) => p.id === b.id), false)
  for (const p of P.personas().slice(1)) P.removePersona(p.id)
  assert.throws(() => P.removePersona(P.personas()[0].id), /至少保留一个人设/)
})

test('非法 id 一律拒（账号必须纯数字 uid，人设必须 slug）', async () => {
  const { P } = await seed()
  assert.throws(() => P.setActiveAccount('../etc'), /不合法/)
  assert.throws(() => P.setActivePersona('Bad Id'), /不合法/)
  assert.throws(() => P.registerAccount({ uid: 'abc' }), /纯数字/)
  const cur = P.activeAccountId()
  assert.ok(/^\d+$/.test(cur), '应该有一个激活号')
  assert.throws(() => P.retireAccount(cur), /当前在用的号/, '当前号不许移除')
})
