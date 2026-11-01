// 门槛链 + 自主发言。
//
// 顺序（顺序即优先级）：
//   群白名单 → @ 我 → 主人 → 静默时段 → requireMention → 每分钟限流 → 醒词 → 自主判定
//
// 「主人」（config.ownerUin）这一档是必回：不 @ 也回、静默时段也回、不跑打分。
// 它和其他人的区别由 relations.mjs 判定，这里只认 tier 字符串。
//
// 自主判定（这就是"不 @ 也能说话"的那一层）：
//   让模型给这条消息打 0~10 分（"接这句话合不合适"），然后按三档决定：
//     score >= autonomyThreshold           → 接
//     autonomyThreshold-2 <= score < 阈值  → 掷骰子（autonomyChance）决定接不接
//     更低的                                → 不接
//   接了之后还要过两道闸：主动性发言冷却（autonomyCooldownSecs）和每小时上限（autonomyMaxPerHour），
//   否则会出现"顺着一个话题连说十句"的机器人。
//
// 一个真实踩过的坑：把关这次调用给 maxTokens=60，而 deepseek-flash 会先花一百多个
// reasoning token 再吐正文 → 正文被截空 → 每条非 @ 消息都被当成"不接"。
// 所以这里给足预算（gateMaxTokens=600），空内容还要重试一次 + 启发式兜底。

export function createGate({ cfg, llm, log, now = () => Date.now(), random = Math.random }) {
  const stats = { checked: 0, passed: 0, silent: 0, skipped: 0, limited: 0, gateCalls: 0, proactive: 0, cooldownHits: 0, hourlyHits: 0, fallback: 0, ownerPassed: 0, closePassed: 0 };
  const minuteHits = new Map(); // groupId -> timestamps
  let proactiveTimes = [];      // 最近一小时的主动发言时间
  let lastProactiveAt = 0;

  function withinQuiet(d = new Date()) {
    if (!cfg.quietEnabled) return false;
    const mins = d.getHours() * 60 + d.getMinutes();
    const toMin = (s) => { const [h, m] = String(s).split(':').map(Number); return (h || 0) * 60 + (m || 0); };
    const a = toMin(cfg.quietStart), b = toMin(cfg.quietEnd);
    return a <= b ? (mins >= a && mins < b) : (mins >= a || mins < b);
  }

  function rateOk(groupId) {
    const limit = Number(cfg.perMinute) || 0;
    if (!limit) return true;
    const t = now();
    const arr = (minuteHits.get(groupId) || []).filter((x) => t - x < 60_000);
    if (arr.length >= limit) { minuteHits.set(groupId, arr); stats.limited += 1; return false; }
    arr.push(t);
    minuteHits.set(groupId, arr);
    return true;
  }

  function cooldownOk() {
    const secs = Number(cfg.autonomyCooldownSecs) || 0;
    return !secs || now() - lastProactiveAt >= secs * 1000;
  }

  function hourlyOk() {
    const max = Number(cfg.autonomyMaxPerHour) || 0;
    proactiveTimes = proactiveTimes.filter((t) => now() - t < 3_600_000);
    return !max || proactiveTimes.length < max;
  }

  function markProactive() {
    lastProactiveAt = now();
    proactiveTimes.push(now());
    stats.proactive += 1;
  }

  const wakeList = () => String(cfg.wakeWords || '').split(',').map((s) => s.trim()).filter(Boolean);

  function safeParse(text) {
    const s = String(text || '');
    const i = s.indexOf('{');
    const j = s.lastIndexOf('}');
    if (i < 0 || j <= i) return null;
    try { return JSON.parse(s.slice(i, j + 1)); } catch { return null; }
  }

  /** 让模型给"要不要接这句话"打分。返回 {score, why}。 */
  async function judge(msg, recent = []) {
    stats.gateCalls += 1;
    const ctx = recent.slice(-6).map((r) => `${r.nickname}：${r.text}`).join('\n');
    const system = [
      '你在判断一条群聊消息，决定一个陪聊机器人要不要接话。只输出 JSON：{"score":0-10,"why":"不超过8字"}',
      '前提：它是群友之一，不是客服 —— **在这个群里，参与聊天比沉默更自然**，只有明显不该插话时才给低分。',
      '评分标准：',
      '  10  = 直接在对机器人说话、点它的名',
      '  8-9 = 明确在提问，或话题正中它的领域（读书、生活、吃喝、心情、猫狗）',
      '  6-7 = 日常闲聊、分享、吐槽、感慨 —— **群里大多数消息都在这一档**，接一句很自然',
      '  4-5 = 明显是在跟某个具体的人说话、或在聊很私人的事，插话略突兀',
      '  0-3 = 抬杠引战、刷屏复读、纯表情/纯标点、完全无关的广告',
      '拿不准时给 6，不要因为"怕打扰"就压分。'
    ].join('\n');
    const user = [
      ctx ? `【最近的对话】\n${ctx}` : '',
      `【这条消息】${msg.nickname}：${msg.text || '（图片）'}`
    ].filter(Boolean).join('\n\n');

    const model = cfg.relevanceModel || cfg.routeGate || cfg.model;
    const timeoutMs = (Number(cfg.relevanceTimeoutSecs) || 12) * 1000;

    let text = '';
    try {
      text = (await llm.chat([{ role: 'system', content: system }, { role: 'user', content: user }], {
        model, maxTokens: Number(cfg.gateMaxTokens) || 600, json: true, timeoutMs
      })).text;
    } catch (e) {
      log?.event('gate', `把关第一次没拿到内容：${e.message}（加预算重试）`);
    }
    if (!text || !text.trim()) {
      try {
        text = (await llm.chat([{ role: 'system', content: system }, { role: 'user', content: user }], {
          model, maxTokens: 1200, json: false, timeoutMs
        })).text;
      } catch (e) {
        log?.event('gate', `把关重试也失败：${e.message}`);
      }
    }

    const parsed = safeParse(text);
    if (parsed && Number.isFinite(Number(parsed.score))) return { score: Number(parsed.score), why: String(parsed.why || ''), source: 'model' };
    if (parsed && typeof parsed.reply === 'boolean') return { score: parsed.reply ? 8 : 2, why: String(parsed.why || ''), source: 'model' };

    // 兜底：模型没给出可用结果时，别把整条链路拖死 —— 用最朴素的启发式。
    stats.fallback += 1;
    const t = String(msg.text || '');
    let score = 4;
    if (/[?？]/.test(t)) score = 7;
    else if (/^(哈+|嘿+|嗯+|哦+|啊+)$/.test(t.trim())) score = 1;
    else if (t.length >= 12) score = 5;
    log?.event('gate', `把关没给出分数，用启发式：${score}`);
    return { score, why: '启发式', source: 'fallback' };
  }

  async function decide(msg, { recent = [], tier = 'friend' } = {}) {
    stats.checked += 1;
    const isPrivate = !msg.groupId; // 私聊 = 直接对话，一律要回
    const groups = (cfg.groups || []).map(String);
    if (msg.groupId && !groups.includes(String(msg.groupId))) return { reply: false, reason: '群不在白名单' };

    const mentioned = msg.mentions.some((q) => String(q) === String(msg.selfId || cfg.selfId));
    const wake = wakeList().some((w) => msg.text.includes(w));

    // @ 我 / 私聊：必回，压过所有"值不值得""冷却没冷却"的判断
    // （踩过的坑：冷却把"明显在问它"的消息也挡了，用户看到的就是"它装死不回"）
    if (mentioned || isPrivate) {
      if (!rateOk(msg.groupId || 'private')) return { reply: false, reason: '触发频率上限' };
      stats.passed += 1;
      return { reply: true, reason: isPrivate ? '私聊' : '@ 我', mentioned, score: 10 };
    }

    // 主人说话：必回。连静默时段和自主判定都不走 —— 这是"最亲"最实的一条。
    // （要不要必回由 ownerAlwaysReply 决定；频率上限仍然保留，防刷屏/防死循环）
    if (tier === 'owner' && cfg.ownerAlwaysReply !== false) {
      if (!rateOk(msg.groupId || 'private')) return { reply: false, reason: '触发频率上限' };
      stats.passed += 1;
      stats.ownerPassed += 1;
      return { reply: true, reason: '主人', owner: true, score: 10 };
    }

    if (withinQuiet()) { stats.silent += 1; return { reply: false, reason: '静默时段' }; }

    // 熟人说话：必回。不走把关打分，也不吃主动发言冷却 —— 但静默时段和频率上限照样管
    // （跟主人的区别就在这里：熟人是"要应"，不是"随时都能吵醒她"）
    if (tier === 'close' && cfg.closeAlwaysReply !== false) {
      if (!rateOk(msg.groupId || 'private')) return { reply: false, reason: '触发频率上限' };
      stats.passed += 1;
      stats.closePassed += 1;
      return { reply: true, reason: '熟人', close: true, score: 10 };
    }

    if (cfg.requireMention) { stats.skipped += 1; return { reply: false, reason: '没 @ 我（requireMention 开着）' }; }
    if (!rateOk(msg.groupId || 'private')) return { reply: false, reason: '触发频率上限' };

    if (wake) {
      if (!cooldownOk()) { stats.cooldownHits += 1; return { reply: false, reason: '醒词触发了，但主动发言在冷却中' }; }
      markProactive();
      stats.passed += 1;
      return { reply: true, reason: '醒词', wake: true, score: 9 };
    }

    // 自主发言总开关（relevanceEnabled=false 视为关闭，兼容老配置）
    const autonomyOn = cfg.autonomyEnabled !== false && cfg.relevanceEnabled !== false;
    if (!autonomyOn) { stats.skipped += 1; return { reply: false, reason: '没开自主发言（只回 @ 和醒词）' }; }

    const v = await judge(msg, recent);
    const score = v.score;
    const A = Number(cfg.autonomyThreshold) || 7;

    const accept = (reason) => {
      // 冷却只压"顺手插一句"，不压"明显在跟它说话"。
      // 阈值可调（autonomyBypassScore，默认 8）：8 分 = "明显在等回复 / 像在问机器人"
      const bypass = Number(cfg.autonomyBypassScore) || 8;
      const why = v.why ? `${v.why} · ` : '';
      if (score < bypass && !cooldownOk()) { stats.cooldownHits += 1; return { reply: false, reason: `主动发言冷却中（${why}${score} 分）`, score }; }
      if (!hourlyOk()) { stats.hourlyHits += 1; return { reply: false, reason: `本小时主动发言已够（${why}${score} 分）`, score }; }
      markProactive();
      stats.passed += 1;
      return { reply: true, reason, score, why: v.why, autonomy: true };
    };

    if (score >= A) return accept('');
    if (score >= A - 2) {
      if (random() < (Number(cfg.autonomyChance ?? 0.5))) return accept(`自主接话（${score} 分，掷中了）`);
      stats.silent += 1;
      return { reply: false, reason: `低分随机不接（${score} 分）`, score };
    }
    stats.silent += 1;
    return { reply: false, reason: `判定不接（${v.why || score + ' 分'}）`, score };
  }

  return { decide, judge, stats, withinQuiet };
}
