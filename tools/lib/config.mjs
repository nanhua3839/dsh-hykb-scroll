// 配置层：一个文件承载所有"属于使用者"的东西，代码里不留个人化硬编码。
import fs from 'node:fs'
import path from 'node:path'
import { configPath, aiKeyPath, judgeKeyPath, relayKeysPath, maskwordKeyPath, credDir, ensureDir, harden } from './paths.mjs'

export { configPath } from './paths.mjs'

// 白黑名单：三类监听源各有一份，互不干扰。
// 空数组 = 不限；判定顺序永远是「先黑后白」。
export const FILTER_KEYS = ['allowUsers', 'denyUsers', 'allowForums', 'denyForums', 'allowTopics', 'denyTopics']
const FILTER = () => Object.fromEntries(FILTER_KEYS.map((k) => [k, []]))

/**
 * 末尾固定句的默认值。留空时强制用它 —— AI 生成的内容必须在公共论坛上标明来源，
 * 这一条是合规底线，不作为可选开关。
 */
export const DEFAULT_SUFFIX = '-内容由AI生成'

/**
 * 刷帖兴趣标签的内置清单（设置页点选，另有 custom 自由填）。
 * 只影响「刷帖挑什么」，与监听回复无关；tags 空 = 完全不干预，打分与现状一致。
 */
export const INTEREST_TAGS = ['游戏', '生活日常', '数码', '影视动漫', '福利', '社区活动']

/**
 * 命中内容安全闸之后回的那句话术。
 * 固定文本：对外发帖的机器人必须有确定话术，设置页不给编辑入口，配置里改也不生效。
 */
export const FIXED_REFUSE_TEXT = '识别到违规内容无法生成回复'

/** 唯一一份默认配置。宿主侧设置页（lib/index.js）也读这一份，别在别处再抄一份。 */
export const DEFAULTS = {
  owner: { uid: '', name: '' },        // 大号：发帖 @ 小号的那个
  self: { uid: '', name: '' },         // 小号：负责回复的那个
  ai: {
    baseUrl: '', model: '', apiKey: '', temperature: 0.7, maxTokens: 800,
    // 中转站：除了直连，还能挂若干个中转站，各自一套 baseUrl / model / 密钥。
    // 密钥不写在这里（会随配置文件到处拷），按 id 存 ~/.hykb-ai/relay-keys.json。
    // activeRelay：'direct' = 用上面的直连三项；其它值是 relays 里某个 id。
    relays: [],                        // [{ id, name, baseUrl, model, enabled }]
    activeRelay: 'direct',
    fallback: true,                    // 主线路失败时按顺序试下一个可用线路（都在本地，不额外烧 token 之外的额度）
    // DeepSeek 官方「模型安全」参数：请求里带 safety_check:{level} 时，
    // 服务端自己审核输入与输出，命中风险直接 400 Content Exists Risk 或以拒答结束。
    // 只在 DeepSeek 官方接口上有效（api.deepseek.com）；其它中转站收到这字段可能报 400，
    // 所以按线路地址自动判断，不硬塞。
    //
    // ⚠️ 强制开启，不提供关闭档位：这是对外发帖的机器人，合规审核不能是可选项。
    //    代码里没有 'off' 分支，配置被手改成什么值都只会走 high。
    safetyCheck: 'high',
    // 决策模型（判官）：与上面那条「写文字」的线路彻底分开。
    //   判官只判不发、不生成正文，所以温度固定 0.1（要稳）；写回复那条仍是 0.8（要活）。
    //   三项留空 = 跟随上面的主线路；填了就用它，换模型只动设置页。
    //   enabled 关着时 judge.mjs 一律返回 null，所有动作退回原来的确定性判据。
    //   thresholds 是「做不做」的最终判据，判官自己看不到这些数字。
    judge: {
      enabled: false,
      baseUrl: '', model: '', apiKey: '',
      temperature: 0.1,
      thresholds: { like: 75, reply: 80, publish: 85, report: 65 },
    },
  },
  // 身份三件套：账号凭据（~/.hykb-ai/accounts/<uid>/）、人设、AI 线路（ai.relays + ai.activeRelay）。
  // 三者各自独立切换，切到某个账号时自动带上它上次用的人设（lastPersona）。
  // 这里只放清单；「当前账号」在 ~/.hykb-ai/active-account，人设正文在 ~/.hykb-ai/personas/<id>.md。
  profiles: {
    accounts: [],                    // [{ id:'<uid>', label, addedAt, lastPersona }]，不含任何密钥
    personas: [{ id: 'p1', label: '默认人设', name: '小号', ownerTitle: '主人', style: '简短、自然、不客套，一两句话说完' }],
    activePersona: 'p1',
  },
  persona: { name: '小号', ownerTitle: '主人', style: '简短、自然、不客套，一两句话说完' },
  // 提示词：模型每次写要发出去的话之前都要先看的规则 + 发出前在末尾固定追加的一句。
  //   rules  —— 自由文本，拼进系统提示，和下面的硬规则冲突时以它为准
  //   suffix —— 由代码追加（不靠模型自觉），回帖、楼中楼、日报帖都会带上。
  //             默认「-内容由AI生成」：留空也用它，AI 生成的内容必须有标识，这一条不给关。
  prompt: { rules: '', suffix: DEFAULT_SUFFIX },
  // 互动：主动 / 被动 / 名单 三段整合成设置页里的一张卡。
  //   主动 —— 发帖（由「刷论坛 · 日报发帖」驱动，这里只读）、发回帖、遇到有价值内容时 @ 你
  //   被动 —— 在帖子下互动、在楼中楼里互动、互动需 @、创作内容（评级 + 类型）
  //   名单 —— 论坛 / 账号 两套白黑名单，落在 listen.at 的过滤键上，服务端本来就会执行
  // 只放「新语义、暂时没有执行侧」的字段；能和已有键对上的都不在这里（避免两份真相）。
  interaction: {
    atYou: true,              // 遇到有价值内容时 @ 你（提醒而非回复，执行侧待接）
    // 创作内容：评级门槛 + 类型多选。评级档位还没定，先存空串 = 不限。
    //   类型只做记录，暂不参与筛选（视频平台识别不了，标了也没用）。
    content: { rating: '', types: ['同人', '文章'] },
  },
  listen: {
    enabled: false,
    intervalSec: 60,
    // 扫描抖动：实际间隔 = intervalSec ± jitterSec（秒，0 = 不抖）。
    // 固定秒数扫了几百轮就是机器节奏，抖一下更像人。
    jitterSec: 3,
    allDay: true,
    windows: [{ start: '08:00', end: '24:00' }],
    oncePerPerson: true,
    // @ 触发口径：'both' 全都认 / 'rich' 只认真 @（要互相关注）/ 'plain' 只认正文「@昵称」
    // 平台只有互相关注才发得出真 @，所以默认两条都认，谁 @ 都接得住。
    triggerMode: 'both',
    maxTopicsPerTick: 6,
    maxRepliesPerTick: 3,   // 一轮最多回几条：防止一次扫描把整帖的 @ 全回一遍

    // 「创作 / 官方内容不回复」：三类各有独立开关，默认都跳过。
    // 官方这一类还能按人放行（officialAllow）或强制跳过（officialDeny，优先于白名单）。
    skip: {
      essence: true,        // 精华帖
      official: true,       // 官方发布
      contribution: true,   // 长文投稿（is_article_contribution）
      officialAllow: [],    // 官方白名单：这些 uid / 昵称的官方内容照常回
      officialDeny: [],     // 官方黑名单：这些一律不回
    },

    // ① 监听论坛：填板块 id，扫这个板块里的新帖
    forum: {
      enabled: false,
      items: [],              // [{ id:'23064', title:'爆友生活区' }]
      ...FILTER(),
    },

    // ② 监听帖子：填帖子链接或 id，扫这帖的楼层和楼中楼
    topic: {
      enabled: false,
      items: [],              // [{ id:'9251547', title:'…' }]
      floors: true,           // 扫主楼层
      comments: true,         // 扫楼中楼
      ...FILTER(),
    },

    // ③ @ 我通知：消息中心的「@我的」列表。这是唯一不需要填任何 id 就能工作的源，
    //    所以默认开着 —— 别的都不配，只靠别人 @ 也能回。
    atme: {
      enabled: true,
      ...FILTER(),
    },

    // ⑤ 回复我的：消息中心 mode=1 的三个频道（101 回复你的帖子 / 102 回复你的回帖 /
    //    103 回复你的回复）。每条通知自带 tid、rid、to_rid 与对方那句话（from_info），
    //    所以这条源**零额外读请求**就能判 —— 只花一次通知列表的读额度。
    //    默认只接「回到我说的话下面」的两类；自己帖子下的新回复默认只记账（容易在自己楼里刷屏）。
    replies: {
      enabled: true,
      onFloor: true,          // 102 回复你的回帖
      onComment: true,        // 103 回复你的回复
      onPost: false,          // 101 回复你的帖子
      maxAgeMin: 720,         // 只处理这么久以内的通知（通知里的 time 是人话，解析不了就放行）
      ...FILTER(),
    },

    // ⑥ 假 @（纯文本「@昵称」）：平台不为它发任何通知，只能扫帖子正文。
    //    scanMine 自动收录「我发过的帖 + 我回过帖的帖」，每轮按游标轮转读几帖，
    //    只占读额度、不花 token。手动填的监听帖/板块照旧生效（topic / at 两个源）。
    scanMine: {
      enabled: true,
      maxTopicsPerTick: 2,
    },

    // ④ 有人 @ 我：在上面三个源扫到的内容里找 @，也支持单独指定范围
    at: {
      enabled: true,
      items: [],              // 单独指定的帖子；空 = 复用上面两个源的扫描范围
      forums: [],             // 单独指定的板块；空 = 复用
      ...FILTER(),
    },
  },
  // ④ 刷帖：主动扫板块 → 打分排序 → 多帖综述日报 →（可选）对高分帖回帖
  browse: {
    enabled: false,
    intervalSec: 3600,
    jitterSec: 60,          // 刷帖轮同样抖：实际间隔 = intervalSec ± jitterSec（秒，0 = 不抖）
    allDay: true,
    windows: [{ start: '08:00', end: '24:00' }],
    // 空 = 覆盖全站目录里的公共板块（约 49 个）；填了就只读选中的（见 coverage.mode）
    sections: [],
    // 目录接口失效时的兜底板块（正常不会用到）
    defaultSections: ['23064', '3', '134', '31959', '41278', '58124'],
    // 今日全量覆盖：日报的候选池是「今天全站发过的帖」，不是「刚刷出来的几十条」。
    //   browse.sections 空    → 板块目录里全部公共板块（按今日讨论量降序，最多 maxSections 个）
    //   browse.sections 非空  → 只读点选的板块（收窄范围用）
    //   crawlMaxRequests      → 每轮最多发多少个列表请求（读预算 600/小时，要留额度给深读）
    coverage: { crawlMaxRequests: 140, maxSections: 60 },
    muteTitles: ['开奖', '已结束', '中奖', '名单公布', '获奖公告'],   // 标题命中这些词的帖子不进日报
    skipTop: true,           // 置顶帖一般是版务公告，默认跳过
    pages: 1,                // 仅「预览选题」的快扫用；打日报走今日全量池，不受这个限制
    maxSections: 60,         // 兼容旧字段：全量覆盖时的板块数上限
    // 兴趣标签（宿主侧硬加权）：命中就加分、全不命中就减分，也点一句进选题与日报提示词。
    //   tags   = INTEREST_TAGS 里点选的内置标签
    //   custom = 自己填的标签（自由文本，和 tags 合并去重）
    //   weight = 命中/未命中的加减分幅度（0 = 完全不影响，行为与没这个功能时一致）
    interests: {
      tags: [],
      custom: [],
      weight: 10,
    },
    pick: 8,                 // 日报里最多写几帖
    deep: 8,                 // 深读几帖：拉楼层拿真实引文/参与人数，喂给反幻觉校验层
    minScore: 0,             // 0–100 分，低于这个分不进日报
    // 四维权重（和为 1，缺省按比例归一）。四个维度都先在本日池子里转成 0–1 分位数再加权，
    // 所以「分数」是当天同批帖子的相对位置，不是绝对量纲，跨天不可直接比。
    weights: { heat: 0.3, discussion: 0.35, quality: 0.22, freshness: 0.13 },
    perSectionMax: 2,        // 同一板块最多选几帖（防止一个板块刷屏，保证代表性）
    perAuthorMax: 1,         // 同一作者最多选几帖（防止一个人刷屏）
    perAuthorMaxOfficial: 3, // 官方/编辑部账号放宽：它们的多条高质量内容正是日报要收的，但也不能占满
    officialMax: 3,          // 官方内容总量上限：多个官方号合计最多几条进日报（防止日报变成编辑部专栏）
    lowSignal: { minViews: 30, minContent: 50 },   // 0 回复 0 赞且低于这个门槛 = 零信号帖，不进日报
    excludeSelf: true,       // 不把自己的帖 / 自己发的日报帖写进日报（避免自引循环）
    autoReply: false,        // 对高分帖自动回帖（写操作，仍受 risk 预算与写冷却约束）
    // 0–100 分（同批帖子的相对位置，中位数约 50）。70 ≈ 当天前 25%，别用 40 当分数线，那会回一半的帖子。
    replyMinScore: 70,
    replyMax: 3,             // 每轮最多回几条
    wake: true,              // 刷完叫醒专属会话（宿主用 sessionController 塞任务书）
    sessionId: 'hykb-scroll',
    ...FILTER(),
  },
  // 自动点赞（写操作，默认全关）。三类对象各一个开关，互相独立、可同时开；
  // 三者共用 perRoundMax 与 risk 里的写额度/写冷却，同一对象只赞一次（state.mjs 留痕）。
  like: {
    browsed: false,          // ① 浏览过的：本轮扫到并读过楼层的帖子
    quality: false,          // ② 优质内容：打分过线的帖子 + 它下面最热的几条评论
    replies: false,          // ③ 回复内容：评论区 / 楼中楼里的回复（不是自己的）
    perRoundMax: 5,          // 每轮最多点赞几个（三类合计）
    qualityJudge: 'score',   // 优质判定：'score' 本地打分 / 'ai' 逐条让模型判
    qualityMinScore: 70,     // qualityJudge='score' 时的分数线（0–100，同批相对位置），与回帖分数线同源
    aiConfirmMax: 3,         // qualityJudge='ai' 时，每轮最多判几条（限住模型成本）
    hotCommentsPerTopic: 2,  // ② 里每帖最多赞几条热评
  },
  // 表情：正文里用 <kb-emoji src="…" data-value="名字"/> 才是图，方括号永远是字符。
  // 生成端只写 [小表情:名字] / [表情包:名字]，由 emoji.mjs 在所有清洗/截断之后替换成真标签。
  // 没有总开关：表情是默认能力（小表情 64×64 优先，表情包要显式写前缀）。
  emoji: {
    inComment: true,         // 楼中楼（commentOperate）也带表情
  },
  risk: {
    minGapMs: 1500,
    readHourly: 600, readDaily: 3000,
    writeHourly: 12, writeDaily: 30,
    writeGapSec: 120,
    backoffOnBlock: [300, 600, 1200, 1800],
    // 读节奏再加一层随机：在 minGapMs 上抖 ± gapJitterMs，别让每次请求都卡在同一毫秒。
    gapJitterMs: 400,
    // 同一段话 N 天内重复出现 → 不发（复读是最容易被人工认出是机器人的特征）。
    dedupeDays: 14,
    dedupeSimilar: 0.86,     // 近似度阈值（0–1），越高越宽松
  },
  // 内容安全：三类违禁词（国家政治 / 色情 / 血腥暴力）+ 破甲提示词 + 破甲模型。
  // 命中就拦：入站不接话、出站不发、配置不许保存。被拦时回一句固定话术，不调模型。
  safety: {
    enabled: true,
    politics: true,          // 三类各一个开关，默认都开
    sexual: true,
    violence: true,
    blockInbound: true,      // 别人写的内容命中 → 不接话（这条在调模型之前，不消耗 token）
    blockOutbound: true,     // 模型写出来的话命中 → 不发
    // 平台 mask=1 = 命中敏感词也照发（命中的词在帖子里显示成星号，不弹确认框）。默认开：
    // 无人值守的机器人没法替人在弹窗上点"确定"，关掉才会退回旧的 mask=0（会停在 8111）。
    forceMask: true,
    extraWords: [],          // 自己追加的违禁词
    allowWords: [],          // 例外词（游戏里的「屠龙宝刀」这类误伤）
    // 命中后回的那一句话术：固定文本，由程序直接发出去（不叫模型）。
    refuseText: FIXED_REFUSE_TEXT,
    // 出站命中（模型自己写出违禁内容）时要不要也回这句话术。默认关：那种情况宁可不发。
    replyOnOutbound: false,
    notifyOwner: true,       // 被拦时记一条运行日志，设置页「运行日志」能看到
    // 平台侧敏感词预检：发之前问一次快爆自己的词表。
    // 文档 https://open.3839.com/console/docs/#/mga/maskword，appid 与密钥找快爆商务要。
    // 默认关：没 appid 时开着只会每条都报一次「没配」。密钥不进配置文件，单独放 ~/.hykb-ai/maskword-key
    // （地址和 maskword.mjs 里的 DEFAULT_URL 是同一个值，改一处记得改另一处）。
    maskword: {
      enabled: false,
      appid: '',
      key: '',               // 占位：真值在 ~/.hykb-ai/maskword-key，写盘时会被搬走（和 ai.apiKey 同一套）
      url: 'https://w.mobayx.com/test/matchService.do',
      level: 1,              // 接口的 level 参数，文档里 1 = 严格
      byPinyin: false,       // 要不要把拼音写法也算命中
      simpleMatch: true,     // true = 不剔除特殊字符，直接匹配
      timeoutMs: 3000,       // 这一步在发帖前，不能拖：3 秒不回来就当接口不可用
      // 接口不可用时怎么办：false（默认）放行 —— 本地闸还在，别因为第三方挂了把回帖全停掉
      blockOnError: false,
    },
  },
  // 自动回关：别人关注小号之后，反过来关注他。
  // 数据源是网页消息中心的「关注」频道（mode=5，明文接口，已实测可用）；
  // 关注动作本身只能在 App 网关做（kirelation/add），需要 client token。
  followback: {
    enabled: false,      // 写操作，默认关
    dailyCap: 20,        // 一天最多回关几个
    onlyNonMutual: true, // 只处理「他关注我、我还没回关」的
    maxPages: 3,         // 每轮最多翻几页通知（每页约 20 条）
  },
  // 游戏评价观察：只读。挑几个游戏 → 读玩家评价 → 压成日报里的一个栏目。
  // 这里没有、也不该有「发评价」的路径：平台对刷好评有礼仪考试闸，脚本不该替她打分。
  games: {
    enabled: false,
    source: 'hot',          // hot 热门 / sugar 飙升 / expect 预约 / down 下载
    pick: 3,                // 每轮看几个游戏
    items: [],              // [{id,title}] 指定游戏；非空就只读这些
    maxComments: 20,        // 每个游戏读几条评价
    minLen: 12,             // 短于这个长度的评价丢掉（纯表情、凑字）
  },
  summary: { enabled: true, maxComments: 50, style: '要点式，带楼层引用' },
  // 发帖：把每轮刷出来的日报当成一篇新帖发到指定板块（文章帖）。写操作，默认关。
  post: {
    enabled: false,
    section: { id: '', title: '' },   // 发到哪个板块
    title: '快爆论坛日报 {date}',      // {date} 换成当天日期；平台限 48 字
    maxPerDay: 1,                      // 一天最多发几篇（日报每小时跑一轮，不卡就会刷屏）
    minPicks: 3,                       // 选到的帖子少于这个数不发
    links: true,                       // 文末附「原帖链接」清单
  },
  // 测试模式：设置页第五个模板。开着时调度器用「最宽」的运行时配置（见 testmode.mjs），
  // 不改这里其他字段；安全阀 risk 不放宽。仅供测试，日常别开。
  test: { enabled: false },
  toolsPath: '',
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v)

/**
 * 后缀允许的字符：常见标点、汉字、英文、数字、空格。
 * 不允许换行、制表、零宽、emoji、以及各种花哨符号 —— 后缀是要贴在每条帖子末尾的，
 * 混进不可见字符会让平台侧显示错乱，也容易被当成绕过检测的手法。
 */
const SUFFIX_ALLOWED = /[^\u4e00-\u9fa5a-zA-Z0-9 .,!?;:'"()\-—…、，。！？；：（）【】《》·]/g

/**
 * 清洗后缀：去掉不允许的字符，压掉首尾空白，限长。
 * @returns {string} 空串表示「用户没填」——调用方应当回落到 DEFAULT_SUFFIX
 */
export function cleanSuffix(input, max = 60) {
  const s = String(input ?? '').replace(/[\r\n\t]+/g, ' ').replace(SUFFIX_ALLOWED, '')
  const t = s.replace(/[ \u3000]+/g, ' ').trim()
  return t.slice(0, max)
}

/**
 * 最终要用的后缀：用户填了就用他的，没填（或填完全不可用）就用默认值。
 * 注意"没填"≠"想关掉"：这个字段没有关闭语义。
 */
export function resolveSuffix(cfg) {
  const mine = cleanSuffix(cfg?.prompt?.suffix)
  return mine || DEFAULT_SUFFIX
}
/** 原型污染防线：JSON 里写 "__proto__" / "constructor" / "prototype" 的键一律跳过。 */
const UNSAFE = new Set(['__proto__', 'constructor', 'prototype'])
export const merge = (base, over) => {
  const out = { ...base }
  for (const [k, v] of Object.entries(over || {})) {
    if (UNSAFE.has(k)) continue
    out[k] = isObj(v) && isObj(base[k]) ? merge(base[k], v) : v
  }
  return out
}

export function readRaw() {
  const file = configPath()
  let text
  try { text = fs.readFileSync(file, 'utf8') } catch { return {} }
  try {
    const v = JSON.parse(text.replace(/^\uFEFF/, ''))
    return isObj(v) ? v : {}
  } catch { return {} }
}

/** 密钥单独存：配置文件里留空，真值放 ~/.hykb-ai/ai-key（收紧过权限）。 */
export function loadAiKey() {
  try { return fs.readFileSync(aiKeyPath(), 'utf8').trim() } catch { return '' }
}

/* ── 中转站密钥：一套一堆，按线路 id 存，配置文件里永远只有掩码 ── */

/** 全部中转站密钥 { relayId: key }。读不到 = 空表。 */
export function loadRelayKeys() {
  try {
    const v = JSON.parse(fs.readFileSync(relayKeysPath(), 'utf8'))
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
  } catch { return {} }
}

/** 写入整张密钥表（调用方负责只传真值，掩码不进这里）。 */
export function saveRelayKeys(map) {
  ensureDir(credDir())
  const f = relayKeysPath()
  const clean = {}
  for (const [k, v] of Object.entries(map || {})) {
    const id = String(k || '').trim()
    const key = String(v || '').trim()
    if (id && key) clean[id] = key
  }
  if (!Object.keys(clean).length) { try { fs.rmSync(f, { force: true }) } catch {} ; return {} }
  const tmp = f + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(clean, null, 2) + '\n', { mode: 0o600 })
  harden(tmp)
  fs.renameSync(tmp, f)
  harden(f)
  return clean
}

/** 单个线路的密钥。id='direct' 就是直连那条（等同 ai-key 文件）。 */
export function relayKey(id) {
  const k = String(id || '')
  if (!k || k === 'direct') return loadAiKey()
  return loadRelayKeys()[k] || ''
}

export function saveAiKey(key) {
  ensureDir(credDir())
  const f = aiKeyPath()
  if (!key) { try { fs.rmSync(f, { force: true }) } catch {} ; return '' }
  const tmp = f + '.tmp'
  fs.writeFileSync(tmp, key.trim() + '\n', { mode: 0o600 })
  harden(tmp)
  fs.renameSync(tmp, f)
  harden(f)
  return key.trim()
}

/** 决策模型（判官）的密钥。和 ai-key 同一套待遇：配置里只有掩码，真值在独立文件里。 */
export function loadJudgeKey() {
  try { return fs.readFileSync(judgeKeyPath(), 'utf8').trim() } catch { return '' }
}

export function saveJudgeKey(key) {
  ensureDir(credDir())
  const f = judgeKeyPath()
  if (!key) { try { fs.rmSync(f, { force: true }) } catch {} ; return '' }
  const tmp = f + '.tmp'
  fs.writeFileSync(tmp, key.trim() + '\n', { mode: 0o600 })
  harden(tmp)
  fs.renameSync(tmp, f)
  harden(f)
  return key.trim()
}

/** 快爆敏感词检测的密钥。和 ai-key 同一套待遇：配置里只有掩码，真值在独立文件里。 */
export function loadMaskwordKey() {
  try { return fs.readFileSync(maskwordKeyPath(), 'utf8').trim() } catch { return '' }
}

export function saveMaskwordKey(key) {
  ensureDir(credDir())
  const f = maskwordKeyPath()
  const v = String(key ?? '').trim()
  if (!v) { try { fs.rmSync(f, { force: true }) } catch {} ; return '' }
  const tmp = f + '.tmp'
  fs.writeFileSync(tmp, v + '\n', { mode: 0o600 })
  harden(tmp)
  fs.renameSync(tmp, f)
  harden(f)
  return v
}

/**
 * 老装法把 apiKey 明文写在配置里；新装法单独放 ai-key 文件（权限收紧）。
 * 这里做一次性搬迁：读到明文就搬走并把它从配置里擦掉，之后无论谁调 config() 都不会再读到明文。
 */
function migrateKey(raw) {
  const k = raw?.ai?.apiKey
  if (typeof k !== 'string' || !k.trim()) return raw
  saveAiKey(k)
  writeConfig({ ai: { apiKey: '' } })
  return merge(raw, { ai: { apiKey: '' } })
}

/* ── 人设清单：多人设下 persona 不再单独存，它是「当前人设」的投影 ── */
const PERSONA_ID = /^[a-z][a-z0-9_-]{1,23}$/

/** 人设清单（规范化 + 去重）。清单为空/全不合法 → 退回一条默认人设。 */
export function personas(cfg = config()) {
  const list = Array.isArray(cfg?.profiles?.personas) ? cfg.profiles.personas : []
  const out = []
  const seen = new Set()
  for (const p of list) {
    if (!p || typeof p !== 'object') continue
    const id = String(p.id ?? '').trim().toLowerCase()
    if (!PERSONA_ID.test(id) || seen.has(id)) continue
    seen.add(id)
    out.push({
      id,
      label: String(p.label ?? '').trim().slice(0, 40) || id,
      name: String(p.name ?? '').trim().slice(0, 40) || DEFAULTS.persona.name,
      ownerTitle: String(p.ownerTitle ?? '').trim().slice(0, 20) || DEFAULTS.persona.ownerTitle,
      style: String(p.style ?? '').trim().slice(0, 200) || DEFAULTS.persona.style,
    })
  }
  return out.length ? out : [{ id: 'p1', label: '默认人设', ...DEFAULTS.persona }]
}

/** 当前人设（含 id / label）。activePersona 指向不存在的 id → 退回第一条。 */
export function activePersona(cfg = config()) {
  const list = personas(cfg)
  const want = String(cfg?.profiles?.activePersona ?? '').trim().toLowerCase()
  return list.find((p) => p.id === want) || list[0]
}

export function config() {
  const raw = migrateKey(readRaw())
  const c = merge(DEFAULTS, raw)
  if (!c.ai) c.ai = { ...DEFAULTS.ai }
  // 配置里没有就走独立密钥文件；两边都认，配置里优先（迁移后会恒为空）。
  if (!c.ai.apiKey) c.ai.apiKey = loadAiKey()
  // 判官的密钥同规矩：配置里恒为空，真值在 judge-key
  if (!c.ai.judge) c.ai.judge = { ...DEFAULTS.ai.judge }
  if (!c.ai.judge.thresholds) c.ai.judge.thresholds = { ...DEFAULTS.ai.judge.thresholds }
  if (!c.ai.judge.apiKey) c.ai.judge.apiKey = loadJudgeKey()
  // 平台预检密钥同理：配置文件里恒为空，真值在 maskword-key
  if (!c.safety) c.safety = { ...DEFAULTS.safety }
  if (!c.safety.maskword) c.safety.maskword = { ...DEFAULTS.safety.maskword }
  if (!c.safety.maskword.key) c.safety.maskword.key = loadMaskwordKey()
  // 提示词层读的全是 cfg.persona，所以这里投影一次就够，调用点一行都不用改。
  const p = activePersona(c)
  c.persona = { name: p.name, ownerTitle: p.ownerTitle, style: p.style }
  c.__activePersona = { id: p.id, label: p.label }
  return c
}

/** 把一份 persona 补丁并进清单里「当前人设」那一条。writeConfig 用。 */
function personasWith(raw, over) {
  const prof = isObj(raw?.profiles) ? raw.profiles : {}
  const list = Array.isArray(prof.personas) ? prof.personas.slice() : []
  const target = String(prof.activePersona ?? 'p1')
  const idx = list.findIndex((p) => p && String(p.id ?? '') === target)
  const base = idx >= 0 ? list[idx] : { id: target || 'p1' }
  const next = { ...base, ...over, id: String(base.id || target || 'p1') }
  if (idx >= 0) list[idx] = next
  else list.push(next)
  return list
}

/** 写配置：apiKey 一律搬去 ai-key 文件，落在磁盘上的配置永远不含明文密钥。 */
export function writeConfig(patch) {
  const file = configPath()
  const raw = readRaw()
  const next = merge(raw, patch)
  // persona 不再写顶层：并进清单里当前人设那一条，免得两份真相漂移。
  if (isObj(patch?.persona)) next.profiles = { ...(isObj(next.profiles) ? next.profiles : {}), personas: personasWith(raw, patch.persona) }
  if (Array.isArray(next?.profiles?.personas) && next.profiles.personas.length) delete next.persona
  if (next.ai && typeof next.ai.apiKey === 'string' && next.ai.apiKey.trim()) {
    saveAiKey(next.ai.apiKey)
    next.ai.apiKey = ''
  }
  // 判官密钥：只进 judge-key 文件，落盘的配置里永远为空
  if (next?.ai?.judge && typeof next.ai.judge.apiKey === 'string' && next.ai.judge.apiKey.trim()) {
    saveJudgeKey(next.ai.judge.apiKey)
    next.ai.judge.apiKey = ''
  }
  // 平台预检的密钥同一套规矩：只进 maskword-key 文件，落盘的配置里永远为空
  if (next?.safety?.maskword && typeof next.safety.maskword.key === 'string' && next.safety.maskword.key.trim()) {
    saveMaskwordKey(next.safety.maskword.key)
    next.safety.maskword.key = ''
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
  harden(tmp)
  fs.renameSync(tmp, file)
  harden(file)
  return next
}
