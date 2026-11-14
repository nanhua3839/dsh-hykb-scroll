import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// paths.mjs 在 import 时就读 USERPROFILE / HOME，所以先把家目录指到临时目录再动态引入。
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hykb-migrate-'))
process.env.USERPROFILE = home
process.env.HOME = home
process.env.HYKB_SCROLL_CONFIG = path.join(home, '.dsh', 'hykb-scroll.config.json')

const L = (f) => import('../tools/lib/' + f)
const cfgFile = () => process.env.HYKB_SCROLL_CONFIG
const credRoot = () => path.join(home, '.hykb-ai')
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''))

function seedLegacy() {
  fs.mkdirSync(path.dirname(cfgFile()), { recursive: true })
  fs.writeFileSync(cfgFile(), JSON.stringify({
    self: { uid: '', name: '' },
    persona: { name: '阿岚', ownerTitle: '姐姐', style: '短句，克制' },
    prompt: { rules: '别客套', suffix: '-内容由AI生成' },
  }, null, 2))
  fs.mkdirSync(credRoot(), { recursive: true })
  fs.writeFileSync(path.join(credRoot(), 'credentials.json'), JSON.stringify({ uid: '1001', Pauth: 'p1|x', Uauth: 'u1', nickname: '阿岚' }))
  fs.writeFileSync(path.join(credRoot(), 'seen.json'), '{"replies":{}}')
  fs.writeFileSync(path.join(credRoot(), 'said.jsonl'), '{"k":"旧话"}\n')
  fs.writeFileSync(path.join(credRoot(), 'traffic-ledger.json'), '{"read":3}')
  fs.writeFileSync(path.join(credRoot(), 'persona.md'), '喜欢用短句和克制的吐槽')
}

test('迁移：旧的单号布局搬成 accounts/<uid> + personas/p1.md，且只复制不删除', async () => {
  seedLegacy()
  const P = await L('profiles.mjs')
  const paths = await L('paths.mjs')
  const out = P.migrate()
  assert.equal(out.error, '')
  assert.equal(out.migrated, true)
  assert.equal(out.accountId, '1001')
  assert.ok(out.backup && fs.existsSync(out.backup), '配置要有备份')
  assert.equal(paths.currentAccountId(), '1001')

  const dir = path.join(credRoot(), 'accounts', '1001')
  assert.equal(readJson(path.join(dir, 'credentials.json')).Pauth, 'p1|x')
  assert.equal(fs.readFileSync(path.join(dir, 'said.jsonl'), 'utf8').includes('旧话'), true)
  assert.equal(readJson(path.join(dir, 'traffic-ledger.json')).read, 3)

  const raw = readJson(cfgFile())
  assert.equal(raw.profiles.accounts[0].id, '1001')
  assert.equal(raw.profiles.accounts[0].label, '阿岚')
  assert.equal(raw.profiles.personas[0].name, '阿岚')
  assert.equal(raw.profiles.personas[0].ownerTitle, '姐姐')
  assert.equal(raw.profiles.activePersona, 'p1')
  assert.equal('persona' in raw, false, '顶层 persona 迁移后要删掉，只留清单一份真相')
  assert.equal(raw.self.uid, '1001')
  assert.equal(fs.readFileSync(path.join(credRoot(), 'personas', 'p1.md'), 'utf8'), '喜欢用短句和克制的吐槽')

  // 原件还在（只复制不删除）
  assert.ok(fs.existsSync(path.join(credRoot(), 'credentials.json')))
  assert.ok(fs.existsSync(path.join(credRoot(), 'persona.md')))
})

test('迁移幂等：第二次调用什么都不动', async () => {
  const P = await L('profiles.mjs')
  const rawBefore = fs.readFileSync(cfgFile(), 'utf8')
  const out = P.migrate()
  assert.equal(out.migrated, false)
  assert.equal(out.error, '')
  assert.equal(fs.readFileSync(cfgFile(), 'utf8'), rawBefore)
  assert.equal(fs.readdirSync(path.join(credRoot(), 'accounts')).filter((d) => /^\d+$/.test(d)).length, 1)
})
