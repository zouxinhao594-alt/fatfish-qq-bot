// 配置：与旧版 config.json 同名字段直接兼容，新增字段带默认值。
// 原则：读失败不静默（沿用旧版教训），坏文件备份成 config.json.bad-<ts>。
//
// 取值优先级（后者覆盖前者）：
//   1. 这里 DEFAULTS 里的默认值
//   2. data/config.json 里存的（控制台「设置」页保存的就是它）
//   3. 环境变量 FATFISH_*（临时覆盖，适合试参数，不会写回文件）
//
// 新增字段时记得去 src/fields.mjs 补一条中文说明 —— 有测试盯着，漏了会红。

import path from 'node:path';
import { readJsonSafe, writeJsonAtomic } from './store.mjs';

export const DEFAULTS = {
  personalityPlasticityEnabled: true,
  personalityLearningEnabled: true,
  personalityHalfLifeDays: 90,
  // —— 模型通道 ——
  apiBase: 'https://api.deepseek.com/v1',
  apiKey: '',
  model: 'deepseek-chat',
  routeChat: '',
  routeGate: '',
  routeMemory: '',
  // 多渠道：每项 {id, name, apiBase, apiKey, api, models:[{id,name,input,contextWindow}]}
  // 路由写成 "渠道id/模型名"；不写渠道就是走上面的默认 apiBase + apiKey。
  // 这一项在控制台「模型」页里管，不在「设置」表单里（太结构化，不适合逐个字段编辑）。
  channels: [],

  // —— 通道 ——
  selfId: '',
  // 关系：ownerUin 就是「主人」。填了它，这个号必回、语气最亲；其他号一律按朋友距离。
  // 多个号用逗号分隔；只认 4 位以上纯数字（填错不会把群友误认成主人）。
  ownerUin: '',
  ownerTitle: '主人',          // 偶尔这样称呼主人（人格里禁的是"亲/宝/老板"，这里单独给主人开口子）
  ownerAlwaysReply: true,      // 主人说话必回：绕过把关打分、主动发言冷却和静默时段
  // 熟人：比群友松（必回、话更多、语气更熟），但仍守静默时段和频率上限
  friendUin: '',               // 熟人 QQ 号，逗号分隔；规则同 ownerUin（只认 4 位以上纯数字）
  closeAlwaysReply: true,      // 熟人说话必回：绕过把关打分和主动发言冷却（不绕静默时段）
  groups: [],
  napcatWs: 'ws://127.0.0.1:3001',
  napcatToken: '',
  consolePort: 3092,

  // —— 门槛 ——
  requireMention: false,
  wakeWords: '鱼,肥鱼,大肥鱼,普鲸,鲸鱼娘,大肥鱼网友',
  relevanceEnabled: true,
  relevanceModel: '',
  relevanceTimeoutSecs: 12,
  perMinute: 6,
  queueMax: 5,
  quietEnabled: false,
  quietStart: '00:30',
  quietEnd: '07:00',

  // —— 自主发言（不 @ 也会自己判断要不要接话）——
  autonomyEnabled: true,
  autonomyThreshold: 7,      // 0~10 的分数线：达到就接
  autonomyChance: 0.5,       // 分数线以下 2 分内的消息，按这个概率掷骰子
  autonomyCooldownSecs: 120, // 主动接话后的冷却，防止连珠炮
  autonomyBypassScore: 8,    // 达到这个分数就无视冷却（"明显在跟它说话"）
  autonomyMaxPerHour: 20,    // 每小时主动发言上限（0=不限）
  gateMaxTokens: 600,        // 把关那一次的 token 预算（模型会先思考，给少了正文为空）

  // —— 主动发起（安静太久时它自己先开口）——
  proactiveEnabled: false,
  proactiveTarget: 'owner',  // owner = 只私聊发给管理员（群里不插话）；group = 发到白名单第一个群
  proactiveIdleMins: 30,     // 安静多少分钟才考虑主动开口
  proactiveCheckMins: 5,     // 每隔多少分钟检查一次
  proactiveChance: 0.25,     // 每次检查时真的开口的概率
  proactiveMaxPerHour: 2,    // 每小时最多主动发起几次
  proactivePrompt: '',       // 留空用内置提示词

  // —— 上下文 ——
  personaFile: 'persona.md',
  personaRolesDir: 'roles',
  maxRecent: 12,
  recentShort: 6,
  contextWindowTokens: 128000,
  contextBudgetRatio: 0.25,
  contextMediaChars: 4000,

  // —— 知识库 / 记忆 ——
  kbDir: '',
  kbTopK: 3,
  kbMaxChars: 900,
  memoryTopK: 3,
  memoryHalfLifeDays: 30,
  memoryMaxPromises: 2,   // 承诺类记忆最多留几条（留太多它就天天追着你要东西）

  // —— 日记（她自己的一天，和"记忆"是两回事）——
  diaryEnabled: true,
  diaryHour: 22,          // 过了这个点、今天还没写，就自己写一条
  diaryMaxChars: 600,     // 单条上限：日记不是作文
  diaryContextCount: 3,   // 注入上下文时带最近几篇
  diaryContextDays: 3,    // 最多跨几天
  // —— QQ空间（日记发到机器人自己的空间，走 SnowLuma 扩展动作）——
  qzoneDiaryEnabled: false,  // 默认关：自动往空间发东西得你自己点头
  qzoneUgcRight: 1,          // 1 所有人可见 / 4 好友 / 16 部分好友 / 64 仅自己 / 128 部分不可见
  // —— 按人记账（同一个人换群换私聊，认识的是同一个人）——
  peopleEnabled: true,
  peopleMaxTopics: 20,    // 每人最多留多少条话题
  peopleMaxTraits: 40,    // 每人最多留多少条"他这个人"
  peopleMaxFacts: 60,     // 每人最多留多少条事实

  // —— 出站治理 ——
  outboundSegmentChars: 1000,
  outboundReplacePaths: true,
  outboundBlockOnSecret: true,
  outboundImageMaxKB: 4096,      // 超过这个体积才退回「发路径」，默认走 base64 内联

  // —— 禁自曝守卫（V2 新增）——
  guardEnabled: true,
  guardModel: '',
  guardRewrite: '我就是群里的大肥鱼呀',
  guardOnFail: 'drop', // drop | rewrite

  // —— 联网抓取（SSRF 闸全开）——
  netEnabled: false,
  netAllowHosts: '',       // 留空 = 不限制域名（仍靠 IP 闸兜底）
  netAllowLoopback: false, // 只在自测时开
  netMaxBytes: 5000000,
  netTextChars: 8000,
  netTimeoutSecs: 10,
  netMaxHops: 2,
  netCacheTtlSecs: 300,

  // —— 联网搜索（让它自己查事实，走 HTTP，不开浏览器）——
  webSearchEnabled: true,
  webSearchEngine: 'so360',  // so360 | bing | sogou | baidu（结果对不上查询就自动换下一个）
  webSearchFallback: true,   // 首选引擎没结果/结果不相关就试下一个
  webSearchTopK: 5,          // 一次拿几条结果
  webSearchChars: 900,       // 塞进 prompt 的搜索块上限
  webSearchReadTop: 1,       // 搜完再打开前几条正文（摘要太短，温度/价格这种查不到）
  webSearchReadChars: 1200,  // 每条正文最多取多少字

  // —— 网易云音乐（PC 客户端，移植自 ai-companion-kit 的 ncm 模块）——
  ncmEnabled: false,        // 网易云（用户选了 QQ音乐，这个默认关掉，想开再开）
  ncmCdpPort: 9222,          // 网易云 PC 版要带 --remote-debugging-port=9222 启动才能点歌

  // —— QQ音乐（搜歌/歌词/热评/下歌都走官方公开接口，不需要装客户端）——
  qqMusicEnabled: true,
  qqMusicCookie: '',        // 下载音频要用：浏览器登录 y.qq.com 后复制 MUSIC_U=...
  qqMusicAutoCookie: true,  // 没手填 cookie 时，自动去本机浏览器里捡
  qqMusicUin: '',           // 可选：QQ音乐里的 uin（cookie 里抠不到时手动填）

  // —— 唱歌（TTS 逐字 + 可选 RVC 换声）——
  ttsTemperature: 1.0,        // GPT-SoVITS 的 temperature（音色包推荐 1.3，情绪起伏更大）
  // —— 唱真歌（Demucs 拆人声 + RVC 换声；路径都在设置页里填）——
  songSingEnabled: true,
  songOwnerOnly: true,          // 点歌/翻唱只有主人能用（吃显卡、跑几分钟，别人不能随便占机器）
  songDefaultSeconds: 60,       // 对方只说"唱首歌"时，默认取多长的一段（0 = 整首，很慢）
  // 换声升调：原曲是男 key 时，不升调换成她的音色也还是男 key，听着不甜。
  songAutoPitch: true,          // 换声前先估原曲音高，自动升到她的音区
  songPitchTargetHz: 300,       // 目标中位音高（她说话约 288 Hz，唱歌略高更甜）
  songPitchMaxUp: 12,           // 最多升 12 个半音（男声原曲常见 +7~+12）
  songPitchMaxDown: 4,          // 最多降 4 个半音（原曲本来就比她还高时）
  // 升调模式：'both' = 人声和伴奏一起升（不跑调，推荐）；'off' = 都不升，保持原调
  // 只升人声不升伴奏 = 整首歌差半音，用户听过说"跑调"，这条就是这么来的。
  songPitchMode: 'both',
  // 高音天花板：升调后高频段（p90）不许超过这个值。超过模型训练音域就会"高音发颤"。
  songPitchCeilingHz: 430,
  // 颤音平滑：RVC 的 f0 中值滤波半径（越大越稳、但咬字会钝一点）
  songFilterRadius: 5,
  // 自动音准：高音发颤/发飘时把音高吸到音阶上（0.4~0.7 比较自然，1 会有电音味）
  songF0Autotune: true,
  songF0AutotuneStrength: 0.6,
  // 音量包络：越小越稳（0.35 是 RVC 常用值）
  songVolumeEnvelope: 0.35,
  // 混音配平：人声拉到这个响度，伴奏固定压在它下面（之前伴奏太吵就是没做这件事）
  songVocalTargetDb: -16,
  songAccompOffsetDb: 6,
  songRefuseText: '',           // 留空用内置话术
  demucsDir: '',                                            // 必填：Demucs 的工作目录（模型/输出都在这）
  demucsPython: '',                                         // 必填：装了 demucs 的那个 python.exe
  demucsModel: 'htdemucs',
  demucsTimeoutSecs: 600,   // 拆人声超时（秒）。卡死的话宁可报错，也别让点歌永远等下去
  singRvcEnabled: true,
  singRvcEndpoint: 'http://127.0.0.1:9885',   // 换声服务地址（CPU 模式，1 秒音频约 5 秒）
  // 换声服务怎么拉起来（可选：填了才走"用时自动起"，否则只能用外部常驻/手动起）
  rvcPython: '',            // 跑 RVC 服务的 python.exe（.venv 里的那个）
  rvcScript: '',            // RVC 服务脚本，比如 sing_rvc_cpu.py 的完整路径
  ffmpegDir: '',            // ffmpeg 的 bin 目录（拉起本地服务时塞进 PATH）

  // —— 网页截图 ——
  ffmpegPath: '',          // ffmpeg 可执行文件；留空自动找（C:\ffmpeg\bin\ffmpeg.exe 或 PATH）
  ffprobePath: '',         // ffprobe 可执行文件；留空自动找（跟 ffmpeg 同目录）
  shotEnabled: false,
  shotBrowserPath: '',     // 留空自动找 Edge/Chrome
  shotWidth: 1280,
  shotHeight: 900,
  shotTimeoutSecs: 20,
  shotKeepFiles: false,

  // —— 表情包 ——
  stickersEnabled: false,
  stickerEagerness: 2,           // 配图积极度：0=少配 1=平衡 2=爱配（情绪表达优先）
  moodEnabled: true,             // 让它有连续的心情状态（影响说话方式和配图）
  moodDecayMins: 30,             // 心情多久淡一档
  stickerCollectEnabled: true,   // 群里有人发表情时自动收进素材库
  stickerCollectMaxKB: 4096,     // 超过这个体积不按表情收（QQ 动图 3~4MB 很常见）
  stickerMatchThreshold: 0.08,   // 挑图命中阈值：低了乱发，高了等于随机
  stickerCollectMaxSide: 800,    // 长边超过这个像素就当照片/长图，不收
  stickerCollectMaxFiles: 500,   // 素材库上限，超了删最老的
  stickersDir: '',         // 留空用 data/stickers

  // —— 拟人化：回复节奏 ——
  humanizeEnabled: true,
  humanDelayBaseMs: 700,      // 读+想的固定开销
  humanDelayPerCharMs: 38,    // 每个字多花的时间
  humanDelayMaxMs: 5500,      // 上限：别让人等太久
  multiMessageGapMs: 850,     // 分成两条发时，中间的停顿
  maxSegments: 2,             // 一条回复最多分几条（真人一般 1~2 条）
  // 连发合并：同一个人在这个时间内连发几条，只回一轮。
  // 没有它的时候，连发 4 条 = 4 个回合并发 = 群里十几条（实测刷屏过）。0 = 不合并。
  mergeWindowMs: 1500,

  // —— 拟人化小动作（真人才有的那些）——
  quoteChance: 0.35,        // 回复时带上"引用对方那条消息"的概率；0 = 永不引用
  splitChance: 0.25,        // 把一句话拆成"先一句短的 + 隔一下再补正文"的概率
  stickerChance: 0.45,      // 每轮真配一张表情的概率（1 = 几乎每轮都配，那样很机械）
  followUpChance: 0.2,      // 主句说完后再补一句的概率（用模型给的 follow 字段）
  avoidOpenerCount: 6,      // 把最近几条自己的开头列进提示词，别老用同一句
  // 多气泡：模型在句子里写 ||| 就是"分几条发"。条数有上限，间隔按手速随机。
  bubbleMax: 3,             // 一轮最多拆几条（超出的并进最后一条，内容不丢）
  bubbleGapMinMs: 700,      // 两条之间的最短停顿
  bubbleGapMaxMs: 2300,     // 两条之间的最长停顿

  // —— 识图 ——
  visionEnabled: false,  visionModel: '',
  visionMaxChars: 400,
  visionPerMinute: 8,   // 一分钟最多看几张（以前 3 张，群里连发图就撞上限，撞了只能不看）
  visionMaxSide: 1280,        // 长边超过这个像素先缩图（体积小但像素巨大也会让接口吐空）
  visionFallbackModels: '',    // 主模型反复失败时的备用视觉模型，逗号分隔

  // —— 生图 ——
  genEnabled: false,
  genBaseUrl: '',
  genApiKey: '',
  genModel: '',
  genSize: '1024x1024',
  genDailyLimit: 0,
  genTimeoutSecs: 60,

  // —— 语音 ——
  ttsEnabled: false,
  ttsEmotionEnabled: true,
  ttsCompactEnabled: true,
  ttsEngine: "sapi",
  ttsEndpoint: "",
  ttsStartScript: "",   // 「按需启动」拉起语音服务用的启动脚本（本机相关，自己填；留空用 tools/start-voice.ps1）
  ttsRefAudio: "",
  ttsRefText: "",
  ttsSpeed: 1,
  ttsTimeoutSecs: 60,
  ttsCacheEnabled: true,
  ttsMaxSeconds: 60,
  ttsPerMinute: 2,
  ttsAllowSapiFallback: false,  // 合成失败不拿 Windows 自带语音顶替（音色不对，比没声音更糟）
  // —— 本地语音/换声服务 ——
  // 默认 false：语音服务**全程常驻**（自己开机自启），机器人随时开口都是她的声音，零等待。
  // 想省内存可以改成 true：用时才拉起、闲置自动关（代价：闲置后第一次要等模型加载 3~4 分钟）。
  voiceOnDemand: false,
  ttsIdleStopMins: 20,        // 只有 voiceOnDemand=true 才有意义：语音合成闲置多少分钟就关掉
  rvcIdleStopMins: 10,        // 换声服务闲置多少分钟就关掉
  ttsStartTimeoutSecs: 420,   // 拉起语音服务最多等多久（实测冷启动要 3~4 分钟）
  rvcStartTimeoutSecs: 150,   // 拉起换声服务最多等多久
  rvcConsolePort: 9887,       // RVC 调音台（tools/rvc-console.mjs）
  rvcConsoleIdleStopMins: 0,  // 调音台闲置多久关（0 = 不自动关，它不吃模型内存）
  ttsVoice: 'Microsoft Huihui Desktop',
  ttsMaxChars: 200,
  ttsKeepFiles: true,
  // 语音自动化：够短的回复可以自己改成语音。
  // 默认 0（只有她说 [语音] / voice:true 才发语音）—— 用户明确说过"不要乱发音频"，
  // 想让它偶尔用嘴说话就调成 0.1~0.2。
  voiceChance: 0,
  voiceMaxChars: 80,     // 超过这个字数就不自动改语音（长段念出来很怪）

  // —— 运行 ——
  dryRun: true, // ★ 默认演练：只记日志不发消息
  dataDir: 'data',
  logKeepDays: 14
};

const ENV_MAP = {
  FATFISH_API_KEY: 'apiKey',
  FATFISH_API_BASE: 'apiBase',
  FATFISH_MODEL: 'model',
  FATFISH_SELF_ID: 'selfId',
  FATFISH_NAPCAT_WS: 'napcatWs',
  FATFISH_NAPCAT_TOKEN: 'napcatToken',
  FATFISH_GROUPS: 'groups',
  FATFISH_PORT: 'consolePort',
  FATFISH_DRYRUN: 'dryRun'
};

function coerce(key, raw) {
  const def = DEFAULTS[key];
  if (key === 'groups') return String(raw).split(',').map((s) => s.trim()).filter(Boolean);
  if (typeof def === 'number') { const n = Number(raw); return Number.isFinite(n) ? n : def; }
  if (typeof def === 'boolean') return !/^(0|false|no|)$/i.test(String(raw).trim());
  if (Array.isArray(def)) return String(raw).split(',').map((s) => s.trim()).filter(Boolean);
  return raw;
}

export function loadConfig(dataDir) {
  const file = path.join(dataDir, 'config.json');
  const parsed = readJsonSafe(file, {});
  const errors = parsed.error ? [parsed.error] : [];
  const disk = parsed.value && typeof parsed.value === 'object' ? parsed.value : {};
  const cfg = { ...DEFAULTS, dataDir };
  for (const k of Object.keys(DEFAULTS)) if (k in disk) cfg[k] = disk[k];
  for (const [env, key] of Object.entries(ENV_MAP)) {
    if (process.env[env] !== undefined && process.env[env] !== '') cfg[key] = coerce(key, process.env[env]);
  }
  if (!Array.isArray(cfg.groups)) cfg.groups = String(cfg.groups || '').split(',').map((s) => s.trim()).filter(Boolean);
  return { cfg, errors, file, backups: parsed.backup ? [parsed.backup] : [] };
}

export function saveConfig(dataDir, cfg) {
  const out = {};
  for (const k of Object.keys(DEFAULTS)) if (k !== 'dataDir') out[k] = cfg[k];
  writeJsonAtomic(path.join(dataDir, 'config.json'), out);
  return out;
}

/** 模型名解析：用途未配置时回落到渠道默认。 */
export function modelFor(cfg, purpose) {
  const key = { chat: 'routeChat', gate: 'routeGate', memory: 'routeMemory' }[purpose];
  const raw = key ? cfg[key] : '';
  const first = String(raw || '').split(',').map((s) => s.trim()).filter(Boolean)[0];
  return first || cfg.model;
}
