import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hykb-persona-'))
process.env.USERPROFILE = home
process.env.HOME = home
process.env.HYKB_SCROLL_CONFIG = path.join(home, '.dsh', 'hykb-scroll.config.json')

const L = (f) => import('../tools/lib/' + f)

test('人设补充按当前人设读；切人设后提示词跟着变', async () => {
  const P = await L('profiles.mjs')
  const K = await L('config.mjs')
  const AI = await L('ai.mjs')
  P.migrate()

  const a = P.addPersona('甲')
  const b = P.addPersona('乙')
  P.writePersonaNotes(a.id, '甲的口吻：对外冷淡')
  P.writePersonaNotes(b.id, '乙的口吻：爱用感叹号')

  P.setActivePersona(a.id)
  assert.equal(AI.personaNotes(K.config()), '甲的口吻：对外冷淡')
  assert.ok(AI.extraRules(K.config()).includes('甲的口吻'))
  assert.equal(K.config().persona.name, '甲')

  P.setActivePersona(b.id)
  assert.equal(AI.personaNotes(K.config()), '乙的口吻：爱用感叹号')
  assert.ok(AI.extraRules(K.config()).includes('乙的口吻'))
  assert.equal(K.config().__activePersona.id, b.id)
})

test('末尾一句全人设共用：applySuffix 不受人设影响', async () => {
  const AI = await L('ai.mjs')
  assert.equal(AI.applySuffix('今天聊得不错'), '今天聊得不错 -内容由AI生成')
  assert.equal(AI.applySuffix('今天聊得不错', { suffix: '' }), '今天聊得不错 -内容由AI生成')
})

test('人设补充限长 20000', async () => {
  const P = await L('profiles.mjs')
  const p = P.personas()[0]
  P.writePersonaNotes(p.id, 'x'.repeat(25000))
  assert.equal(P.readPersonaNotes(p.id).length, 20000)
})
