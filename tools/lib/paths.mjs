// 路径层：所有落盘位置集中在这里，别在业务代码里拼字符串。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const HOME = process.env.USERPROFILE || os.homedir()
const DSH_HOME = process.env.DSH_HOME || path.join(HOME, '.dsh')

export const dshHome = () => DSH_HOME
export const dshPath = (...p) => path.join(DSH_HOME, ...p)
const CONFIG_FILE = path.join(DSH_HOME, 'hykb-scroll.config.json')
/** 改名前的配置文件：首次读到新文件不存在时搬过来，别让使用者的设置凭空消失。 */
const LEGACY_CONFIG_FILE = path.join(DSH_HOME, 'hykb-whale.config.json')

export const configPath = () => {
  const file = process.env.HYKB_SCROLL_CONFIG || CONFIG_FILE
  if (file === CONFIG_FILE && !fs.existsSync(file) && fs.existsSync(LEGACY_CONFIG_FILE)) {
    try { fs.copyFileSync(LEGACY_CONFIG_FILE, file) } catch {}
  }
  return file
}
export const credDir = () => path.join(HOME, '.hykb-ai')

/* ── 多账号：一个指针文件 + 每号一个目录 ──
 * 「当前账号」只存在 active-account（一行 uid）里，不写配置文件：
 *   - config.mjs 依赖本模块，反向 import 会成环，所以这里只读文件、不 import config；
 *   - CLI 与宿主必须看到同一个答案，落盘才不会两边不一致。
 * 指针不存在 / 内容非法 → currentAccountId() 返回 ''，下面所有路径回落到改造前的根目录，
 * 老装机与既有测试因此照旧工作，迁移是「检测到旧布局才做」。 */
export const activeAccountFile = () => path.join(credDir(), 'active-account')
export const accountsRoot = () => path.join(credDir(), 'accounts')
export const trashDir = () => path.join(accountsRoot(), '.trash')

/** 当前激活账号 id；读不到或不是纯数字 uid 时返回 ''（= 旧的单号布局）。 */
export function currentAccountId() {
  try {
    const v = fs.readFileSync(activeAccountFile(), 'utf8').trim()
    return /^\d+$/.test(v) ? v : ''
  } catch { return '' }
}

/** 账号目录。id 空 = 旧的单号布局（就用 credDir 根）。 */
export const accountDir = (id) => (id ? path.join(accountsRoot(), id) : credDir())
/** 省略 id → 当前账号；显式 '' → 旧的单号布局；否则指定账号。 */
const scopeOf = (id) => accountDir(id === undefined ? currentAccountId() : id)

export const credentialsPath = (id) => path.join(scopeOf(id), 'credentials.json')
export const ledgerPath = (id) => path.join(scopeOf(id), 'traffic-ledger.json')
export const auditPath = () => path.join(credDir(), 'audit.jsonl')
export const seenPath = (id) => path.join(scopeOf(id), 'seen.json')
export const postLogPath = (id) => path.join(scopeOf(id), 'posts.json')
/** 浏览记录：她读过/回过/跳过的帖，一行一条 JSONL。与 activity（一轮一条）不是一回事。 */
export const historyPath = (id) => path.join(scopeOf(id), 'browsed.jsonl')
/** 复读台账：发过的话（归一化 + 近似度查重用）。JSONL 追加写，与 seen.json 不是一回事。 */
export const saidPath = (id) => path.join(scopeOf(id), 'said.jsonl')
/** 回关台账：基线、每个粉丝的处理结果、每日计数。与 seen.json（回帖去重）分开，互不影响。 */
export const fansPath = (id) => path.join(scopeOf(id), 'fans.json')
/** App 登录态（user_token）：和网页 cookie 分开存，单独收权，不进配置文件。 */
export const appTokenPath = (id) => path.join(scopeOf(id), 'app-token.json')
/** 人设：每人一份 md。省略 id 仍是改造前那份 persona.md。 */
export const personasDir = () => path.join(credDir(), 'personas')
export const personaPath = (id) => (id ? path.join(personasDir(), id + '.md') : path.join(credDir(), 'persona.md'))
/** AI 密钥单独存一个文件：配置文件常被设置页整份回写、也常被拷来拷去，密钥不该跟着走。 */
export const aiKeyPath = () => path.join(credDir(), 'ai-key')

// 决策模型（判官）的密钥：和 ai-key 同一套待遇，单独一个文件，配置里只留掩码。
export const judgeKeyPath = () => path.join(credDir(), 'judge-key')
/** 中转站密钥表 { relayId: key }：与直连密钥分开存，同样不进配置文件。 */
export const relayKeysPath = () => path.join(credDir(), 'relay-keys.json')
// 快爆敏感词检测的密钥：和 ai-key 一样单独存，配置文件里不留明文
export const maskwordKeyPath = () => path.join(credDir(), 'maskword-key')
export const workDir = () => path.join(DSH_HOME, 'hykb-work')
/** 日报落盘：~/.dsh/hykb-work/digest-YYYY-MM-DD.md（同一天多次刷帖是追加，不覆盖） */
export const digestDir = () => path.join(DSH_HOME, 'hykb-work')
/** 缺省日期用本地日，跟 digest.mjs 的 today() 保持同一个口径（UTC 日会让东八区 0-8 点写成前一天的日报）。 */
export const digestPath = (date) => path.join(digestDir(), 'digest-' + (date || localDay()) + '.md')

/** 本地日期 YYYY-MM-DD。 */
export function localDay(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return now.getFullYear() + '-' + p(now.getMonth() + 1) + '-' + p(now.getDate())
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

/**
 * 把文件权限收到"只有本人能读"。
 * Windows 上 chmod 的 mode 参数直接被忽略（落盘实测永远是 666），
 * 所以走 icacls：先砍掉继承，再只授当前用户读写。失败不阻断业务（有些 FS 上 icacls 不可用）。
 * @returns {boolean} 是否真的收紧了
 */
export function harden(file) {
  if (!file) return false
  if (process.platform !== 'win32') {
    try { fs.chmodSync(file, 0o600); return true } catch { return false }
  }
  // 取当前用户：process.env.USERNAME 在部分执行环境（服务、容器）里是空的，
  // 空用户名会让 icacls 收到 ":R,W" 直接报「无效参数」，所以用 os.userInfo() 兜底。
  let user = ''
  try { user = os.userInfo().username || '' } catch {}
  if (!user) user = process.env.USERNAME || process.env.USER || ''
  if (!user) return false
  try {
    // 权限串必须写成 user:(R,W)：写成 user:R,W 会被 icacls 当成无效参数（exit 87）静默失败。
    execFileSync('icacls.exe', [file, '/inheritance:r', '/grant:r', user + ':(R,W)'], {
      stdio: 'ignore', timeout: 5000, windowsHide: true,
    })
    return true
  } catch { return false }
}
