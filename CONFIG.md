# 配置说明 · dsh-hykb-scroll

这份文档只回答一件事：**哪些必须配、哪些不配也活着、哪些看起来能用其实什么都不做**。
所有结论都对着代码核过，括号里是源码位置。

---

## 0. 先回答两个最常被误解的问题

| 你的直觉 | 实际行为 | 依据 |
| --- | --- | --- |
| 「扫帖子」关掉 = 扫全部帖子 | **相反**：关掉 = 一条都不扫 | `tools/lib/watch.mjs` `collect()`：`(L.topic?.enabled ? L.topic.items : [])` |
| 「板块」清单清空 = 扫全部板块 | **相反**：清空 = 一个板块都不扫 | `collect()` 只在 `enabled` 为真时遍历 `items`，空数组 = 循环零次 |
| `@ 我` 范围留空 = 扫全站找 @ | **不是**：它不扩大范围，只是不加限制 | `evaluate()` 里的 `at.items` / `at.forums` 只做白名单，`collect()` 只把 `at.items` 当**追加的帖子**读 |
| 「@ 我通知」要配点什么才工作 | **不需要**：它默认就开着，什么都不填也能用 | `config.mjs` `DEFAULTS.listen.atme.enabled = true`，`watch.mjs` `collect()` 的 `L.atme?.enabled !== false` 分支 |
| 别人回我的评论 / 我的帖子，她会接话 | **会**（默认就开）：平台消息中心另有一个「回复我的」频道 | `DEFAULTS.listen.replies` + `watch.mjs` 的 `replies` 源（第 2.1 节） |
| 手打 `@昵称` 也算叫我 | **算，但要扫正文**：假 @ 不产生通知，只能轮转扫「我参与过的帖」 | `DEFAULTS.listen.scanMine` + `watch.mjs` 的 `mine` 源（第 2.2 节） |

一句话：**板块源和帖子源没有「全站扫描」这个能力，留空就是「不扫」；「@ 我通知」是例外 —— 它读的是平台自己的 @ 列表，本来就不需要范围。**

反过来，会自己出去找帖的是另一个模块 —— **自动刷论坛**（`browse`），它有一条「留空 = 六个默认公共讨论区」的兜底
（`tools/lib/daypool.mjs` `sectionsFor()`：`sections` 空 → 板块目录全部（按今日讨论量降序，最多 `coverage.maxSections`）→ 目录挂掉才退回 `defaultSections`）。

---

## 1. 配置项最小全集

**除了「@ 我通知」「回复我的」「假 @ 兜底」这三个免清单的源，别的都得配。** 让她回一条帖，下面 5 项必须同时成立，缺任何一项都是静默失败（日志里有原因，但不会有人告诉你）：

| # | 必须成立 | 缺了会怎样 | 谁给的 |
| --- | --- | --- | --- |
| 1 | 已登录：`credentials.json` 里有 `uid` + `Pauth` | `tick()` 在入口就返回，日志写「写权限缺失…本轮只登记不发送」，`stats.blocked='no-pauth'`（`watch.mjs:213-220`） | 设置页扫一次码；**不用手填**，扫码成功时宿主自动写 `self`（`lib/index.js:352`、`index.js:381`） |
| 2 | `listen.enabled = true` | 宿主调度器起不来；即使起来了 `tick()` 也会立刻自己停车（`lib/index.js:454-459`） | 设置页「自动回帖」开关，或模式卡「只回 @」 |
| 3 | 至少一个**能出候选**的源：`atme` 开着（默认开），或板块/帖子源里有非空清单 | `collect()` 返回 0 条候选，`stats.scanned=0`，什么都不发生 | 见第 2 节 |
| 4 | AI 三项齐全：`ai.baseUrl` + `ai.model` + `ai.apiKey` | 命中 @ 也发不出去：`ai.mjs:29-34` 直接 throw，`watch.mjs:288` 吞掉后 `continue`，日志一行 `[ai] AI 未配置…` | 设置页「接上 AI」 |
| 5 | 那一轮扫到的那条内容里，**确实 @ 了她** | `matchTrigger` 不命中 → `skip 'no-trigger'`（`watch.mjs` `evaluate()`） | 别人发的帖子/楼层/楼中楼；**`atme` 源不需要这一条**，平台的通知本身就是「有人 @ 了你」 |

另外两个容易漏的：

- **首次扫描只登记、不回复**。`seen.__primed` 为假时，第一轮把扫到的全部历史内容登记进去然后直接 return
  （`watch.mjs` `tick()` 的 `primed` 分支）。所以「刚开监听，帖子里明明有 @ 她，却没回」是设计如此 —— 要等**之后新出现**的内容。
  想重新走一遍登记（比如换了扫描范围），在 CLI 里跑 `node tools/hykb.mjs watch --reset`
  （`tools/hykb.mjs:187-188` 调 `resetPrimed()`；设置页没有这个按钮，对应接口是 `POST /dsh-hykb/api/watch` + `{action:'reset'}`，`lib/index.js:494`）。
- **宿主调度器要「在跑」**。`listen.enabled` 只是意愿，实际执行靠 `sched.running`；插件加载时若 `listen.enabled` 为真会自动启动
  （`lib/index.js` 插件加载处）。但点过「停止」之后 `running=false`，之后再改配置**不会**把它拉起来（`sched.invalidate()` 只在 `running` 时重排），
  必须再点一次「启动」。设置页那颗按钮就是这么来的：`/status` 的 `listen.running` 决定它显示「启动」还是「停止」
  （`lib/client.js` 的 `listenRunning` 与卡片④底部单按钮）。

---

## 2. 扫描范围到底怎么算（自动回帖的六个源）

六个源是**并联**的，各自独立，互不兜底：

| 源 | 开关字段 | 清单字段 | 关掉开关 | 开着但清单空 |
| --- | --- | --- | --- | --- |
| **@ 我通知** | `listen.atme.enabled`（默认 **true**） | 无 | 不去读消息中心，别人的 @ 全收不到 | 不适用 —— 它本来就不需要清单 |
| **回复我的** | `listen.replies.enabled`（默认 **true**）+ 三类各一开关 | 无 | 不读「回复我的」，别人回到你说的话下面也收不到 | 不适用 —— 也不需要清单 |
| 板块 | `listen.forum.enabled` | `listen.forum.items` | 不读任何板块 | **也不读任何板块**（循环零次） |
| 帖子 | `listen.topic.enabled` | `listen.topic.items` | 不读任何帖子 | **也不读任何帖子** |
| @ 的规矩 | `listen.at.enabled` | `listen.at.items` / `listen.at.forums` | 不追加帖子、且跳过 at 的白黑名单校验 | 不追加帖子（范围不扩大） |
| **假 @ 兜底** | `listen.scanMine.enabled`（默认 **true**） | 无（范围 = 我参与过的帖 + 上面两个源的清单） | 不扫正文，纯文本 @ 一条都收不到 | 不适用 |

`collect()` 的实际取数（`tools/lib/watch.mjs` 的 `collect()`）：

```
@我通知源：atme.enabled !== false
           → POST www.3839.com/app/hykb_web/api/api_user.php  (ac=message&mode=3)
           → 丢掉 del_status=1（已删）和 type!=202（发帖类 @，没有楼层可回）
           → 按 tid 去重后 slice(0, maxTopicsPerTick) 读帖，定位 rid 那层楼
回复我的源：replies.enabled !== false
           → POST 同一个端点 (ac=message&mode=1)
           → 按 type 分三类开关（101 回复你的帖子 / 102 回复你的回帖 / 103 回复你的回复）
           → 丢掉 del_status=1、没有 id 或 tid 的、超过 maxAgeMin 的
           → 候选直接用通知字段构造，**不额外读帖**（103 例外，见 2.2）
板块源：  for (item of forum.enabled ? forum.items : [])        → 每个板块扫第一页帖子
帖子源：  topics = (topic.enabled ? topic.items : []) ++ (at.enabled ? at.items : [])
          再 slice(0, maxTopicsPerTick)                         → 每个帖子读楼层 + 楼中楼
假@兜底源：scanMine.enabled !== false
           → 范围 = seen.json 里我碰过的帖 + posts.json 里点到过的帖
           → 按游标轮转，每轮读 scanMine.maxTopicsPerTick 个帖
           → 楼层 / 楼中楼里出现纯文本「@昵称」才算命中
```

**「@ 我通知」是唯一不用配就能工作的源**：它读的是平台消息中心里「@我的」那一页，平台已经替你筛好了「谁在哪一帖的哪一层 @ 了你」，
所以不需要板块 id、不需要帖子 id，也不需要正文里有字面的 `@昵称`（富文本 @ 是 `<kb-contact>` 标签）。

它的代价：通知列表只有**明细**，没有正文。所以每命中一个帖子还要多读一次帖（一次读 20 层），
受 `maxTopicsPerTick`（默认 6）限制 —— 一轮最多为通知读 6 个不同的帖。

`maxTopicsPerTick` 默认 6：帖子列了 20 个也**只读前 6 个**，日志会明说「本轮只读前 6 帖」。
所以想让第 7 个帖也被盯住，要么调大这个数，要么换成板块源。

### `at.items` 是个双面刃（重要）

它**既**是「额外要读的帖子」，**又**是「@ 只在哪些帖子里算数」的白名单：

```js
// watch.mjs 的 evaluate()：注意 !isNotice —— 通知源不受它约束
if (!isNotice && (L.at.items || []).length && !L.at.items.some((x) => String(x.id) === String(cand.topicId))) {
  return { action: 'skip', why: 'at-topic-not-allowed' }
}
```

也就是说：一旦你在「@ 的规矩 → 额外要看的帖子」里填了 A 帖，那么**板块源/帖子源扫到的其他帖子里的 @ 就全被过滤掉**。
想「再多盯一个帖子」应该填【帖子】源，不要填这里。「@ 的规矩」这个源的清单留空才是「不额外限制」。

`at.forums` 只做限制、不做扩大，UI 文案是「只在这些板块里应 @」。这两个清单都**不拦 @ 我通知**，
**也不拦「回复我的」与假 @ 兜底**（那两个源的范围由自己的开关定）：
通知本身已经是全站的 @，再拿清单收窄等于自己把消息扔掉。

### 2.1 「回复我的」：别人回到你说的话下面（`listen.replies.*`）

消息中心同一支接口还有第二个频道：**`mode=1`「回复我的」**。实测返回里三类混在一起，
每条都带 `tid`（帖）、`rid`、`to_rid`、`from_uid`、`from_nickname`、`from_info`（对方那句话的富文本），
所以**不用再读帖就能判、就能回**——只花一次通知列表的读额度，零 token。

| `type` | `msg_type` | 是什么意思 | 开关 | 默认 |
| --- | --- | --- | --- | --- |
| 101 | 回复你的帖子 | 别人在你的帖里发了一层新楼（不一定在跟你说话） | `listen.replies.onPost` | **关** |
| 102 | 回复你的回帖 | 别人新发一层楼、指的是你那一层 | `listen.replies.onFloor` | 开 |
| 103 | 回复你的回复 | 别人在楼中楼里回到你的评论下面 | `listen.replies.onComment` | 开 |

- 总开关 `listen.replies.enabled`（默认开）；**未知 type 一律不接** —— 平台以后加频道不该自动开口。
- `listen.replies.maxAgeMin`（默认 720 分钟 = 12 小时）：通知里的时间是「11小时前」或「11-07」两种写法，都认；
  解析不了的**放行**（宁可多回一条，也不静默丢）。
- 落点：102 → `replyOperate({replyId: rid})`，回在对方那层楼下面（实测 `rid` 是楼层 id，
  `to_rid` 是评论 id，别拿它当楼层用）；101 → 主楼回复（`replyId=0`）。
- 103 是唯一要**多读一次帖**的一类：回进楼中楼需要「板块号 + 楼层号 + 评论 id」，通知里三样都没有，
  所以按 `tid` 读一次 `topicDetail`（同一轮同一帖只读一次，读失败也缓存、不重试），拿 `reply[].sid` 当板块号、
  用「对方 uid + 正文前 20 字」在楼层评论里定位那条评论 → 命中就 `commentOperate` 回进楼中楼。
  ⚠️ **定位不到就退回主楼回复 + 正文纯文本 @对方**（`@昵称 …`）。这条退路不是偷懒：
  楼中楼详情接口 `getCommentList` 实测 403，而楼中楼翻页参数本就无效（一次只回前 3 条），
  所以**第一页里没有对方那条评论时，没有第二条路可走**。真实通知里这类情况不少，日志会明写
  `103 → 主楼 @X`。
- 去重键是 `n:<type>:<通知id>`。**它不落进 `t:/f:/c:` 前缀**，所以 `forgetTopics`/
  `watch --reset` 清「某帖记录」时不会把这些通知记录一起清掉。
- 首次启用会**只登记不回**（`seen.__repliedPrimed`），避免升级那一轮冲着一片旧回复刷屏。

### 2.2 假 @：纯文本 `@昵称` 只能靠扫正文（`listen.scanMine.*`）

平台只为**富文本真 @**（`<kb-contact>`）写通知，手打的 `@昵称` **不产生任何通知** ——
所以 @ 我通知与回复我的这两个源都收不到它，只能去帖子正文里找。
`listen.scanMine.enabled`（默认开）就是干这个的：

- 范围 = `seen.json` 里出现过的帖（`t:/f:/c:` 键的第二段）+ `posts.json` 里点到过的帖；
  这两份台账读不到就当没有，不抛错。
- 每轮按游标轮转读 `listen.scanMine.maxTopicsPerTick` 个（默认 2，上限 10）。
  台账实测几百个帖，轮一轮要几小时 —— **它是兜底，不是实时通道**。
- 只扫每个帖的**第一页**楼层与楼中楼（20 层）；深夜的大水帖后半截扫不到。
- 命中判据仍是 `trigger.mjs` 那套（所以 `triggerMode=rich` 时它也会瞎），**只花读额度，不花 token**。

> 一句话：想第一时间接住「别人回我」，靠的是 2.1 的推送式通知；
> 想连「手打 @」都接住，才需要 2.2 的扫正文，代价是慢和读额度。

---

## 3. 「什么都不配、只靠别人 @ 就回」—— 能做到，走 @ 我通知

这是你最想要的用法，现在**成立**：`listen.atme.enabled` 默认就是 `true`，
加上「登录 + 打开自动回帖 + AI 三项」（第 1 节的 1/2/4），她就只靠别人 @ 也能回，**不需要填任何板块 id 或帖子 id**。

⭐ 2026-11 起，「零配置就能干活」的源有三个：**@ 我通知**（2）、**回复我的**（2.1）、**假 @ 兜底**（2.2）。
三者默认都开，所以「什么都没填却有人说她不回」这类问题，先看第 8 节的闸门表，而不是先怀疑清单没填。

它读到的是平台消息中心的「@我的」列表：

| 项 | 值 |
| --- | --- |
| 端点 | `POST https://www.3839.com/app/hykb_web/api/api_user.php` |
| 请求体 | `ac=message&mode=3&last_id=&cursor=`（`mode=3` 就是「@我的」那一页） |
| 必须的头 | 完整 cookie（`uid` + `Pauth` + `Uauth` + `nickname`）+ `x-requested-with: XMLHttpRequest` + `referer: https://www.3839.com/zone/msg` + `origin: https://www.3839.com` |
| 返回 | `{code:100, result:{last_id, cursor, data:[…]}}`，每条含 `tid`（帖）、`rid`（楼层）、`from_uid`/`from_nickname`（谁）、`to_info`（命中正文）、`del_status` |
| 签名 | **无**。前端 axios 拦截器是直通（`function L(t){return t}`），qs 序列化，无 sign、无时间戳 |

少了 `referer`/`origin` 或改成 GET，服务端会回 `{"code":0,"msg":"出错啦~"}` —— 这是最容易踩的一个坑。

### 处理链路（`watch.mjs` 的 `collect()` → `evaluate()` → `tick()`）

1. 拉 mode=3 通知列表；
2. 丢掉 `del_status=1`（内容已删，没正文也没楼层）和 `type!=202`（`type=200` 是「在帖子中@了你」，只有 `tid` 没有 `rid`，回法不同，当前不处理）；
3. 按 `tid` 去重，最多 `maxTopicsPerTick`（默认 6）个帖，各读一次 `m.bbs.3839.com/wap.php?m=topic&ac=detail`（即 `topicDetail()`），从 `result.reply` 里找到 `id === rid` 的那层楼；
4. 楼层不在第一页时，正文用通知里的 `to_info` 兜底 —— `commentOperate` 只认 `replyId`，照样能回；
5. 判定时**跳过触发词匹配**：平台的通知本身就是「有人 @ 了你」，再拿正文匹配一遍反而会被 `triggerMode='plain'` 挡掉（富文本 @ 是标签，不是字面 `@昵称`）；
6. 发送走 `commentOperate({fid: topic.sid, replyId: rid, commentId: 0, content})`。

### 它做不到什么（别误会）

- **回不了「帖子正文里的 @」**：`type=200` 那类（在主楼 @ 你）没有 `rid`，要回就得跟主楼走另一条发送路径，当前没做。
- **已经删掉的 @ 收不到**：`del_status=1` 全跳过。
- **通知有延迟**：平台侧什么时候写进列表由它定，不是实时；一轮扫描拿的是「此刻列表里的」。
- **没有「标记已读」可用**：找不到已读接口，所以去重完全靠本地 `seen.json`（键是 `f:<帖id>:<楼层id>`）。
  清掉 `seen.json` 或跑 `node tools/hykb.mjs watch --reset` 会让老 @ 重新算「没回过」。
- **它不替代板块/帖子源**：那两个是「主动去看」，通知源是「等你叫她」。想要她既接 @ 又主动刷，两边都开。

---

## 4. 最小可用配置（照抄就能跑）

### 4a. 只靠别人 @ 就回（什么都不用填）

设置页 **设置 → 刷快爆**，只做三件事：

1. **① 登录账号** —— 扫码。扫完 `self.uid` / `self.name` 自动写好，不用手填。
2. **② 接上 AI** —— 填接口地址、模型、密钥。三项缺一项都发不出话。
3. **④ 自动回帖** —— 打开右上角开关（也可以点模式卡「只回 @」），然后点卡片底部 **启动**。

就这样。**不用填板块 id，也不用填帖子 id** —— 卡片④的源页签默认停在「@ 我通知」，那里没有可填的东西，它自己就在工作。

配置文件里只多这一行（其实默认就是 true，不写也一样）：

```jsonc
{
  "self":   { "uid": "162319955", "name": "nanhua的大肥鱼" },  // 扫码后自动写
  "ai":     { "baseUrl": "https://api.deepseek.com/v1", "model": "deepseek-chat" },  // 密钥在 ~/.hykb-ai/ai-key
  "listen": { "enabled": true, "atme": { "enabled": true } }
}
```

### 4b. 再加上「主动去某个帖 / 某个板块里接 @」

在 4a 基础上多做一步：

- 【帖子】页签 → 打开开关 → 贴 1–3 个帖子 id（或直接粘链接）；
  或【板块】页签 → 打开开关 → 填板块 id（可以先点「查板块 ID」）。

```jsonc
{
  "listen": {
    "enabled": true,
    "atme":  { "enabled": true },
    "topic": { "enabled": true, "items": [{ "id": "9251547", "title": "" }], "floors": true, "comments": true }
  }
}
```

等一个扫描周期（默认 60 秒）。**第一轮只登记不回**：第一次跑会把当前能扫到的全部内容记成「已看过」，
所以刚开的那一分钟里出现的 @ 不会回，之后新出现的才会。

---

## 4c. 三个时间、浏览记录、抖动、游戏评价

| 东西 | 怎么算 | 开关/位置 |
| --- | --- | --- |
| 发布时间 | 帖子的 `time`（`YYYY-MM-DD HH:MM:SS`，不是时间戳） | 一直有，浏览记录里显示成「12 分钟前（2026-11-13 19:44）」 |
| 修改时间 | `edit_time`，没改过是 `0000-00-00 00:00:00`（当「无」） | 同上 |
| 最近回复时间 | `reply_time` | 同上 |
| 浏览记录 | 每帖一行：动作（已回复/写进日报/跳过）+ 原因 + 三个时间；同帖同日同动作只记一次，最多 5000 行 | `~/.hykb-ai/browsed.jsonl`，设置页「浏览记录」卡片可看最近 100 条、可清空；CLI `hykb.mjs history` |
| 扫描抖动 | `listen.jitterSec`（默认 3 秒）/ `browse.jitterSec`（默认 60 秒），实际间隔 = 间隔 ± 抖动，0 = 不抖 | 卡片④「扫描抖动（±秒）」/ 卡片⑤「刷帖抖动（±秒）」 |
| 游戏评价观察 | 挑几个游戏 → 读玩家评价 → 压成日报里的一段。**只读**，不发评价 | `games.*`，卡片⑤下半截；CLI `hykb.mjs games` |

**为什么游戏评价只读**：写评价走 `www.3839.com/app/comment.php?ac=comment_add`，平台对「刷好评迹象」有礼仪考试闸，
撞上会被要求先考试、内容不发。脚本替人打分既没有意义，也不该拿她的号去冒这个。

---

## 5. 想让她「自己过日子」：那是另一个模块

| 你想要的 | 该开的 | 默认值 |
| --- | --- | --- |
| 自己出去翻板块、给帖子打分、写日报 | `browse.enabled`（卡片 ⑤ 自动刷论坛） | 关 |
| 日报写几帖 / 深读几帖 | `browse.pick` / `browse.deep` | 8 / 8 |
| 候选池覆盖哪些板块 | `browse.sections`（`["23064", …]` 或 `[{id,title}, …]`），**留空 = 板块目录里全部公共板块**（约 49 个，按今日讨论量降序，最多 `browse.coverage.maxSections`=60 个）；填了 = 只读这些 | 空 |
| 每轮最多发几个列表请求 | `browse.coverage.crawlMaxRequests`（读预算 600/小时，留额度给深读） | 140 |
| 四维权重 | `browse.weights` = `{heat, discussion, quality, freshness}`（热度/讨论度/质量/活跃度，和为 1） | .30/.35/.22/.13 |
| 代表性配额 | `browse.perSectionMax`(2) / `perAuthorMax`(1) / `perAuthorMaxOfficial`(3) / `officialMax`(3) | 见左 |
| 零信号下限 | `browse.lowSignal` = `{minViews:30, minContent:50}`：0 回复 0 赞且低于这个门槛的帖不进日报 | 见左 |
| 把日报发成帖子 | `post.enabled` + `post.section`（`{id,title}`，不选不发）+ `post.maxPerDay`(1) + `post.minPicks`(3) | 关 |
| 文末原帖链接 | `post.links` | 开 |
| 回复前先想的规则 / 末尾固定加一句 | `prompt.rules` / `prompt.suffix`（≤60 字，单行） | 空 |
| 刷完在她自己的会话里说话 | `browse.wake` | 开 |
| 顺手回高分帖 | `browse.autoReply` + `replyMinScore`(70，0–100 分制) + `replyMax`(3) | 关 |
| 个性化题材（硬加权） | `browse.interests` = `{tags:[], custom:[], weight:10}`（见 5.1） | 空 / 10 |

`browse` 与 `listen` **完全独立**：两边的开关、间隔、时间窗各管各的，一个关着不影响另一个。
模式卡（只回 @ / 两个都要 / 只刷不发 / 先关着）只是同时改这两个布尔，不是第三套逻辑（`lib/client.js:858-861`）。

### 5.1 个性化题材 `browse.interests`（宿主侧硬加权）

设置页是一排可点的标签 + 一个自定义输入框。它只影响**刷帖挑什么**，与监听/回复完全无关。

| 字段 | 作用 | 默认 |
| --- | --- | --- |
| `browse.interests.tags` | 点选的内置题材，只认这份清单：游戏 / 生活日常 / 数码 / 影视动漫 / 福利 / 社区活动（`lib/index.js` 归一化时会把别的值丢掉） | 空 |
| `browse.interests.custom` | 自己填的题材，逗号分隔，与上面合并去重（大小写不敏感） | 空 |
| `browse.interests.weight` | 加减分幅度，0–30 | 10 |

计算方式（`tools/lib/rank.mjs` 的 `scorePool()`）：

1. 先照旧算四维（热度 / 讨论度 / 质量 / 活跃度）→ 池内分位数 → 加权成 0–100；
2. **之后**才加题材：命中 N 个题材 `+N×weight`，一个都不命中 `-weight`，最后 clamp 回 0–100；
3. 命中判据 = 题材文本出现在**标题 / 正文 / 板块名**里（正文先剥 HTML 标签，避免 `class="demo"` 这类属性值误判）。
   中文没有词边界，所以用子串包含，不分词。

两个必须记住的性质：

- **标签空、或者 `weight<=0` ⇒ 完全回退**：分值与没这个功能时**逐帖相等**，连 `interestHits` 字段都不产生
  （`tests/rank-tags.test.mjs` 用独立重算的旧公式逐帖断言，不是"大概相等"）。
- **`weight=0` 而标签非空 = 纯软偏好档**：不打分，但日报提示词里照样点一句「他常年偏好的题材：…」。
  想彻底关掉就把题材清空。

日报提示词那一行同时落在 `ai.mjs` 的 `digestPrompt()` 与**真正在跑的** `ground.mjs` 的 `digestProsePrompt()`
（现行主流程走后者）；空标签时两处的消息数组与改动前逐元素相同。

刷帖落盘：`~/.dsh/hykb-work/digest-<YYYY-MM-DD>.md`，同一天多轮是**追加**。

---

## 6. @ 到底怎么算

先说一句能省掉一半困惑的话：**这一节只对「扫正文」的源生效 —— 板块源 / 帖子源 / 假 @ 兜底源。**
「@ 我通知」与「回复我的」这两个源不参与这个判定 —— 它们本身就是平台推来的「有人找你了」，
再拿正文匹配一遍只会把它挡掉（富文本 @ 是 `<kb-contact>` 标签，不是字面 `@昵称`）。
换句话说：**`triggerMode` 设成 `rich`，假 @ 兜底也会一起瞎掉。**

平台有两种 @，行为完全不同（`tools/lib/trigger.mjs`）：

| 写法 | 形态 | 平台校验 | 触发判定 |
| --- | --- | --- | --- |
| 真 @（富文本） | `<kb-contact data-id="你的uid">昵称</kb-contact>` | **要求互相关注**，非好友整条被拒 `code:8112` | `hasRichTag()` 认 uid |
| 文字 @ | 正文里就是 `@昵称` 这几个字 | 不校验，任何号都能打 | `hasPlainTag()` 认昵称，且要求后一字符不是 `[0-9A-Za-z_]`（否则「@小号1」会误命中「@小号」） |

因为「只有互相关注才发得出真 @」，所以要给一个口径开关：「怎么算 @ 我」（`listen.triggerMode`）：

- `both`（默认）—— 两种都认，谁 @ 都接得住（代价：有人手打你的昵称也能骗她回）
- `rich` —— 只认真 @（代价：非互关的人根本 @ 不到她，等于只能你自己叫）
- `plain` —— 只认文字（代价：谁打这五个字都算）

归一化在 `lib/index.js` 的 `normalizeListen()`，非法值一律回落 `both`，不会因为拼错变成「永远不回」。

---

## 7. 谁 @ 她会被回：判定顺序

`evaluate()`（`tools/lib/watch.mjs`）从上到下短路，任一步拦下就不回：

1. 自己发的 → 跳过（`self`）
2. 来自 `atme` 且 `listen.atme.enabled === false` → 跳过（`atme-off`）；
   来自 `replied` 而 `listen.replies.enabled === false` → `replies-off`；
   来自 `mine` 而 `listen.scanMine.enabled === false` → `scanMine-off`
3. 内容里没触发 → 跳过（`no-trigger`，按第 6 节的口径）。
   **`atme` 与 `replied` 两个源跳过这一步**：前者是平台筛好的 @，后者是「有人直接回到你的话下面」，
   都不需要正文里再出现 @；`mine` 源则必须过 `matchTrigger`（它扫的就是正文里的字面 @）
4. **作者是 `owner.uid`（大号）→ 直接放行**，不看任何名单（`why:'owner'`）
5. `at.enabled` 为真时：过 at 的六条名单 + `at.items` / `at.forums` 范围（`at.items` 对 `atme` 不生效）
6. 再过**源自己**的六条名单（forum / topic / at / atme 各一套）
7. 通过 → `reply`

`owner.uid` **是空的就等于没有这条直通车道**。默认是 `{ uid: '', name: '' }`，本机现状也是空的，
所以「大号一律放行」现在不生效 —— 想用就填「她是谁 → 你的 uid（大号）」。

六条名单（`tools/lib/config.mjs` 的 `FILTER_KEYS`）语义：`allow*` 非空 = 白名单（只放行这些），`deny*` 永远优先。
留空 = 该维度不限制。**`atme` 源自己也有一整套这六条**，想「只在某些板块里接 @」就填它的 `allowForums`。

---

## 8. 还有这些闸门（都会让你以为「配好了却不回」）
| 闸门 | 触发条件 | 表现出来 | 位置 |
| --- | --- | --- | --- |
| 时间窗 | `listen.allDay=false` 且当前不在 `windows` 内 | 日志「不在时间窗内，跳过本轮」 | `watch.mjs` `inWindow()` |
| 首次登记 | `seen.__primed` 为假 | 第一轮什么都不回，日志「首次扫描，登记 N 条」 | `watch.mjs` `tick()` |
| 每轮回复上限 | 一轮已回满 `maxRepliesPerTick`（默认 3） | 「本轮已达上限，剩下的下轮再说」 | `watch.mjs` `tick()` |
| 同帖一轮一条 | 同一帖里两个楼层都 @ 她（含通知源同一帖的多条通知） | 只回第一条 | `watch.mjs` `tick()` 的 `repliedTopics` |
| 同人 30 天冷却 | `oncePerPerson=true`（默认开） | 「冷却期内已回过」 | `watch.mjs` + `state.mjs` 的 `seenPerson()` |
| 写预算 | 本小时 ≥ `risk.writeHourly`(12) / 今天 ≥ `writeDaily`(30) | throw「写预算用尽」 | `traffic.mjs` |
| 写冷却 | 距上次写 < `writeGapSec`(120) 秒 | throw「写冷却中」 | `traffic.mjs` |
| 风控暂停 | 撞到平台拒绝后按 `backoffOnBlock`(300/600/1200/1800s) 退避 | throw「风控暂停中」 | `traffic.mjs` |
| 读预算 | 本小时 ≥ `risk.readHourly`(600，设置页 60–6000) / 今天 ≥ `readDaily`(3000，300–50000)；小时窗口从窗口内第一次读起算满 60 分钟 | throw「读预算用尽」，带恢复时间 | `traffic.mjs` |
| 创作/官方内容 | `listen.skip.essence` / `.official` / `.contribution` 为真（默认都真），且这条帖带对应标记 | 跳过，日志与浏览记录写 `why=essence / official / official-deny / contribution` | `watch.mjs` 的 `skipRule()`（在触发词判定之前） |
| 通知过期（@ 我） | 通知里的 `time` 超过 7 天（如「8天前」） | 该条直接不进候选 | `watch.mjs` 的 `noticeAgeMin()` |
| 通知过期（回复我的） | 超过 `listen.replies.maxAgeMin`（默认 720 分钟） | 该条直接不进候选 | `watch.mjs` 的 `replyAgeMin()` |
| 回复我的首登记 | `seen.__repliedPrimed` 为假 | 第一轮只登记不回，日志会说 | `watch.mjs` 的 `collect()` |
| 假 @ 扫帖上限 | 每轮只读 `listen.scanMine.maxTopicsPerTick` 个帖（默认 2） | 其余帖下一轮轮转，日志「本轮读 N 个」 | `watch.mjs` 的 `collect()` |
| 通知已删 / 非楼层 @ | `del_status=1` 或 `type!=202` | 该条直接不进候选，日志只在「通知 N 条，可用 M 条」里体现 | `watch.mjs` 的 `collect()` |
| **内容安全（入站）** | `safety.enabled` 且 `safety.blockInbound`，且正文命中三类词之一 | 不接话或回固定话术，**不调模型**（零 token）；浏览记录写 `why=inbound-sexual` 这类 | `watch.mjs` 的 `evaluate()`，判定在触发词之前 |
| **内容安全（出站）** | `safety.blockOutbound`，模型写出来的话命中三类词 | 整条不发；`why=outbound-xxx` | `watch.mjs` 的 `gateOutbound()`（`digest.mjs` 里同一套） |
| **平台词表预检** | `safety.maskword.enabled` 且总闸开着，且出站闸已放行；请求快爆自己的敏感词接口 | 整条不发；`why=platform-word`。没配 appid / 密钥时这一步自动跳过 | `watch.mjs` / `digest.mjs` 里的 `maskwordGate()`（`maskword.mjs`） |
| **复读查重** | 同一句 / 相似度 ≥ `risk.dedupeSimilar` 的话在 `risk.dedupeDays` 天内发过 | 不发，`why=repeat` | `dedupe.mjs` 的 `findRepeat()` |
| **破甲拦截（保存时）** | 提示词 / 人设里出现破甲话术，或 AI 线路的模型名 / 地址 / 站名命中破甲特征 | **保存直接 400 拒绝**，页面显示命中了什么 | `lib/index.js` 的 `/settings` POST 与 `/persona` |

**内容安全这三道闸默认全开**，只有显式写 `false` 才关。判定的位置很关键：
入站那道在「触发词匹配」和「调模型」之前，所以被它拦下的内容一次模型都不调；
出站那道在生成之后，token 已经花了但东西没发出去。被拦时日志只写类目与条数，
不回显命中的原文 —— 违禁词本身扩散出去也是一种问题。


**通知源的读额度消耗比想象中大**：每条有效 @ 都要多读一次帖（1 次读），一轮最多 6 个帖。
读预算 600/小时，60 秒一轮的话最多 60 轮，理论上够；但如果同时开着板块源（每个板块 1 次）和帖子源，会更快见底。

去重记录在 `~/.hykb-ai/seen.json`：换扫描范围时宿主会调 `syncScope()` 清掉旧帖记录，
否则新范围里的老帖会一直显示「已回」。**`atme` 的记录是 `f:<帖id>:<楼层id>`**，不受 `syncScope` 影响
（它只清 `topic.items` / `at.items` 里的帖）。

---

## 9. 文件都在哪

| 内容 | 路径 |
| --- | --- |
| 配置（含 `profiles` 三张清单） | `~/.dsh/hykb-scroll.config.json` |
| **当前用哪个号**（指针，一行 uid；删掉它 = 退回改造前的单号布局） | `~/.hykb-ai/active-account` |
| 登录凭据（uid / Pauth / Uauth / nickname，**按号分目录**） | `~/.hykb-ai/accounts/<uid>/credentials.json` |
| 各号自己的台账（额度 / 已读 / 复读 / 浏览 / 回关 / 发帖 / App token） | `~/.hykb-ai/accounts/<uid>/{traffic-ledger,seen,said,browsed,fans,posts}.…`、`app-token.json` |
| 被移除的号（可原样搬回） | `~/.hykb-ai/accounts/.trash/<uid>-<时间戳>/` |
| **人设正文**（每个人设一份） | `~/.hykb-ai/personas/<人设id>.md` |
| AI 密钥（单独存，配置里只有掩码） | `~/.hykb-ai/ai-key` |
| **中转站密钥表**（`{ relayId: key }`，配置里只有 `hasKey`） | `~/.hykb-ai/relay-keys.json` |
| 快爆敏感词检测密钥（配置里只留空字符串） | `~/.hykb-ai/maskword-key` |
| 写操作审计 / 运行日志（全局共用） | `~/.hykb-ai/audit.jsonl`、`activity.jsonl` |
| 日报 | `~/.dsh/hykb-work/digest-<YYYY-MM-DD>.md` |

改造前的单号布局（`~/.hykb-ai/credentials.json` + 根目录那堆台账 + `persona.md`）**第一次启动会被复制成新布局，原件一个都不删**，
可以随时回退：删掉 `active-account` 就回到"一个号"的老行为。迁移幂等，失败原因在 `/api/status.migration`。

密钥永不出现在配置文件里：`config.mjs:150-156` 写入时把 `ai.apiKey` 搬去 `ai-key`；
设置页读回来只有 `sk-…` 掩码，**掩码原样提交 = 不改密钥**（`lib/index.js:199-200, 222-223, 262`）。

---

## 9.5 多账号 / 多人设 / 多线路：三向切换

三样东西各自独立，互不绑定：

| 维度 | 存在哪 | 怎么切 |
| --- | --- | --- |
| **账号**（谁在回帖） | `~/.hykb-ai/accounts/<uid>/` + 指针 `active-account` | 设置页顶部「账号」、卡片①的「我的号」、`hykb.mjs account use <uid>` |
| **人设**（用什么口吻） | 配置 `profiles.personas` + `personas/<id>.md` | 顶部「人设」、卡片③的「当前人设」、`hykb.mjs persona use <id>` |
| **AI 线路**（谁在写字） | 配置 `ai.relays` + `ai.activeRelay` | 顶部「AI 线路」、卡片②的「当前线路」 |

几条口径：

- **切号会带回这个号上次用的人设**（`profiles.accounts[].lastPersona`）；切过去之后当场还能再换，
  所以"一个号轮几个人设"和"不同人设挂不同号"两种玩法都成立。
- **切换即刻生效**，不用重启宿主：账号是一个指针文件，下一个请求就换人；人设与线路在下一轮读配置时生效。
- **正在跑的那一轮不会被撕开**：切换会先等当前轮跑完（最长 60 秒），超时接口回 409 让前端提示"正在跑一轮"。
  绝不能半轮换号 —— 那会用 B 的 cookie 去回 A 扫到的楼层。
- **台账按号隔离**：读写额度、已读去重、复读库、浏览记录、回关台账、发帖计数、App token 都跟着账号走；
  `audit.jsonl` / `activity.jsonl` 保持全局。切号不会让新号"继承"旧号的额度与去重历史。
- **全号共用**：监听源 / 时间窗 / 刷帖 / 发帖 / 安全阀 / 限流策略 / 写作规矩（`prompt.rules`）/ 合规后缀（`prompt.suffix`）。
  换号不用重配任何规则，这正是"每次都要配置一遍"要避免的东西。
- **命令行是长循环时别切号**：`hykb.mjs listen` / `watch` 这类一次起、一直跑的调试命令，进程内不会等轮末，
  切号可能出现半轮混用；要切号走宿主（设置页），或者停掉 CLI 再起。宿主侧这条已经由 `awaitIdle` 挡住。
- **接口**：`GET /dsh-hykb/api/profiles` 读三张清单 + 当前选择；`POST` 用 `{action, id}` 切
  （`switchAccount` / `switchPersona` / `switchLine`）或管人设与账号备注（`addPersona` / `renamePersona` /
  `duplicatePersona` / `removePersona` / `labelAccount` / `retireAccount`）。密钥永远只回 `hasKey`。

---

## 10. 常见症状速查

| 症状 | 最可能的原因 |
| --- | --- |
| 开着监听，一条都不回 | `atme` 被关了且板块/帖子清单全空（第 2 节）；或首次登记还没过；或 AI 三项没配齐 |
| 日志 `[atme] 通知读失败 0 登录错误` | cookie 不全（少了 `nickname` 或 `Uauth`），回设置页重扫一次码 |
| 日志 `[atme] 通知 N 条，可用 0 条` | 通知里全是已删内容或发帖类 @（`type=200`），这两种当前都回不了（第 3 节） |
| 明明收到 @ 却判 `no-trigger` | 只有板块/帖子源会这样；如果那条来自通知源，说明是 bug，不是配置 |
| 日志「写权限缺失」 | `Pauth` 没了（半张票），重新扫码 |
| 日志「no-trigger」刷屏 | @ 的方式和口径不匹配，或 `self.name` 为空（文字 @ 匹配不上），或对方 @ 的昵称和你配的不一致 |
| 别人的 @ 不回、只有大号的回 | 正常：`owner.uid` 直通，其他人要过 at 名单与范围 |
| 换了帖子 id 后不回 | `at.items` 白名单把别的帖子过滤了（第 2 节末尾） |
| 点过「停止」后怎么改都不动 | `running=false`，要再点「启动」（第 1 节第 2 条的补充说明） |
| 清过 `seen.json` 后老 @ 又被回了一遍 | 去重全靠它（平台没有已读接口），第 3 节 |
| 别人回到我的评论下面不回 | 看卡片 ④ 的「接「回复我的」通知」与「有人回你的回复/回帖时接话」（2.1）；也可能是超过 `maxAgeMin` 或撞了写预算 |
| 我帖子下的新回复不回 | **默认就不回**：「你帖子下的新回复也接话」（`replies.onPost`，type=101）默认关，怕在自己的楼里刷屏 |
| 手打 `@昵称` 的不回 | 假 @ 不产生通知，只能靠卡片 ④ 的「扫我参与过的帖，认纯文本 @」（2.2）：帖太多时轮一圈要几小时，且 `triggerMode=rich` 时它也不认 |
| 换了人设/换了号，回帖口吻没变 | 切换要等这一轮跑完（最长 60 秒）；另外看顶部三条「账号 / 人设 / AI 线路」是不是你想要的，别只看卡片里的字段 |
| 切号后额度像被清空 / 去重没生效 | 正常：额度与去重是**按号**分开记的（`accounts/<uid>/`） |
| 移除了一个号又想找回来 | 它在 `~/.hykb-ai/accounts/.trash/<uid>-<时间戳>/`，搬回 `accounts/<uid>/` 即可 |
| 日报里的口味没变 | 卡片 ⑤ 的「个性化题材」一个都没点；或只有题材而 `weight` 被设成 0（那只是纯软偏好档，排名不动，见 5.1） |
| 日报一直不出现 | 卡片 ⑤ 没开；开了但 `browse.wake` 只影响叫醒，日报文件照写 |
| 设置页显示「保存失败」 | 改动去抖 400ms 后整份 POST `/dsh-hykb/api/settings`；再改一下会重试，失败原因看页尾红字 |

---

## 9. 自动点赞 / 表情（新增，全部默认关或默认安全）

### 9.1 自动点赞 `like.*

| 字段 | 作用 | 默认 | 备注 |
| --- | --- | --- | --- |
| `like.browsed` | 赞这一轮读过楼层的帖子 | **关** | 「读过」= 真的拉过楼层，不是被扫到 |
| `like.quality` | 赞打分过线的帖子 + 它下面最热的几条评论 | **关** | 热评条数看下一项 |
| `like.replies` | 赞评论区 / 楼中楼里别人的回复 | **关** | 只开「自动回帖」也会生效（回完顺手赞） |
| `like.perRoundMax` | 每轮最多赞几个（三类合计） | 5 | 写冷却 120 秒时一轮会摊开成约 10 分钟 |
| `like.qualityJudge` | `score` 本地打分 / `ai` 逐条让模型判 | score | `ai` 会真花钱，每条一次调用 |
| `like.qualityMinScore` | `score` 模式下的分数线（0–100，同批相对位置） | 70 | 与 `browse.replyMinScore` 同源思路，但独立配置 |
| `like.aiConfirmMax` | `ai` 模式每轮最多判几条 | 3 | 限住模型成本 |
| `like.hotCommentsPerTopic` | `quality` 模式下每帖最多赞几条热评 | 2 | 按 `up_vote` 排序取前几 |

看起来能用其实不做的三件事：**不取消赞**（`state=2` 的接口留了，程序不用）、**不赞自己**、**不重复赞**。
三条都不是配置开关，是代码里的硬判断。

### 9.2 表情 `emoji.*

| 字段 | 作用 | 默认 |
| --- | --- | --- |
| `emoji.inComment` | 楼中楼（`commentOperate`）也带表情 | **开** |

表情**没有总开关**了：小表情（`emoji` 包 80 条，64×64）和表情包（另 15 个包 368 条，大图）由
`tools/lib/emoji.mjs` 决定，设置页只留「楼中楼也能带表情」这一项。老配置里的 `emoji.enabled`
在保存时会被删掉（`lib/index.js` 的 settings 归一化），不会出现「关了却不生效」的键。

- 写法：`[小表情:名]` / `[名]`（不带前缀时**小表情优先**）/ `[表情包:名]`。前缀那一边没有这个名字时回落到另一边。
- 被要求发表情时：`wantsEmoji()` 命中而正文没有表情，`finishReply()` 会在后缀前补一个小表情。
- 楼中楼能不能显示出图仍没有前端证据，但默认按可用来发；真出现裸标签就把这一项关掉。

### 9.3 常见误解（都对着代码核过）

| 直觉 | 实际 | 依据 |
| --- | --- | --- |
| 「赞过了」记在平台，程序每次问它 | 平台只说「我赞没赞」（`is_up_voted`），没赞是 `-1`；程序再记一道本地账 | `tools/lib/like.mjs` `liked()` + `state.mjs` `seenReply` |
| 把 `<kb-emoji …/>` 先拼进正文再走清洗 | 会被 `tidy()` / `strip()` 当成 HTML 删光 | `ai.mjs` 的 `tidy`、`digest.mjs` 的 `strip` |
| 楼中楼和楼层能用同一套表情 | 代码两边都发；楼中楼没实测过显示效果，出问题就关 `emoji.inComment` | `emoji.inComment` |
| 「只会发表情包」是模型的问题 | 是解析顺序的问题：表里表情包在前，同名都被大图抢走；现在小表情优先 | `tools/lib/emoji.mjs` 的 `byKind` |
| 搜索能搜到「刚加但没渲染」的设置 | 搜得到；点它会滚过去并提示「这张卡现在关着」，不会替你改配置 | `lib/client.js` `jumpTo` |

## 自动回关（followback）

别人关注小号之后，反过来关注他。全部走**网页用户中心接口**（www.3839.com/app/hykb_web/api/api_user.php），
明文表单 + cookie，不需要 App 签名、不需要 root、不需要 App 登录态。

| 用途 | 接口 |
| --- | --- |
| 我的粉丝 | ac=fans_user_list2&page=N |
| 我关注的人 | ac=home_kifollowother2&page=N |
| 关注 / 取消 | ac=add_focus_user、ac=cancel_focus_user（参数 vuid） |
| 关系 | ac=get_relation_info&vuid= |

判定规则（实测得出，别用 relation 判断互关）：relation 只有 1（无关系）和 4（存在关注关系）两种，
粉丝和互关都是 4，分辨不了方向。**唯一可靠判据是「他是否在 home_kifollowother2 里」**：
在 → 已回关；不在 → 待回关。回关成功后他会出现在关注列表里，所以天然幂等。

配置（followback）：

- enabled 默认 false（写操作）
- dailyCap 一天最多回关几个，默认 20，范围 1–100
- onlyNonMutual 只处理还没回关的，默认 true
- maxPages 粉丝 / 关注列表各翻几页，默认 3

行为：listen.enabled 或 followback.enabled 任一打开，调度就按 listen.intervalSec 的节拍跑；
只处理**接入之后新增的粉丝**（首次运行把现有粉丝登记成基线）；成功/失败都进 activity.jsonl 与 audit.jsonl；
撞到 5001/5003/403 立刻整批停手。

命令行：hykb.mjs fans（只读）、hykb.mjs followback（预演）、hykb.mjs followback --send（真回关）。
