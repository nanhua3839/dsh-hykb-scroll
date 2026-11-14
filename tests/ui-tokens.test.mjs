
/**
 * 设计 token 守门测试。
 *
 * 用户的原话是「后出的功能往往与新出的功能不一致」——这类不一致几乎都不是故意的，
 * 是加新东西时随手写了个 12.5px / 6px。这里把当前这套刻度锁死：
 * 想加新的字号或圆角，必须先改这份清单，也就没法在无人察觉的情况下漂移。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const src = fs.readFileSync(path.join(HERE, '..', 'lib', 'client.js'), 'utf8')
const css = src.match(/const CSS = \[([\s\S]*?)\]\.join\(""\);/)[1]

/** 从 CSS 里取出某个属性的所有取值（去重） */
function values(prop) {
  const out = new Set()
  const re = new RegExp(prop + ':\\s*([^;"}]+)', 'g')
  let m
  while ((m = re.exec(css))) out.add(m[1].trim())
  return [...out]
}

/** 只比数值部分：1px 0 4px 8px 这种复合值也要能比对 */
const nums = (v) => (v.match(/-?\d+(?:\.\d+)?px|50%|999px/g) || [])

const RADIUS_OK = new Set(['0', '1px', '7px', '8px', '9px', '10px', '12px', '13px', '15px', '50%', '999px'])
const FONT_OK = new Set(['10px', '11px', '11.5px', '12px', '13px', '14px', '15px'])

test('圆角只用这套刻度：0 / 1 / 7 / 8 / 9 / 10 / 12 / 13 / 15 / 50% / 999px', () => {
  const bad = values('border-radius').filter((v) => !nums(v).every((n) => RADIUS_OK.has(n)))
  assert.deepEqual(bad, [], '出现了刻度外的圆角：' + bad.join('、'))
})

test('字号只用这套刻度：10 / 11 / 11.5 / 12 / 13 / 14 / 15', () => {
  const bad = values('font-size').filter((v) => !FONT_OK.has(v))
  assert.deepEqual(bad, [], '出现了刻度外的字号：' + bad.join('、'))
})

test('同一语义用同一档：列表项标题统一 13px/600', () => {
  for (const sel of ['.hks-accl-n', '.hks-mode>b', '.hks-relay-h>b', '.hks-region-h']) {
    const rules = css.split('\n').filter((l) => l.includes(sel + '{'))
    assert.ok(rules.length >= 1, '找不到规则：' + sel)
    assert.ok(rules.some((r) => /font-size:13px/.test(r)), sel + ' 的字号不是 13px')
  }
})

test('面板里的行按钮统一 7px 圆角', () => {
  for (const sel of ['.hks-res>button', '.hks-idmi', '.hks-pick-l>button', '.hks-seg>button']) {
    const rules = css.split('\n').filter((l) => l.includes(sel + '{'))
    assert.ok(rules.length >= 1, '找不到规则：' + sel)
    assert.ok(rules.some((r) => /border-radius:7px/.test(r)), sel + ' 的圆角不是 7px')
  }
})

test('边框只用三档 token + 状态色', () => {
  const bad = values('border').filter((v) => {
    if (v === 'none' || v === '0') return false
    if (/var\(--dsw-alias-(border-l2|border-l3|label-primary|state-warn-primary|state-error-primary)\)/.test(v)) return false
    // 放大镜图标那一圈是图不是框，字号/线宽跟着图标走
    if (v === '1.5px solid currentColor') return false
    return true
  })
  assert.deepEqual(bad, [], '出现了规范外的边框：' + bad.join('、'))
})
