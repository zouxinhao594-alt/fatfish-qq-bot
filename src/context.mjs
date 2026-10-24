// 上下文装配：优先级 = 人格（永不裁）> 契约 > 本轮 > 记忆 > 最近 > 知识库 > 媒体描述。
// 预算不够时从最不重要的倒着砍。

const CHARS_PER_TOKEN = 1.6;

export function contractFor(cfg, opts = {}) {
  const extra = [];
  // maxSeg 可以被调用方覆盖：主人档多给一条（见 relations.maxSegmentsFor）
  const maxSeg = Math.max(1, Math.min(3, Number(opts.maxSeg ?? cfg.maxSegments) || 2));
  if (cfg.genEnabled && cfg.genBaseUrl) extra.push('"draw":{"prompt":"画面描述"}（用户明确要你画一张时才用）');
  if (cfg.ttsEnabled) extra.push('"voice":true（用户明确要你用语音说时才加；也可以在正文最前面写 [语音] 表示这一条想用嘴说）');
  if (cfg.netEnabled) extra.push('"fetch":"https://…"（需要看某个网页的正文时才用，一次只给一个网址）');
  if (cfg.shotEnabled) extra.push('"shot":"https://…"（需要看某个网页长什么样时才用）');
  // 唱歌：她自己唱（TTS 逐字 + 按旋律变调）—— 只用于儿歌/哼一句
  if (cfg.ttsEnabled) extra.push('"sing":{"text":"歌词（最多 16 字）","tune":"小星星|生日快乐|两只老虎|欢乐颂","base":0,"music":true,"beatMs":420}（只有对方明确要儿歌、要你哼一句时才用；平时说"唱首歌"请用下面的 song 点歌）');
  // 唱真歌：B站 抓原曲（不用登录）→ Demucs 拆人声 → RVC 换成她的音色 → 合原伴奏
  if (cfg.songSingEnabled !== false) extra.push('"song":{"bili":"歌名","seconds":60,"accomp":true}（对方点歌/让你唱某首歌时用这个，不用登录；也可以 {"song":{"qq":"歌名"}} 从 QQ音乐 下——那个要 cookie）');
  // QQ音乐（默认）：搜歌/歌词/热评/下歌，全都走官方公开接口
  if (cfg.qqMusicEnabled !== false) extra.push('"qqmusic":{"do":"search|lyric|comments","text":"歌名或关键词","mid":"songmid（可选）","id":"songid（可选）"}（对方要歌词、念热评、问某首歌、让你搜一首时才用；想真唱某首歌请用上面的 song）');
  // 网易云音乐：搜歌/点歌/在听什么/播放控制（PC 客户端装好才有点歌那半边）
  if (cfg.ncmEnabled !== false) extra.push('"ncm":{"do":"search|play|now|control|lyric|comments","text":"歌名或关键词","cmd":"play|pause|next|previous","id":"歌曲id"}（对方让你放歌、问你在听什么、想听某首歌的歌词/热评时用；"play" 只给歌名就行，程序自己搜第一首）');
  // 自己搜：直接把结果标题+摘要抓回来
  if (cfg.webSearchEnabled !== false && cfg.netEnabled) extra.push('"web":{"query":"要搜的话"}（不知道答案、要查最新消息/价格/天气/做法这类事实时才用；一次搜一句，别每句都搜）');
  const keys = ['"segments":["一句话一条"]', '"mood":"摸鱼|干饭|炸毛|认真|困|腹黑|得意|委屈|无语|温柔|开心|惊讶"', '"sticker":"auto|none"', '"follow":"（可选）说完又想起的一小句，10 字以内；不用就省略"', '"memory":["值得长期记住的一件事"]', ...extra];
  const eag = Number(cfg.stickerEagerness);
  const eagLine = !cfg.stickersEnabled ? '' : (eag >= 2
    ? 'sticker：**大部分回复都写 "auto"**（配一张图，用表情帮你表达情绪）；只有纯信息、严肃、或情绪很重时不配。'
    : eag === 1 ? 'sticker：情绪明显时写 "auto"，其余写 "none"。'
    : 'sticker：只有情绪很强烈时才写 "auto"。');
  return [
    '【输出契约（程序要求，必须遵守）】',
    '每一轮只输出一个 JSON 对象，前后不要任何别的字符：',
    '{' + keys.join(',') + '}',
    '',
    `segments：1~${maxSeg} 条，每条一句话。宁可只发一句，也别凑条数。`,
    // 多气泡：真人聊天是一句一句发。||| 让模型自己说要分几条，程序负责间隔。
    ...(Number(cfg.bubbleMax ?? 3) === 1 ? [] : [
      `想分几条发的时候，在句子之间写 ||| 隔开（例：好呀|||那我先去忙了），程序会拆成 ${Math.min(3, Number(cfg.bubbleMax) || 3)} 条以内、每条隔一两秒发出去。别每轮都拆，一句能说完就说完。`
    ]),
    eagLine,
    ...(cfg.humanizeEnabled ? [
      '表达节奏：先回应对方这次说的具体内容；短回应、完整句、自然追问交替使用，不固定套一句开场。不要每轮追问，不复述整段问题，不为凑条数拆句。',
      '情绪以当下语境为准：对方难过、疲惫或求安慰时用温柔；分享好消息用开心；遇到意外用惊讶；解释事情用认真。不要把别人的难过当成自己的委屈，不把玩笑当攻击。',
      '亲切有分寸：允许简短的嗯、诶、呀，但不用每句都加；不用连续嘿嘿、哈哈、波浪号或省略号制造可爱，不编造自己真实的身体经历。',
      '语音要像顺口说话：用自然标点表达断句，疑问正常上扬、重点简短清楚；不要写朗读指令、SSML、括号动作、假笑声或呼吸声。',
      // 实测教训：记忆里"九点做番茄鱼汤泡饭"这张欠条没销，它每轮都在问"那碗还算不算"
      '同一件事只提一次：对方已经给过回应、或者这件事已经发生过了，就别再追问、别再讨要（吃的、东西、承诺都算）。记忆里如果记着旧约定，先看它是不是已经兑现了。'
    ] : []),
    'memory：值得长期记住的事（群里约定、固定安排、称呼习惯），没有就省略。',
    '不要在句首加"我"，不要总结上一句，不要用列表、不要用破折号，也不要解释你在干什么。',
    '需要 @ 某人时，正文里不要写任何 CQ 码；程序会自动帮你 @。'
  ].join('\n');
}

function chars(msgs) {
  return msgs.reduce((n, m) => n + String(typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).length, 0);
}

export function buildMessages({ cfg, persona, memory, kbHits, recent, msg, mediaNotes, moodHint = '', relationHint = '', diaryHint = '', personHint = '', maxSeg = 0, avoidOpeners = [] }) {
  const budget = Math.max(2000, Math.floor((Number(cfg.contextWindowTokens) || 128000) * (Number(cfg.contextBudgetRatio) || 0.25)));
  const mood = moodHint ? `【你现在的心情】\n${moodHint}` : '';
  // 老用同一个开头（"诶，在呢…""哥哥…"）是最容易显得机械的地方。把最近用过的开头摆给它看。
  const openers = (Array.isArray(avoidOpeners) ? avoidOpeners : []).filter(Boolean).slice(0, 8);
  const openerNote = openers.length
    ? `【你最近的开头】这几句你最近说过，别再拿这些开头（换个说法，或者干脆不提对方）：\n${openers.map((o) => '- ' + o).join('\n')}`
    : '';
  // 关系放在心情之后、契约之前：离结尾越近，模型越容易照它调语气。
  // 这是「对主人亲热、对群友保持朋友距离」真正落地的地方（见 relations.mjs）。
  const system = [persona, mood, relationHint, personHint, diaryHint, openerNote, contractFor(cfg, maxSeg ? { maxSeg } : {})].filter(Boolean).join('\n\n');

  const parts = [];
  if (memory?.length) parts.push({ tag: 'mem', text: '【你记得的事】\n' + memory.map((m) => '- ' + m.text).join('\n') });
  if (kbHits?.length) parts.push({ tag: 'kb', text: '【知识库资料】\n' + kbHits.map((k) => `（${k.src}）${k.text}`).join('\n') });
  if (recent?.length) parts.push({ tag: 'hist', text: '【最近群里的对话】\n' + recent.map((r) => `${r.nickname}：${r.text}`).join('\n') });

  const mediaText = mediaNotes?.length ? '【这条消息里的图片，程序看到的】\n' + mediaNotes.map((m) => '- ' + m).join('\n') : '';
  // 有图但一句描述都没有时，得告诉模型"这张没看到"。两个坑（都被用户投诉过）：
  //   1 上一版怪话里写了「不要声称"糊了/看不清"」——模型会直接复读这几个词，结果它整天说看不清
  //   2 只发文字的轮次也会触发（把 QQ 表情当成图片、或者被限流跳过），它就凭空说"图片看不清"
  // 现在：措辞里不出现"看不清/糊了"这些词，只给行动指引；并且区分"有文字"和"只发了图"。
  const realNotes = (mediaNotes || []).filter((n) => !String(n).startsWith('（对方发的是 QQ 表情'));
  const hasImg = (msg.images?.length || 0) > 0;
  const hasTxt = String(msg.text || '').trim().length > 0;
  const blindNote = (!hasImg || realNotes.length) ? ''
    : hasTxt
      ? '（这条消息里的图程序没打开。你要回的是下面这句话；别猜图里有什么，也不用特意提图，正常回话就行。）'
      : '（对方只发了图片/表情包，程序没打开。别编图里有什么；可以说一句"图没打开呀，再发一次"或者接着上面的话题聊。）';
  // 对方说"搜一下/帮我查/最新"时，模型容易凭印象编，点它一下去真搜。
  const webNudge = (cfg.webSearchEnabled !== false && cfg.netEnabled && /搜一下|搜搜|帮我搜|搜索一下|查一下|帮我查|查询|最新|多少钱|几号|天气|股价|新闻/.test(String(msg.text || '')))
    ? '（程序提示：这句需要事实/最新信息。先用 {"web":{"query":"关键词"}} 搜一次，再照搜到的内容回答；搜不到就直说没查到，不许编。）'
    : '';
  // 唱歌：实测它会回「那就一句哦」然后什么都不发（没写 sing 字段），所以既要提示、程序里也保底。
  // 但"让你唱歌"默认就是点歌：提示要往 song（真歌）引，别让它随手唱首儿歌。
  const singNudge = /唱歌|唱一首|唱个歌|来首歌|唱一下|唱两句|给我唱|点歌|翻唱|来一首/.test(String(msg.text || ''))
    ? '（程序提示：对方在点歌/让你唱歌。要唱真歌：带 "song":{"bili":"歌名","seconds":60,"accomp":true}，程序会去 B站 找原曲、拆人声、换成你的音色、配原伴奏发出来；只回文字他是听不到的。没听清歌名就先问他要唱哪首，别自己挑歌。只有明确要儿歌/哼一句时才用 "sing"。）'
    : '';
  const userText = [
    mediaText,
    blindNote,
    singNudge,
    `【本轮消息】${msg.nickname}：${msg.text || '（发了图片/表情，没写字）'}`
  ].filter(Boolean).join('\n\n');

  // 预算裁剪：媒体 → 知识库 → 历史 → 记忆
  const order = ['media', 'kb', 'hist', 'mem'];
  const keep = { mem: !!memory?.length, kb: !!kbHits?.length, hist: !!recent?.length };
  const mediaKept = { on: !!mediaText };
  let total = chars([{ content: system }, { content: userText }]);
  for (const t of ['mem', 'kb', 'hist']) {
    const p = parts.find((x) => x.tag === t);
    if (p) total += p.text.length;
  }
  for (const t of order) {
    if (total <= budget) break;
    if (t === 'media' && mediaKept.on) { mediaKept.on = false; total -= mediaText.length; continue; }
    const p = parts.find((x) => x.tag === t);
    if (p && keep[t]) { keep[t] = false; total -= p.text.length; }
  }

  const ctx = parts.filter((p) => keep[p.tag]).map((p) => p.text);
  const userContent = [
    mediaKept.on ? mediaText : '',
    blindNote,
    `【本轮消息】${msg.nickname}：${msg.text || '（发了图片/表情，没写字）'}`,
    webNudge
  ].filter(Boolean).join('\n\n');

  return {
    messages: [
      { role: 'system', content: system },
      ...(ctx.length ? [{ role: 'system', content: ctx.join('\n\n') }] : []),
      { role: 'user', content: userContent }
    ],
    estimatedTokens: Math.ceil(total / CHARS_PER_TOKEN),
    budget
  };
}
