// 主动发起：群里安静太久时，它自己开个话头。
//
// 和"自主接话"（gate.mjs）不是一回事：
//   - 接话 = 有人说话，它判断要不要搭腔（反应式）
//   - 发起 = 没人说话，它自己找个话题（主动式，容易招人烦，所以要克制）
//
// 三道闸：安静够久 + 每小时次数 + 掷骰子。任何一样不过就不开口。

import { modelFor } from './config.mjs';
import { extractJson, normalizeReply } from './llm.mjs';

const BUILTIN_PROMPT = [
  '群里已经安静了一阵子。你想主动说一句，像群里的人随口冒个泡那样。',
  '要求：一句话，不超过 20 字；不要提问超过一个；不要总结之前的聊天；不要自我介绍；不要 @ 任何人。',
  '只输出 JSON：{"segments":["一句话"]}'
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

  /** 该不该开口（纯判断，不发消息）。返回 {fire, why}。 */
  function shouldFire() {
    if (!cfg.proactiveEnabled) return { fire: false, why: '没开主动发起' };
    const groups = (cfg.groups || []).map(String).filter(Boolean);
    if (!groups.length) return { fire: false, why: '没有白名单群' };
    if (withinQuiet()) return { fire: false, why: '静默时段' };
    const idleMin = (now() - lastActivityAt) / 60_000;
    const need = Number(cfg.proactiveIdleMins) || 30;
    if (idleMin < need) return { fire: false, why: `才安静 ${Math.round(idleMin)} 分钟（要 ${need} 分钟）` };
    hourTimes = hourTimes.filter((t) => now() - t < 3_600_000);
    const cap = Number(cfg.proactiveMaxPerHour) || 0;
    if (cap && hourTimes.length >= cap) return { fire: false, why: `本小时已经主动 ${hourTimes.length} 次` };
    if (random() >= (Number(cfg.proactiveChance) || 0)) return { fire: false, why: '这次不开口（掷骰子没中）' };
    return { fire: true, why: '', groupId: groups[0] };
  }

  async function generate(groupId) {
    const recent = (recentOf?.(groupId) || []).slice(-8).map((r) => `${r.nickname}：${r.text}`).join('\n');
    const messages = [
      { role: 'system', content: [persona, BUILTIN_PROMPT].filter(Boolean).join('\n\n') },
      { role: 'user', content: (cfg.proactivePrompt || '') + (recent ? `\n\n【刚才群里说的】\n${recent}` : '') }
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
      const lines = await generate(d.groupId);
      const target = { groupId: d.groupId };
      for (let i = 0; i < lines.length; i++) {
        if (cfg.dryRun) {
          // 演练模式下不真发（和 pipeline 一致），只在事件里留痕
          log?.event('proactive', `[演练] 本来要主动说：${lines[i]}`);
        } else {
          await transport.send([{ type: 'text', data: { text: lines[i] } }], target);
        }
        if (i < lines.length - 1) await new Promise((r) => setTimeout(r, Number(cfg.multiMessageGapMs) || 800));
      }
      laneMark();
      log?.event('proactive', `主动开话头（${reason}）：${lines.join(' / ').slice(0, 120)}`);
      return { ok: true, lines };
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

  return { noteActivity, shouldFire, fire, start, stop, stats, get lastActivityAt() { return lastActivityAt; } };
}
