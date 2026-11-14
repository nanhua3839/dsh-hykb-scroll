import test from 'node:test'
import assert from 'node:assert/strict'
import { commonToken, encryptBody, buildRequest, QUERY_WHITELIST } from '../tools/lib/app-sign.mjs'

// 向量由已验证的 Python 实现（_re/hykb_token.py、hykb_client.py）交叉产出
const KEYS = ['c', 'a', 'v', 'uid', 'page', 'vuid', 'n', 'ts', 'vc', 'params']
const VALS = ['kifansother2', 'home', '1536', '162319955', '1', '162319955', '7654321', '1700000000', '20260', '1']
const PLAIN = '{"page":"1","vuid":"162319955","isNightMode":"0","permission_storage":"1","n":"7654321","ts":"1700000000","vc":"20260","uid":"162319955","type":"0","t":"deadbeefdeadbeefdeadbeefdeadbeef"}'
const BODY_T0 = 'RmYSISwdzFQDbT/MrD+hgYNnG+l++NxtWqVHqRxhX2gWHyffSe2q86iRByNctjrcCj4Tq9214D/CJ1fSPJY4UikuZrgMDggi7ulYe+YQQLEUDO2Yy9FWv4jPG4XtbmKhTWv9QIL/YrpKT6oFk/jehEAW8eBeB2ZqeId1ib9PhVtH3txB9AKaSumPEPqYUWmrFgwLYH0oNLXuXEjpmf8bhdqDZuBh3RbMBKBUlv545czRnowfgHg0EF5pHmXU4SSt'
const BODY_T1 = '7CoTDRV1303J2eu+K8oCs0lTSxEpRhWhLKfEO+KsBHXEjC7Zg7Yj5sWw8dO+cuCnSWITZupAB4kUEAcjiqgbfqAl75hY/kvIpEjlI8x979nnxg71AG55uGyr5HtiFAnZMfy8jLnxhyNcvOFSxFbiNBeb9jph6z3UFu342/6AKu9Fcsesz/UsNC84gnOkn543JI8+BjLVgJTVB1Nu2FC1MUC1TGpm2mS3TEQRsLwbK3EWUJG4ZS3/8SCVfalETrpg'

test('commonToken 与 Python 实现逐字节一致', () => {
  assert.equal(commonToken(KEYS, VALS), '3a3a2daab769923704970fa349fb8149')
})

test('commonToken 只由 (keys,values) 决定，与顺序无关', () => {
  const a = commonToken(['b', 'a'], ['2', '1'])
  const b = commonToken(['a', 'b'], ['1', '2'])
  assert.equal(a, b)
  assert.equal(a, commonToken(['b', 'a'], ['2', '1']))
})

test('encryptBody type=0/1 与 Python 实现一致（零填充，非 PKCS#7）', () => {
  assert.equal(encryptBody(PLAIN, 0), BODY_T0)
  assert.equal(encryptBody(PLAIN, 1), BODY_T1)
})

test('buildRequest：白名单进 query，其余（含 t）进加密体', () => {
  const map = { v: '1536', c: 'kifansother2', a: 'home', uid: '162319955', page: '1', vuid: '162319955', n: '7654321', ts: '1700000000', vc: '20260', type: '0' }
  const r = buildRequest(map)
  assert.deepEqual(Object.keys(r.query).sort(), ['a', 'c', 'params_encryption', 'uid', 'v', 'vc'].sort())
  assert.equal(r.query.params_encryption, '1')
  assert.equal(r.bodyMap.page, '1')
  assert.equal(r.bodyMap.type, '0')
  assert.equal(r.bodyMap.t, r.token)
  assert.ok(!('t' in r.query))
  for (const k of Object.keys(r.query)) assert.ok(QUERY_WHITELIST.includes(k) || k === 'params_encryption')
  assert.ok(r.body.length > 0 && !r.body.includes('\n'))
})
