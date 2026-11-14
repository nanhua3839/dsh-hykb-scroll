import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hykb-migrate-empty-'))
process.env.USERPROFILE = home
process.env.HOME = home
process.env.HYKB_SCROLL_CONFIG = path.join(home, '.dsh', 'hykb-scroll.config.json')

test('没有旧凭据时：只迁人设，不写账号指针，凭据路径回落到根目录', async () => {
  fs.mkdirSync(path.dirname(process.env.HYKB_SCROLL_CONFIG), { recursive: true })
  fs.writeFileSync(process.env.HYKB_SCROLL_CONFIG, JSON.stringify({ persona: { name: '小白' } }))
  const P = await import('../tools/lib/profiles.mjs')
  const paths = await import('../tools/lib/paths.mjs')

  const out = P.migrate()
  assert.equal(out.error, '')
  assert.equal(out.migrated, true)
  assert.equal(out.accountId, '')
  assert.equal(paths.currentAccountId(), '')
  assert.equal(paths.credentialsPath(), path.join(home, '.hykb-ai', 'credentials.json'))
  const raw = JSON.parse(fs.readFileSync(process.env.HYKB_SCROLL_CONFIG, 'utf8'))
  assert.equal((raw.profiles.accounts || []).length, 0)
  assert.equal(raw.profiles.personas[0].name, '小白')
})
