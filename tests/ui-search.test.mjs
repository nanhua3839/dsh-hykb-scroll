/**
 * 设置项搜索（纯函数）单测 —— 不依赖 DOM，也不依赖浏览器。
 *
 * client.js 把 matchFields 挂到 exports 上就是为了这里：喂真实的 FIELDS，
 * 验「匹配范围 = 名称 + 说明 + 所属卡标题」「中文子串 / 英文不分大小写」
 * 「空输入不出结果」「最多 3 条」这几条界面看不见的规则。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLIENT = path.join(HERE, '..', 'lib', 'client.js')

/** 假 react：只要能加载模块即可，这里一个组件都不展开 —— 匹配是纯函数 */
function makeReact() {
  const React = {
    createElement: () => null,
    useState: (init) => [init, () => {}],
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useEffect: () => {},
    useRef: (v) => ({ current: v }),
  }
  return React
}

/** 加载 client.js 拿 exports（window.__ModuleLoader__ 那层壳是唯一的外部依赖） */
async function loadClient() {
  const src = fs.readFileSync(CLIENT, 'utf8')
  const React = makeReact()
  let factory = null
  const sandbox = {
    window: { __ModuleLoader__: { load: ({ factory: f }) => { factory = f } } },
    document: { querySelector: () => null, createElement: () => ({ setAttribute() {}, textContent: '' }), head: { appendChild() {} } },
  }
  const fn = new Function('window', 'document', src)
  fn(sandbox.window, sandbox.document)
  assert.ok(factory, 'client.js 没有调用 window.__ModuleLoader__.load')
  const mod = factory((name) => {
    if (name !== 'react') throw new Error('未知依赖：' + name)
    return React
  })
  return mod
}

const { matchFields, FIELDS, CARD_OF } = await loadClient()

const keys = (rows) => rows.map((r) => r.key)
const labels = (rows) => rows.map((r) => r.label)

test('matchFields / FIELDS 都从 client.js 导出', () => {
  assert.equal(typeof matchFields, 'function')
  assert.ok(Array.isArray(FIELDS) && FIELDS.length > 0)
  assert.equal(typeof CARD_OF, 'object')
})

test('空输入不出结果（含纯空白）', () => {
  assert.deepEqual(matchFields(FIELDS, ''), [])
  assert.deepEqual(matchFields(FIELDS, '   '), [])
  assert.deepEqual(matchFields(FIELDS, '\n\t'), [])
  assert.deepEqual(matchFields(FIELDS, null), [])
  assert.deepEqual(matchFields(FIELDS, undefined), [])
})

test('最多 3 条，每条都带「设置项名 + 所属卡片名」', () => {
  const rows = matchFields(FIELDS, '赞')
  assert.equal(rows.length, 3, '「赞」应该正好出 3 条（截图那张就是这个状态）')
  for (const r of rows) {
    assert.ok(r.label && typeof r.label === 'string', '缺设置项名')
    assert.ok(r.card && typeof r.card === 'string', '缺卡片名')
    assert.ok(r.field && r.field.path, '缺字段引用（点结果要靠它定位）')
    assert.equal(r.key, r.field.path.join('.'))
    assert.equal(r.card, CARD_OF[r.field.sec])
  }
  // 显式上限也要尊重
  assert.equal(matchFields(FIELDS, '赞', 1).length, 1)
  assert.ok(matchFields(FIELDS, '赞', 5).length <= 5)
})

test('中文按子串匹配，能命中说明文字（不只是名称）', () => {
  const rows = matchFields(FIELDS, '楼中楼', 20)
  assert.ok(keys(rows).includes('listen.replies.onComment'), '「楼中楼」应该命中 listen.replies.onComment 的说明')
  // 「浏览过」只出现在 like.browsed 的名称里
  assert.deepEqual(keys(matchFields(FIELDS, '浏览过', 20)), ['like.browsed'])
  // 说明里的短语同样能搜到
  assert.ok(keys(matchFields(FIELDS, '热评', 20)).includes('like.hotCommentsPerTopic'))
})

test('英文不分大小写（大小写两种写法的结果完全一致）', () => {
  const lower = keys(matchFields(FIELDS, 'openai', 10))
  const upper = keys(matchFields(FIELDS, 'OpenAI', 10))
  const mixed = keys(matchFields(FIELDS, 'OpenAi', 10))
  assert.ok(lower.length > 0, '「openai」应该有命中')
  assert.deepEqual(upper, lower)
  assert.deepEqual(mixed, lower)
  assert.ok(lower.includes('ai.baseUrl'), 'OpenAI 兼容那句说明在 ai.baseUrl 的 hint 里')
})

test('卡片名也参与匹配：按卡片搜能一次搜到这张卡的设置项', () => {
  const rows = matchFields(FIELDS, '安全阀', 50)
  assert.ok(rows.some((r) => r.field.sec === 'risk'), '「安全阀」应该命中安全阀卡里的字段')
  assert.ok(rows.filter((r) => r.field.sec === 'risk').every((r) => r.card === '安全阀'))
  // 别的卡在说明里引用了「安全阀」也算命中：搜到了一句提到它的说明，这是有意的
  assert.ok(rows.some((r) => r.field.sec !== 'risk'), '说明里提到安全阀的字段也该被搜到')

  const like = matchFields(FIELDS, '自动点赞', 50)
  assert.ok(like.some((r) => r.field.sec === 'like'), '「自动点赞」应该命中这张卡里的字段')
  assert.ok(like.filter((r) => r.field.sec === 'like').every((r) => r.card === '自动点赞'))
})

test('无匹配时返回空数组，不抛错', () => {
  assert.deepEqual(matchFields(FIELDS, '这句话一定不在任何设置项里'), [])
})

test('结果不重复，且是纯函数（同样输入同样输出）', () => {
  const a = matchFields(FIELDS, '刷')
  const b = matchFields(FIELDS, '刷')
  assert.deepEqual(keys(a), keys(b))
  assert.equal(new Set(keys(a)).size, keys(a).length, '同一条设置项不该出现两次')
  // 前后空白不该改变结果
  assert.deepEqual(keys(matchFields(FIELDS, '  刷  ')), keys(a))
})

test('自动点赞 / 表情的新字段全部进了 FIELDS（否则搜索搜不到）', () => {
  const wanted = [
    'like.browsed', 'like.quality', 'like.replies', 'like.perRoundMax',
    'like.qualityJudge', 'like.qualityMinScore', 'like.aiConfirmMax', 'like.hotCommentsPerTopic',
  ]
  const inFields = new Set(keys(FIELDS.map((f) => ({ key: f.path.join('.'), field: f }))))
  for (const k of wanted) assert.ok(inFields.has(k), 'FIELDS 里缺少：' + k)
  // 每一条都能被自己的名字搜到
  const byName = FIELDS.filter((f) => wanted.includes(f.path.join('.')))
  for (const f of byName) {
    assert.ok(keys(matchFields(FIELDS, f.label, 20)).includes(f.path.join('.')), '搜不到自己的名称：' + f.label)
  }
  // 优质判定是二选一，两个选项都得有
  const judge = FIELDS.find((f) => f.path.join('.') === 'like.qualityJudge')
  assert.equal(judge.kind, 'seg')
  assert.deepEqual(judge.opts.map((o) => o.key), ['score', 'ai'])
  assert.deepEqual(judge.opts.map((o) => o.t), ['本地打分', 'AI 逐条判'])
})

test('没有自造总开关字段（自动点赞只能逐类打开）', () => {
  const likeKeys = FIELDS.filter((f) => f.sec === 'like').map((f) => f.path.join('.'))
  for (const bogus of ['like.enabled', 'like.on', 'like.auto']) {
    assert.ok(!likeKeys.includes(bogus), '不该存在总开关字段：' + bogus)
  }
})

test('表情没有任何开关：楼中楼带表情是默认能力', () => {
  // 用户要求去掉「楼中楼也能带表情」这个前端开关，改为默认开启，所以 emoji 一个字段都不该有
  const emojiKeys = FIELDS.filter((x) => x.sec === 'emoji').map((x) => x.path.join('.'))
  assert.deepEqual(emojiKeys, [], '表情不该再有开关字段')
})
