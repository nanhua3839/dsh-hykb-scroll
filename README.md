# dsh-hykb-scroll · 刷快爆

在好游快爆放一个 AI 小号。两条独立的腿：

1. **被动回帖** —— 有人 `@小号`，小号读到后用 AI 生成回复发回楼中楼。两种收法：读平台消息中心的「@我的」
  通知（**不用配任何 id**，别人在哪 @ 都收得到），或者自己盯几个板块 / 帖子。
2. **主动刷帖** —— 宿主自己的时钟到点扫板块、给帖子打分排序、深读前几帖、写一份中文日报落盘，
   再把「你醒了」的任务书塞进她自己的会话（`sessionController.prompt`），让她读到日报、挑话、推给主人。

第 2 条是「真的会自己刷论坛」与「只能等人 @」的分界：日报是材料，叫醒会话才是让她真的过日子。

形态与 `dsh-bili-whale` 一致：一个 DSH 插件（设置页 + 宿主定时器）+ 一套共用工具链。

**配置项到底怎么配、哪些不配就完全用不了、留空是「不扫」还是「扫全部」—— 看 [CONFIG.md](./CONFIG.md)。**

## 装

本机没装 `dsh` CLI 时手工装（等价于 `dsh plugin --profile desktop add link:<path>`）：

```powershell
# 1. 源码挂进插件库
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\plugins\dsh-hykb-scroll" ``
  -Target "<仓库路径>\dsh-hykb-scroll"
# 2. 挂进 profile 的 node_modules
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-hykb-scroll" ``
  -Target "$env:USERPROFILE\.dsh\plugins\dsh-hykb-scroll"
# 3. profile/package.json 里加依赖与 bundle（见下）
```

`~\.dsh\profiles\desktop\package.json`：

```json
{
  "dependencies": { "dsh-hykb-scroll": "link:C:/Users/<你>/.dsh/plugins/dsh-hykb-scroll" },
  "dsh": { "profile": { "bundles": [ "...", "dsh-hykb-scroll" ] } }
}
```

装完在 DSH 里按刷新按钮，或重启 DSH。设置页在 **设置 → 刷快爆**。

## 用

```bash
node tools/hykb.mjs login            # 扫码登录，cookie 落到 ~/.hykb-ai/credentials.json
node tools/hykb.mjs whoami           # uid / 昵称 / 未读数
node tools/hykb.mjs read 9251547     # 读帖子
node tools/hykb.mjs summary 9251547  # AI 总结
node tools/hykb.mjs reply 9251547 "内容"   # 发主回复
node tools/hykb.mjs comment 9251547 27047246 "内容"  # 发楼中楼
node tools/hykb.mjs del 9251547 27062212   # 删自己楼层
node tools/hykb.mjs traffic          # 本小时/今天 读写作数与冷却
node tools/hykb.mjs listen           # 常驻监听（与设置页里的开关同一份配置）
node tools/hykb.mjs browse --dry     # 只读：这一轮会扫哪些板块、前 N 名是谁
node tools/hykb.mjs browse sections  # 本轮会扫的板块清单
node tools/hykb.mjs digest --dry     # 跑一轮日报但不回帖、不叫醒
node tools/hykb.mjs digest           # 真跑：写日报 +（可选）对高分帖回帖
```

日报落在 `~/.dsh/hykb-work/digest-<YYYY-MM-DD>.md`，同一天多轮是**覆盖写**（日报是今日全量快照，不是流水账）。

## 接口事实（实测，别再猜）

| 用途 | 方法 |
| --- | --- |
| 读帖 + 楼层 + 楼中楼 | `GET m.bbs.3839.com/wap.php?m=topic&ac=detail&v=1.1&topic_id=<id>&sort=2&app_version=413` |
| 发主回复 | `POST bbs.3839.com/index.php?m=api&c=thread&a=replyOperate` `{tid,content,replyId:0,type:3,state:1,mask:0}` |
| 发楼中楼 | `POST ...a=commentOperate` `{fid,replyId,commentId:0,content,type:2,extra_comment:1,mask:0}` |
| 删自己楼层 | `POST ...a=replyOperate` `{tid,replyId:<id>,type:4,state:1}` |
| 登录态探针 | `GET ...a=getMsgInfo` → `code:100` 即已登录 |
| 扫码建码 | `POST www.3839.com/user/index.php?ac=QRcodeCreate&appId=web` → `result.qrcode` |
| 扫码轮询 | `POST ...ac=QRcodePolling&appId=web` `{qrcode,r}` |
| 板块帖子列表（刷帖主接口） | `GET m.bbs.3839.com/wap.php?m=topic&ac=section_topic&v=1.0&section_id=<sid>&app_version=413&topic_list_type=all&subject_id=0&last_id=0&cursor=0&screen_id=0&sort=reply_time` |
| 板块目录 | `GET bbs3839.5054399.com/app/wap.php?m=section&ac=index&v=1.1` → `result.data[]{recommend,hot,recent_view,official,media}` |

坑：

- PC 的 `a=getReplyList` / `a=getCommentList` 一律 `code:403`，`data.encryptString` 是 base64 的 IP 水印 → IP 级风控，读只能走移动版。
- 楼中楼一次只回前 3 条，翻页参数全部无效；发出去后靠 `comment_count` 增长自证。
- `replyOperate` 的 `type` 必须是 3、`state` 必须是 1，否则 `code:1000 参数不完整(100)`。
- `@` 有两种写法：`<kb-contact data-id="uid">` 走好友校验（非好友整条被拒 `code:8112`）；纯文本 `@昵称` 不走校验，任何号都能发。
- 登录态 = `uid` / `Pauth` / `Uauth` / `nickname` 四个 cookie。
- 板块列表免登录可读；翻页把上一页的 `cursor` + `last_id` 回传，实测 p1 20 条 → p2 10 条、零重叠。
- `sort` 只有 `reply_time` 有效，`post_time` / `hot` / `new` / `essence` 一律 `code:1000 排序类型错误`。
  `topic_list_type` 与 `section_id` 都是必填。
- feed 里的 `is_top` / `is_essence` 是**数字 -1/1**，不是布尔 —— `!!t.is_top` 恒真，会把所有帖子当置顶跳过
  （表现为每个板块「扫到 0 帖」）。必须 `Number(t.is_top) > 0`。
- 板块目录的 `discuss_num` 是「23.8万」这种字符串，`Number()` 得 0，要自己解析。
- 楼层里常有大段重复 emoji（「恭喜🎉🎉🎉…」连刷十几条）。原样塞进综述 prompt 会让模型跟着退化成乱码，
  所以 `ai.mjs` 的 `tidy` / `tidyFloors` 必须先折叠重复再去重，深读帖也只喂"一句速读"给日报。
- **按「码元」截断中文/emoji 会切出孤立代理项**：`slice(0, 120)` 正好切在 emoji 中间时，字符串在 JS 里合法、
  `JSON.stringify` 也合法，但发给 DeepSeek 会被它自己的解析器拒掉（`HTTP 400 Failed to parse the request body as JSON:
  messages[1].content: unexpected end of hex escape`），整份 AI 综述直接掉回骨架。现在 `ai.mjs` 有 `wellFormed()`
  （`String.prototype.toWellFormed`）在 `tidy()` 截断后修、在 `chat()` 出网前再兜一道，
  回归用例见 `tests/ai-wire.test.mjs`。

## 刷帖怎么配

设置页 **设置 → 刷快爆 → 刷帖**：

| 字段 | 作用 | 默认 |
| --- | --- | --- |
| 总开关 | 开了才按时钟刷 | 关 |
| 刷帖间隔（秒） | 两轮之间的最短间隔 | 3600 |
| 全天刷 / 时间段 | 关掉全天就只在窗口内刷 | 全天 |
| 读哪些板块 | 点「选板块」从全站目录里搜着选（可多选），也能直接填板块 ID；**不选 = 全站目录里的全部公共板块（约 49 个）**。只勾一两个板块时日报就只覆盖这些，日志会明确警告 | 空 |
| 日报写几帖 | `pick` | 8 |
| 深读几帖 | 前 N 帖拉楼层，取真实引文 + 参与人数喂给反幻觉层 | 8 |
| 对高分帖自动回帖 | 写操作，仍受 risk 预算与写冷却 | 关 |
| 回帖分数线 / 每轮最多回几条 | `replyMinScore` / `replyMax` | 40 / 3 |
| 刷完叫醒会话 | 关掉 = 只写日报文件，不在她会话里说话 | 开 |

### 把日报发成帖子

同一张卡下半截「把日报发成帖子」：

| 字段 | 作用 | 默认 |
| --- | --- | --- |
| 每轮写完自动发帖 `post.enabled` | 每轮日报写完，以小号身份在选定板块发一篇文章帖 | 关 |
| 发到哪个板块 `post.section` | 单选，`{id,title}`。不选就不发 | 空 |
| 帖子标题 `post.title` | `{date}` 换成日期，平台限 48 字；同一天第二篇自动加「· 2」 | `快爆论坛日报 {date}` |
| 文末附原帖链接 `post.links` | 文末列出这期写到的每一帖：标题 + `https://bbs.3839.com/thread-<id>.htm`，程序拼，不让模型编 | 开 |
| 一天最多发几篇 `post.maxPerDay` | 1–5。手动「现在发一篇」也算在里面 | 1 |
| 少于几帖不发 `post.minPicks` | 选到的帖不够就跳过（手动发不看这条） | 3 |

- 接口：`POST https://bbs.3839.com/index.php?m=api&c=thread&a=setThread`（发帖页 `send_thread.js` 用的同一个），表单字段 `type=1 fid title content cate=1 …`，成功 `code=100`。返回里没有新帖 id。
- 正文是编辑器 HTML：只用 `<div> <h2> <b> <br>`。平台编辑器不支持 `<a>`，所以链接是纯文本网址。
- 发帖先于「顺手回高分帖」：两次写之间有写冷却（`risk.writeGapSec`），先保主产物。
- 每次发帖记进 `~/.hykb-ai/posts.json`（最近 200 条）和审计日志 `audit.jsonl`（action=`post`）。
- 「跑一轮（不真发）」会把要发的标题和正文一起预览出来，不出网写。

### 提示词（回复前先想的规则）

卡片 ③ 下半截：

| 字段 | 作用 |
| --- | --- |
| 回复前先想的规则 `prompt.rules` | 拼进每次生成要发出去的话的系统提示（自动回帖、楼中楼、日报、日报帖、刷帖顺手回），和内置规则冲突时以这里为准 |
| 末尾固定加一句 `prompt.suffix` | 程序在每条发出去的话最后追加，例如「内容由AI生成」。模型自己写了也会去重，截断时先截正文、保住这一句 |

「人设补充」（`~/.hykb-ai/persona.md`）现在也真的拼进系统提示了，之前只存不用。
命令行手打的 `reply` / `comment` 是你自己写的字，不加后缀。

### 内容安全（三道闸，命中就不发）

| 闸 | 什么时候判 | 命中后 | 花 token 吗 |
| --- | --- | --- | --- |
| **入站** | 读到别人写的内容，**在调模型之前** | 跳过这条，或直接回一句固定话术 | **不花** |
| **出站** | 模型写完了，**在发出去之前** | 整条不发（可选回固定话术） | 已经花了 |
| **配置** | 保存提示词 / 人设 / AI 线路时 | 直接拒绝保存，并说明命中了什么 | 不花 |

命中后回的那句话（`safety.refuseText`，默认「识别到违规内容，无法生成回复。」）是**配置里的死文本，由程序直接发，不经过模型**——所以被拦下的那些一条 token 都不花。留空 = 静默跳过，只在运行日志里留痕。

三类违禁词各一个开关，都是「词干」匹配而不是整句，并且先做归一化（全角折半角、去零宽、去词中间插入的空格与符号、转小写），所以 `色 情` / `色*情` / `色-情` / `ＳＥＸ` / 插零宽 都拦得住。

内置词表（`tools/lib/safety.mjs` 的 `BUILTIN`，可用 `node tools/hykb.mjs safety list` 打印全量）：

**国家 / 政治**（72 条）
法轮功、法轮大法、六四事件、六四、8964、64事件、天安门事件、天安门屠杀、坦克人、八九民运、藏独、疆独、台独、港独、台湾独立、西藏独立、新疆独立、达赖喇嘛、东突厥斯坦、分裂国家、颠覆国家政权、煽动颠覆、推翻政府、推翻共产党、打倒共产党、共产党下台、一党专政、政变、颜色革命、境外势力、反华、辱华、反共、新疆集中营、再教育营、强制劳动、白纸运动、四通桥、雨伞革命、占领中环、政治避难、维权律师、访民、上访、群体事件、游行示威、非法集会、罢工潮、举报领导、领导人丑闻、政治黑幕、政治迫害、洗脑宣传、专制政权、独裁统治、刘晓波、诺贝尔和平奖政治、人权迫害、言论审查、网络审查、政治敏感、政治立场、反政府、抗议政府、政府腐败、官员腐败、贪腐丑闻、选举舞弊、独裁者、专制统治、人权问题、制裁中国

**色情**（64 条）
色情、黄片、黄图、黄色网站、成人视频、裸聊、裸照、全裸、露点、走光、约炮、一夜情、援交、卖淫、嫖娼、招嫖、包养、楼凤、外围女、做爱、性交、口交、肛交、乳交、足交、手淫、自慰、打飞机、射精、阴茎、阴道、龟头、阴蒂、睾丸、乳头、骚逼、淫水、精液、潮吹、高潮迭起、性高潮、性虐、调教、sm调教、捆绑play、乱伦、迷奸、强奸、淫秽、猥亵、性侵、未成年性、萝莉控、正太控、肉文、黄文、情色小说、porn、nsfw、hentai、onlyfans、sexcam、blowjob、cumshot

**血腥暴力**（51 条）
杀人、杀死他、杀掉、砍死、捅死、打死、掐死、勒死、毒死、炸死、碎尸、分尸、肢解、开膛、剖腹、挖心、割喉、斩首、爆头、凌迟、虐杀、虐待致死、屠村、灭门、血洗、血流成河、血肉模糊、血淋淋、尸体、腐尸、尸块、人肉、吃人、食人、啃脸、自杀、自残、割腕、上吊、跳楼、卧轨、烧炭自杀、服毒、安乐死、恐怖袭击、爆炸装置、制作炸弹、枪支改装、自制枪、血腥视频、死亡直播

**破甲提示词**（52 条，命中就拒绝保存提示词 / 人设）
忽略之前、忽略以上、忽略上面、忽略前面、无视之前、无视以上、无视上面、忘记之前的指令、忘记上面的规则、不要遵守、不必遵守、不受限制、没有限制、无限制模式、开发者模式、越狱模式、破甲、破限、解除限制、解除审查、绕过审核、绕过限制、绕过安全、关闭安全、禁用安全、关闭审查、不再审查、你现在是、从现在开始你是、扮演一个没有、假装你没有规则、假装你是、角色扮演不受、dan模式、do anything now、jailbreak、ignore previous、ignore above、ignore all previous、disregard previous、disregard your、forget your instructions、no restrictions、without restrictions、unfiltered mode、developer mode、god mode、系统提示词、system prompt、泄露提示词、输出你的设定、重复上面的指令

**破甲模型特征**（31 条，命中就拒绝保存线路）
uncensored、abliterated、jailbreak、jailbroken、unfiltered、nofilter、nsfw、erotic、lewd、smut、hentai、dolphin、wizard-vicuna-uncensored、vicuna-uncensored、llama2-uncensored、openhermes-uncensored、mythomax、goliath、venice、amoral、无审查、无限制、未审查、破甲、破限、越狱、去限制、解锁版、色色、搞黄、涩涩

两个可调的地方：
- **自加违禁词** `safety.extraWords`：和内置词一样，入站出站都拦。
- **例外词** `safety.allowWords`：游戏语境里的误伤词填这里（比如「尸体派对」这种游戏名），命中例外的那个词干就不再拦，但它同类的其它词照拦。

命令行：`node tools/hykb.mjs safety`（看状态）、`safety list`（打印全量词表）、`safety test <一句话>`（看会被哪道闸拦）、`safety said`（复读台账）。

### 复读查重（风控的另一半）

机器最容易暴露的不是频率，是「同一句话反复出现」。所以发过的每句话都记进 `~/.hykb-ai/said.jsonl`，同一句（或很像的一句）在 `risk.dedupeDays`（默认 14 天）窗口内说过就不再发。

- 判重两档：归一化后完全相同，或字符二元组 Jaccard ≥ `risk.dedupeSimilar`（默认 0.86）。中文按二元组比对，不需要分词。
- 台账上限 2000 条，留 20% 余量才压缩（否则会在上限附近变成每条都全量重写）。
- 长度差一倍以上的句子直接跳过比较（性能预筛）。台账满的时候单次判重约 2ms。
- 设 `risk.dedupeDays: 0` = 关掉查重；设置页「内容安全」里有「清空复读台账」。

### 中转站

除了直连那三行，还能挂若干个中转站，各自一套地址 / 模型 / 密钥。

| 字段 | 作用 | 默认 |
| --- | --- | --- |
| `ai.relays[]` | 每条 `{ id, name, baseUrl, model, enabled }`。最多 12 条 | 空 |
| `ai.activeRelay` | `direct`（用直连那三行）或某条 relay 的 id | direct |
| `ai.fallback` | 主线路失败自动按顺序试下一条 | 开 |

- 密钥按线路 id 存 `~/.hykb-ai/relay-keys.json`，配置文件里永远只有 `hasKey: true/false`，页面只显示「已保存」。
- 一条线路要进候选，必须**三项齐全**（地址 + 模型 + 密钥）且地址是 http/https。
- **破甲模型在选中之前就被剔除**：模型名 / 地址 / 站名任意一处命中 `JAILBREAK_MODEL` 的线路不进候选，保存时也会被拒。
- 全失败时错误里会列出每条线路名和原因；一条都没有时会分清是「没填」「缺密钥」还是「被破甲判定拦下」——三种情况用户要做的事完全不同。
- 命令行：`node tools/hykb.mjs relays`（列线路，标出哪条可用、哪条被破甲拦）、`relays clear <id>`（清某条密钥）。


做不了。网页端（`www.3839.com/zone`、`bbs.3839.com`、`m.bbs.3839.com`）的消息中心只有回复我 / 系统 / @我 / 赞 / 关注五类通知，前端脚本里没有任何私信接口；私信只在 App 里，要逆向 App 协议，不在这个插件的范围内。

**要让她真的"刷"起来，必须给那个会话完全访问权限** —— 她醒来要跑命令行读日报、看帖子。
会话在 **工作区 → 未分组** 里，不点开看不见。没有 `sessionController`（headless 模式）时日报照写，
但不会叫醒任何人；设置页「刷新状态」会直接写出这一条。

### 创作 / 官方内容不回复（可关）

帖子列表和帖详情里直接带三个标记，所以这条判定不需要额外请求：

| 标记 | 字段 | 开关（默认开） |
| --- | --- | --- |
| 精华 | `is_essence=1` | `listen.skip.essence` |
| 官方发布 | `is_official=1` | `listen.skip.official` |
| 长文投稿 | `is_article_contribution=1` | `listen.skip.contribution` |

- 判定在 `evaluate()` 的最前面（在触发词之前）：这类内容连 AI 都不叫起来，省一次模型调用。
- 官方这一类还带两个名单：`listen.skip.officialAllow`（点名放行，开关开着也回）、`listen.skip.officialDeny`（强制跳过，优先于白名单）。
  两个名单都认 uid 和昵称。
- 跳过会写进浏览记录（`why=essence / official / official-deny / contribution`），所以在设置页能看出「为什么这条没回」。

### 三个时间 + 浏览记录

平台给的时间是 `YYYY-MM-DD HH:MM:SS` 字符串，不是时间戳（`time` 发布 / `edit_time` 修改 / `reply_time` 最近回复，
没改过是 `0000-00-00 00:00:00`）。现在这三样都认，并且：

- **浏览记录**（`~/.hykb-ai/browsed.jsonl`）按帖记：谁发的、哪个板块、三个时间、这次是「已回复 / 写进日报 / 跳过」以及原因。
  同一帖同一天同一动作只记一次，文件最多 5000 行。
- 设置页有「浏览记录」卡片（不展开不发请求），命令行 `node tools/hykb.mjs history [条数]`，清空用 `history --clear`。
- 顺手修掉一个老 bug：`browse.mjs` 之前用 `Number(t.time)` 当毫秒时间戳，字符串转数字得 NaN，
  **新鲜度加分这一项一直是 0**。现在新帖真的会排前面（下面「刷帖打分」那一项才真正生效）。

### 游戏评价观察（只读，可关）

日报里多一段「游戏评价观察」：挑几个游戏 → 读玩家在它们下面的评价 → 让 AI 压成一段。

| 字段 | 作用 | 默认 |
| --- | --- | --- |
| `games.enabled` | 开了才写这一段 | 关 |
| `games.source` | 从哪个榜单挑：`hot` 热门 / `sugar` 飙升 / `expect` 预约 / `down` 下载 | hot |
| `games.items` | 填了就只读这些（`{id,title}`，只填 id 会去游戏页补名字）；留空用榜单 | 空 |
| `games.pick` | 每轮看几个游戏 | 3 |
| `games.maxComments` / `games.minLen` | 每个游戏读几条评价 / 多短的丢掉 | 20 / 12 |

**只读，不发任何评价、不替她打分。** 这条链路上没有写接口 —— 平台对「刷好评迹象」有礼仪考试闸
（`comment.php` 会拦并要求先考试），脚本替人打分既没意义也容易被判违规。

- 榜单：`https://m.3839.com/top/<hot|sugar|expect|down>.html`（服务端渲染，直接给 id + 名字 + 平台分）。
  二次元 / 玩家 / 开发者榜由 `top.js` 现拉数据，解析不到，所以只支持这四个。
- 评价：`GET https://www.3839.com/app/comment.php?ac=get_comment_list&m=pc&v=1.0&pid=1&fid=<游戏id>`
  → `{code:100, result:{star_info:{star}, count, data:[{star, content, time_str, user}]}}`，免登录。
- 设置页卡片 ⑤ 有「试读一批评价」：只读、不写日报、不动调度，用来确认这条链路通不通。

### 扫描抖动

固定秒数扫几百轮，请求节奏就是机器节奏（整点、误差 0 秒），平台的频控最容易认出来的正是这个。

| 字段 | 作用 | 默认 |
| --- | --- | --- |
| `listen.jitterSec` | 回帖轮实际间隔 = `listen.intervalSec` ± 这个数（秒） | 3 |
| `browse.jitterSec` | 刷帖轮实际间隔 = `browse.intervalSec` ± 这个数（秒） | 60 |

- 填 0 = 不抖，回到固定间隔。间隔 20 秒 + 抖动 2 秒 → 每轮落在 18–22 秒之间。
- 抖出负数会压到 5 秒下限（`lib/jitter.js`），否则 `setTimeout` 会立刻触发，等于疯狂扫描。
- 只抖「按间隔排下一轮」：启动的 1.5 秒和改配置后的 3 秒是即时动作，不抖。

## 日报怎么选帖（四维打分 + 配额 + 反幻觉）

日报的候选池是**今天全站目录里发过的帖**，不是「刚刷出来的那几十条」。整条链路分四层，
每层只有一个文件、只做一件事：

| 层 | 文件 | 做什么 | 保证什么 |
| --- | --- | --- | --- |
| 抓取 | `tools/lib/daypool.mjs` | 按板块增量翻页，直到最早一条 `reply_time` 早于本地当天 00:00；游标按天存盘，下一轮只补新的 | **当天全量覆盖**（依据：列表按 `reply_time` 倒序，零回复帖的 `reply_time` = 发布时间，翻过 0 点就说明当天发的帖全见过） |
| 打分 | `tools/lib/rank.mjs` | 热度/讨论度/质量/活跃度四维原始分 → **在本日池内各自转成 0–100 的分位数** → 按 30/35/22/13 加权 | 同一池子里所有帖子用同一把尺子，**同一份数据跑两次结果完全一样**，模型不参与打分 |
| 选帖 | 同上 `selectPicks` | 配额 + 保送 + 去噪：每板块 ≤2、每作者 ≤1（官方号 ≤3、官方总量 ≤3）、零信号帖剔除、池内同标题去重、自己的日报帖剔除；当天回复最多的那帖**保送**进日报 | **代表性**：不会被一个板块/一个人/编辑部专栏占满，也不会漏掉「今天讨论最多」 |
| 渲染 | `tools/lib/ground.mjs` | 标题/链接/统计/板块/作者/引用楼层全部由代码从证据包写；模型只写「概览 + 每帖一句点评」，**每句都过事实校验**（数字必须在证据里、链接必须是真的、引文必须是原文子串、编号必须存在），过不了整句丢掉 | **不编**：过不了的句子直接丢弃，整份都不合格就退回纯代码骨架，日报里不会出现模型编的标题/数字/链接 |

分数是 0–100，但含义是「当天同批帖子里的相对位置」：中位数约 50，前 10% 大约 85 分以上。
**跨天不可直接比**（每天池子不同）。权重在 `browse.weights`，配额在 `browse.perSectionMax` /
`perAuthorMax` / `perAuthorMaxOfficial` / `officialMax`，设置页没暴露，改配置文件即可。

### 覆盖情况从哪看

- 日报头部有一行「覆盖：N 个板块 · 今日抓到 M 帖 · K 次请求 · 已翻到当日首帖」，`## 这期怎么排的` 里还有缺口清单。
- 抓取按 `browse.coverage.crawlMaxRequests`（默认 140）限流：一轮补不完就下一轮接着补，
  游标在 `~/.hykb-ai/daypool-<日期>.json`，**不会漏，只会晚**。
- 每一轮日报旁边还会落一份 `digest-<日期>.evidence.json`：选了什么、四维分位数多少、模型写了什么、
  哪几句被校验丢掉，都能事后追。

### 同一天多轮 = 覆盖写

日报是「今日全量快照」，不是每小时叠一段的流水账：同一天再跑会**覆盖** `digest-<日期>.md`，
头部注释里带更新时间。历史快照看 `.evidence.json`。

## 设置页长什么样

打开 **设置 → 刷快爆**，从上到下六张卡：

| # | 卡片 | 一张卡做完什么 |
| --- | --- | --- |
| 1 | 登录账号 | 没登录时放二维码 / 手填 Cookie；登录后只显示账号摘要（头像字、昵称、uid、能不能发帖）+「换个号」「退出登录」。换号时才展开扫码框，可以「不换了」退回去；退出会删掉本机凭据（不动网页端的登录） |
| 2 | 接上 AI | 接口地址 / 模型 / 密钥，她写的话由这个模型生成 |
| 3 | 她是谁 | 角色名、她怎么称呼你、说话风格、人设补充；下面是提示词：回复前先想的规则、末尾固定加一句 |
| 4 | 自动回帖 | 扫描间隔、**怎么算 @ 我**（两种都认 / 只认真 @ / 只认文字 @）、四个源页签（**@ 我通知**（默认开、无需任何 id）/ 板块 / 帖子 / @ 的规矩）各自的开关与清单、「每轮最多读几帖 / 最多回几条」—— 关掉时整张卡正文不渲染，只剩一句「关着：不会主动发任何回复。」卡底一颗按钮按宿主状态二选一：没跑显示「启动」，在跑显示「停止」 |
| 5 | 刷论坛 · 日报发帖 | 读哪些板块（多选）、多久刷一轮、日报写几帖、刷完叫醒她、顺手回高分帖；把日报发到哪个板块（单选）、标题、原帖链接、每天上限；按钮：预览选题 / 跑一轮（不真发）/ 现在发一篇 / 看最新日报 |
| 6 | 安全阀 | 两次写之间隔、每小时/每天上限，所有出网共用这一份额度账本 |

卡片 4、5 顶上各有一排**模式卡**（只回 @ / 两个都要 / 只刷不发 / 先关着），点一下就同时改 `listen.enabled` 与 `browse.enabled`，不用分别进两张卡找开关。当前态由这两个布尔反推，选中项只靠边框与标题变色表示。

版式照 `dsh-bili-whale` 的设置页来：没有卡片阴影、没有彩色图标块。每行左边标签 + 灰字提示，右边控件。**卡片之间靠圆角深灰背景块分开**（`.hks-card`：`border-radius:12px` + `background:var(--dsw-alias-interactive-bg-active)`，容器 `gap:10px`），**不用分割线**；卡片标题行是「序号圆点 + 标题 + 右侧开关」。输入框是透明底 + 1px 细边（不是填色块），开关 36x20，按钮 30px 高。

页面顶部状态条四枚 chip：`账号` `AI` `回帖` `刷帖`；宿主没有会话能力时多一枚红 chip `叫醒 / 宿主无会话能力`。

**没有保存按钮**：改哪个就存哪个，改动去抖 400ms 后整份配置自动提交，页尾只留一行状态——`改动会自动保存` / `保存中…` / `✓ 已保存` / `✗ 保存失败，改一下会重试`。提交的始终是整份配置，所以没显示的字段不会被抹掉；保存期间继续改，会等这次回来再补一次提交。命令行用法收在最下面的 `命令行用法` 折叠里。

版式约束（改样式时守住）：`.hkw` 宽 720px 封顶、行内右列 `minmax(120px,200px)`、所有控件右边缘同一条线、无横向溢出；字号只有六档、行高全部写死（`[line-height]` 里不许出现 `normal`）；`.hkw` 上必须有 `container-type:inline-size`，窄于 520px 时靠 **`@container`** 而不是 `@media` 降级成单列（`.hks-grid4` 四列降两列）——DSH 设置面板是容器，视口宽度不等于面板宽度（漏了 `container-type` 这行，窄屏不会降级、右列会横向溢出）。

改完的视觉自检：跑 `node --test "tests/ui.test.mjs"` 确认结构没坏（卡片序号连续、字段路径都存在于默认配置、正文里没有 `undefined` / `NaN`、没有保存按钮、点一下开关会自动 POST 一次），再在设置页里缩到 340px 宽看一眼单列降级。上面那组像素值来自一次真实无头浏览器测量，不是渲染时校验的。

写 CSS 时注意：属性选择器的值不能裸写数字，`[data-on=1]` 是非法选择器，整条规则会被浏览器丢掉（开关就一直灰着、滑块不动），必须写成 `[data-on='1']`。

## 测试

```bash
npm test                                  # 等价于下面这条
node --test "tests/*.test.mjs"
```

全部用例都是离线的：出网一律走 `fetch` 桩，不碰 bbs.3839.com。注意 `node --test tests/`（传目录）会 MODULE_NOT_FOUND，要传 glob 并加引号让 node 自己展开。

覆盖：路由 / 设置页归一化 / 刷帖 / 时钟 / 监听去重 / 读预算 / seen.json 并发 / dry-run 不落盘 / 触发器。

`tests/trigger.test.mjs` 在 Node 26 下会挂住不返回，单独跑它自己。

### 自动点赞（写操作，默认全关）

设置页卡片 ⑥「自动点赞」三个开关互相独立、可同时开，合计每轮最多 `like.perRoundMax` 个：

| 开关 | 赞什么 | 字段 |
| --- | --- | --- |
| 浏览过的自动点赞 | 这一轮扫到**并真读过楼层**的帖子，给帖子本身 | `like.browsed` |
| 优质内容自动点赞 | 打分过线的帖子 + 它下面最热的几条评论 | `like.quality` / `like.qualityMinScore` / `like.hotCommentsPerTopic` |
| 回复内容自动点赞 | 评论区 / 楼中楼里别人写的回复（不含她自己的） | `like.replies` |

- **接口**：帖子 `POST bbs.3839.com/index.php?m=api&c=thread&a=threadOperate` `{type:10,state:1,tid}`；
  楼层同一入口 `a=replyOperate` `{fid,tid,replyId,type:1,state:1}`。`state=2` 是取消赞，成功 `code:100`。
- **判重两道**：读帖返回的 `is_up_voted`（未赞实测 `-1`，所以一律 `Number(x) > 0`）+ 本地 `seen.json` 的 `l:t:<tid>` / `l:r:<rid>`。
  自己的帖、自己的楼层、已赞的都不碰。
- **判定方式** `like.qualityJudge`：`score` 用刷帖那套本地打分（不花钱）；`ai` 逐条让模型判「值不值得赞」，
  每轮最多判 `like.aiConfirmMax` 条（每条一次模型调用，明确要花钱）。
- **写额度照旧**：点赞走 `guardedFetch(..., 'write')`，吃「安全阀」的写额度与 `writeGapSec` 写冷却。
  写冷却 120 秒时，一轮 5 个赞会摊开成约 10 分钟——这是设计，不是卡住。
- **回帖时顺手赞**：回完一条，按开关把「刚回的那条内容」赞一次（`watch.mjs` 的 `likeAfterReply`），
  所以只开「自动回帖」不刷帖时，③ 也照样生效。

### 表情（真的会变成图，不是方括号）

快爆的表情在正文里是**自闭合短标签**，不是 `[微笑]`：

```
这个先祖在哪里啊？求<kb-emoji src="https://bbs.3839app.com/app/static/images/kbface/kbxiaobao014.png" data-value="大哭"/>
```

全链路没有「方括号 → 图片」的转换器，所以 `[微笑]` 永远是字符。程序里这样用：

- 模型只写 `[表情:名字]`（或正文里 `[名字]`，名字在表内才认），由 `tools/lib/emoji.mjs` 的 `render()` 换成真标签。
- **顺序是硬约束**：清洗 → 截断 → `render()`。`ai.mjs` 的 `tidy()` 与 `digest.mjs` 的 `strip()` 都是
  `replace(/<[^>]+>/g,' ')`，先拼标签再清洗 = 表情被删光只剩空格。
- 表在 `tools/lib/emoji-data.mjs`（448 条 / 16 个表情包 / 373 个唯一名，45 个名字跨包重名，索引键是「包+名」）。
  同名取表里第一条，所以「点赞」落到哪个包的图是稳定的、但不等于你手点的那张。
- `emoji.enabled` 关掉时 `render(text,{max:0})` 会把 `[表情:x]` 整个删掉，不会把方括号原样发出去。
- **楼中楼（`commentOperate`）能不能带表情还没实测**，所以 `emoji.inComment` 默认关：
  楼层回复带表情，楼中楼退回纯文字。要开就自己在设置页打开，然后发一条看看。

### 设置页搜索

页头标题下多一行搜索框：输入即时筛，**最多 3 条**，每条是「设置项名 · 所属卡片名」
（匹配范围 = 名称 + 说明 + 卡片名；中文子串，英文不分大小写）。点一条 → 滚到那张卡的那个设置行并高亮 1.5 秒；
目标收在「高级」里就只展开它所在的那一个 `details`。Esc 清空。

纯函数 `matchFields(fields, query, limit)` 从 `lib/client.js` 导出，`tests/ui-search.test.mjs` 直接测它（不依赖 DOM）。
