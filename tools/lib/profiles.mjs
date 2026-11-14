// 身份层：账号清单 / 人设清单 / 激活指针 / 一次性迁移。
// 这里是「多账号 + 多人设」唯一的写入者；别的模块只读（paths.mjs 读指针、config.mjs 读清单）。
//
// 关键不变量：
//   · 当前账号只在 ~/.hykb-ai/active-account 里（一行 uid）。指针不存在 = 改造前的单号布局。
//   · 谁在回帖由指针决定；哪个人设在说话由 config.profiles.activePersona 决定。
//   · AI 线路不在这里，沿用 ai.relays + ai.activeRelay。
import fs from 'node:fs'
import path from 'node:path'
import {
  credDir, accountsRoot, trashDir, accountDir, credentialsPath, activeAccountFile,
  currentAccountId, personasDir, personaPath, ensureDir, harden, configPath,
} from './paths.mjs'
import { readRaw, writeConfig, DEFAULTS } from './config.mjs'
import { deriveCred, prettyNickname } from './cred.mjs'

const ACC_ID = /^\d+$/
const PERSONA_ID = /^[a-z][a-z0-9_-]{1,23}$/
/** 跟着账号走的台账：额度是平台按号算的，复读/去重/回关也是某个号自己的历史。 */
export const STATE_FILES = ['seen.json', 'said.jsonl', 'browsed.jsonl', 'fans.json', 'traffic-ledger.json', 'posts.json', 'app-token.json']

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v)
const cleanLabel = (v) => String(v ?? '').replace(/[\r\n\t\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40)
const readJson = (file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) } catch { return {} }
}

/* ───────────── 账号 ───────────── */

export const activeAccountId = () => currentAccountId()

function accountView(entry, active) {
  const id = String(entry.id)
  const file = credentialsPath(id)
  const c = readJson(file)
  const hasPauth = !!c.Pauth
  const nick = cleanLabel(prettyNickname(c.nickname))
  // 老登录把 URL 编码的昵称写进了标签：这种标签直接当没有，回落到昵称
  const stored = String(entry.label || '').includes('%') ? '' : cleanLabel(entry.label)
  return {
    id,
    label: stored || nick || id,
    uid: id,
    nickname: nick,
    present: !!(c.uid && hasPauth),
    hasPauth,
    active: id === active,
    missing: !fs.existsSync(accountDir(id)),
    lastPersona: String(entry.lastPersona || ''),
  }
}

/**
 * 账号视图：清单 ⋈ 磁盘。
 * 磁盘上有目录而清单里没有的号（手工拷进来 / 清单被改成空）也列出来，不让文件变成隐形垃圾。
 */
export function accounts(raw = readRaw()) {
  const active = currentAccountId()
  const list = Array.isArray(raw?.profiles?.accounts) ? raw.profiles.accounts : []
  const out = []
  const seen = new Set()
  for (const a of list) {
    const id = String(isObj(a) ? a.id : '').trim()
    if (!ACC_ID.test(id) || seen.has(id)) continue
    seen.add(id)
    out.push(accountView(a, active))
  }
  let dirs = []
  try {
    dirs = fs.readdirSync(accountsRoot(), { withFileTypes: true })
      .filter((d) => d.isDirectory() && ACC_ID.test(d.name))
      .map((d) => d.name)
  } catch {}
  for (const id of dirs) if (!seen.has(id)) out.push(accountView({ id }, active))
  return out
}

function catalogPatch(mutator) {
  const raw = readRaw()
  const list = Array.isArray(raw?.profiles?.accounts) ? raw.profiles.accounts.filter((a) => isObj(a) && ACC_ID.test(String(a.id ?? ''))) : []
  return { profiles: { accounts: mutator(list) } }
}

/** 记一个号（已有就只补昵称/标签，不动 lastPersona）。 */
export function registerAccount({ uid, nickname, label } = {}) {
  const id = String(uid || '').trim()
  if (!ACC_ID.test(id)) throw new Error('账号 id 必须是纯数字 uid：' + id)
  ensureDir(accountDir(id))
  const patch = catalogPatch((list) => {
    const i = list.findIndex((a) => String(a.id) === id)
    if (i >= 0) {
      const cur = list[i]
      list[i] = { ...cur, label: cleanLabel(label) || cleanLabel(cur.label) || cleanLabel(nickname) || id }
      return list
    }
    list.push({ id, label: cleanLabel(label) || cleanLabel(nickname) || id, addedAt: new Date().toISOString(), lastPersona: '' })
    return list
  })
  writeConfig(patch)
  return accounts().find((a) => a.id === id) || null
}

export function labelAccount(id, label) {
  const key = String(id || '').trim()
  if (!ACC_ID.test(key)) throw new Error('账号 id 不合法：' + key)
  writeConfig(catalogPatch((list) => list.map((a) => (String(a.id) === key ? { ...a, label: cleanLabel(label) || key } : a))))
  return accounts().find((a) => a.id === key) || null
}

/** 记住这个号上次用的人设（切号时自动带回来）。 */
export function rememberPersona(accountId, personaId) {
  const key = String(accountId || '').trim()
  const pid = String(personaId || '').trim()
  if (!ACC_ID.test(key) || !PERSONA_ID.test(pid)) return
  writeConfig(catalogPatch((list) => list.map((a) => (String(a.id) === key ? { ...a, lastPersona: pid } : a))))
}

/**
 * 移除一个号：目录移进 accounts/.trash（可逆），清单里删掉。
 * 拒绝移除当前激活账号 —— 先切到别的号再说，否则一移除就"没有号"了。
 */
export function retireAccount(id) {
  const key = String(id || '').trim()
  if (!ACC_ID.test(key)) throw new Error('账号 id 不合法：' + key)
  if (currentAccountId() === key) throw new Error('这是当前在用的号，先切到别的号再移除')
  const dir = accountDir(key)
  if (fs.existsSync(dir)) {
    ensureDir(trashDir())
    const dest = path.join(trashDir(), key + '-' + Date.now())
    fs.renameSync(dir, dest)
  }
  writeConfig(catalogPatch((list) => list.filter((a) => String(a.id) !== key)))
  return accounts()
}

/** 切号指针。写入是 tmp + rename，权限收紧；这是"谁能回帖"的唯一开关。 */
export function setActiveAccount(id) {
  const key = String(id || '').trim()
  if (!ACC_ID.test(key)) throw new Error('账号 id 不合法：' + key)
  if (!fs.existsSync(accountDir(key))) throw new Error('这个号没有凭据目录（先扫码登录）：' + key)
  ensureDir(credDir())
  const file = activeAccountFile()
  const tmp = file + '.' + process.pid + '.tmp'
  fs.writeFileSync(tmp, key + '\n', { mode: 0o600 })
  harden(tmp)
  fs.renameSync(tmp, file)
  harden(file)
  return key
}

/**
 * 切号（宿主与 CLI 共用这一个动作）：记住旧号当前人设 → 写指针 → 带回新号上次的人设 → 同步 self。
 * self 是「我是谁」的镜像，watch / digest 都读它，切号后必须跟着变。
 */
export function switchAccount(id, { personaId = '' } = {}) {
  const key = String(id || '').trim()
  if (!ACC_ID.test(key)) throw new Error('账号 id 不合法：' + key)
  const cur = currentAccountId()
  if (cur && cur !== key && PERSONA_ID.test(String(personaId || '').trim())) rememberPersona(cur, personaId)
  setActiveAccount(key)
  const view = accounts().find((a) => a.id === key) || null
  const wantPersona = String(view?.lastPersona || '').trim()
  if (wantPersona && personas().some((p) => p.id === wantPersona)) writeConfig({ profiles: { activePersona: wantPersona } })
  writeConfig({ self: { uid: key, name: view?.nickname || '' } })
  return { account: key, persona: activePersonaId() }
}

/* ───────────── 人设 ───────────── */

const personaList = (raw) => (Array.isArray(raw?.profiles?.personas) ? raw.profiles.personas : [])
const normPersona = (p, i) => {
  const id = String(isObj(p) ? p.id : '').trim().toLowerCase()
  return {
    id: PERSONA_ID.test(id) ? id : 'p' + (i + 1),
    label: cleanLabel(p?.label) || cleanLabel(p?.name) || '人设 ' + (i + 1),
    name: cleanLabel(p?.name) || DEFAULTS.persona.name,
    ownerTitle: cleanLabel(p?.ownerTitle) || DEFAULTS.persona.ownerTitle,
    style: String(p?.style ?? '').trim().slice(0, 200) || DEFAULTS.persona.style,
  }
}

/** 规范化后的人设清单；空 → 一条默认人设（保证永远有东西可用）。 */
export function personas(raw = readRaw()) {
  const list = personaList(raw).filter(isObj)
  const out = []
  const seen = new Set()
  for (let i = 0; i < list.length; i += 1) {
    const p = normPersona(list[i], i)
    if (seen.has(p.id)) continue
    seen.add(p.id)
    out.push(p)
  }
  if (out.length) return out
  return [{ id: 'p1', label: '默认人设', name: DEFAULTS.persona.name, ownerTitle: DEFAULTS.persona.ownerTitle, style: DEFAULTS.persona.style }]
}

export function activePersonaId(raw = readRaw()) {
  const list = personas(raw)
  const want = String(raw?.profiles?.activePersona ?? '').trim().toLowerCase()
  return list.find((p) => p.id === want)?.id || list[0].id
}

export function setActivePersona(id) {
  const key = String(id || '').trim().toLowerCase()
  if (!PERSONA_ID.test(key)) throw new Error('人设 id 不合法：' + key)
  if (!personas().some((p) => p.id === key)) throw new Error('没有这个人设：' + key)
  writeConfig({ profiles: { activePersona: key } })
  const acc = currentAccountId()
  if (acc) rememberPersona(acc, key)
  return key
}

export function addPersona(label) {
  const list = personaList(readRaw()).filter(isObj)
  let n = 1
  const used = new Set(personas().map((p) => p.id))
  while (used.has('p' + n)) n += 1
  const rec = {
    id: 'p' + n,
    label: cleanLabel(label) || '人设 ' + n,
    name: cleanLabel(label) || DEFAULTS.persona.name,
    ownerTitle: DEFAULTS.persona.ownerTitle,
    style: DEFAULTS.persona.style,
  }
  writeConfig({ profiles: { personas: [...list, rec] } })
  return rec
}

export function updatePersona(id, patch) {
  const key = String(id || '').trim().toLowerCase()
  if (!PERSONA_ID.test(key)) throw new Error('人设 id 不合法：' + key)
  const raw = readRaw()
  const list = personaList(raw).filter(isObj)
  const i = list.findIndex((p) => String(p.id ?? '').toLowerCase() === key)
  if (i < 0) throw new Error('没有这个人设：' + key)
  const next = { ...list[i] }
  if (patch && 'label' in patch) next.label = cleanLabel(patch.label) || next.label
  if (patch && 'name' in patch) next.name = cleanLabel(patch.name) || next.name
  if (patch && 'ownerTitle' in patch) next.ownerTitle = cleanLabel(patch.ownerTitle) || next.ownerTitle
  if (patch && 'style' in patch) next.style = String(patch.style ?? '').trim().slice(0, 200) || next.style
  list[i] = next
  writeConfig({ profiles: { personas: list } })
  return next
}

/** 复制一份人设（连同人设补充 md 一起），返回新记录。 */
export function duplicatePersona(id) {
  const src = personas().find((p) => p.id === String(id || '').trim().toLowerCase())
  if (!src) throw new Error('没有这个人设：' + id)
  const list = personaList(readRaw()).filter(isObj)
  let n = 1
  const used = new Set(personas().map((p) => p.id))
  while (used.has('p' + n)) n += 1
  const rec = { ...src, id: 'p' + n, label: (src.label + ' 副本').slice(0, 40) }
  writeConfig({ profiles: { personas: [...list, rec] } })
  try {
    const notes = readPersonaNotes(src.id)
    if (notes) writePersonaNotes(rec.id, notes)
  } catch {}
  return rec
}

/** 删一个人设：最后一个不许删；正在用的那个删了就切到剩下的第一个。 */
export function removePersona(id) {
  const key = String(id || '').trim().toLowerCase()
  const raw = readRaw()
  const list = personaList(raw).filter(isObj)
  const rest = list.filter((p) => String(p.id ?? '').toLowerCase() !== key)
  if (!rest.length) throw new Error('至少保留一个人设')
  const patch = { profiles: { personas: rest } }
  if (activePersonaId(raw) === key) patch.profiles.activePersona = personas({ profiles: { personas: rest } })[0].id
  writeConfig(patch)
  try { fs.rmSync(personaPath(key), { force: true }) } catch {}
  return personas()
}

export function readPersonaNotes(id) {
  try { return fs.readFileSync(personaPath(id || ''), 'utf8') } catch { return '' }
}

export function writePersonaNotes(id, text) {
  const file = personaPath(id || '')
  ensureDir(path.dirname(file))
  const tmp = file + '.' + process.pid + '.tmp'
  fs.writeFileSync(tmp, String(text ?? '').slice(0, 20000), { mode: 0o600 })
  harden(tmp)
  fs.renameSync(tmp, file)
  harden(file)
  return String(text ?? '').slice(0, 20000)
}

/* ───────────── 一次性迁移 ───────────── */

const copyOnly = (from, to) => {
  try {
    if (!fs.existsSync(from) || fs.existsSync(to)) return false
    ensureDir(path.dirname(to))
    fs.copyFileSync(from, to)
    harden(to)
    return true
  } catch { return false }
}

function backupConfig() {
  try {
    const dir = path.dirname(configPath())
    const has = fs.existsSync(dir) && fs.readdirSync(dir).some((f) => f.startsWith('hykb-scroll.config.json.bak-'))
    if (has) return ''
    const dest = configPath() + '.bak-' + Date.now()
    fs.copyFileSync(configPath(), dest)
    return dest
  } catch { return '' }
}

/**
 * 把改造前的单号布局搬成「多账号 + 多人设」。幂等，全程只复制不删除：
 *   · 已有清单/指针 → 只补缺目录，返回 migrated:false
 *   · 旧的 credentials.json + 7 份台账 → accounts/<uid>/，最后才写指针（指针没写成就等于没迁）
 *   · 旧的 persona.md + 配置里的 persona → personas/p1.md + 清单第一条
 * 任何一步失败都不中断其余步骤，原因写进返回值的 error 里（宿主会折进 /status）。
 */
export function migrate() {
  const out = { migrated: false, accountId: '', personaId: '', error: '', backup: '' }
  try {
    ensureDir(accountsRoot()); ensureDir(personasDir()); ensureDir(trashDir())
  } catch (e) { out.error = '建目录失败：' + String(e?.message ?? e); return out }

  // ① 账号
  try {
    const raw = readRaw()
    const known = Array.isArray(raw?.profiles?.accounts) && raw.profiles.accounts.length > 0
    const pointer = currentAccountId()
    if (!known && !pointer) {
      const legacy = path.join(credDir(), 'credentials.json')
      if (fs.existsSync(legacy)) {
        const j = readJson(legacy)
        const cred = deriveCred(j)
        const uid = String(cred.uid || '').trim()
        if (ACC_ID.test(uid)) {
          const dir = accountDir(uid)
          ensureDir(dir)
          copyOnly(legacy, credentialsPath(uid))
          for (const f of STATE_FILES) copyOnly(path.join(credDir(), f), path.join(dir, f))
          out.backup = backupConfig()
          writeConfig({
            profiles: { accounts: [{ id: uid, label: cleanLabel(cred.nickname) || uid, addedAt: new Date().toISOString(), lastPersona: '' }] },
            self: { uid, name: cleanLabel(cred.nickname) },
          })
          setActiveAccount(uid)
          out.accountId = uid
          out.migrated = true
        }
      }
    } else if (pointer) {
      out.accountId = pointer
    }
  } catch (e) { out.error = (out.error ? out.error + '；' : '') + '账号迁移失败：' + String(e?.message ?? e) }

  // ② 人设
  try {
    const raw = readRaw()
    const list = personaList(raw)
    if (!list.length) {
      const legacyNotes = path.join(credDir(), 'persona.md')
      const src = isObj(raw?.persona) ? raw.persona : {}
      const first = {
        id: 'p1',
        label: cleanLabel(src.name) || '默认人设',
        name: cleanLabel(src.name) || DEFAULTS.persona.name,
        ownerTitle: cleanLabel(src.ownerTitle) || DEFAULTS.persona.ownerTitle,
        style: String(src.style ?? '').trim() || DEFAULTS.persona.style,
      }
      if (!out.backup) out.backup = backupConfig()
      writeConfig({ profiles: { personas: [first], activePersona: 'p1' } })
      if (fs.existsSync(legacyNotes)) copyOnly(legacyNotes, personaPath('p1'))
      out.personaId = 'p1'
      out.migrated = true
    } else {
      out.personaId = activePersonaId(raw)
      for (const p of personas(raw)) ensureDir(path.dirname(personaPath(p.id)))
    }
  } catch (e) { out.error = (out.error ? out.error + '；' : '') + '人设迁移失败：' + String(e?.message ?? e) }

  // ③ 标签自愈：老 cookie 里的昵称是 URL 编码的，标签跟着存成了 nanhua%E7%9A%84…。
  // 只在标签里带 '%' 时动手，改完就再也不会命中。
  try {
    const raw = readRaw()
    const list = Array.isArray(raw?.profiles?.accounts) ? raw.profiles.accounts : []
    const dirty = list.filter((a) => isObj(a) && String(a.label || '').includes('%'))
    if (dirty.length) {
      writeConfig({ profiles: { accounts: list.map((a) => (isObj(a) && String(a.label || '').includes('%')
        ? { ...a, label: cleanLabel(prettyNickname(readJson(credentialsPath(String(a.id))).nickname)) || String(a.id) }
        : a)) } })
      out.migrated = true
    }
  } catch {}

  return out
}
