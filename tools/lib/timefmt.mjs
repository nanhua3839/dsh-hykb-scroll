// 时间层：快爆接口里的时间全是「YYYY-MM-DD HH:MM:SS」字符串，不是时间戳。
//
// 踩过的坑：browse.mjs 之前用 Number(t.time) 当毫秒时间戳，字符串转数字得 NaN，
// 于是「新鲜度加分」这一项永远是 0 —— 分数只剩互动量，新帖排不到前面。
//
// 平台给的 0000-00-00 00:00:00 表示「没有」（没改过 / 还没人回复），一律当 0。

const NONE = 0

/** 'YYYY-MM-DD HH:MM:SS' → 毫秒（按本机时区解析，平台给的就是北京时间）。解析不了返回 0。 */
export function parseKbTime(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(s ?? '').trim())
  if (!m) return NONE
  const [y, mo, d, h, mi, se] = m.slice(1).map(Number)
  if (!y || !mo || !d) return NONE
  const t = new Date(y, mo - 1, d, h, mi, se).getTime()
  return Number.isFinite(t) ? t : NONE
}

/** 接口原样字符串 → 能显示的样子；0000-00-00 这类占位返回空串。 */
export function kbTimeText(s) {
  const ms = parseKbTime(s)
  return ms ? String(s).trim() : ''
}

const MIN = 60000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

/** 距离现在多久：刚刚 / 12 分钟前 / 3 小时前 / 5 天前。0 或未来 → 空串。 */
export function ago(ms, now = Date.now()) {
  const n = Number(ms) || 0
  if (!n) return ''
  const d = now - n
  if (d < 0) return '刚刚'
  if (d < MIN) return '刚刚'
  if (d < HOUR) return Math.floor(d / MIN) + ' 分钟前'
  if (d < DAY) return Math.floor(d / HOUR) + ' 小时前'
  if (d < 30 * DAY) return Math.floor(d / DAY) + ' 天前'
  return new Date(n).toLocaleDateString('sv-SE')
}

/** 「3 小时前（2026-11-13 09:12）」这种给人看的一行；没有时间就返回空串。 */
export function timeLine(label, ms, now = Date.now()) {
  const n = Number(ms) || 0
  if (!n) return label + '：—'
  const rel = ago(n, now)
  const abs = new Date(n).toLocaleString('sv-SE').slice(0, 16)
  return label + '：' + (rel === abs ? abs : rel + '（' + abs + '）')
}
