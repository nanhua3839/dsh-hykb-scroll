// 云侧账号 + 多端同步：快爆Pro账号（自建，与快爆官方无关）跑在腾讯云函数 nanhua-api 上。
//
// 契约见 CLOUD-CONTRACT.md（v2），字段名对不上就是 bug。
// 四条硬规矩：
//   1. 令牌只留在服务端（~/.hykb-ai/plugin-account.json，收权），永不出进程；
//   2. 载荷只装配置 / 人设 / 快爆凭据 / 已读去重 / 当日额度；AI Key、中转站密钥、浏览记录永不上云；
//   3. 冲突按字段级后写覆盖（t 大者胜），本地没被远端改到的键原样保留；
//   4. 租约保证同一时刻只有一个写者，所以 seen/ledger 用整份 blob 同步是安全的。
import fs from 'node:fs'
import path from 'node:path'
import * as C from './config.mjs'
import * as PR from './profiles.mjs'
import {
  accountDir, activeAccountFile, configPath, credDir, credentialsPath, currentAccountId,
  ensureDir, harden, ledgerPath, personaPath, seenPath,
} from './paths.mjs'

export const CLOUD = {
  baseUrl: 'https://nanhua-7gd6q2h3cb2db2cb.service.tcloudbase.com/nanhua-api',
  schemaVersion: 2,
  timeoutMs: 15000,
  maxBytes: 480 * 1024,
  syncMs: 10000,
  leaseMs: 30000,
  leaseTtl: 90000,
}

const accountFile = () => path.join(credDir(), 'plugin-account.json')
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const readJson = (file) => { try { const v = JSON.parse(fs.readFileSync(file, 'utf8')); return isObj(v) ? v : {} } catch { return {} } }
const canon = (v) => JSON.stringify(v === undefined ? null : v)

/* ───────────── 本地账号态 ───────────── */

export function readAccount() {
  const raw = readJson(accountFile())
  return {
    username: String(raw.username || ''),
    token: String(raw.token || ''),
    lastSyncAt: Number(raw.lastSyncAt) || 0,
    lastSyncDir: ['push', 'pull'].includes(raw.lastSyncDir) ? raw.lastSyncDir : '',
    cloudUpdatedAt: Number(raw.cloudUpdatedAt) || 0,
  }
}

function writeAccount(next) {
  const file = accountFile()
  ensureDir(path.dirname(file))
  const tmp = file + '.' + process.pid + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
  harden(tmp)
  fs.renameSync(tmp, file)
  harden(file)
  return readAccount()
}

export function state() {
  const a = readAccount()
  return {
    loggedIn: Boolean(a.username && a.token),
    username: a.username,
    lastSyncAt: a.lastSyncAt,
    lastSyncDir: a.lastSyncDir,
    cloudUpdatedAt: a.cloudUpdatedAt,
  }
}

async function apiCall(route, { method = 'GET', token = '', body = null } = {}) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), CLOUD.timeoutMs)
  try {
    const headers = { Accept: 'application/json' }
    if (token) headers.Authorization = 'Bearer ' + token
    if (body !== null) headers['Content-Type'] = 'application/json'
    const r = await fetch(CLOUD.baseUrl + route, { method, headers, body: body === null ? undefined : JSON.stringify(body), signal: ac.signal })
    let data = null
    try { data = await r.json() } catch { data = null }
    if (!r.ok) throw new Error(isObj(data) && data.error ? String(data.error) : '云端返回 ' + r.status)
    if (!isObj(data)) throw new Error('云端回包不是 JSON')
    return data
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('云端超时，检查网络后重试')
    throw new Error(String(e.message || e))
  } finally { clearTimeout(timer) }
}

/** 注册 / 登录：成功后落本地账号态，并把同步循环叫醒。 */
export async function auth({ action, username, password }) {
  const op = action === 'register' ? 'register' : 'login'
  const name = String(username ?? '').trim()
  if (name.length < 3 || name.length > 20) throw new Error('账号要 3-20 个字符')
  if (String(password ?? '').length < 6) throw new Error('密码至少 6 位')
  const data = await apiCall('/' + op, { method: 'POST', body: { username: name, password: String(password ?? '') } })
  if (!data.ok || !data.token) throw new Error('注册/登录没拿到令牌')
  writeAccount({ username: String(data.username || name), token: String(data.token), lastSyncAt: 0, lastSyncDir: '', cloudUpdatedAt: 0 })
  return state()
}

export function logout() {
  try { fs.rmSync(accountFile(), { force: true }) } catch {}
  return state()
}

/* ───────────── 载荷：本地盘 ↔ 扁平 KV ───────────── */

/** 把配置递归拆成 cfg.<a>.<b> 叶子；profiles 子树另走 persona./acct./meta.ptr，避免同一份数据两条真相。 */
function flatten(prefix, value, out) {
  if (Array.isArray(value) || !isObj(value)) { out[prefix] = value === undefined ? null : value; return out }
  const keys = Object.keys(value)
  if (!keys.length) { out[prefix] = {}; return out }
  for (const k of keys) flatten(prefix + '.' + k, value[k], out)
  return out
}

/** 当前磁盘状态的扁平快照。paths 可见 CLOUD-CONTRACT.md §2。 */
export function snapshot() {
  const raw = C.readRaw()
  const out = {}
  const cfg = {}
  for (const [k, v] of Object.entries(raw)) if (k !== 'profiles') cfg[k] = v
  flatten('cfg', cfg, out)
  for (const p of PR.personas(raw)) {
    out['persona.' + p.id + '.meta'] = { label: p.label, name: p.name, ownerTitle: p.ownerTitle, style: p.style }
    out['persona.' + p.id + '.notes'] = PR.readPersonaNotes(p.id)
  }
  for (const a of PR.accounts(raw)) {
    out['acct.' + a.id + '.meta'] = { label: a.label, lastPersona: String(a.lastPersona || '') }
    out['acct.' + a.id + '.cred'] = readJson(credentialsPath(a.id))
    out['seen.' + a.id] = readJson(seenPath(a.id))
    out['ledger.' + a.id] = readJson(ledgerPath(a.id))
  }
  out['meta.ptr'] = { account: String(currentAccountId() || ''), persona: PR.activePersonaId(raw) }
  return out
}

/** 两个快照之间真正变了的路径（值相等不算变）。 */
export function diffPaths(prev, next) {
  const keys = new Set([...Object.keys(prev || {}), ...Object.keys(next || {})])
  const out = []
  for (const k of keys) if (canon(prev?.[k]) !== canon(next?.[k])) out.push(k)
  return out
}

const writeJsonFile = (file, value) => {
  ensureDir(path.dirname(file))
  const tmp = file + '.' + process.pid + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(value ?? {}, null, 2) + '\n', { mode: 0o600 })
  harden(tmp)
  fs.renameSync(tmp, file)
  harden(file)
}

function catalogPatch(next) {
  const raw = C.readRaw()
  const cur = PR.accounts(raw)
  const list = Array.isArray(raw?.profiles?.accounts) ? raw.profiles.accounts.filter((a) => isObj(a)) : []
  const merged = list.map((a) => (next[String(a.id)] ? { ...a, ...next[String(a.id)] } : a))
  const known = new Set(list.map((a) => String(a.id)))
  for (const [id, patch] of Object.entries(next)) {
    if (known.has(id)) continue
    const exists = cur.some((a) => a.id === id)
    if (exists) merged.push({ id, ...patch })
  }
  C.writeConfig({ profiles: { accounts: merged } })
}

function personaCatalogPatch(next) {
  const raw = C.readRaw()
  const list = Array.isArray(raw?.profiles?.personas) ? raw.profiles.personas.filter((p) => isObj(p)) : []
  const merged = list.map((p) => (next[String(p.id)] ? { ...p, ...next[String(p.id)] } : p))
  const known = new Set(list.map((p) => String(p.id)))
  for (const [id, patch] of Object.entries(next)) if (!known.has(id)) merged.push({ id, ...patch })
  C.writeConfig({ profiles: { personas: merged } })
}

/** 把远端 KV 落到磁盘。只写给出的路径，本地其它内容（含密钥文件）一个字节都不动。 */
export function applyKV(kv) {
  const cfgLeaves = []
  const acctMeta = {}
  const personaMeta = {}
  for (const [p, entry] of Object.entries(kv || {})) {
    const v = isObj(entry) ? entry.v : undefined
    if (p.startsWith('cfg.')) { cfgLeaves.push([p.slice(4), v]); continue }
    if (p === 'meta.ptr') {
      const acc = String(v?.account || '')
      if (/^\d+$/.test(acc) && fs.existsSync(accountDir(acc))) {
        const file = activeAccountFile()
        ensureDir(path.dirname(file))
        fs.writeFileSync(file, acc + '\n', { mode: 0o600 })
        harden(file)
      }
      const per = String(v?.persona || '')
      if (per) { try { C.writeConfig({ profiles: { activePersona: per } }) } catch {} }
      continue
    }
    const m = p.match(/^persona\.([^.]+)\.(meta|notes)$/)
    if (m) {
      if (m[2] === 'notes') { try { PR.writePersonaNotes(m[1], String(v ?? '')) } catch {} }
      else if (isObj(v)) personaMeta[m[1]] = v
      continue
    }
    const a = p.match(/^acct\.([^.]+)\.(meta|cred)$/)
    if (a) {
      if (a[2] === 'cred') { if (isObj(v) && Object.keys(v).length) writeJsonFile(credentialsPath(a[1]), v) }
      else if (isObj(v)) acctMeta[a[1]] = v
      continue
    }
    const s = p.match(/^(seen|ledger)\.([^.]+)$/)
    if (s) {
      const file = s[1] === 'seen' ? seenPath(s[2]) : ledgerPath(s[2])
      if (isObj(v)) writeJsonFile(file, v)
      continue
    }
  }
  if (cfgLeaves.length) {
    const patch = {}
    for (const [dotted, v] of cfgLeaves) {
      const segs = dotted.split('.')
      let cur = patch
      for (let i = 0; i < segs.length - 1; i += 1) {
        if (!isObj(cur[segs[i]])) cur[segs[i]] = {}
        cur = cur[segs[i]]
      }
      cur[segs[segs.length - 1]] = v
    }
    C.writeConfig(patch)
  }
  if (Object.keys(personaMeta).length) { try { personaCatalogPatch(personaMeta) } catch {} }
  if (Object.keys(acctMeta).length) { try { catalogPatch(acctMeta) } catch {} }
  return { paths: Object.keys(kv || {}).length }
}

/** 整份载荷（手动 push / 云端为空时首次上传用）。 */
export function buildPayload() {
  const kv = {}
  const now = Date.now()
  for (const [p, v] of Object.entries(snapshot())) kv[p] = { v, t: now }
  const payload = { schemaVersion: CLOUD.schemaVersion, exportedAt: now, kv }
  const size = Buffer.byteLength(JSON.stringify(payload), 'utf8')
  if (size > CLOUD.maxBytes) throw new Error('本地配置太大（' + Math.round(size / 1024) + 'KB），超出云端 480KB 上限')
  return payload
}

export async function applyPayload(payload) {
  if (!isObj(payload) || payload.schemaVersion !== CLOUD.schemaVersion) throw new Error('云端数据版本不匹配（本地 ' + CLOUD.schemaVersion + '）')
  if (!isObj(payload.kv)) throw new Error('云端数据缺少 kv')
  applyKV(payload.kv)
  return { paths: Object.keys(payload.kv).length }
}

/* ───────────── 云 API ───────────── */

/** 只推指定路径（增量同步用）。逐键 LWW 由云侧合并，推错的代价只是被更强的 t 覆盖。 */
export async function pushKv(kv) {
  const a = readAccount()
  if (!a.username || !a.token) throw new Error('还没登录快爆Pro账号')
  if (!isObj(kv) || !Object.keys(kv).length) return { now: Date.now(), applied: 0 }
  const size = Buffer.byteLength(JSON.stringify(kv), 'utf8')
  if (size > CLOUD.maxBytes) throw new Error('本次改动太大（' + Math.round(size / 1024) + 'KB），超出云端 480KB 上限')
  const data = await apiCall('/plugin/state', { method: 'POST', token: a.token, body: { kv, clientUpdatedAt: Date.now() } })
  writeAccount({ ...a, lastSyncAt: Date.now(), lastSyncDir: 'push', cloudUpdatedAt: Number(data.now) || Date.now() })
  return { now: Number(data.now) || Date.now(), applied: Number(data.applied) || 0 }
}

export async function pushAll() {
  const payload = buildPayload()
  const r = await pushKv(payload.kv)
  return { ...r, t: payload.exportedAt }
}

export async function pullAll(since = 0) {
  const a = readAccount()
  if (!a.username || !a.token) throw new Error('还没登录快爆Pro账号')
  const data = await apiCall('/plugin/state?since=' + Math.max(0, Number(since) || 0), { token: a.token })
  const kv = isObj(data.kv) ? data.kv : {}
  if (Object.keys(kv).length) applyKV(kv)
  writeAccount({ ...a, lastSyncAt: Date.now(), lastSyncDir: 'pull', cloudUpdatedAt: Number(data.now) || Date.now() })
  let maxT = Number(since) || 0
  for (const e of Object.values(kv)) { const t = Number(isObj(e) ? e.t : 0) || 0; if (t > maxT) maxT = t }
  return { now: Number(data.now) || Date.now(), count: Object.keys(kv).length, since: maxT }
}

export async function leaseCall(action, deviceId, deviceName) {
  const a = readAccount()
  if (!a.username || !a.token) throw new Error('还没登录快爆Pro账号')
  const data = await apiCall('/plugin/lease', { method: 'POST', token: a.token, body: { action, deviceId, deviceName } })
  return { mine: data.mine === true, holder: isObj(data.holder) ? data.holder : null, ttl: Number(data.ttl) || CLOUD.leaseTtl }
}

export async function qrStart(deviceName) {
  return apiCall('/plugin/qr/start', { method: 'POST', body: { deviceName: String(deviceName || '') } })
}

export async function qrPoll(code) {
  const data = await apiCall('/plugin/qr/poll?code=' + encodeURIComponent(String(code || '')), {})
  const status = String(data.status || 'invalid')
  if (status === 'ok' && data.token) {
    writeAccount({ username: String(data.username || ''), token: String(data.token), lastSyncAt: 0, lastSyncDir: '', cloudUpdatedAt: 0 })
    return { status, account: state() }
  }
  return { status }
}
