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
import os from 'node:os'
import zlib from 'node:zlib'
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
  // 轮询间隔 30 分钟。一次 syncRound 同时做「推改动 / 拉改动 / 续租约」，所以这就是唯一的定时请求。
  // 为什么要降频：实测约 0.042 资源点/次，按 10 秒一轮一天 1.15 万次，体验版 3000 点 6 天就烧光，
  // 额度用尽后整个环境停服（接口回 410）。
  syncMs: 30 * 60 * 1000,
  // 已并入 syncMs，保留只为兼容旧调用；不要再单独起租约定时器。
  leaseMs: 30 * 60 * 1000,
  // 与云侧 PLUGIN_LEASE_TTL 对齐；服务端回包里的 ttl 优先。
  leaseTtl: 40 * 60 * 1000,
  // 云备份（「方案」）：存在同一份 KV 里，路径 backup.<id>，值是 gzip+base64 的整份配置快照。
  // 为什么要压缩：kv 与租约同一份文档，整份 JSON 有 512KB 上限，而一份方案里配置 + 人设很容易上几十 KB。
  backupMax: 8,
  // 单份（上云后的条目体积）与所有方案合计的上限。合计留出余量给实时同步的 KV：
  // 云端文档整份 JSON 上限 512KB，超了整个 POST 会 400「数据过大」。
  backupMaxBytes: 200 * 1024,
  backupTotalBytes: 380 * 1024,
}

const accountFile = () => path.join(credDir(), 'plugin-account.json')
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const readJson = (file) => { try { const v = JSON.parse(fs.readFileSync(file, 'utf8')); return isObj(v) ? v : {} } catch { return {} } }
const canon = (v) => JSON.stringify(v === undefined ? null : v)

/* ───────────── 本机身份（设备 id / 名字 / 主机备机） ───────────── */

const deviceFile = () => path.join(credDir(), 'plugin-device.json')

export function readDevice() {
  const raw = readJson(deviceFile())
  return {
    id: String(raw.id || ''),
    name: String(raw.name || ''),
    // 只有明确选过主机才算主机：没选过 / 旧文件 / 字段写坏都按副机，
    // 免得一台新机器默默拿 primary 把正在跑的那台顶下来（云侧只拦「两台都 primary」）。
    // off = 本机完全不参与运行（不抢租约、不跑监听/刷帖），只保留云同步。
    role: raw.role === 'primary' ? 'primary' : (raw.role === 'off' ? 'off' : 'secondary'),
    // createdAt：这台机器是什么时候开始用插件的。另一台「下线双端设备」时会在云端写一个
    // sys.offline 标记；只有比本机出生时间新的标记才认，否则新装的机器一登录就被历史标记关掉。
    createdAt: Number(raw.createdAt) || 0,
    // offAckAt：已经消费过的下线标记时间。同一份标记不重复生效。
    offAckAt: Number(raw.offAckAt) || 0,
  }
}

/** 首次调用时生成并落盘；id 一旦定下就不再变（租约靠它认人）。 */
export function ensureDevice() {
  const cur = readDevice()
  if (cur.id) return cur
  const id = (Date.now().toString(16) + Math.random().toString(16).slice(2, 10)).slice(0, 16)
  let name = '本机'
  try { name = os.hostname() || '本机' } catch {}
  const next = { id, name, role: 'secondary', createdAt: Date.now(), offAckAt: 0 }
  try {
    ensureDir(path.dirname(deviceFile()))
    fs.writeFileSync(deviceFile(), JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
    harden(deviceFile())
  } catch {}
  return readDevice()
}

/** 主机 / 副机 / 关闭：用户选的，跟着这台机器走，不上云（别人的角色跟你无关）。
 *  primary = 优先跑（可抢占）；secondary = 让位待命（不抢占，主机断了才接管）；
 *  off = 只同步（连租约都不抢，等于「这台不参与运行」）。
 *  「取消副机」不等于「我要跑」：缺省一律副机，只有显式选主机才有抢占权。 */
export function writeDeviceRole(role) {
  const cur = readJson(deviceFile())
  const picked = role === 'primary' ? 'primary' : (role === 'off' ? 'off' : 'secondary')
  const next = {
    ...cur,
    id: cur.id || ensureDevice().id,
    name: cur.name || ensureDevice().name,
    role: picked,
    createdAt: Number(cur.createdAt) || Date.now(),
    offAckAt: Number(cur.offAckAt) || 0,
  }
  ensureDir(path.dirname(deviceFile()))
  fs.writeFileSync(deviceFile(), JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
  harden(deviceFile())
  return readDevice()
}

/** 记下「已经消费过的下线标记」，同一个 at 不再重复生效（对端写标记 / 本机写标记都会调）。 */
export function ackOffline(at) {
  const stamp = Number(at) || 0
  if (!stamp) return readDevice()
  const cur = readJson(deviceFile())
  if (stamp <= (Number(cur.offAckAt) || 0)) return readDevice()
  const base = cur.id ? cur : { ...cur, ...ensureDevice() }
  const next = { ...base, offAckAt: stamp, createdAt: Number(base.createdAt) || Date.now() }
  ensureDir(path.dirname(deviceFile()))
  fs.writeFileSync(deviceFile(), JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
  harden(deviceFile())
  return readDevice()
}

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

/**
 * 网关状态码 → 人话。
 * 410 在这套 CloudBase 网关上就是「环境被停服」的信号（响应体是空的，也没有专门的错误码字段）：
 * 管理接口里跟它对应的是 `DescribeFunction.AvailableStatus = InsufficientBalance`
 * 加上用量接口的 `Credits.used === total` + `EnableOverrun: false`，但那两样要腾讯云凭据，
 * 插件在运行时拿不到，只能按状态码映射。所以对 410 说「资源用尽」，并保留 HTTP 码便于对照。
 */
export function explainStatus(code) {
  const c = Number(code) || 0
  if (c === 410) return '资源用尽 · 云端已停服（HTTP 410）'
  if (c === 401) return '登录已失效，请重新登录（HTTP 401）'
  if (c === 403) return '没有权限（HTTP 403）'
  if (c === 429) return '云端限流，稍后重试（HTTP 429）'
  if (c >= 500) return '云端故障，稍后重试（HTTP ' + c + '）'
  return '云端返回 ' + c
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
    if (!r.ok) throw new Error(isObj(data) && data.error ? String(data.error) : explainStatus(r.status))
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

/** 云侧把 kv 存成条目数组（字段名不能带点，CloudBase 会把点展开成嵌套对象）；这里统一回对象形态。 */
export function normalizeKv(input) {
  const out = {}
  if (Array.isArray(input)) {
    for (const e of input) {
      if (!isObj(e) || !String(e.p || '').trim()) continue
      out[String(e.p)] = { v: e.v === undefined ? null : e.v, t: Number(e.t) || 0 }
    }
    return out
  }
  if (isObj(input)) {
    for (const [p, c] of Object.entries(input)) {
      if (!isObj(c)) continue
      out[p] = { v: c.v === undefined ? null : c.v, t: Number(c.t) || 0 }
    }
  }
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
export function applyKV(rawKv) {
  const kv = normalizeKv(rawKv)
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

/* ───────────── 云备份：把整套设置存成云端的「方案」 ─────────────
 *
 * 云同步解决的是「两台机器跟着改」；备份解决的是「改坏了能不能退回去 / 换台机器能不能挑一份装」。
 * 存储复用同一份 KV（nh_plugin_state），路径 `backup.<id>` —— 这样不用改云函数：
 *   · 一台机器上传，另一台登录同一个账号，下一轮同步就能看到这份方案（并在本机缓存下来）；
 *   · 删除用墓碑（deleted:true）覆盖，云侧只做「后写覆盖」，没有删除语义正好够用。
 * 方案内容：配置 + 人设 + 账号备注，不含 AI 密钥 / 中转站密钥 / 快爆登录态 / 已读去重 / 额度。
 */

const BACKUP_PREFIX = 'backup.'
const backupsFile = () => path.join(credDir(), 'cloud-backups.json')

function readBackupsRaw() {
  const raw = readJson(backupsFile())
  const out = {}
  for (const [id, b] of Object.entries(raw)) {
    if (!isObj(b)) continue
    out[id] = b
  }
  return out
}

function writeBackupsRaw(map) {
  const file = backupsFile()
  ensureDir(path.dirname(file))
  const tmp = file + '.' + process.pid + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(map ?? {}, null, 2) + '\n', { mode: 0o600 })
  harden(tmp)
  fs.renameSync(tmp, file)
  harden(file)
}

/** 本地缓存里的方案清单（不含正文，界面只要名字 / 时间 / 大小）。 */
export function backupList() {
  return Object.values(readBackupsRaw())
    .filter((b) => b && !b.deleted && b.id)
    .sort((a, b) => Number(b.at) - Number(a.at))
    .map((b) => ({
      id: String(b.id),
      name: String(b.name || ''),
      at: Number(b.at) || 0,
      byName: String(b.byName || ''),
      bytes: Number(b.bytes) || 0,
    }))
}

/** 云端条目 → 本地缓存条目（解压失败就当没这份，不抛）。 */
function decodeBackup(id, v) {
  if (!isObj(v) || !v.z) return null
  let payload = null
  try {
    const raw = zlib.gunzipSync(Buffer.from(String(v.z), 'base64')).toString('utf8')
    payload = JSON.parse(raw)
  } catch { return null }
  if (!isObj(payload) || !isObj(payload.kv)) return null
  return {
    id,
    name: String(v.n || ''),
    at: Number(v.a || v.at || 0) || 0,
    byName: String(v.dn || ''),
    bytes: Number(v.b) || Buffer.byteLength(String(v.z), 'base64'),
    // 上云后的条目体积（base64 后）：用来估算云端文档还有多少余量
    enc: Buffer.byteLength(String(v.z), 'utf8'),
    payload,
  }
}

/** 上传时打包：配置 + 人设 + 账号备注，剔除密钥类与体量大的运行数据。 */
function backupPayload() {
  const now = Date.now()
  const kv = {}
  for (const [p, v] of Object.entries(snapshot())) {
    if (/^(seen|ledger)\./.test(p)) continue           // 去重 / 额度：又大又只对本机有意义
    if (/^acct\.[^.]+\.cred$/.test(p)) continue         // 快爆登录态：换了机器也该重新扫码
    kv[p] = { v, t: now }
  }
  return { schemaVersion: CLOUD.schemaVersion, exportedAt: now, kv }
}

function defaultBackupName(deviceName) {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  const stamp = p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
  return (deviceName ? deviceName + ' · ' : '') + stamp
}

/**
 * 把远端 kv 里的备份条目 / 下线标记收进本地缓存。配置本身由 applyKV 处理，这里不碰。
 * 返回 { offline }：本轮看到的 sys.offline 标记（没有就是 null），由宿主决定要不要执行。
 */
export function ingestAux(rawKv) {
  const kv = normalizeKv(rawKv)
  const map = readBackupsRaw()
  let changed = false
  let offline = null
  for (const [p, entry] of Object.entries(kv)) {
    const v = isObj(entry) ? entry.v : null
    if (p.startsWith(BACKUP_PREFIX)) {
      const id = p.slice(BACKUP_PREFIX.length)
      if (!id) continue
      if (isObj(v) && v.deleted) { if (map[id]) { delete map[id]; changed = true } continue }
      const next = decodeBackup(id, v)
      if (!next) continue
      const prev = map[id]
      if (!prev || Number(next.at) >= Number(prev.at)) { map[id] = next; changed = true }
      continue
    }
    if (p === 'sys.offline' && isObj(v)) offline = v
  }
  if (changed) {
    try { writeBackupsRaw(map) } catch {}
  }
  return { offline }
}

/** 上传一份方案。名字留空就用「设备名 · MM-DD HH:mm」。 */
export async function backupUpload({ name = '', deviceName = '' } = {}) {
  const a = readAccount()
  if (!a.username || !a.token) throw new Error('还没登录快爆Pro账号')
  const map = readBackupsRaw()
  const list = backupList()
  if (list.length >= CLOUD.backupMax) throw new Error('云端已经有 ' + CLOUD.backupMax + ' 份方案；先删掉一份再上传')
  const dev = readDevice()
  const payload = backupPayload()
  const raw = Buffer.from(JSON.stringify(payload), 'utf8')
  const entry = {
    n: String(name || '').trim().slice(0, 40) || defaultBackupName(deviceName || dev.name),
    a: Date.now(),
    d: dev.id,
    dn: String(deviceName || dev.name || ''),
    b: raw.length,
    z: zlib.gzipSync(raw).toString('base64'),
  }
  const cell = { p: BACKUP_PREFIX + 'b' + entry.a.toString(36) + Math.random().toString(36).slice(2, 6), v: entry, t: entry.a }
  const size = Buffer.byteLength(JSON.stringify(cell), 'utf8')
  if (size > CLOUD.backupMaxBytes) throw new Error('这份方案太大（' + Math.round(size / 1024) + 'KB），超出单份上限')
  // 文档是同步 KV + 方案共用的一份，总 JSON 有 512KB 上限；给实时配置留出余量再收新方案
  const used = Object.values(map).reduce((n, b) => n + (Number(b.enc) || 0), 0)
  if (used + size > CLOUD.backupTotalBytes) {
    throw new Error('云端方案总容量快满了（已占 ' + Math.round(used / 1024) + 'KB），先删掉一份再上传')
  }
  await pushKv({ [cell.p]: { v: entry, t: entry.t } })
  map[cell.p.slice(BACKUP_PREFIX.length)] = {
    id: cell.p.slice(BACKUP_PREFIX.length),
    name: entry.n, at: entry.a, byName: entry.dn, bytes: raw.length, enc: size, payload,
  }
  writeBackupsRaw(map)
  return { id: cell.p.slice(BACKUP_PREFIX.length), name: entry.n, backups: backupList() }
}

/** 删一份：写墓碑（云侧的 KV 只有后写覆盖，没有删除）。 */
export async function backupDelete(id) {
  const key = String(id || '')
  if (!key) throw new Error('缺少方案 id')
  const at = Date.now()
  await pushKv({ [BACKUP_PREFIX + key]: { v: { deleted: true, at }, t: at } })
  const map = readBackupsRaw()
  if (map[key]) { delete map[key]; writeBackupsRaw(map) }
  return { id: key, backups: backupList() }
}

/** 从云端把方案清单拉一遍（只收 backup.* / sys.offline，不动本机配置）。 */
export async function backupRefresh() {
  const a = readAccount()
  if (!a.username || !a.token) throw new Error('还没登录快爆Pro账号')
  const data = await apiCall('/plugin/state?since=0', { token: a.token })
  ingestAux(normalizeKv(data.kv))
  return backupList()
}

/** 下载（应用）一份方案到本机：覆盖配置 / 人设 / 账号备注，不碰密钥与快爆登录态。 */
export function backupApply(id) {
  const key = String(id || '')
  const b = readBackupsRaw()[key]
  if (!b) throw new Error('本机没有这份方案；先点「刷新」从云端取一次')
  if (!isObj(b.payload) || !isObj(b.payload.kv)) throw new Error('方案内容不完整，读不出来')
  if (Number(b.payload.schemaVersion) !== CLOUD.schemaVersion) {
    throw new Error('方案的版本是 ' + (b.payload.schemaVersion || '?') + '，当前插件只认 ' + CLOUD.schemaVersion)
  }
  applyKV(b.payload.kv)
  return { id: key, name: String(b.name || ''), applied: Object.keys(b.payload.kv).length }
}

/** 把一份「双端下线」标记推上云：对端下一次同步会读到并把本机角色改成关闭。 */
export async function pushOfflineMarker(deviceId, deviceName) {
  const at = Date.now()
  await pushKv({ 'sys.offline': { v: { at, by: String(deviceId || ''), byName: String(deviceName || ''), scope: 'all' }, t: at } })
  ackOffline(at)
  return at
}

/* ───────────── 云 API ───────────── */

/** 只推指定路径（增量同步用）。逐键 LWW 由云侧合并，推错的代价只是被更强的 t 覆盖。 */
export async function pushKv(kv) {
  const a = readAccount()
  if (!a.username || !a.token) throw new Error('还没登录快爆Pro账号')
  if (!isObj(kv) || !Object.keys(kv).length) return { now: Date.now(), applied: 0 }
  const entries = Object.entries(kv).map(([p, c]) => ({ p, v: isObj(c) ? c.v : c, t: Number(isObj(c) ? c.t : 0) || 0 }))
  const size = Buffer.byteLength(JSON.stringify(entries), 'utf8')
  if (size > CLOUD.maxBytes) throw new Error('本次改动太大（' + Math.round(size / 1024) + 'KB），超出云端 480KB 上限')
  const data = await apiCall('/plugin/state', { method: 'POST', token: a.token, body: { kv: entries, clientUpdatedAt: Date.now() } })
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
  const kv = normalizeKv(data.kv)
  if (Object.keys(kv).length) applyKV(kv)
  const aux = ingestAux(kv)
  writeAccount({ ...a, lastSyncAt: Date.now(), lastSyncDir: 'pull', cloudUpdatedAt: Number(data.now) || Date.now() })
  let maxT = Number(since) || 0
  for (const e of Object.values(kv)) { const t = Number(isObj(e) ? e.t : 0) || 0; if (t > maxT) maxT = t }
  return { now: Number(data.now) || Date.now(), count: Object.keys(kv).length, since: maxT, kv, offline: aux.offline }
}

/**
 * 合并同步：一次请求把「推本地改动 / 拉远端改动 / 续抢租约」一起做完（云侧 §1.4 POST /plugin/sync）。
 * 定时轮和「立即同步」按钮都走这里；手动同步不做节流。
 * kv 给了就按字段级后写覆盖推上去，不给就只拉。
 */
export async function syncRound({ since = 0, kv = null, deviceId = '', deviceName = '', role = 'secondary' } = {}) {
  const a = readAccount()
  if (!a.username || !a.token) throw new Error('还没登录快爆Pro账号')
  const picked = String(role || '')
  const body = {
    since: Math.max(0, Number(since) || 0),
    deviceId: String(deviceId || ''),
    deviceName: String(deviceName || ''),
    role: ['primary', 'secondary', 'off'].includes(picked) ? picked : 'secondary',
  }
  if (isObj(kv) && Object.keys(kv).length) {
    const entries = Object.entries(kv).map(([p, c]) => ({ p, v: isObj(c) ? c.v : c, t: Number(isObj(c) ? c.t : 0) || 0 }))
    const size = Buffer.byteLength(JSON.stringify(entries), 'utf8')
    if (size > CLOUD.maxBytes) throw new Error('本次改动太大（' + Math.round(size / 1024) + 'KB），超出云端 480KB 上限')
    body.kv = entries
  }
  const data = await apiCall('/plugin/sync', { method: 'POST', token: a.token, body })
  const remote = normalizeKv(data.kv)
  if (Object.keys(remote).length) applyKV(remote)
  const aux = ingestAux(remote)
  writeAccount({ ...a, lastSyncAt: Date.now(), lastSyncDir: body.kv ? 'push' : 'pull', cloudUpdatedAt: Number(data.now) || Date.now() })
  let maxT = Math.max(0, Number(since) || 0)
  for (const e of Object.values(remote)) { const t = Number(isObj(e) ? e.t : 0) || 0; if (t > maxT) maxT = t }
  return {
    now: Number(data.now) || Date.now(),
    count: Object.keys(remote).length,
    since: maxT,
    applied: Number(data.applied) || 0,
    mine: data.mine === true,
    holder: isObj(data.holder) ? data.holder : null,
    ttl: Number(data.ttl) || CLOUD.leaseTtl,
    kv: remote,
    offline: aux.offline,
  }
}

export async function leaseCall(action, deviceId, deviceName) {
  const a = readAccount()
  if (!a.username || !a.token) throw new Error('还没登录快爆Pro账号')
  const role = readDevice().role
  const data = await apiCall('/plugin/lease', { method: 'POST', token: a.token, body: { action, deviceId, deviceName, role } })
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
