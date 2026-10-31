// 配置项的中文说明书（控制台「设置」页就是照这张表渲染的）。
//
// 为什么单独一个文件：
//   1. 配置项有七十多个，混在页面里改起来容易漏；
//   2. 有了这张表，测试可以断言「每个配置项都有中文名和说明」，不会越加越乱；
//   3. 以后要做"只读视图/文档导出"，直接读这张表。
//
// 字段说明：
//   group   —— 归到哪个分区（见下面 FIELD_GROUPS）
//   label   —— 中文名（人在控制台看到的标题）
//   hint    —— 一句话说明（写清楚"改了会怎样"，而不是复述字段名）
//   type    —— text | password | number | bool | list
//   options —— type=select 时的候选
//   advanced—— 收进「高级」折叠区，日常不用碰
//   unit    —— 数字的单位（秒/字/字节…），只影响显示

/** 控制台「设置」页的分区顺序与分区说明。 */
export const FIELD_GROUPS = [
  { id: 'channel', name: '通道与账号', hint: '机器人怎么连上 QQ —— 这一段配错了就完全收不到消息' },
  { id: 'model', name: '模型与路由', hint: '用哪个模型；聊天 / 把关 / 记忆可以分别指到不同（更便宜的）模型' },
  { id: 'gate', name: '接话规则', hint: '什么情况下它才会开口 —— 白名单群、@ 必回、醒词、静默时段、频率' },
  { id: 'human', name: '拟人节奏', hint: '回复快慢与分条 —— 决定它像不像真人' },
  { id: 'context', name: '上下文与人格', hint: '发给模型的内容怎么拼、留多少预算' },  { id: 'kb', name: '知识库与记忆', hint: '资料放哪、检索几条、记忆能记多久' },
  { id: 'outbound', name: '出站治理', hint: '发出去之前的那一道关：分段、脱敏、把本机路径藏起来' },
  { id: 'guard', name: '禁自曝守卫', hint: '不许说出模型/厂商/技术栈。这是三层防线的第 2、3 层' },
  { id: 'vision', name: '识图', hint: '群友发图时，先让一个视觉模型"看一眼"，把看到的东西转成文字进上下文' },
  { id: 'gen', name: '生图', hint: '让它会画图。要单独配一个 images 接口，和聊天接口不是一回事' },
  { id: 'tts', name: '语音', hint: '通用情绪与节奏控制，可连接本地语音引擎，失败回退 Windows 系统语音' },
  { id: 'net', name: '联网抓取与搜索', hint: '模型说"我去看看这个网页 / 我查一下"，程序代它抓回来再答' },
  { id: 'shot', name: '网页截图', hint: '让浏览器无头截一张图，再交给视觉模型描述' },
  { id: 'stickers', name: '表情包', hint: '模型只说"想配张图"，从你的素材库里挑一张' },
  { id: 'run', name: '运行与安全', hint: '演练模式、控制台端口、日志保留' }
];

/** 每个配置项的中文说明。键名必须和 config.mjs 的 DEFAULTS 一一对应（有测试盯着）。 */
export const FIELDS = {

  personalityPlasticityEnabled: { group: 'context', label: '人格可塑性', type: 'bool', hint: '在底层角色卡上应用后天表达习惯；关闭后不应用、不学习，保留已有记录。' },
  personalityLearningEnabled: { group: 'context', label: '人格成长学习', type: 'bool', hint: '允许真实互动形成习惯。关闭后停止新增学习，已有习惯仍应用并随时间淡化。' },
  personalityHalfLifeDays: { group: 'context', label: '性格习惯淡化周期', type: 'number', unit: '天', hint: '未被强化的习惯与熟悉度在此周期后减半，有效范围14～365天，默认90天；底层性格不变。' },
  ttsCompactEnabled: {group:'tts',label:'紧凑语音',hint:'整段连贯合成，适度提速，压缩超过 250 毫秒的极低能量停顿并修整首尾静音；关闭后恢复原语速情绪规则。情绪关闭时不额外提速，仍可压缩长静音',type:'bool'},
  ttsEmotionEnabled: { group: 'tts', label: '语音情绪', hint: '让语速、音高、轻重与句间停顿跟随回复心情及三档强弱，支持温柔、开心、惊讶等；关闭后使用自然平静语气。不同引擎支持程度不同，失败回退系统语音', type: 'bool' },
  ttsEngine: {"group":"tts","label":"语音引擎","hint":"sapi 离线；local 接兼容 /tts 的本地服务（如 IndexTTS、GPT-SoVITS）；cloud 预留，失败降级 SAPI","type":"text"},
  ttsEndpoint: {"group":"tts","label":"本地语音接口","hint":"回环 HTTP 地址，例如 http://127.0.0.1:9880；也可含 /tts","type":"text"},
  ttsStartScript: { group: 'tts', label: '语音服务启动脚本', hint: '「按需启动」时要用的启动脚本（.ps1 绝对路径，里面写你自己的 GPT-SoVITS 启动命令）；留空则用 tools/start-voice.ps1。不放脚本就关掉按需启动、自己先把 9882 起好', type: 'text', advanced: true },
  ttsRefAudio: {"group":"tts","label":"参考音频","hint":"参考音频绝对路径；是否必填由所选引擎决定，切换音色时一并检查","type":"text"},
  ttsRefText: {"group":"tts","label":"参考原文","hint":"参考音频中实际说出的中文，换音频时同步修改","type":"text"},
  ttsSpeed: {"group":"tts","label":"朗读速度","hint":"0.5 至 2 倍；默认 1；SAPI 使用近似语速","type":"number"},
  ttsTimeoutSecs: {"group":"tts","label":"引擎超时","hint":"每个引擎最多等待多少秒；允许 1 至 300 秒","type":"number"},
  ttsCacheEnabled: {"group":"tts","label":"缓存语音","hint":"相同文本与参数复用；参考文件内容改变会失效；换服务模型后应清理缓存","type":"bool"},
  ttsMaxSeconds: {"group":"tts","label":"语音时长上限","hint":"按实际采样截断，范围 1 至 60 秒；完整文字仍保留","type":"number"},
  ttsPerMinute: {"group":"tts","label":"每群语音频率","hint":"滚动一分钟最多合成几条，含失败尝试；0 关闭；私聊按用户隔离","type":"number"},
  voiceChance: { group: 'tts', label: '自动改语音的概率', hint: '够短的回复（不超过下面那个字数）按这个概率整条改成语音。默认 0 = 只在她说 [语音] 时才发语音；想让她偶尔用嘴说话填 0.1~0.2', type: 'number' },
  voiceMaxChars: { group: 'tts', label: '多长以内才自动改语音', hint: '超过这个字数就不自动改语音（长段念出来像播报）。模型明确要 [语音] 的不受限制', type: 'number', unit: '字' },
  ttsAllowSapiFallback: { group: 'tts', label: '合成失败时用系统自带语音', hint: '默认关：本地引擎没好就不发语音（音色不对比没声音更糟）。打开才会退回 Windows 自带 SAPI', type: 'bool' },
  voiceOnDemand: { group: 'tts', label: '本地语音/换声按需启动', hint: '默认关 = 语音服务全程常驻（自己开机自启），随时开口零等待。开 = 用时才拉起、闲置自动关（省内存，代价是闲置后第一次要等模型加载 3~4 分钟，且要自己配启动脚本）', type: 'bool' },
  ttsIdleStopMins: { group: 'tts', label: '语音服务闲置多久关', hint: '只有开了「按需启动」才有意义：多久没被用过就关掉（分钟）。0 = 不自动关', type: 'number', unit: '分钟' },
  ttsStartTimeoutSecs: { group: 'tts', label: '等语音服务起来的上限', hint: '拉起后最多等多久就放弃（秒）。CPU 上加载 4 个模型实测 4 分钟左右，建议 420 以上', type: 'number', unit: '秒', advanced: true },
  rvcIdleStopMins: { group: 'tts', label: '换声服务闲置多久关', hint: '唱歌换声多久没被用过就关掉（分钟）；0 = 不自动关', type: 'number', unit: '分钟' },
  rvcStartTimeoutSecs: { group: 'tts', label: '等换声服务起来的上限', hint: '拉起 RVC 后最多等多久（秒），一般 20~30 秒就绪', type: 'number', unit: '秒', advanced: true },
  rvcConsolePort: { group: 'tts', label: 'RVC 调音台端口', hint: 'tools/rvc-console.mjs 这个本地调音网页的端口，默认 9887。改完重启机器人生效', type: 'number', advanced: true },
  rvcConsoleIdleStopMins: { group: 'tts', label: '调音台闲置多久关', hint: '0 = 不自动关（调音台不吃模型内存，建议留 0）', type: 'number', unit: '分钟', advanced: true },
  // ── 通道与账号 ──
  napcatWs: { group: 'channel', label: '网关地址', hint: 'OneBot11 正向 WebSocket，默认 ws://127.0.0.1:3001。现在跑的是 SnowLuma；换回 NapCat 也是这个地址', type: 'text' },
  napcatToken: { group: 'channel', label: '网关访问令牌', hint: '网关那边设的 access_token（SnowLuma 面板「配置」里能看到）。没设就留空；填错会连不上（报 JS 101 失败）', type: 'password' },
  selfId: { group: 'channel', label: '机器人 QQ 号', hint: '留空会自动从网关的登录信息里读；填错会导致"@ 我"识别不出来', type: 'text' },
  ownerUin: { group: 'channel', label: '管理员（主人）QQ 号', hint: '填了就等于认主：这个号必回，不受把关打分/冷却/静默限制，语气也最亲；其他人一律按朋友距离。多个号用逗号分隔', type: 'text' },
  ownerTitle: { group: 'channel', label: '怎么称呼主人', hint: '它偶尔会这样叫主人，默认「主人」。别在人格里禁掉的称呼（亲/宝/老板）里选', type: 'text' },
  ownerAlwaysReply: { group: 'gate', label: '主人说话必回', hint: '主人没 @ 你、正处静默时段、把关给了低分，也照回。关掉就和其他人一样走判定', type: 'bool' },
  groups: { group: 'channel', label: '允许说话的群', hint: '白名单，逗号分隔。留空 = 哪个群都不理（不是"所有群都理"，这个坑很多）', type: 'list' },

  // ── 模型与路由 ──
  channels: { group: 'model', label: '多渠道清单', hint: '在控制台「模型」页里管理（从 DSH 导入 / 刷新清单），不在这个表单里逐项编辑', type: 'json', hidden: true },
  apiBase: { group: 'model', label: '接口地址', hint: 'OpenAI 兼容地址，一般以 /v1 结尾，例如 https://api.deepseek.com/v1', type: 'text' },
  apiKey: { group: 'model', label: 'API Key', hint: '只存在本机 config.json；控制台显示成掩码，留空 = 不修改', type: 'password' },
  model: { group: 'model', label: '默认模型', hint: '没有单独指定用途时都用它', type: 'text' },
  routeChat: { group: 'model', label: '聊天用的模型', hint: '真正回话的那一次调用。留空 = 用默认模型', type: 'text' },
  routeGate: { group: 'model', label: '把关用的模型', hint: '判断"这条消息值不值得接话"。每条非 @ 消息都会调一次，建议指便宜模型', type: 'text' },
  routeMemory: { group: 'model', label: '记忆用的模型', hint: '压缩/整理长期记忆时用。留空 = 用默认模型', type: 'text' },

  // ── 接话规则 ──
  requireMention: { group: 'gate', label: '只回 @ 我的', hint: '打开后：没被 @ 就完全不说话（连把关判定都不跑，最省钱也最安静）', type: 'bool' },
  wakeWords: { group: 'gate', label: '醒词', hint: '消息里出现这些词就算在叫它，逗号分隔', type: 'list' },
  relevanceEnabled: { group: 'gate', label: '启用把关判定', hint: '关掉 = 只要在白名单群里、不在静默时段，什么都接（会很吵，也费钱）', type: 'bool' },
  relevanceModel: { group: 'gate', label: '把关模型（单独指定）', hint: '留空 = 用上面「把关用的模型」', type: 'text' },
  relevanceTimeoutSecs: { group: 'gate', label: '把关超时', hint: '超过这个时间就把这条当"不接"处理，避免卡住整条队列', type: 'number', unit: '秒' },
  perMinute: { group: 'gate', label: '每分钟最多说几句', hint: '按群计算。0 = 不限制（不建议，容易被当成刷屏）', type: 'number', unit: '句' },
  queueMax: { group: 'gate', label: '同时处理上限', hint: '同一时间最多几条消息在跑，超出的直接放弃，防止雪崩', type: 'number', unit: '条' },
  quietEnabled: { group: 'gate', label: '夜间静默', hint: '打开后，静默时段内只回 @ 我的，其余不主动接话', type: 'bool' },
  quietStart: { group: 'gate', label: '静默开始', hint: '24 小时制，例如 00:30', type: 'text' },
  quietEnd: { group: 'gate', label: '静默结束', hint: '可以跨零点（比如 00:30 到 07:00）', type: 'text' },
  autonomyEnabled: { group: 'gate', label: '自主发言', hint: '不 @ 也会自己判断要不要接话；关掉就只回 @ 和醒词', type: 'bool' },
  autonomyThreshold: { group: 'gate', label: '接话分数线', hint: '0~10 分里达到多少分才接。7=日常闲聊可接；调到 8 更矜持，调到 6 更爱说话', type: 'number', unit: '分' },
  autonomyChance: { group: 'gate', label: '低分掷骰子概率', hint: '分数线往下 2 分内的消息，按这个概率随机决定接不接（0.5 = 一半机会）', type: 'number' },
  autonomyCooldownSecs: { group: 'gate', label: '主动发言冷却', hint: '主动接话后至少隔多少秒才再主动说话，防止连珠炮', type: 'number', unit: '秒' },
  autonomyBypassScore: { group: 'gate', label: '越过冷却的分数', hint: '达到这个分数就不管冷却直接回（8 分 = 明显在跟它说话 / 在等它回复）', type: 'number', unit: '分' },
  autonomyMaxPerHour: { group: 'gate', label: '每小时主动上限', hint: '0 = 不限。留个上限更像真人', type: 'number', unit: '次' },
  gateMaxTokens: { group: 'gate', label: '把关 token 预算', hint: '把关模型会先思考再输出，预算给少了正文会被截空（实测 60 完全不够，600 稳）', type: 'number', unit: 'token', advanced: true },
  proactiveEnabled: { group: 'gate', label: '主动开话头', hint: '安静太久时，它自己说一句（不是回话，是"找话说"）。默认关，容易显得刻意', type: 'bool' },
  proactiveTarget: { group: 'gate', label: '主动消息发到哪儿', hint: 'owner = 只私聊发给管理员，群里绝不自己插话（更像真人）；group = 发到白名单第一个群（老行为，容易显得刻意）', type: 'select', options: ['owner', 'group'] },
  proactiveIdleMins: { group: 'gate', label: '安静多久才开口', hint: '有这么久没人说话，才考虑主动发起', type: 'number', unit: '分钟' },
  proactiveCheckMins: { group: 'gate', label: '检查间隔', hint: '每隔多少分钟看一次"要不要开口"', type: 'number', unit: '分钟' },
  proactiveChance: { group: 'gate', label: '每次开口概率', hint: '0.25 = 每次检查有 1/4 机会说一句；别指望每次都开口', type: 'number' },
  proactiveMaxPerHour: { group: 'gate', label: '每小时最多开几次', hint: '主动找话最招人烦，建议 2 次以内', type: 'number', unit: '次' },
  proactivePrompt: { group: 'gate', label: '主动发起提示词', hint: '留空用内置的（"随口冒个泡、一句话、不超过 20 字"）。想换风格就写自己的', type: 'text', advanced: true },

  // ── 拟人化节奏 ──
  humanizeEnabled: { group: 'human', label: '拟人节奏', hint: '回复前停顿一下、按字数算打字时间、分条时有间隔。关掉就变成秒回', type: 'bool' },
  humanDelayBaseMs: { group: 'human', label: '基础停顿', hint: '读一遍、想一下的固定开销。700 毫秒比较像人', type: 'number', unit: '毫秒' },
  humanDelayPerCharMs: { group: 'human', label: '每个字加多少', hint: '38 毫秒/字 ≈ 每分钟 90 字，接近真人打字速度', type: 'number', unit: '毫秒' },
  humanDelayMaxMs: { group: 'human', label: '最长停顿', hint: '再长就显假了，也别让人等太久', type: 'number', unit: '毫秒' },
  multiMessageGapMs: { group: 'human', label: '分条间隔', hint: '一句话拆成两条发时，中间停多久', type: 'number', unit: '毫秒' },
  bubbleMax: { group: 'human', label: '最多拆几条', hint: '模型在句子里写 ||| 就是要求分条发。超出的会并进最后一条，内容不丢；填 1 = 不拆', type: 'number', unit: '条' },
  bubbleGapMinMs: { group: 'human', label: '气泡间最短停顿', hint: '分条发时两条之间至少停这么久（真人打完一句要松手）', type: 'number', unit: '毫秒' },
  bubbleGapMaxMs: { group: 'human', label: '气泡间最长停顿', hint: '两条之间最多停这么久；实际值在这个区间里随机', type: 'number', unit: '毫秒' },
  maxSegments: { group: 'human', label: '最多分几条', hint: '真人一般 1~2 条。填 1 = 永远只发一条', type: 'number', unit: '条' },
  mergeWindowMs: { group: 'human', label: '连发合并窗口', hint: '同一个人在这个时间内连发几条，只回一轮（合成一条上下文），不再一句一条地追。0 = 不合并（连发几条就回几轮，会刷屏）', type: 'number', unit: '毫秒' },
  quoteChance: { group: 'human', label: '引用对方消息的概率', hint: '回复时把对方那条消息带成引用，像真人一样。0 = 永不引用；1 = 每条都引用', type: 'number' },
  splitChance: { group: 'human', label: '一句话拆两条的概率', hint: '先发一句短的，隔一下再补正文（真人边想边打）。0 = 不拆', type: 'number' },
  stickerChance: { group: 'human', label: '配表情的概率', hint: '每轮真配一张表情的概率。设 1 会显得机械（每句都配图）', type: 'number' },
  followUpChance: { group: 'human', label: '补一句的概率', hint: '主句说完几秒后，再补一句"对了…"。最像真人，也最难控，默认给得低', type: 'number' },
  avoidOpenerCount: { group: 'human', label: '记住几个旧开头', hint: '把最近几条自己说过的话的开头列进提示词，让它别老用"诶、在呢、哥哥"开头', type: 'number', unit: '条' },

  // ── 上下文与人格 ──
  diaryEnabled: { group: 'context', label: '写日记', hint: '让她每天自己写一条日记（她的一天，不是关于你的事）。会挑角度、不重复已写过的事', type: 'bool' },
  diaryHour: { group: 'context', label: '几点之后写', hint: '过了这个点、今天还没写，就自己写一条。0 = 一过零点就写', type: 'number', unit: '点' },
  diaryMaxChars: { group: 'context', label: '一条日记最多多少字', hint: '日记是短文，不是作文。默认 600', type: 'number', unit: '字' },
  diaryContextCount: { group: 'context', label: '带几篇旧日记进上下文', hint: '回话时注入她最近写的日记，让她"记得自己写过什么"', type: 'number', unit: '篇' },
  diaryContextDays: { group: 'context', label: '旧日记最多跨几天', hint: '只翻最近这几天的，别把日记变成第二本记忆账本', type: 'number', unit: '天' },
  qzoneDiaryEnabled: { group: 'context', label: '日记发到 QQ 空间', hint: '开了以后她写完日记会顺手发一条说说（发在机器人自己的空间）。控制台「空间」页也能手动发', type: 'bool' },
  qzoneUgcRight: { group: 'context', label: '说说的可见范围', hint: '1 所有人可见 / 4 好友可见 / 16 部分好友 / 64 仅自己可见 / 128 部分好友不可见', type: 'number', advanced: true },
  peopleEnabled: { group: 'kb', label: '按人记账', hint: '把记忆挂在 QQ 号上，而不是挂在会话上：同一个人换群、换私聊，它认识的是同一个人', type: 'bool' },
  peopleMaxTopics: { group: 'kb', label: '每人留多少话题', hint: '滚动保留，超了删最老的。这个会进 prompt，别给太大', type: 'number', unit: '条', advanced: true },
  peopleMaxTraits: { group: 'kb', label: '每人留多少条脾气', hint: '“他常熬夜”“嘴上嫌我笨其实一直加功能”这类', type: 'number', unit: '条', advanced: true },
  peopleMaxFacts: { group: 'kb', label: '每人留多少条事实', hint: '他明确告诉过你的信息', type: 'number', unit: '条', advanced: true },
  personaFile: { group: 'context', label: '人格文件名', hint: '相对 data 目录，默认 persona.md。改完保存即生效，不用重启', type: 'text' },
  personaRolesDir: { group: 'context', label: '角色卡目录', hint: '相对 data 目录，默认 roles。里面的每个 *.md 就是一张可切换的人格卡', type: 'text' },
  maxRecent: { group: 'context', label: '带多少条最近对话', hint: '越多越连贯，也越贵。12 条是平衡点', type: 'number', unit: '条' },
  recentShort: { group: 'context', label: '最近对话取多长', hint: '每条只截前面这么多字，防止一段长文占满预算', type: 'number', unit: '字' },
  contextWindowTokens: { group: 'context', label: '模型上下文窗口', hint: '按你用的模型填（例如 128000）。只用来算预算，不会发给模型', type: 'number', unit: 'token' },
  contextBudgetRatio: { group: 'context', label: '上下文最多用多少', hint: '0.25 = 只用窗口的四分之一。超预算时从"媒体描述→知识库→历史→记忆"倒着砍，人格永不砍', type: 'number' },
  contextMediaChars: { group: 'context', label: '媒体描述最多多少字', hint: '图片/截图描述进上下文的上限', type: 'number', unit: '字' },

  // ── 知识库与记忆 ──
  kbDir: { group: 'kb', label: '知识库目录', hint: '留空 = data/kb。放 .md/.txt，按空行分块，每块不超过 900 字命中率最高', type: 'text' },
  kbTopK: { group: 'kb', label: '知识库取几条', hint: '每次最多注入几块资料。3 条通常够，多了反而干扰', type: 'number', unit: '块' },
  kbMaxChars: { group: 'kb', label: '知识库总字数上限', hint: '几块加起来不超过这个数', type: 'number', unit: '字' },
  memoryTopK: { group: 'kb', label: '记忆取几条', hint: '按"重要性 × 时效衰减"排序后取前几条', type: 'number', unit: '条' },
  memoryMaxPromises: { group: 'kb', label: '承诺类记忆最多留几条', hint: '「答应给我做…」这类欠条留太多，它会天天追着你要东西；超了自动挤掉最旧的', type: 'number', unit: '条', advanced: true },
  memoryHalfLifeDays: { group: 'kb', label: '记忆半衰期', hint: '30 天 = 一条记忆 30 天后权重减半。想让旧事更快淡出就调小', type: 'number', unit: '天' },

  // ── 出站治理 ──
  outboundSegmentChars: { group: 'outbound', label: '单条消息最多多少字', hint: '超过就按标点切成多条发，别在群里刷一大段', type: 'number', unit: '字' },
  outboundReplacePaths: { group: 'outbound', label: '隐藏本机路径', hint: '把 C:\\... 这类路径换成 <路径>，避免把电脑结构说出去', type: 'bool' },
  outboundImageMaxKB: { group: 'outbound', label: '图片内联上限', hint: '超过这个体积就退回「发路径」，默认用 base64 内联（NapCat 不认 file:/// 路径）', type: 'number', unit: 'KB', advanced: true },
  outboundBlockOnSecret: { group: 'outbound', label: '拦截密钥', hint: '识别 sk-... / Bearer / apiKey= 并打码，防止把密钥发进群', type: 'bool' },

  // ── 禁自曝守卫 ──
  guardEnabled: { group: 'guard', label: '开启守卫', hint: '关掉它，模型就会自己说"我是 DeepSeek"这类话', type: 'bool' },
  guardModel: { group: 'guard', label: '守卫判定模型', hint: '留空 = 可疑即拦（宁可少说一句）；填了就用这个便宜模型判"这句是不是在自曝"', type: 'text' },
  guardRewrite: { group: 'guard', label: '被拦后的替换话术', hint: '守卫模式选"改写"时，用这句替换被拦的内容', type: 'text' },
  guardOnFail: { group: 'guard', label: '被拦后怎么处理', hint: 'drop = 这条不发；rewrite = 换成上面那句无害的话术再发', type: 'select', options: ['drop', 'rewrite'] },

  // ── 识图 ──
  visionEnabled: { group: 'vision', label: '开启识图', hint: '要求 visionModel 指向真正支持图片输入的通道，否则会空转', type: 'bool' },
  visionModel: { group: 'vision', label: '视觉模型', hint: '留空 = 用默认模型。注意：不是所有模型都能收图', type: 'text' },
  visionMaxChars: { group: 'vision', label: '描述最多多少字', hint: '太长会挤占上下文', type: 'number', unit: '字' },
  visionMaxSide: { group: 'vision', label: '最大边长', hint: '超过这个像素先缩图再送模型（体积小但像素巨大的图特别容易让接口返回空）', type: 'number', unit: 'px', advanced: true },
  visionFallbackModels: { group: 'vision', label: '备用视觉模型', hint: '主模型反复失败时换它试，逗号分隔；留空只用一个', type: 'text', advanced: true },
  visionPerMinute: { group: 'vision', label: '每分钟最多看几张', hint: '看图要花钱，这是限流。超出的图仍会记进上下文，只是这次不描述', type: 'number', unit: '张' },

  // ── 生图 ──
  genEnabled: { group: 'gen', label: '开启生图', hint: '打开后，模型可以提议画图；仍然只在用户明确要求时才会用', type: 'bool' },
  genBaseUrl: { group: 'gen', label: '生图接口地址', hint: 'OpenAI images 兼容，例如 https://api.xxx.com/v1（程序会拼 /images/generations）', type: 'text' },
  genApiKey: { group: 'gen', label: '生图 Key', hint: '留空 = 复用聊天那个 apiKey', type: 'password' },
  genModel: { group: 'gen', label: '生图模型', hint: '例如某个具体的绘图模型名；留空则由接口自己选默认', type: 'text' },
  genSize: { group: 'gen', label: '图片尺寸', hint: '常见 1024x1024 / 1024x1536；具体支持哪些看你的接口', type: 'text' },
  genDailyLimit: { group: 'gen', label: '每天最多画几张', hint: '0 = 不限制（建议设一个，生图最费钱）', type: 'number', unit: '张' },
  genTimeoutSecs: { group: 'gen', label: '生图超时', hint: '生图通常 10~30 秒，这里给足余量', type: 'number', unit: '秒' },

  // ── 语音 ──
  ttsEnabled: { group: 'tts', label: '开启语音', hint: '用 Windows 自带 SAPI 离线合成 wav，再作为语音条发出', type: 'bool' },
  ttsVoice: { group: 'tts', label: '音色', hint: '留空用系统默认；填系统里已装的中文语音名（控制面板→语音）', type: 'text' },
  ttsMaxChars: { group: 'tts', label: '语音最长多少字', hint: '太长会截断。QQ 语音单条有时长上限', type: 'number', unit: '字' },
  ttsKeepFiles: { group: 'tts', label: '保留合成的音频', hint: '留着便于排查"为什么没声音"；不占多少空间', type: 'bool' },

  // ── 联网 ──
  netEnabled: { group: 'net', label: '开启联网抓取', hint: '模型可以要求看某个网页，程序代抓正文再答', type: 'bool' },
  netAllowHosts: { group: 'net', label: '允许的域名', hint: '逗号分隔，留空 = 不限制域名（仍会拦内网地址）。想更严就填几个常用站点', type: 'list' },
  netMaxBytes: { group: 'net', label: '单页最大字节', hint: '防止抓到一个巨大的文件把内存撑爆', type: 'number', unit: '字节', advanced: true },
  netTextChars: { group: 'net', label: '正文最多取多少字', hint: '抓回来只留前这么多字给模型看', type: 'number', unit: '字', advanced: true },
  netTimeoutSecs: { group: 'net', label: '抓取超时', hint: '超时就当没抓到，照常回话', type: 'number', unit: '秒', advanced: true },
  netMaxHops: { group: 'net', label: '最多跟几次跳转', hint: '每跳都会重新做一次安全检查', type: 'number', unit: '次', advanced: true },
  netCacheTtlSecs: { group: 'net', label: '抓取缓存时间', hint: '同一网址在这个时间内重复问，直接用缓存，不重复抓', type: 'number', unit: '秒', advanced: true },
  netAllowLoopback: { group: 'net', label: '允许访问本机地址', hint: '只给自测用。打开后模型能读你本机服务，生产环境别开', type: 'bool', advanced: true },

  // ── 联网搜索（自己搜东西）──
  webSearchEnabled: { group: 'net', label: '开启联网搜索', hint: '模型遇到要查事实的问题时，自己去搜一句再答（走 HTTP，不开浏览器）', type: 'bool' },
  webSearchEngine: { group: 'net', label: '搜索用哪个引擎', hint: 'so360 对中文长尾（菜名、教程）最准；bing 快但长尾偶尔给不相干的结果，会给自动跳过', type: 'select', options: ['so360', 'bing', 'sogou', 'baidu'] },
  webSearchFallback: { group: 'net', label: '没结果时换引擎再试', hint: '首选引擎解析不到结果就自动试下一个', type: 'bool' },
  webSearchTopK: { group: 'net', label: '一次取几条结果', hint: '取太多会把 prompt 撑满', type: 'number', unit: '条', advanced: true },
  webSearchChars: { group: 'net', label: '搜索块最多多少字', hint: '塞给模型的搜索结果上限，超出截断', type: 'number', unit: '字', advanced: true },
  webSearchReadTop: { group: 'net', label: '顺手读几条正文', hint: '搜索摘要常常只有一句话（查温度/价格查不到），再打开前几条正文才查得准。0 = 不读', type: 'number', unit: '条', advanced: true },
  webSearchReadChars: { group: 'net', label: '正文最多取多少字', hint: '每条正文只留前这么多字，别把 prompt 撑满', type: 'number', unit: '字', advanced: true },

  // ── 网易云音乐 ──
  songSingEnabled: { group: 'tts', label: '唱真歌（Demucs 拆人声）', hint: '给一个音频文件，拆出人声换成她的音色，再和原伴奏合起来。歌放 data/songs/', type: 'bool' },
  songOwnerOnly: { group: 'tts', label: '点歌只有主人能用', hint: '跑一首歌要几分钟显卡，群里谁都能点会被人玩坏。关掉就是所有人可点', type: 'bool' },
  songDefaultSeconds: { group: 'tts', label: '点歌默认取多长', hint: '只说"唱首歌"没给秒数时，取这么长一段（秒）。0 = 整首，CPU 上要跑很久', type: 'number', unit: '秒' },
  songRefuseText: { group: 'tts', label: '别人点歌时怎么回', hint: '留空用内置话术。别写长句，群里一句话带过就行', type: 'text' },
  songAutoPitch: { group: 'tts', label: '换声自动升调', hint: '男声原曲不升调，换成她的音色也还是男 key（听着不甜）。开着会先估原曲音高再升到她的音区', type: 'bool' },
  songPitchTargetHz: { group: 'tts', label: '升调到多少 Hz', hint: '她说话约 288 Hz；唱歌略高会更甜，300 左右合适。调太高会有卡通感', type: 'number', unit: 'Hz' },
  songPitchMaxUp: { group: 'tts', label: '最多升几个半音', hint: '男声原曲一般要 +7~+12。别超过 12，再多会发尖', type: 'number', unit: '半音', advanced: true },
  songPitchMaxDown: { group: 'tts', label: '最多降几个半音', hint: '原曲本来就比她高时最多降这么多，降太多会闷', type: 'number', unit: '半音', advanced: true },
  songF0Autotune: { group: 'tts', label: '自动音准（压高音发颤）', hint: '把换声后的音高吸附到音阶上。高音发颤/发飘时开着最有用；关掉会更自然但更容易飘', type: 'bool' },
  songF0AutotuneStrength: { group: 'tts', label: '音准吸附强度', hint: '0.4~0.7 自然；1 会明显电音味。默认 0.6', type: 'number' },
  songPitchCeilingHz: { group: 'tts', label: '高音上限', hint: '升调后高音段不许超过这个 Hz（超过模型音域会发颤）。默认 430', type: 'number', unit: 'Hz' },
  songFilterRadius: { group: 'tts', label: '颤音平滑', hint: 'RVC 的 f0 中值滤波半径：0~7，越大高音越稳，但咬字会钝一点，默认 5', type: 'number' },
  songVolumeEnvelope: { group: 'tts', label: '音量包络', hint: '越小越稳（喘气声少），默认 0.35。高音发抖时可以先降到 0.2', type: 'number' },
  songPitchMode: { group: 'tts', label: '升调方式', hint: 'both = 人声和伴奏一起升（推荐，不跑调）；off = 都不升。只升人声会让整首歌差几度音', type: 'text' },
  songVocalTargetDb: { group: 'tts', label: '人声配平响度', hint: '先把人声拉到这个响度（dBFS），再定伴奏。默认 -16', type: 'number', unit: 'dB', advanced: true },
  songAccompOffsetDb: { group: 'tts', label: '伴奏压多少', hint: '伴奏比人声低多少 dB。默认 6；觉得伴奏还是吵就调到 8~10', type: 'number', unit: 'dB' },
  demucsDir: { group: 'tts', label: 'Demucs 目录', hint: '模型和输出都放这里，必须自己填（建议放非系统盘，例如 D 盘下建一个 Demucs 目录）；留空就唱不了真歌', type: 'text', advanced: true },
  demucsPython: { group: 'tts', label: 'Demucs 的 Python', hint: '装了 demucs 的那个 venv 里的 python.exe（没填就唱不了真歌）', type: 'text', advanced: true },
  demucsTimeoutSecs: { group: 'tts', label: '拆人声超时', hint: 'Demucs 超过这个秒数还没跑完就报错放弃（默认 600）。别设太小，整首歌在 CPU 上要一两分钟', type: 'number', unit: '秒', advanced: true },
  demucsModel: { group: 'tts', label: 'Demucs 模型', hint: 'htdemucs 是默认的（人声/伴奏两轨）；换模型要下新权重', type: 'text', advanced: true },
  ttsTemperature: { group: 'tts', label: '语音情绪起伏', hint: 'GPT-SoVITS 的 temperature：0.6~1.3，越大起伏越大（音色包推荐 1.3）', type: 'number', advanced: true },
  singRvcEnabled: { group: 'tts', label: '唱歌时用 RVC 换声', hint: '逐字合成后过一遍 RVC（胡桃模型），音色更像真人；慢约 5 倍实时，关了就是原始逐字唱', type: 'bool' },
  singRvcEndpoint: { group: 'tts', label: 'RVC 换声服务', hint: '换声服务地址（默认 http://127.0.0.1:9885）；用 CPU 模式（GPU 模式实测反而慢 50 倍）', type: 'text', advanced: true },
  rvcPython: { group: 'tts', label: 'RVC 服务的 Python', hint: '想让它按需自动拉起换声服务时填：装了 RVC 依赖的 venv 里的 python.exe；留空 = 只能你自己先把服务起好', type: 'text', advanced: true },
  rvcScript: { group: 'tts', label: 'RVC 服务脚本', hint: '换声服务启动脚本的完整路径（比如 sing_rvc_cpu.py）；跟上一项一起填才生效', type: 'text', advanced: true },
  ffmpegDir: { group: 'tts', label: 'ffmpeg 目录', hint: 'ffmpeg 的 bin 目录；拉起本地语音/换声服务时会加进 PATH。留空就用系统 PATH 里的', type: 'text', advanced: true },
  qqMusicCookie: { group: 'net', label: 'QQ音乐 Cookie', hint: '要下歌换人声就得填：浏览器登录 y.qq.com → F12 → 应用 → Cookie → 复制 MUSIC_U=… 这一整段', type: 'password' },
  qqMusicAutoCookie: { group: 'net', label: '自动从浏览器读 cookie', hint: '没手填 cookie 时，自动去本机 Edge/Chrome 里找 MUSIC_U（浏览器要登录过 y.qq.com 且最好关掉）', type: 'bool', advanced: true },
  qqMusicUin: { group: 'net', label: 'QQ音乐 uin', hint: '可选；cookie 里抠不到 uin 时手动填（音乐账号的数字 ID）', type: 'text', advanced: true },
  qqMusicEnabled: { group: 'net', label: '开启QQ音乐', hint: '搜歌、歌词、热评随时能用；装了 cookie 还能下歌给她唱', type: 'bool' },
  ncmEnabled: { group: 'net', label: '开启网易云音乐', hint: '她能搜歌、报歌词、看热评；装了 PC 版客户端还能替你点歌、说出现在在听什么', type: 'bool' },
  ncmCdpPort: { group: 'net', label: '网易云调试端口', hint: 'PC 客户端要用 --remote-debugging-port=9222 启动，端口对上才能点歌', type: 'number', unit: '端口', advanced: true },

  // ── 截图 ──
  ffmpegPath: { group: 'vision', label: 'ffmpeg 路径', hint: '动图（GIF/WebP）要先转成 PNG 才能被看懂；留空自动找', type: 'text', advanced: true },
  ffprobePath: { group: 'vision', label: 'ffprobe 路径', hint: '判断表情包尺寸要用它；留空自动找（跟 ffmpeg 同目录），再不行就用 PATH 里的', type: 'text', advanced: true },
  shotEnabled: { group: 'shot', label: '开启网页截图', hint: '需要本机有 Edge 或 Chrome', type: 'bool' },
  shotBrowserPath: { group: 'shot', label: '浏览器路径', hint: '留空自动找 Edge/Chrome；找不到时在这里直接指到 msedge.exe', type: 'text' },
  shotWidth: { group: 'shot', label: '截图宽度', hint: '', type: 'number', unit: 'px', advanced: true },
  shotHeight: { group: 'shot', label: '截图高度', hint: '', type: 'number', unit: 'px', advanced: true },
  shotTimeoutSecs: { group: 'shot', label: '截图超时', hint: '无头浏览器启动慢，给 20 秒比较稳', type: 'number', unit: '秒', advanced: true },
  shotKeepFiles: { group: 'shot', label: '保留截图文件', hint: '不保留的话 10 分钟后自动删', type: 'bool', advanced: true },

  // ── 表情包 ──
  stickerCollectEnabled: { group: 'stickers', label: '自动收表情', hint: '群里有人发表情时自动存进素材库，用看图描述当标签，以后能按话题挑出来发', type: 'bool' },
  stickerMatchThreshold: { group: 'stickers', label: '挑图命中阈值', hint: '话题和标签的相似度达到这个比例才发。低了容易乱发，高了基本等于随机', type: 'number', advanced: true },
  stickerCollectMaxKB: { group: 'stickers', label: '多大的不当表情收', hint: '超过这个体积就当照片处理，不进素材库', type: 'number', unit: 'KB' },
  stickerCollectMaxSide: { group: 'stickers', label: '长边多大算照片', hint: '长边超过这个像素就不算表情（照片、长截图）', type: 'number', unit: 'px', advanced: true },
  stickerCollectMaxFiles: { group: 'stickers', label: '素材库上限', hint: '超了自动删最老的', type: 'number', unit: '张', advanced: true },
  stickerEagerness: { group: 'stickers', label: '配图积极度', hint: '0=只在很明显时配 1=平衡 2=爱配（情绪表达优先，推荐）', type: 'number' },
  moodEnabled: { group: 'gate', label: '有心情', hint: '给它一个连续的情绪状态：被夸会得意、被骂会委屈、深夜会困，心情会影响说话方式和配图', type: 'bool' },
  moodDecayMins: { group: 'gate', label: '心情多久淡一档', hint: '情绪会自己冷下来，不然会一直炸毛', type: 'number', unit: '分钟', advanced: true },
  stickersEnabled: { group: 'stickers', label: '开启表情包', hint: '模型说"想配张图"时，从素材库挑一张发出去', type: 'bool' },
  stickersDir: { group: 'stickers', label: '素材目录', hint: '留空 = data/stickers；文件名里带关键词更容易被选中', type: 'text' },

  // ── 运行与安全 ──
  dryRun: { group: 'run', label: '演练模式', hint: '★ 打开时：收消息、走完整流程、写日志，但一条都不发。第一次上线前保持打开', type: 'bool' },
  consolePort: { group: 'run', label: '控制台端口', hint: '被占用会自动往后试。改完要重启生效', type: 'number' },
  logKeepDays: { group: 'run', label: '日志保留天数', hint: '', type: 'number', unit: '天', advanced: true }
};

/** 按分区把配置项分组，控制台直接用这个结构渲染（hidden 的项不渲染，走各自的专用页面）。 */
export function fieldsByGroup() {
  return FIELD_GROUPS.map((g) => ({
    ...g,
    fields: Object.entries(FIELDS)
      .filter(([, m]) => m.group === g.id && !m.hidden)
      .map(([key, m]) => ({ key, ...m }))
  })).filter((g) => g.fields.length);
}
