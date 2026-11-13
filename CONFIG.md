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

一句话：**板块源和帖子源没有「全站扫描」这个能力，留空就是「不扫」；「@ 我通知」是例外 —— 它读的是平台自己的 @ 列表，本来就不需要范围。**

反过来，会自己出去找帖的是另一个模块 —— **自动刷论坛**（`browse`），它有一条「留空 = 六个默认公共讨论区」的兜底
（`tools/lib/daypool.mjs` `sectionsFor()`：`sections` 空 → 板块目录全部（按今日讨论量降序，最多 `coverage.maxSections`）→ 目录挂掉才退回 `defaultSections`）。

---

## 1. 配置项最小全集

**除了「@ 我通知」，别的都得配。** 让她回一条帖，下面 5 项必须同时成立，缺任何一项都是静默失败（日志里有原因，但不会有人告诉你）：

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

## 2. 扫描范围到底怎么算（自动回帖的四个源）

四个源是**并联**的，各自独立，互不兜底：

| 源 | 开关字段 | 清单字段 | 关掉开关 | 开着但清单空 |
| --- | --- | --- | --- | --- |
| **@ 我通知** | `listen.atme.enabled`（默认 **true**） | 无 | 不去读消息中心，别人的 @ 全收不到 | 不适用 —— 它本来就不需要清单 |
| 板块 | `listen.forum.enabled` | `listen.forum.items` | 不读任何板块 | **也不读任何板块**（循环零次） |
| 帖子 | `listen.topic.enabled` | `listen.topic.items` | 不读任何帖子 | **也不读任何帖子** |
| @ 的规矩 | `listen.at.enabled` | `listen.at.items` / `listen.at.forums` | 不追加帖子、且跳过 at 的白黑名单校验 | 不追加帖子（范围不扩大） |

`collect()` 的实际取数（`tools/lib/watch.mjs` 的 `collect()`）：

```
@我通知源：atme.enabled !== false
           → POST www.3839.com/app/hykb_web/api/api_user.php  (ac=message&mode=3)
           → 丢掉 del_status=1（已删）和 type!=202（发帖类 @，没有楼层可回）
           → 按 tid 去重后 slice(0, maxTopicsPerTick) 读帖，定位 rid 那层楼
板块源：  for (item of forum.enabled ? forum.items : [])        → 每个板块扫第一页帖子
帖子源：  topics = (topic.enabled ? topic.items : []) ++ (at.enabled ? at.items : [])
          再 slice(0, maxTopicsPerTick)                         → 每个帖子读楼层 + 楼中楼
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

`at.forums` 只做限制、不做扩大，UI 文案是「只在这些板块里应 @」。这两个清单都**不拦 @ 我通知**：
通知本身已经是全站的 @，再拿清单收窄等于自己把消息扔掉。

---

## 3. 「什么都不配、只靠别人 @ 就回」—— 能做到，走 @ 我通知

这是你最想要的用法，现在**成立**：`listen.atme.enabled` 默认就是 `true`，
加上「登录 + 打开自动回帖 + AI 三项」（第 1 节的 1/2/4），她就只靠别人 @ 也能回，**不需要填任何板块 id 或帖子 id**。

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

`browse` 与 `listen` **完全独立**：两边的开关、间隔、时间窗各管各的，一个关着不影响另一个。
模式卡（只回 @ / 两个都要 / 只刷不发 / 先关着）只是同时改这两个布尔，不是第三套逻辑（`lib/client.js:858-861`）。

刷帖落盘：`~/.dsh/hykb-work/digest-<YYYY-MM-DD>.md`，同一天多轮是**追加**。

---

## 6. @ 到底怎么算

先说一句能省掉一半困惑的话：**这一节只对「板块源 / 帖子源扫到的正文」生效。**
「@ 我通知」源不参与这个判定 —— 通知本身就是平台筛好的 @，再匹配一遍只会把它挡掉。

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
2. 来自 `atme` 且 `listen.atme.enabled === false` → 跳过（`atme-off`）
3. 内容里没 @ 她 → 跳过（`no-trigger`，按第 6 节的口径；**`atme` 源跳过这一步**）
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
| 通知过期 | 通知里的 `time` 超过 7 天（如「8天前」） | 该条直接不进候选 | `watch.mjs` 的 `noticeAgeMin()` |
| 通知已删 / 非楼层 @ | `del_status=1` 或 `type!=202` | 该条直接不进候选，日志只在「通知 N 条，可用 M 条」里体现 | `watch.mjs` 的 `collect()` |
| **内容安全（入站）** | `safety.enabled` 且 `safety.blockInbound`，且正文命中三类词之一 | 不接话或回固定话术，**不调模型**（零 token）；浏览记录写 `why=inbound-sexual` 这类 | `watch.mjs` 的 `evaluate()`，判定在触发词之前 |
| **内容安全（出站）** | `safety.blockOutbound`，模型写出来的话命中三类词 | 整条不发；`why=outbound-xxx` | `watch.mjs` 的 `gateOutbound()`（`digest.mjs` 里同一套） |
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
| 配置 | `~/.dsh/hykb-scroll.config.json` |
| 登录凭据（uid / Pauth / Uauth / nickname） | `~/.hykb-ai/credentials.json` |
| AI 密钥（单独存，配置里只有掩码） | `~/.hykb-ai/ai-key` |
| **中转站密钥表**（`{ relayId: key }`，配置里只有 `hasKey`） | `~/.hykb-ai/relay-keys.json` |
| **复读台账**（发过的话，JSONL 追加写，上限 2000 条） | `~/.hykb-ai/said.jsonl` |
| 读/写额度账本 | `~/.hykb-ai/traffic-ledger.json` |
| 写操作审计 | `~/.hykb-ai/audit.jsonl` |
| 已读/已回去重 | `~/.hykb-ai/seen.json` |
| 浏览记录（她读过/回过/跳过的帖，含三个时间） | `~/.hykb-ai/browsed.jsonl` |
| 日报 | `~/.dsh/hykb-work/digest-<YYYY-MM-DD>.md` |
| 日报发帖台账 | `~/.hykb-ai/posts.json` |
| 人设补充 | `~/.hykb-ai/persona.md` |

密钥永不出现在配置文件里：`config.mjs:150-156` 写入时把 `ai.apiKey` 搬去 `ai-key`；
设置页读回来只有 `sk-…` 掩码，**掩码原样提交 = 不改密钥**（`lib/index.js:199-200, 222-223, 262`）。

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
| `emoji.enabled` | 回复里允许出现表情（模型写 `[表情:名]`，程序换成真标签） | 开 |
| `emoji.inComment` | 楼中楼（`commentOperate`）也带表情 | **关** |

`inComment` 默认关的原因：网页端楼中楼输入框是纯 textarea，前端从不给 `commentOperate` 发 `kb-emoji` 标签，
服务端怎么处理没有前端证据。要开就自己开，然后发一条看看能不能显示出图。

### 9.3 常见误解（都对着代码核过）

| 直觉 | 实际 | 依据 |
| --- | --- | --- |
| 「赞过了」记在平台，程序每次问它 | 平台只说「我赞没赞」（`is_up_voted`），没赞是 `-1`；程序再记一道本地账 | `tools/lib/like.mjs` `liked()` + `state.mjs` `seenReply` |
| 把 `<kb-emoji …/>` 先拼进正文再走清洗 | 会被 `tidy()` / `strip()` 当成 HTML 删光 | `ai.mjs` 的 `tidy`、`digest.mjs` 的 `strip` |
| 楼中楼和楼层能用同一套表情 | 楼层确认可用；楼中楼没实测，所以默认关 | `emoji.inComment` |
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
