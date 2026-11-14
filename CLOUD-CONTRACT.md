# 快爆Pro账号 · 多端同步契约（v2，冻结）

> v1 的「整份快照 push/pull」已被 v2 取代：用户要求**自动双向同步 + 主备租约 + 手机扫码登录**。
> 决策记录：① 只同步配置/人设/凭据，另加已读去重与当日额度（租约要求）；② 允许改 nanhua-api，纯新增端点 + `nh_` 集合；③ 只有快爆上云（含凭据），AI Key / 中转站密钥永不上云；④ 扫码 = 手机相机扫 → 云函数伺服的确认页；⑤ 双向自动，字段级后写覆盖，每 10s；⑥ 租约 90s / 心跳 30s。

## 0. 面向用户的承诺（验收口径）

- 两台机器同登一个「快爆Pro账号」：A 改任意设置项，B 在 ≤15s 内自动跟随；B 改也一样。
- 两台都开着：只有一台真正跑（回帖 / 刷帖），另一台界面显示「待命 · 主设备在跑」；主设备 90s 内不再心跳，备机自动接管并开跑。
- 登录支持：用户名+密码，或手机扫插件显示的二维码 → 手机浏览器打开确认页 → 登录后点确认 → 插件自动登录。

## 1. 云侧（`3839lsp模块/backend/functions/nanhua-api/index.js`）

基址 `https://nanhua-7gd6q2h3cb2db2cb.service.tcloudbase.com/nanhua-api`，lastSegment 路由，令牌沿用 `makeToken/verifyToken`。

### 1.1 字段级 KV（`nh_plugin_state`，每 username 一条）

```
GET  /plugin/state?since=<ms>      (Bearer) → {ok:true, now:<ms>, kv:[ {p, v, t} ]}
    · 只回 t > since 的键；since=0（或缺省）回全部
POST /plugin/state                 (Bearer) {kv:[ {p, v, t} ]} → {ok:true, now:<ms>, applied:<n>}
    · 逐键合并：库里没有该键，或 t > 库里 t → 覆盖；否则忽略（不报错）
    · 合并后整份 kv 的 JSON 长度 >512KB → 400「数据过大」；kv 缺失/不可解析 → 400「参数不合法」
    · p 是 §2 的路径字符串（带点），但**存成条目数组**：CloudBase NoSQL 会把带点的字段名
      展开成嵌套对象（{"cfg.a.b": …} → {cfg:{a:{b:…}}}），所以路径绝不能当文档字段名用
```

```
nh_plugin_state(username, schema_version, kv:[{p,v,t}], lease_owner, lease_device, lease_name, lease_until, updated_at)
    · 租约存成**顶层标量** lease_* 而不是嵌套对象：NoSQL 适配器会把嵌套对象展开成 $set 点路径，
      旧值恰为 null 时 "lease.device" 会写失败（Cannot create field 'device' in element {lease: null}）
```

### 1.2 主备租约（同一文档的 `lease` 字段）

```
POST /plugin/lease (Bearer) {action:'claim'|'renew'|'release', deviceId, deviceName} 
  → {ok:true, mine:bool, holder:{deviceId, deviceName, until}|null, ttl:90000}
  · claim/renew 成功条件：无 lease / until 已过期 / holder.deviceId === deviceId
  · 成功 → lease={owner:<username>, device:deviceId, deviceName, until: now+90000}
  · release：holder 是自己 → 清空 lease，返回 mine:false
  · 抢不到时 mine:false，holder 原样回传（界面显示「另一台在跑」）
```

### 1.3 扫码登录（`nh_plugin_codes`）

```
POST /plugin/qr/start              (无鉴权) {deviceName} → {ok:true, code, expiresAt, url}
    · code = 32 位 hex，单次有效，TTL 300s；url = <基址>/plugin/link?code=<code>
GET  /plugin/qr/poll?code=<code>   (无鉴权) → {ok:true, status:'waiting'|'ok'|'expired'|'invalid', token?, username?}
    · status=ok 时回 token（沿用 makeToken(username)），并把该 code 标记已用（再次轮询回 expired/invalid）
GET  /plugin/link?code=<code>      (无鉴权) → HTML 确认页：说明 + 账号/密码输入 + 确认按钮 → POST /plugin/qr/confirm
POST /plugin/qr/confirm            (无鉴权) {code, username, password} → {ok:true} / {ok:false, error}
    · 校验账号密码（同 /login 的 hash 校验）；已封禁账号直接拒绝
```

## 2. 字段路径表（载荷路径 ↔ 本地文件）

| path | 本地 | 形态 |
|---|---|---|
| `cfg.<dotted>` | `~/.dsh/hykb-scroll.config.json` 的叶子（数组整体一个值，对象递归到叶子） | 任意 JSON |
| `persona.<id>.meta` | `config.profiles.personas[i]` 的 label/name/ownerTitle/style | 对象 |
| `persona.<id>.notes` | `~/.hykb-ai/personas/<id>.md` | 字符串 |
| `acct.<uid>.meta` | `config.profiles.accounts[i]` 的 label/lastPersona | 对象 |
| `acct.<uid>.cred` | `~/.hykb-ai/accounts/<uid>/credentials.json` | 对象（含 Pauth） |
| `meta.ptr` | `~/.hykb-ai/active-account` + `config.profiles.activePersona` | `{account,persona}` |
| `seen.<uid>` | `accounts/<uid>/seen.json` | 整份 blob |
| `ledger.<uid>` | `accounts/<uid>/traffic-ledger.json` | 整份 blob |

**永不进同步**：`ai-key`、`judge-key`、`relay-keys.json`、`maskword-key`、`said.jsonl`、`browsed.jsonl`、`fans.json`、`posts.json`、`audit.jsonl`、`activity.jsonl`、`~/.dsh/hykb-work/*`。
`seen`/`ledger` 用整份 blob 的理由：租约保证同一时刻只有一个写者，standby 只会读，所以文件级后写覆盖即正确。

## 3. 插件服务端（`dsh-hykb-scroll/lib/index.js` + `tools/lib/cloud.mjs`）

本地 API：

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/dsh-hykb/api/cloud` | — | `{ok:true, account, sync:{lastSyncAt, lastPushAt, lastPullAt, pending, error}, lease:{mine, holderName, until}, cloud:{baseUrl, schemaVersion}}` |
| POST | `/dsh-hykb/api/cloud/auth` | `{action:'login'\|'register', username, password}` | `{ok:true, account}` |
| POST | `/dsh-hykb/api/cloud/logout` | `{}` | `{ok:true, account}`（登出同时 release 租约、停同步） |
| POST | `/dsh-hykb/api/cloud/qr/start` | `{}` | `{ok:true, code, expiresAt, url, qrDataUrl}`（`qrcode` 包现成依赖，服务端生成 PNG data URL） |
| POST | `/dsh-hykb/api/cloud/qr/poll` | `{code}` | `{ok:true, status, account?}`（ok 时服务端已落令牌） |
| POST | `/dsh-hykb/api/cloud/sync` | `{direction:'push'\|'pull'}` | `{ok:true, summary}`（手动立即同步，仍保留） |

后台循环（**浏览器关掉也照跑**）：
- 同步：每 10s reconcile 一次 —— 本地快照 diff → POST 变更；GET `?since` → 应用远端 → 前进 since。写盘后刷新 baseline 防回环。
- 租约：每 30s claim/renew；拿到租约才允许 sched（回帖监听 / 刷帖时钟）运行；失去租约 → 先 stop 再待命，运行日志记一条切换。
- 备机手动操作（`/dsh-hykb/api/listen`、`/browse` 的 run、`/followback` 的 run）一律拒绝：`{ok:false, error:'这台在待命，主设备正在跑（切主备请等 90s）'}`。

## 4. 客户端（`dsh-hykb-scroll/lib/client.js`）

账号条（整页第一块）：
- 未登录：左列 **登录快爆Pro账号** / 优势文案（云端同步：设置、人设、AI 线路与快爆登录态，换台电脑登录一次就全回来）/ 小字 **此账号与快爆官方无关**；右列 **[注册]** **[登录]**。
- 打开面板后两种方式并列成 tab：**密码登录/注册** 与 **手机扫码登录**（扫码页展示二维码 + 倒计时 + 「等待手机确认…」）。
- 已登录：左列用户名 + 两个 pill（同步状态：同步中/刚刚同步/N 分钟前/失败；主备：**主机 · 本机在跑** / **待命 · 另一台在跑**）；右列 **[立即同步]** **[退出登录]**。
- 视觉只用 `--dsw-alias-*` 与既有刻度（`tests/ui-tokens.test.mjs` 白名单内）。
## 5. v3 追加：主机 / 副机（用户手动指定优先跑的那台）

**目标**：用户能明确指定哪台优先跑；主机没断时副机只待命；主机断了（90s 租约过期）副机接管。

- 设备身份：`~/.hykb-ai/plugin-device.json` = `{ id, name, role }`，`role` ∈ `"primary"`（主机）/ `"secondary"`（副机），默认 `primary`（等于今天的行为）。
- `POST /plugin/lease` 增参 `role`，云侧把 `lease_role` 一起存；响应 `holder` 增加 `role` 字段。
- 抢占规则（云侧）：
  1. 无有效租约 / 已过期 → 谁抢到算谁的；
  2. 持有者是本机 → 续租；
  3. 持有者是别人：**请求方 role=primary 且持有者 role≠primary → 抢占**（对方下次心跳转待命）；否则拒绝并回传 holder。
  4. 两台都是 primary → 不互相抢占，先到先得（避免来回抢）。
- 本地新增 **`POST /dsh-hykb/api/cloud/role`** `{role}` → 存本地设备角色 + 立刻心跳一次（抢占即时生效）→ 回 `{ok:true, account, sync, lease, device}`。
- `GET /dsh-hykb/api/cloud` 增字段 `device: {id, name, role}`。
- 客户端：账号条（已登录）加一行「本机角色」二选一（主机 / 副机），切换即调 `/cloud/role`；状态 pill 文案：`主机 · 本机在跑` / `主机 · 等另一台停下`（本机是 primary 但被占）/ `待命 · 主机在跑（<名字>）` / `待命 · 副机在跑（<名字>）`。
