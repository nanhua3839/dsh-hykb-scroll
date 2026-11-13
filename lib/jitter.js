/**
 * 扫描抖动：每次排下一轮时在 [间隔-抖动, 间隔+抖动] 之间取一个值。
 *
 * 为什么需要它：固定间隔扫几百轮，请求节奏是机器节奏（每分钟整点、误差 0 秒），
 * 平台的频控最容易认出来的就是这种节奏。抖一下不影响「大约每分钟一次」的语义。
 *
 * 约定：jitterSec = 0 → 返回原间隔（不抖）；抖出负数就压到下限，
 * 否则间隔变成负的 setTimeout 会立刻触发，等于疯狂扫描。
 */
const MIN_MS = 5000

export function withJitter(baseMs, jitterSec = 0) {
  const b = Math.max(0, Number(baseMs) || 0)
  const j = Math.max(0, Number(jitterSec) || 0) * 1000
  if (!j) return b
  const lo = Math.max(MIN_MS, b - j)
  const hi = Math.max(lo, b + j)
  return Math.round(lo + Math.random() * (hi - lo))
}
