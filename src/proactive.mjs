// 主动发起：安静太久时，它自己先开口。
//
// 和"自主接话"（gate.mjs）不是一回事：
//   - 接话 = 有人说话，它判断要不要搭腔（反应式）
//   - 发起 = 没人说话，它自己找个话题（主动式，容易招人烦，所以要克制）
//
// 发到哪儿由 proactiveTarget 决定：
//   - 'owner'（默认）：私聊发给管理员（主人）。群里绝不自己插话，显得更真
//   - 'group'：发到白名单第一个群（老行为，想恢复就改设置页）
//
// 三道闸：安静够久 + 每小时次数 + 掷骰子。任何一样不过就不开口。

import { modelFor } from './config.mjs';
import { extractJson, normalizeReply } from './llm.mjs';

const BUILTIN_PROMPT_GROUP = [
  '群里已经安静了一阵子。你想主动说一句，像群里的人随口冒个泡那样。',
  '按话题需要自然说一两句；可以延续未完的话题或分享有依据的兴趣，不必每次提问。不要 @ 任何人，不虚构刚刚做过的事情。',
  '只输出 JSON：{"segments":["一句话"]}'
].join('\n');

const BUILTIN_PROMPT_OWNER = [
  '你想主动给对方发一条消息。像给熟人发消息那样随意，不用先解释为什么突然想起对方。',
  '可以问一句最近怎么样、说一件手里的小事、接着上次没说完的话题说一句；不必每次都提问，也不要说"我刚刚看了书"这类刻意编出来的日常。',
  '不要 @ 任何人，不虚构自己刚刚做过的事情。只输出 JSON：{"segments":["一句话"]}'
].join('\n');

export function createProactive({ cfg, llm, persona, guard, log, transport, recentOf, now = () => Date.now(), random = Math.random }) {
  const stats = { checks: 0, fired: 0, skipped: 0, failed: 0, lastFireAt: 0, lastReason: '' };
  let lastActivityAt = now();
  let hourTimes = [];
  let timer = null;

  function noteActivity() { lastActivityAt = now(); }

  function withinQuiet(d = new Date(now())) {
    if (!cfg.quietEnabled) return false;
    const mins = d.getHours() * 60 + d.getMinutes();
    const toMin = (s) => { const [h, m] = String(s).split(':').map(Number); return (h || 0) * 60 + (m || 0); };
    const a = toMin(cfg.quietStart), b = toMin(cfg.quietEnd);
    return a <= b ? (mins >= a && mins < b) : (mins >= a || mins < b);
  }

  /** 发到哪儿：{target, key} 或 {why}。key 用来取"上一段聊天"当上下文。 */
  function pickTarget() {
    if (String(cfg.proactiveTarget || 'owner') === 'group') {
      const groups = (cfg.groups || []).map(String).filter(Boolean);
      if (!groups.length) return { why: '没有白名单群' };
      return { target: { groupId: groups[0] }, key: groups[0], to: '群里' };
    }
    const owner = String(cfg.ownerUin || '').split(/[,，;；\s]+/).map((s) => s.trim()).filter(Boolean)[0];
    if (!owner) return { why: '没设管理员 QQ 号，主动消息没地方发' };
    return { target: { userId: owner }, key: '', to: '私聊主人' };
  }

  /** 该不该开口（纯判断，不发消息）。返回 {fire, why, target, key}。 */
  function shouldFire() {
    if (!cfg.proactiveEnabled) return { fire: false, why: '没开主动发起' };
    const t = pickTarget();
    if (t.why) return { fire: false, why: t.why };
    if (withinQuiet()) return { fire: false, why: '静默时段' };
    const idleMin = (now() - lastActivityAt) / 60_000;
    const need = Number(cfg.proactiveIdleMins) || 30;
    if (idleMin < need) return { fire: false, why: `才安静 ${Math.round(idleMin)} 分钟（要 ${need} 分钟）` };
    hourTimes = hourTimes.filter((x) => now() - x < 3_600_000);
    const cap = Number(cfg.proactiveMaxPerHour) || 0;
    if (cap && hourTimes.length >= cap) return { fire: false, why: `本小时已经主动 ${hourTimes.length} 次` };
    if (random() >= (Number(cfg.proactiveChance) || 0)) return { fire: false, why: '这次不开口（掷骰子没中）' };
    return { fire: true, why: '', target: t.target, key: t.key, to: t.to };
  }

  async function generate(key) {
    const recent = (recentOf?.(key) || []).slice(-8).map((r) => `${r.nickname}：${r.text}`).join('\n');
    const isGroup = String(cfg.proactiveTarget || 'owner') === 'group';
    const builtin = isGroup ? BUILTIN_PROMPT_GROUP : BUILTIN_PROMPT_OWNER;
    const messages = [
      { role: 'system', content: [typeof persona === 'function' ? persona() : persona, builtin].filter(Boolean).join('\n\n') },
      { role: 'user', content: (cfg.proactivePrompt || '') + (recent ? `\n\n【刚才说的】\n${recent}` : '') }
    ];
    const out = await llm.chat(messages, { model: modelFor(cfg, 'chat'), maxTokens: 500, timeoutMs: 45_000, json: true });
    let parsed = normalizeReply(extractJson(out.text), cfg.maxSegments);
    if (!parsed) {
      const plain = String(out.text || '').replace(/```[a-z]*\n?/gi, '').replace(/```/g, '').trim();
      if (plain) parsed = normalizeReply({ segments: [plain] }, cfg.maxSegments);
    }
    if (!parsed) throw new Error('模型没给出可用内容');
    // 走同一套禁自曝守卫
    const kept = [];
    for (const seg of parsed.segments) {
      const g = await guard.check(seg);
      if (!g.blocked) kept.push(seg);
    }
    if (!kept.length) throw new Error('内容被守卫拦掉了');
    return kept;
  }

  /** 触发一次（控制台「立刻试一次」也走这里）。 */
  async function fire(reason = '定时检查') {
    const d = shouldFire();
    if (!d.fire) { stats.skipped += 1; stats.lastReason = d.why; return { ok: false, why: d.why }; }
    try {
      const lines = await generate(d.key);
      for (let i = 0; i < lines.length; i++) {
        if (cfg.dryRun) {
          // 演练模式下不真发（和 pipeline 一致），只在事件里留痕
          log?.event('proactive', `[演练] 本来要${d.to}说：${lines[i]}`);
        } else {
          await transport.send([{ type: 'text', data: { text: lines[i] } }], d.target);
        }
        if (i < lines.length - 1) await new Promise((r) => setTimeout(r, Number(cfg.multiMessageGapMs) || 800));
      }
      laneMark();
      log?.event('proactive', `${d.to}主动开口（${reason}）：${lines.join(' / ').slice(0, 120)}`);
      return { ok: true, lines, to: d.to };
    } catch (e) {
      stats.failed += 1;
      stats.lastReason = e.message;
      log?.event('proactive', `主动发起失败：${e.message}`);
      return { ok: false, why: e.message };
    }
  }

  function laneMark() {
    stats.fired += 1;
    stats.lastFireAt = now();
    hourTimes.push(now());
    noteActivity();
  }

  function start() {
    const mins = Math.max(1, Number(cfg.proactiveCheckMins) || 5);
    if (timer) clearInterval(timer);
    timer = setInterval(() => {
      stats.checks += 1;
      fire('定时检查').catch(() => { });
    }, mins * 60_000);
    if (timer.unref) timer.unref();
    return mins;
  }

  function stop() { if (timer) clearInterval(timer); timer = null; }

  return { noteActivity, shouldFire, fire, start, stop, stats, pickTarget, get lastActivityAt() { return lastActivityAt; } };
}
