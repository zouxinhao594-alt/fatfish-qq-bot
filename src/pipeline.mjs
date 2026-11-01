// 一个回合的全流程（这就是整个机器人最核心的 10 步）：
//   1 收帧（由 onebot.mjs 归一化后送进来）
//   2 去重：self_id:message_id，512 条 / 60 秒窗口
//   3 门槛：白名单群 → 主人 → @必回 → 静默时段 → 醒词 → 相关性判定 → 频率
//   4 看图：图片交给视觉通道描述，变成文字（失败也不挡回话）
//   5 装配：人格（永不裁）+ 心情 + 关系（主人/群友）+ 契约 + 记忆 + 历史 + 知识库 + 本轮消息
//   6 调模型：OpenAI 兼容 /chat/completions，要求返回契约 JSON
//   7 补看：模型说"要看网页/截图"→ 程序代抓 → 回灌 → 再想一次（最多一次）
//   8 守卫：逐条查是否自曝模型/厂商/技术栈，命中按配置丢弃或改写
//   9 出站：CQ→真段、切分、脱敏、路径替换，必要时补表情/生图/语音
//  10 记账：写事件、累 token、把模型说"值得记"的写进长期记忆

import { buildMessages } from './context.mjs';
import { buildOutbound, splitBubbles } from './outbound.mjs';
import { extractJson, normalizeReply } from './llm.mjs';
import { userFacing } from './guard.mjs';
import { modelFor } from './config.mjs';
import { humanizeDelay } from './humanize.mjs';
import { createRelations } from './relations.mjs';
import fs from 'node:fs';

// 这句话是不是在要事实/最新消息（要它去查）——和 context.mjs 里的 webNudge 用同一套词
const ASK_FACTS = /搜一下|搜搜|帮我搜|搜索一下|查一下|帮我查|查询|最新|多少钱|几号|天气|股价|新闻/;
export function wantsWebSearch(text) {
  return ASK_FACTS.test(String(text || ''));
}

/** 从「帮我搜一下今天上海的天气」里抠出搜索词：去掉客套和动词，太短就整句拿去搜。 */
export function queryFromAsk(text) {
  const raw = String(text || '').trim();
  const q = raw
    .replace(/^(麻烦你|麻烦|帮我|给我|你|能不能|可以)?\s*(搜一下|搜搜|搜索一下|搜索|查一下|查查|查询|查)/, '')
    .replace(/[？?。！!，,、\s]+$/g, '')
    .trim();
  return (q.length >= 2 ? q : raw).slice(0, 120);
}

/**
 * 多气泡之间的停顿（毫秒）：真人"打完一句停一下"的手速，0.7~2.3 秒。
 * 导出是为了让单测能直接验范围，不用靠随机。
 */
export function bubbleGap(cfg, rnd = Math.random) {
  const lo = Math.max(120, Number(cfg?.bubbleGapMinMs) || 700);
  const hi = Math.max(lo, Number(cfg?.bubbleGapMaxMs) || 2300);
  return lo + Math.floor(rnd() * (hi - lo));
}

/**
 * 去掉句首的 [语音] 标记（她用它表示"这条想用嘴说"）。
 * 是导出函数，单测直接验，不用把管道整个跑起来。
 */
export function stripVoiceTag(text) {
  return String(text ?? '').replace(/^\s*\[语音\]\s*/, '');
}

/**
 * 从"给我唱首晴天""点歌 起风了""翻唱《晴天》"里抠出歌名。
 * 抠不出来（"唱首歌""来一首"）就返回空串 —— 让程序去问歌名，而不是随手唱一首儿歌。
 * 抠出来像"你说说话"这种句子（带你我他/说/话/语气词）也当没歌名，免得去 B站 乱搜。
 */
export function songNameFrom(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return '';
  const s = raw.replace(/^(?:能不能|可以|麻烦你?|帮我|给我|你|大肥鱼|小鱼|再)\s*/g, '');
  const m = s.match(/(?:点歌|翻唱|唱一首|唱首|唱个|来一首|来首|想听|我要听|唱)\s*[《「"'“”]?\s*([^》」"'“”，。！？!?、\s]+)/);
  let name = m ? m[1] : '';
  if (!name) return '';
  name = name
    .replace(/(?:吧|呗|呀|啊|啦|哦|嘛|好吗|好嘛|可以吗|行吗|好不好|听听|给我听听|谢谢)+$/g, '')
    .replace(/^[《「"'“”]+|[》」"'“”]+$/g, '')
    .trim();
  if (!name || name.length > 40) return '';
  // "唱首歌""来一首"这种只有量词的，不算歌名
  if (/^(?:歌|首歌|一个歌|一首|一下|两句|一段|点儿?|什么|啥|点歌|翻唱|儿歌|童谣)$/.test(name)) return '';
  // 抠出来带"你/我/说/话/语气词"的，多半是半句话（"想听你说说话"），别当歌名
  if (/[你我他她说吗呢吧啊话]/.test(name)) return '';
  return name;
}

/**
 * 这句是不是在要唱歌／点歌。程序靠它决定"这轮别把回话改语音、也别乱配儿歌"。
 * 注意要能接住"唱首晴天""点歌起风了""想听夜曲"这些说法。
 */
export function isSingRequest(text) {
  return /唱歌|唱一首|唱首|唱个|来首歌|来一首|来首|点歌|翻唱|给我唱|唱一下|唱下|唱两句|想听|我要听|哼/.test(String(text ?? ''));
}

/**
 * 只允许"哼一段"的请求（儿歌、随便唱一句）。
 * 这类才走按旋律唱（sing）；"唱首歌""点歌"一律先去点真歌。
 */
export function wantsHum(text) {
  return /哼|儿歌|童谣|随便唱|唱一句|唱两句|来两句|小星星|生日快乐|两只老虎|欢乐颂/.test(String(text ?? ''));
}

export function createPipeline({ cfg, log, llm, gate, persona, memory, kb, guard, caps, transport, mood = null, relations = null, diary = null, people = null, webSearch = null, ncm = null, qqMusic = null, sing = null, song = null, now = () => Date.now(), random = Math.random }) {
  // 关系不传就自己建一个：让单测和老调用方式都不用改
  const rel = relations || createRelations({ cfg, log });

  // —— 拟人化小工具 ——
  /** 概率闸：配置写成 0/1 也要稳，0 一律不发、1 一律发 */
  const chance = (p) => {
    const v = Number(p);
    if (!Number.isFinite(v) || v <= 0) return false;
    if (v >= 1) return true;
    return random() < v;
  };

  /** 把一句话从中间断开，变成"先一句短的 + 剩下"；断不开就返回 null */
  function splitLead(text) {
    const s = String(text || '').trim();
    if (s.length < 10) return null;
    const mid = Math.floor(s.length * 0.45);
    const cut = Math.max(s.lastIndexOf('，', mid), s.lastIndexOf('。', mid), s.lastIndexOf('！', mid), s.lastIndexOf('？', mid), s.lastIndexOf('…', mid));
    if (cut < 2) return null;
    const head = s.slice(0, cut + 1).trim();
    const tail = s.slice(cut + 1).trim();
    if (!head || !tail) return null;
    return [head, tail];
  }

  // 自己的开头用过的说法（"诶""在呢""哥哥"…），交给上下文让它换着说
  const ownOpeners = [];
  function rememberOpener(line) {
    const s = String(line || '').trim();
    if (s.length < 2) return;
    const head = s.slice(0, Math.min(6, s.length));
    ownOpeners.push(head);
    while (ownOpeners.length > Math.max(1, Number(cfg.avoidOpenerCount) || 6)) ownOpeners.shift();
  }
  const avoidOpeners = () => ownOpeners.slice(-Math.max(1, Number(cfg.avoidOpenerCount) || 6));
  const dedup = new Map();       // key -> ts
  const recent = new Map();      // groupId -> [{nickname,text,ts}]
  const metrics = { received: 0, replies: 0, skipped: 0, errors: 0, deduped: 0, sent: 0, inFlight: 0, tokens: 0, turns: 0 };

  function dedupHit(msg) {
    if (!msg.id) return false;
    const key = `${msg.selfId}:${msg.id}`;
    const t = now();
    for (const [k, ts] of dedup) if (t - ts > 60_000) dedup.delete(k);
    if (dedup.has(key)) { metrics.deduped += 1; return true; }
    dedup.set(key, t);
    if (dedup.size > 512) dedup.delete(dedup.keys().next().value);
    return false;
  }

  function pushRecent(msg, own) {
    const k = msg.groupId || 'private';
    const arr = recent.get(k) || [];
    arr.push({ nickname: own ? '我' : msg.nickname, text: String(msg.text || '（图片）').slice(0, 60), ts: now() });
    while (arr.length > (Number(cfg.maxRecent) || 12)) arr.shift();
    recent.set(k, arr);
  }

  async function send(segments, msg) {
    const target = msg.groupId ? { groupId: msg.groupId } : { userId: msg.userId };
    if (cfg.dryRun) {
      log?.event('send', `[演练] ${JSON.stringify(segments).slice(0, 200)}`, { group: msg.groupId, user: msg.userId });
      return { dryRun: true };
    }
    const r = await transport.send(segments, target);
    metrics.sent += 1;
    return r;
  }

  const contentSeen = new Map();  // 内容级去重：groupId|userId|text → 时间（防止同一条被投递多次、id 还不同）
  const selfEcho = [];   // 最近自己发出去的话（防 NapCat 把我们的消息当新消息推回来，形成"我一直回我在"）

  /**
   * 点一首真歌：B站 抓原曲（不用登录）/ QQ音乐（要 cookie）/ data/songs 里的本地文件，
   * 拆人声 → 换成她的音色 → 合原伴奏 → 发一条语音。
   * 返回 true 表示"这一轮的音频预算已经用掉了"，调用方不许再发第二条。
   * 非主人、唱不出来都会给出人话，并且绝不再补第二条音频。
   */
  async function playOneSong(msg, { spec = null, text = '', seconds = 0 } = {}) {
    if (!song) throw new Error('点歌模块没挂载');
    if (cfg.songOwnerOnly !== false && !rel.isOwner(msg.userId)) {
      log?.event('song', `非主人点歌，拒绝：${msg.userId}（${msg.nickname}）`);
      try { await send([{ type: 'text', data: { text: String(cfg.songRefuseText || '点歌只给我主人用，你要听就去找他') } }], msg); } catch { /* 拒的话发不出去也无所谓 */ }
      return false;
    }
    const obj = spec && typeof spec === 'object' ? spec : null;
    const biliName = obj ? String(obj.bili || obj.bilibili || '') : '';
    const qqName = obj ? String(obj.qq || obj.qqmusic || '') : '';
    const localName = String(text || (typeof spec === 'string' ? spec : (obj ? (obj.name || obj.file || '') : ''))).trim();
    const secs = Number(seconds) || (obj ? Number(obj.seconds) : 0) || Number(cfg.songDefaultSeconds) || 60;
    const accomp = obj ? (obj.accomp === true || obj.accompaniment === true) : true;
    try {
      const r = text || biliName
        ? await song.singBili({ text: text || biliName, seconds: secs, accomp })
        : qqName ? await song.singQq({ text: qqName, accomp }) : await song.singSong({ name: localName });
      const file = 'base64://' + fs.readFileSync(r.file).toString('base64');
      await send([{ type: 'record', data: { file } }], msg);
      log?.event('song', `唱完发出去了：${r.source}（${r.seconds} 秒，换声${r.voiced ? '成功' : '失败'}${r.cached ? '，缓存命中' : ''}）`);
      return true;
    } catch (e) {
      log?.event('song', `没唱成：${e.message}`);
      try { await send([{ type: 'text', data: { text: `这首我唱不了：${String(e.message).slice(0, 40)}` } }], msg); } catch { /* ignore */ }
      return false;
    }
  }

  /** 过滤一条原始消息；返回丢弃原因，空串表示要处理。
   *  抽出来是为了"连发合并"：合并前要先按单条去重，合并后就认不出原始 message_id 了。 */
  function prefilter(msg) {
    log?.event("recv", "收到 " + msg.nickname + "（" + msg.userId + "）" + (msg.groupId ? "在群 " + msg.groupId : "私聊") + "：" + String(msg.text || "").slice(0, 40) + (msg.images?.length ? " [图" + msg.images.length + "]" : ""), { group: msg.groupId, user: msg.userId, id: msg.id });
    // 内容级去重：同一个人 45 秒内发同样的话，只处理一次
    // （NapCat 在某些情况下会把同一条消息投递多次，且 message_id 可能不同，靠 id 去重兜不住）
    const ckeyBase = `${msg.groupId || 'priv'}|${msg.userId}|${String(msg.text || '').trim()}`;
    if (String(msg.text || '').trim()) {
      const ts = now();
      for (const [k, v] of contentSeen) if (ts - v > 45_000) contentSeen.delete(k);
      if (contentSeen.has(ckeyBase)) {
        metrics.deduped += 1;
        log?.event('dedup', `同一句话重复到达，丢掉（${String(msg.text).slice(0, 20)}）`, { group: msg.groupId, user: msg.userId });
        return 'dup-content';
      }
      contentSeen.set(ckeyBase, ts);
    }

    // 回声守卫：内容和 90 秒内自己发过的一模一样 → 当成回声丢掉
    const txtNow = String(msg.text || "").trim();
    if (txtNow) {
      const echo = selfEcho.find((e) => e.text === txtNow && now() - e.at < 90_000);
      if (echo) {
        metrics.deduped += 1;
        log?.event("echo", "收到自己刚发过的同一句，丢掉：" + txtNow.slice(0, 20));
        return 'echo';
      }
    }
    if (dedupHit(msg)) { log?.event('dedup', `重复投递，丢弃 message_id=${msg.id}`, { group: msg.groupId }); return 'dedup'; }
    return '';
  }

  async function handle(msg) {
    if (!msg.__prefiltered) {
      metrics.received += 1;
      const why = prefilter(msg);
      if (why) return { replied: false, reason: why };
    }
    pushRecent(msg, false);

    // 关系：这条消息是不是"主人"发的。后面提示词、条数、心情、必回都看它。
    const tier = rel.tierOf(msg.userId);

    // 把关要看到最近几条对话，否则它只能看到孤零零一句，自然判成"别人在聊天"
    const verdict = await gate.decide(msg, { recent: (recent.get(msg.groupId || '') || []).slice(0, -1), tier });
    if (!verdict.reply) { metrics.skipped += 1; log?.event('skip', verdict.reason, { group: msg.groupId, user: msg.userId }); return { replied: false, reason: verdict.reason }; }
    if (verdict.owner) log?.event('relation', `主人说话了，没 @ 也接：${String(msg.text || '').slice(0, 20)}`, { group: msg.groupId, user: msg.userId });

    if (metrics.inFlight >= (Number(cfg.queueMax) || 5)) { log?.event('skip', '队列满了，这条不接'); return { replied: false, reason: '队列满' }; }
    metrics.inFlight += 1;
    try {
      // 心情：先看时间（深夜困/饭点饿），再看这条消息有没有夸/骂/吃的味道
      // 主人这一档：正常说话就把坏情绪拉回来（他骂你除外，那就该委屈）
      const segCap = rel.maxSegmentsFor(tier, cfg.maxSegments);
      if (cfg.moodEnabled !== false && mood) {
        try {
          mood.ambient();
          const ev = mood.observe(msg.text);
          if ((tier === 'owner' || tier === 'close') && !ev) mood.warm();
        } catch { /* 心情坏了不影响回话 */ }
      }
      const mediaNotes = await caps.enrich(msg);
      const growthRole = persona.growthRole?.() || '';
      const growthHint = persona.growth?.hint(growthRole, msg.userId) || '';
      const { messages, estimatedTokens } = buildMessages({
        cfg, persona: persona.text + (growthHint ? '\n\n' + growthHint : ''), memory: memory.topK(), kbHits: kb.search(msg.text || '图片'), recent: recent.get(msg.groupId || 'private'), msg, mediaNotes,
        relationHint: rel.hintFor({ userId: msg.userId, nickname: msg.nickname, groupId: msg.groupId }),
        maxSeg: segCap,
        avoidOpeners: avoidOpeners(),
        // 她最近写的日记：让她"记得自己写过什么"，人味主要来自这里
        diaryHint: (cfg.diaryEnabled !== false && diary) ? (diary.context() || '') : '',
        // 这个人的账：换群换私聊也认识同一个人
        personHint: (cfg.peopleEnabled !== false && people) ? (people.renderPerson(msg.userId) || '') : '',
        moodHint: (cfg.moodEnabled !== false && mood) ? `${mood.hint()}（现在心情：${mood.label()}）` : ''
      });

      let out;
      try {
        out = await llm.chat(messages, { model: modelFor(cfg, 'chat'), maxTokens: 1200, timeoutMs: 45_000, json: true });
      } catch (e) {
        metrics.errors += 1;
        log?.event('llm', `回合失败：${e.message}`);
        if (verdict.mentioned) await send([{ type: 'text', data: { text: userFacing(e) } }], msg);
        return { replied: false, reason: '模型失败' };
      }

      let parsed = normalizeReply(extractJson(out.text), segCap);
      if (!parsed) {
        // 契约失败不等于"不该说话"：模型只要写了人话，就照样发出去（去掉 CQ 码后）
        const plain = String(out.text || '').replace(/```[a-z]*\n?/gi, '').replace(/```/g, '').trim();
        if (plain && !/^\s*\{/.test(plain)) {
          log?.event('llm', `模型没按契约输出，按纯文本发出去：${plain.slice(0, 60)}`);
          parsed = normalizeReply({ segments: [plain] }, segCap);
        } else if (plain) {
          // 看着像 JSON 但解析失败：把里面的字符串捞出来当话
          const salvaged = [...plain.matchAll(/"([^"\\]{2,120})"/g)].map((m) => m[1]).filter((s) => !/^(segments|mood|sticker|memory|action|voice|prompt|fetch|shot|draw)$/.test(s));
          if (salvaged.length) {
            log?.event('llm', `契约 JSON 解析失败，捞回 ${salvaged.length} 段文本`);
            parsed = normalizeReply({ segments: salvaged }, segCap);
          }
        }
      }
      if (!parsed) {
        metrics.errors += 1;
        log?.event('llm', `模型这一轮没有可用内容：${String(out.text).slice(0, 120)}`);
        if (verdict.mentioned) await send([{ type: 'text', data: { text: '哎呀，我刚刚走神了，你再说一遍呀' } }], msg);
        return { replied: false, reason: '契约失败' };
      }

      // 能力补看：模型说"我要看这个网页/这张网页的样子" → 程序代抓 → 回灌 → 再想一次
      const evidence = [];
      if (parsed.action?.fetch && cfg.netEnabled) {
        const r = await caps.fetchUrl(String(parsed.action.fetch));
        evidence.push(r.ok ? `【网页正文】${r.text.slice(0, 3000)}` : `（网页没抓到：${r.error}）`);
      }
      // 自己搜：模型给关键词，程序去必应（百度常反爬就自动换引擎）把结果抓回来
      let didSearch = false;
      const runSearch = async (q) => {
        const query = String(q || '').trim().slice(0, 120);
        if (!query) return;
        try {
          const r = await webSearch.search(query);
          const block = webSearch.render(r, Number(cfg.webSearchChars) || 900);
          if (block) evidence.push(block);
          didSearch = true;
          log?.event('search', `搜「${query}」→ ${r.results?.length || 0} 条`);
          // 摘要往往只有一句话（"天气预报"页面摘要里根本没有温度），
          // 所以再把前几条结果打开读正文 —— 这才是"真的查到了"。
          const readTop = Math.max(0, Math.min(2, Number(cfg.webSearchReadTop ?? 1)));
          for (const hit of (r.results || []).slice(0, readTop)) {
            try {
              const page = await caps.fetchUrl(hit.url);
              if (page.ok && page.text) {
                const body = String(page.text).replace(/\s+/g, ' ').trim().slice(0, Number(cfg.webSearchReadChars) || 1200);
                evidence.push(`【打开第一条：${hit.title.slice(0, 40)}】${body}`);
                log?.event('search', `读了正文：${hit.url} → ${body.length} 字`);
              }
            } catch (e) { log?.event('search', `正文没读到：${e.message}`); }
          }
        } catch (e) {
          evidence.push(`（联网搜索失败：${e.message}）`);
          log?.event('search', `搜「${query}」失败：${e.message}`);
        }
      };
      if (parsed.action?.web && webSearch) {
        const spec = parsed.action.web;
        await runSearch(typeof spec === 'string' ? spec : (spec?.query || spec?.q || spec?.text || ''));
      }
      // 第二层保险：对方明说要"搜/查"，但模型只回了句"我查一下"就结束了（实测就是这样）。
      // 程序替它真搜一次，把结果塞回去让它重答 —— 不然那句"我查一下"就是骗人的。
      if (!didSearch && webSearch && cfg.netEnabled && cfg.webSearchEnabled !== false && wantsWebSearch(msg.text)) {
        await runSearch(queryFromAsk(msg.text));
      }
      // QQ音乐：搜歌/歌词/热评（全都走官方公开接口，不依赖任何客户端）
      if (parsed.action?.qqmusic && qqMusic && cfg.qqMusicEnabled !== false) {
        const spec = parsed.action.qqmusic;
        const op = String(typeof spec === 'string' ? 'search' : (spec?.do || spec?.op || 'search')).trim().toLowerCase();
        try {
          const r = await qqMusic.doOp(op, typeof spec === 'object' ? spec : { text: spec });
          if (op === 'search') {
            const list = (r.songs || []).slice(0, 5).map((s, i) => `${i + 1}. ${s.name} — ${s.singer}《${s.album}》（${s.duration}s，mid ${s.mid}）`).join('\n');
            evidence.push(`【QQ音乐搜索：${r.query}】\n${list || '没搜到'}`);
          } else if (op === 'lyric') {
            evidence.push(`【QQ音乐歌词】${(r.lines || []).slice(0, 12).join(' / ')}`);
          } else if (op === 'comments') {
            const top = (r.hot || []).slice(0, 3).map((c) => `- ${c.user}（${c.likes}赞）：${c.text}`).join('\n');
            evidence.push(`【QQ音乐热评】共 ${r.total} 条\n${top}`);
          } else {
            evidence.push(`【QQ音乐】${op} 完成`);
          }
          log?.event('qqmusic', `${op} 完成`);
        } catch (e) {
          evidence.push(`（QQ音乐 ${op} 没成：${e.message}）`);
          log?.event('qqmusic', `${op} 失败：${e.message}`);
        }
      }      // 网易云：搜歌/点歌/在听什么/播放控制/歌词/热评
      if (parsed.action?.ncm && ncm && cfg.ncmEnabled !== false) {
        const spec = parsed.action.ncm;
        const op = String(typeof spec === 'string' ? spec : (spec?.do || spec?.op || '')).trim();
        try {
          const r = await ncm.doOp(op, typeof spec === 'object' ? spec : { text: spec });
          if (op.toLowerCase() === 'search') {
            const songs = (r.songs || []).slice(0, 5).map((s, i) => `${i + 1}. ${s.name} — ${s.artist}（id ${s.id}）`).join('\n');
            evidence.push(`【网易云搜索：${r.query}】\n${songs || '没搜到'}`);
          } else if (op.toLowerCase() === 'now') {
            evidence.push(r.ok
              ? `【网易云在听】${r.title} — ${r.artist}（${r.playing ? '正在播放' : '暂停'}）${r.lyric ? `，当前这句：「${r.lyric}」` : ''}`
              : `（网易云没在放歌：${r.error || '读不到'}）`);
          } else if (op.toLowerCase() === 'lyric') {
            evidence.push(`【歌词】${(Array.isArray(r) ? r : []).slice(0, 12).join(' / ')}`);
          } else if (op.toLowerCase() === 'comments') {
            const top = (r.hot || []).slice(0, 3).map((c) => `- ${c.user}：${c.text}`).join('\n');
            evidence.push(`【网易云热评】共 ${r.total} 条\n${top}`);
          } else {
            evidence.push(`【网易云】${op} 完成${r.title ? '：' + r.title : ''}`);
          }
          log?.event('ncm', `${op} 完成`);
        } catch (e) {
          evidence.push(`（网易云 ${op} 没成：${e.message}）`);
          log?.event('ncm', `${op} 失败：${e.message}`);
        }
      }
      if (parsed.action?.shot && cfg.shotEnabled) {
        const r = await caps.shotDescribe(String(parsed.action.shot));
        evidence.push(r.ok ? `【网页截图内容】${r.text}` : `（截图失败：${r.error}）`);
      }
      if (evidence.length) {
        try {
          const again = await llm.chat([
            ...messages,
            { role: 'assistant', content: String(out.text).slice(0, 2000) },
            { role: 'user', content: `${evidence.join('\n\n')}\n\n请基于上面的内容重新回答，仍然只输出契约要求的 JSON。` }
          ], { model: modelFor(cfg, 'chat'), maxTokens: 1200, timeoutMs: 45_000, json: true });
          const p2 = normalizeReply(extractJson(again.text), segCap);
          if (p2) { parsed = p2; out = again; }
          log?.event('llm', `补看后重答一次（${evidence.length} 条证据）`);
        } catch (e) {
          log?.event('llm', `补看后重答失败，用第一遍结果：${e.message}`);
        }
      }

      // 守卫：逐条检查，命中按配置处理
      const kept = [];
      for (const seg of parsed.segments) {
        const g = await guard.check(seg);
        if (g.blocked) {
          log?.event('guard', `拦下：${seg.slice(0, 40)}（${g.why}）`);
          if (cfg.guardOnFail === 'rewrite') kept.push(cfg.guardRewrite);
          continue;
        }
        kept.push(seg);
      }
      if (!kept.length) { metrics.skipped += 1; log?.event('skip', '整条回复被守卫拦空，这次不发'); return { replied: false, reason: '守卫拦截' }; }

      // 表情：模型只说"想要"，挑哪张由程序定
      // 挑图的查询：群聊上下文 + 这轮消息 + 它的回话（只用回话命中率太低，实测几乎每次都随机）
      const stickerQuery = (() => {
        const ctx = (recent.get(msg.groupId || '') || []).slice(-4).map((r) => r.text).join(' ');
        return [ctx, msg.text, parsed.segments.join(' ')].filter(Boolean).join(' ');
      })();
      let stickerSeg = null;
      // 配图概率：每轮都配很机械（群里看着像表情机器），按 stickerChance 掷一下
      const wantSticker = parsed.sticker === 'auto' && chance(cfg.stickerChance);
      if (wantSticker) {
        try {
          stickerSeg = caps.stickerSegment(await caps.chooseSticker({ query: stickerQuery, recent: recent.get(msg.groupId || '') || [], reply: parsed.segments.join(' '), mood: (cfg.moodEnabled !== false && mood) ? mood.label() : '' }));
        } catch (e) {
          log?.event('sticker', `配图失败（不影响回话）：${e.message}`);
        }
      }

      // 多气泡：模型在句子里写 ||| 就是"分几条发"的显式要求（真人聊天就这样）。
      // 但条数要有上限 —— 拆过头就是刷屏；超出的并进最后一条，内容不丢。
      const bubbleMax = Math.max(1, Math.min(5, Number(cfg.bubbleMax) || 3));
      const flat = kept.flatMap((s) => splitBubbles(s));
      if (flat.length > bubbleMax) {
        const head = flat.slice(0, bubbleMax - 1);
        const tail = flat.slice(bubbleMax - 1).join('，');
        flat.length = 0;
        flat.push(...head, tail);
      }
      const explicitBubbles = flat.length > kept.length;
      if (explicitBubbles) log?.event('human', `模型要求分 ${flat.length} 条发`);

      // 拆两条：真人常常先甩一句短的再补正文（"诶" + 正经内容）
      let segmentsForOut = flat;
      if (!explicitBubbles && chance(cfg.splitChance) && segmentsForOut.length === 1) {
        const parts = splitLead(segmentsForOut[0]);
        if (parts) {
          segmentsForOut = parts;
          log?.event('human', `把一句话拆成两条：${parts[0]} ／ ${parts[1]}`);
        }
      }

      // —— 音频预算：一轮最多一条音频 ——
      // 踩过的坑：要她唱歌时，模型常常同时写 sing + voice，再加上原来"没写 sing 就替它唱一句"
      // 的兜底，一轮能冒出两三条音频（用户听到的就是"重复乱发音频"）。
      // 现在的规矩：song（点歌）> sing（儿歌哼唱）> voice（说话），三个只允许发一个；
      // 而且"让你唱歌"默认就是点歌 —— 不再随便唱一闪一闪亮晶晶。
      const askedToSing = isSingRequest(msg.text);
      const hasSongAction = !!(parsed.action?.song && song && cfg.songSingEnabled !== false);
      const hasSingAction = !!parsed.action?.sing && !!sing;
      let audioUsed = false;

      // 语音自动化：两条路都能把这一整条改成语音
      //   1) 模型在句首写 [语音]（她明确表示"这条想用嘴说"）
      //   2) voiceChance：够短的回复有一定概率自己改说语音（真人也会懒得打字）
      // 语音没出来必须退回文字 —— 绝不能因为 TTS 挂了就不回话。
      const joinedForVoice = segmentsForOut.join(' ');
      const voiceTagged = /^\s*\[语音\]/.test(joinedForVoice);
      if (voiceTagged) {
        segmentsForOut = segmentsForOut.map(stripVoiceTag).filter(Boolean);
        // 极端情况：整条就是 "[语音]"（标记后面没字）—— 不能因此一条都不发
        if (!segmentsForOut.length) segmentsForOut = ['嗯？'];
        log?.event('tts', '模型在句首写了 [语音]，这条改成语音');
      }
      const voiceMaxChars = Math.max(1, Number(cfg.voiceMaxChars) || 80);
      // 这轮要唱歌（或对方在点歌）就别把回话改语音：唱歌那条音频才是回复
      const singingTurn = askedToSing || hasSongAction || hasSingAction;
      let wantVoice = !singingTurn && (voiceTagged || parsed.voice === true);
      if (!wantVoice && !singingTurn && cfg.ttsEnabled && segmentsForOut.length === 1 && (segmentsForOut[0] || '').length <= voiceMaxChars) {
        wantVoice = chance(cfg.voiceChance);
        if (wantVoice) log?.event('tts', `短回复（${segmentsForOut[0].length} 字）按概率改成语音`);
      }
      // 语音不再"替换文字"：先把文字发出去，等语音服务加载好再补一条语音。
      // 为什么：TTS 是按需启动的，冷启动要几分钟；原来整轮都在等它，人看不到任何回复。
      // 而且现在不用系统自带语音兜底了（音色不对，比没有更糟）。
      let voiceJob = null;
      if (wantVoice && cfg.ttsEnabled && segmentsForOut.length) {
        const said = segmentsForOut.join(' ');
        const moodHint = cfg.moodEnabled !== false ? (parsed.mood || mood?.label() || '') : '';
        parsed.voice = false;   // 别让 caps.act 再发一遍
        audioUsed = true;       // 这一轮的音频预算用掉了
        voiceJob = (async () => {
          const seg = (await caps.voiceSegment?.(said, msg, { mood: moodHint })) || null;
          if (!seg) { log?.event('tts', '语音没合成出来，这条就不发了（不发系统自带语音）'); return; }
          await send(seg, msg);
          log?.event('tts', `文字之后补发了语音：${said.slice(0, 24)}`);
        })().catch((e) => log?.event('tts', `补发的语音没发出去：${e.message}`));
      }

      const outbound = buildOutbound({ ...parsed, segments: segmentsForOut }, cfg, {
        atUserId: verdict.mentioned ? msg.userId : '',
        maxMessages: Math.max(segCap, segmentsForOut.length)
      });

      // 引用对方那条消息：真人回复经常带引用，群里也更好看出在回谁
      if (outbound.length && chance(cfg.quoteChance) && msg.id) {
        outbound[0] = [{ type: 'reply', data: { id: String(msg.id) } }, ...outbound[0]];
      }

      const sentTexts = [];
      for (let i = 0; i < outbound.length; i++) {
        const segs = outbound[i];
        const line = segs.filter((s) => s.type === 'text').map((s) => s.data.text).join('');
        // 拟人节奏：第一条是"读完想完再打字"，后续条是"打完一句停一下"
        const wait = (i > 0 && explicitBubbles)
          ? bubbleGap(cfg, random)
          : humanizeDelay(cfg, line, i, Math.random, cfg.moodEnabled !== false ? (parsed.mood || mood?.label() || '') : '');
        if (wait > 0) {
          log?.event('human', `停顿 ${wait} 毫秒再发第 ${i + 1} 条（${line.length} 字）`);
          await new Promise((r) => setTimeout(r, wait));
        }
        try {
          await send(segs, msg);
        } catch (e) {
          // 引用段被 NapCat 拒（比如那条消息撤回了）时，去掉引用重发一次，别把整轮弄丢
          log?.event('human', `发送失败，去掉引用重试：${e.message}`);
          await send(segs.filter((s) => s.type !== 'reply'), msg);
        }
        sentTexts.push(line);
        if (line) { selfEcho.push({ text: line.trim(), at: now() }); while (selfEcho.length > 30) selfEcho.shift(); }
        if (line) rememberOpener(line);
      }
      // 语音在后台跑（voiceJob）：这一轮不等它，先把文字送到人眼前。
      void voiceJob;
      if (stickerSeg) {
        try { await send([stickerSeg], msg); } catch (e) { log?.event("sticker", "配图没发出去（不影响正文）：" + e.message); }
      }

      // 补一句：主句说完 3~8 秒，突然想起点什么（模型在契约里给 follow，程序决定发不发）
      if (parsed.follow && chance(cfg.followUpChance)) {
        // 补的这句也要过守卫：不能成为"绕过禁自曝"的后门
        const fg = await guard.check(parsed.follow);
        if (fg.blocked) {
          log?.event('guard', `补的那句被拦下：${parsed.follow.slice(0, 30)}（${fg.why}）`);
        } else {
          const gap = 3000 + Math.floor(random() * 5000);
          log?.event('human', `隔 ${Math.round(gap / 1000)} 秒补一句：${parsed.follow}`);
          await new Promise((r) => setTimeout(r, gap));
          try {
            await send([{ type: 'text', data: { text: parsed.follow } }], msg);
            sentTexts.push(parsed.follow);
            selfEcho.push({ text: parsed.follow.trim(), at: now() }); while (selfEcho.length > 30) selfEcho.shift();
          } catch (e) { log?.event('human', `补的那句没发出去：${e.message}`); }
        }
      }


      // ─── 唱歌：点歌优先，一轮只发一条音频 ───
      // 1) 模型写了 song（点歌/翻唱真歌）→ 走它
      // 2) 对方在点歌、且说得清歌名 → 点歌（模型手滑写了 sing 也让给点歌）
      // 3) 明确只要儿歌/哼一句（"哼一段""唱个儿歌"）→ 按旋律唱 sing
      // 4) 在点歌但没歌名 → 问歌名，绝不自己挑一首（"唱首歌"直接唱小星星就是这个坑）
      // 音频一律后台做：文字已经发出去了，唱歌要几分钟（Demucs + 换声），
      // 不能让这一轮一直挂着 —— 挂着的话这个人的下一条消息也得排队等。
      if (!audioUsed && hasSongAction) {
        audioUsed = true;
        void playOneSong(msg, { spec: parsed.action.song }).catch((e) => log?.event('song', `点歌后台任务出错：${e.message}`));
      } else if (!audioUsed && askedToSing && song && cfg.songSingEnabled !== false) {
        const wantName = songNameFrom(msg.text);
        const hum = wantsHum(msg.text);
        if (wantName && !hum) {
          log?.event('song', `对方点歌「${wantName}」，按点歌走`);
          audioUsed = true;
          void playOneSong(msg, { text: wantName }).catch((e) => log?.event('song', `点歌后台任务出错：${e.message}`));
        } else if (!hum) {
          try { await send([{ type: 'text', data: { text: '想听哪首？把歌名给我，我去找原曲来唱。' } }], msg); } catch { /* ignore */ }
          log?.event('song', '对方说了要唱但没给歌名，先问歌名（不乱唱）');
          audioUsed = true;   // 已经回话了，这轮别再补语音
        }
      }
      if (!audioUsed && hasSingAction && (wantsHum(msg.text) || !askedToSing)) {
        const spec = parsed.action.sing;
        audioUsed = true;
        void (async () => {
          const r = await sing.sing({
            text: typeof spec === 'string' ? spec : (spec.text || spec.lyric || ''),
            tune: typeof spec === 'object' ? (spec.tune || spec.melody || '小星星') : '小星星',
            base: typeof spec === 'object' ? Number(spec.base) || 0 : 0,
            music: !(typeof spec === 'object' && spec.music === false),
            beatMs: typeof spec === 'object' ? (Number(spec.beatMs) || undefined) : undefined
          });
          const file = 'base64://' + fs.readFileSync(r.file).toString('base64');
          await send([{ type: 'record', data: { file } }], msg);
          log?.event('sing', `唱完了发出去：${r.chars}（${r.tune}，${r.seconds} 秒）`);
        })().catch((e) => log?.event('sing', `没唱成：${e.message}`));
      }

      // 输出侧能力（生图 / 语音）：这一轮已经发过音频的话，把 voice 掐掉，绝不再补一条
      if (audioUsed) parsed.voice = false;
      let extra = [];
      try { extra = await caps.act(parsed, msg, { mood: cfg.moodEnabled !== false && mood ? mood.label() : '' }); } catch (e) { log?.event("sticker", "附加动作失败：" + e.message); }
      for (const segs of extra) {
        try { await send(segs, msg); } catch (e) { log?.event("sticker", "附加消息没发出去：" + e.message); }
      }

      // 模型自报的心情比触发词准，用它校准状态
      if (cfg.moodEnabled !== false && mood && parsed.mood) { try { mood.adopt(parsed.mood); } catch { /* ignore */ } }
      for (const m of parsed.memory || []) {
        memory.add(m);
        // 同一件事也记到"这个人"的账上：以后他换个群说话，你还认识他
        if (cfg.peopleEnabled !== false && people) {
          try { people.remember(msg.userId, { fact: m, name: msg.nickname }); } catch { /* 记账失败不影响回话 */ }
        }
      }
      // 只学习成功完成的真实互动；角色切换期间不把旧回合写进新角色。
      if (!cfg.dryRun && sentTexts.length) {
        try { persona.growth?.observe(growthRole, msg); } catch (e) { log?.event('personality', '成长记录保存失败：' + e.message); }
      }
      // 一轮跑完算一次互动（合并批次只算一次，别把"聊过 N 次"刷成天文数字）
      if (cfg.peopleEnabled !== false && people) {
        try {
          people.remember(msg.userId, { name: msg.nickname, topic: String(msg.text || '').replace(/\s+/g, ' ').slice(0, 60) });
        } catch { /* ignore */ }
      }
      pushRecent({ nickname: '我', text: sentTexts.join(' ') }, true);

      metrics.replies += 1;
      metrics.turns += 1;
      metrics.tokens += Number(out.usage?.total_tokens) || 0;
      log?.event('reply', sentTexts.join(' / ').slice(0, 200), { group: msg.groupId, user: msg.userId, tier, model: out.model, tokens: out.usage?.total_tokens ?? 0, mood: parsed.mood, est: estimatedTokens });

      return { replied: true, texts: sentTexts, mood: parsed.mood, usage: out.usage, tier, dryRun: !!cfg.dryRun };
    } finally {
      metrics.inFlight -= 1;
    }
  }

  // ── 连发合并 ──────────────────────────────────────────────
  // 踩过的坑：用户连发 4 条（"在吗" / 图 / "小鱼" / 图），就是 4 个回合并发跑，
  // 每回合 2 条文字 + 1 张表情 → 群里十秒内冒出十几条。不是"分条"的问题，是"一消息一回合"。
  // 现在的规矩：
  //   1. 同一个人（同群）在 mergeWindowMs 内的连发先攒着，到点合并成一轮再回；
  //   2. 正在回话时又来了新消息，攒着等这轮说完，合并成下一轮 —— 不丢，但不会一句一条地追；
  //   3. 不同的人互不影响。
  const pending = new Map();   // key -> { msgs: [], timer: null, running: false }
  const keyOf = (msg) => `${msg.groupId || 'priv'}|${msg.userId}`;

  /** 把几条消息捏成一条：文字用空格连起来（模型看到的就是"你连发了几句"） */
  function batchOf(msgs) {
    const first = msgs[0];
    const text = msgs.map((m) => String(m.text || '').trim()).filter(Boolean).join(' ');
    const images = msgs.flatMap((m) => m.images || []).slice(0, 4);
    return {
      ...first,
      id: first.id + (msgs.length > 1 ? `+${msgs.length - 1}` : ''),
      text: text || first.text || '',
      images,
      mergedCount: msgs.length,
      __prefiltered: true      // 每条在排队前已经过滤过了，合并后的这条不要再计一次
    };
  }

  /** 收消息入口（main 用这个）：先过滤，再进合并窗 */
  function enqueue(msg) {
    metrics.received += 1;
    const why = prefilter(msg);
    if (why) return { replied: false, reason: why };

    const key = keyOf(msg);
    let p = pending.get(key);
    if (!p) { p = { msgs: [], timer: null, running: false }; pending.set(key, p); }
    p.msgs.push(msg);
    if (p.running || p.timer) return { queued: true, reason: p.running ? '正在回话，已攒进下一轮' : '已在合并窗里' };

    const win = Math.max(0, Number(cfg.mergeWindowMs) || 0);
    if (win <= 0) { void drain(key); return { queued: true }; }
    p.timer = setTimeout(() => { p.timer = null; void drain(key); }, win);
    return { queued: true, reason: `等 ${win} 毫秒看还有没有下一句` };
  }

  async function drain(key) {
    const p = pending.get(key);
    if (!p || p.running || !p.msgs.length) return;
    p.running = true;
    try {
      const batch = p.msgs.splice(0);
      if (batch.length > 1) {
        log?.event('merge', `连发 ${batch.length} 条合并成一轮：${batch.map((m) => m.text).filter(Boolean).join(' / ').slice(0, 60)}`, { group: batch[0].groupId, user: batch[0].userId });
      }
      await handle(batchOf(batch));
      // 这一轮说话期间又来了新的：攒成下一轮（不丢，但也不必等下一个窗口）
      if (p.msgs.length) {
        const next = p.msgs.splice(0);
        log?.event('merge', `回话期间又来了 ${next.length} 条，合成下一轮`, { group: next[0].groupId, user: next[0].userId });
        await handle(batchOf(next));
      }
    } catch (e) {
      log?.event('error', `回合异常：${e.message}`);
    } finally {
      p.running = false;
      if (p.msgs.length) {
        p.timer = setTimeout(() => { p.timer = null; void drain(key); }, 150);
      } else {
        pending.delete(key);
      }
    }
  }

  return { handle, enqueue, metrics, recent, dedup, relations: rel, pending, diary };
}
