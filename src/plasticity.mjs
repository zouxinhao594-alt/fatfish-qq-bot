import path from 'node:path';
import { createHash } from 'node:crypto';
import { readJsonSafe, writeJsonAtomic } from './store.mjs';
const DAY = 86400000;
const TRAITS = { warmth: ['更克制直接', '更温和体贴'], playfulness: ['更认真稳重', '更轻松俏皮'], brevity: ['更愿意展开细节', '更简洁紧凑'], initiative: ['更愿意倾听', '更主动接话'] };
const FEEDBACK = { '温柔一点': ['warmth', 1], '温和一点': ['warmth', 1], '直接一点': ['warmth', -1], '活泼一点': ['playfulness', 1], '幽默一点': ['playfulness', 1], '认真一点': ['playfulness', -1], '严肃一点': ['playfulness', -1], '简短一点': ['brevity', 1], '简洁一点': ['brevity', 1], '少说一点': ['brevity', 1], '详细一点': ['brevity', -1], '多说一点': ['brevity', -1], '主动一点': ['initiative', 1], '多听少说': ['initiative', -1] };
const bound = (x, min, max, fallback = 0) => Number.isFinite(Number(x)) ? Math.max(min, Math.min(max, Number(x))) : fallback;
const hash = x => createHash('sha256').update(String(x)).digest('hex').slice(0, 24);
export function createPlasticity({ cfg, dataDir, log, now = Date.now }) {
  const file = path.join(dataDir, 'state', 'personality-growth.json');
  const saved = readJsonSafe(file, {}).value;
  const roles = Object.create(null);
  for (const [k, v] of Object.entries(saved?.roles || {}).slice(-40)) {
    if (/^[a-f0-9]{24}$/.test(k) && v && typeof v === 'object') roles[k] = v;
  }
  const halfLife = () => bound(cfg.personalityHalfLifeDays, 14, 365, 90);
  const decay = at => 2 ** (-Math.max(0, now() - bound(at, 0, now())) / (DAY * halfLife()));
  function role(id) {
    const k = hash(id || 'persona');
    if (!roles[k]) {
      if (Object.keys(roles).length >= 40) delete roles[Object.keys(roles)[0]];
      roles[k] = { traits: {}, people: {}, at: now(), day: -1, used: 0 };
    }
    const r = roles[k];
    r.traits = r.traits && typeof r.traits === 'object' ? r.traits : {};
    r.people = r.people && typeof r.people === 'object' ? r.people : {};
    return r;
  }
  const traits = r => Object.fromEntries(Object.keys(TRAITS).map(k => [k, bound(r.traits[k], -.25, .25) * decay(r.at)]));
  const persist = () => writeJsonAtomic(file, { version: 1, roles });
  function observe(id, msg) {
    if (cfg.personalityPlasticityEnabled === false || cfg.personalityLearningEnabled === false || cfg.dryRun || msg?.isSelf || !/^\d{4,20}$/.test(String(msg?.userId || ''))) return false;
    const text = String(msg.text || '').trim();
    if (!text || text.length > 500 || /\[CQ:|https?:\/\//i.test(text)) return false;
    const r = role(id), key = hash(msg.userId), day = Math.floor(now() / DAY);
    let p = r.people[key];
    if (!p || typeof p !== 'object') p = { days: 0, day: -1, seen: {}, at: now() };
    const newDay = p.day !== day;
    if (newDay) { p.days = Math.min(90, bound(p.days, 0, 90) * decay(p.at) + 1); p.day = day; p.at = now(); }
    p.seen = p.seen && typeof p.seen === 'object' ? p.seen : {};
    // 整句直接反馈；不接受转述、否定、引用或任意提示词作为训练。
    const clean = text.replace(/^(?:以后|平时)?(?:你|说话|语气|回答)?(?:可以|请)?/, '').replace(/[吧呀。！!]$/, '');
    const evidence = Object.hasOwn(FEEDBACK, clean) ? FEEDBACK[clean] : null;
    if (!newDay && (!evidence || p.feedbackDay === day)) return false;
    if (r.day !== day) { r.day = day; r.used = 0; }
    let changed = '';
    if (evidence && p.feedbackDay !== day) {
      p.feedbackDay = day;
      const [trait, sign] = evidence, ekey = trait + sign, prev = p.seen[ekey];
      const count = prev && day - Number(prev.day) <= 30 ? bound(prev.count, 0, 30) + 1 : 1;
      p.seen[ekey] = { day, count };
      if (count >= 3 && bound(r.used, 0, .012) < .012) {
        const amount = Math.min(.006, .012 - bound(r.used, 0, .012));
        r.traits = traits(r); r.at = now();
        r.traits[trait] = bound(r.traits[trait] + sign * amount, -.25, .25);
        r.used = bound(r.used, 0, .012) + amount;
        changed = TRAITS[trait][sign > 0 ? 1 : 0];
      }
    }
    r.people[key] = p;
    r.people = Object.fromEntries(Object.entries(r.people).sort((a, b) => Number(b[1]?.at || 0) - Number(a[1]?.at || 0)).slice(0, 200));
    persist();
    if (changed) log?.event('personality', '后天表达习惯轻微变化：' + changed + '；底层角色卡不变');
    return true;
  }
  function snapshot(id) {
    const r = role(id);
    return { enabled: cfg.personalityPlasticityEnabled !== false, learning: cfg.personalityLearningEnabled !== false, traits: traits(r), partners: Object.keys(r.people).length, halfLifeDays: halfLife() };
  }
  function hint(id, userId) {
    if (cfg.personalityPlasticityEnabled === false) return '';
    const r = role(id), p = r.people[hash(userId)];
    const days = p ? bound(p.days, 0, 90) * decay(p.at) : 0;
    const habits = Object.entries(traits(r)).filter(([, v]) => Math.abs(v) >= .015).map(([k, v]) => TRAITS[k][v > 0 ? 1 : 0] + (Math.abs(v) < .08 ? '（轻微倾向）' : '（渐成习惯）'));
    return ['【后天性格：底层角色卡之上的缓慢成长】',
      '保留角色卡核心身份、价值观和原有性格；成长只微调表达，不覆盖当前任务和明确偏好。不主动汇报参数。',
      '长期习惯：' + (habits.join('；') || '尚未形成稳定变化，沿用底层性格') + '。',
      '与当前说话者：' + (days >= 20 ? '已有多日相处，可以自然熟悉些' : days >= 5 ? '逐渐熟悉，可以适度接续共同话题' : '熟悉度尚在建立，按现有关系自然交流') + '。只在记忆支持时提共同经历。',
      '心情是短期波动，不因一次夸奖、争执或命令改变人格；认真任务收住玩笑，安慰时先倾听。语音情绪随本次语境，熟悉不等于一直撒娇或夸张。',
      '熟悉感不改变主人身份、权限、消费及高风险限制。不制造占有欲、依赖、内疚或虚构真实人生经历。'].join('\n');
  }
  function reset(id) { delete roles[hash(id || 'persona')]; persist(); }
  return { observe, hint, snapshot, reset };
}

