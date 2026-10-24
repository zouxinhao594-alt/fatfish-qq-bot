// 情绪：它得有个"心情"，不然表情包只是贴图，不是表达。
//
// 三条设计原则：
//   1. 心情是**连续状态**，不是每轮重新猜 —— 存盘、会衰减、会被人影响
//   2. 心情影响**说话方式**（提示词里给它一句"你现在有点委屈"）和**配什么图**
//   3. 幅度有限：最多 3 档，衰减回"摸鱼"，不然会一直炸毛或一直得意
//
// 心情取值与人格契约里的 mood 枚举一致：摸鱼 | 干饭 | 炸毛 | 认真 | 困 | 腹黑 | 得意 | 委屈 | 无语

import path from 'node:path';
import { readJsonSafe, writeJsonAtomic } from './store.mjs';

const MOODS = ['摸鱼', '干饭', '炸毛', '认真', '困', '腹黑', '得意', '委屈', '无语', '温柔', '开心', '惊讶'];

/** 坏情绪：主人一开口就该回暖的那几种（"别把气撒到他身上"） */
const NEGATIVE = ['炸毛', '委屈', '无语', '困'];

/** 每种心情给模型的一句话（写进上下文，影响它怎么说话） */
const HINTS = {
  温柔: '你在认真照顾对方的感受，先接住他刚说的具体事情，语气柔和，不强行说教，也别连着劝。',
  开心: '你有点开心，语气明亮、轻快，但不每句话都加感叹号或重复笑声。',
  惊讶: '你有一点意外，先短短回应，再自然追问；不要夸张尖叫或每件事都大惊小怪。',
  摸鱼: '你在群里有一搭没一搭地待着，说话随意、短，不太主动。',
  干饭: '你有点饿了，注意力在吃的上，聊到吃会来精神。',
  炸毛: '你现在有点炸毛，说话冲一点、短一点，但别真骂人。',
  认真: '你现在比较认真，话会更完整，但不啰嗦。',
  困: '你困了，反应慢半拍，句子更短、更软，别长篇大论。',
  腹黑: '你有点坏心眼，喜欢调侃和玩梗，但不下狠嘴。',
  得意: '你有点小得意，说话轻快，愿意被夸。',
  委屈: '你有点委屈，话少、语气软，不太想主动接话，被问才答。',
  无语: '你有点无语，回得敷衍，常用"……""嗯""随你"这种。'
};

/** 触发词表：只做很朴素的判断，别指望它懂反讽 */
const EVENTS = [
  { type: 'comfort', mood: '温柔', re: /(想哭|好难过|很难过|心情不好|好累|累死了|压力好大|失眠|求安慰|安慰我)/ },
  { type: 'praised', mood: '得意', re: /(可爱|厉害|好棒|牛啊|牛蛙|喜欢你|好聪明|真强|太强了|夸你)/ },
  { type: 'insulted', mood: '委屈', re: /(傻逼|笨蛋|滚|闭嘴|烦死|恶心|垃圾|别说话)/ },
  { type: 'food', mood: '干饭', re: /(吃饭|吃什么|想吃|好吃|干饭|早饭|午饭|晚饭|夜宵|奶茶|火锅|烧烤|鸡腿|咖啡|饿了)/ },
  { type: 'bored', mood: '无语', re: /(呵呵|随便|都行|无语|6\b|\.\.\.|。。。)/ }
];

export function createMood({ dataDir, cfg, log, now = () => Date.now() }) {
  const file = path.join(dataDir, 'state', 'mood.json');
  const saved = readJsonSafe(file, {}).value || {};
  const state = {
    current: MOODS.includes(saved.current) ? saved.current : '摸鱼',
    intensity: Math.max(0, Math.min(3, Number(saved.intensity) || 0)),
    updatedAt: Number(saved.updatedAt) || now(),
    lastAmbientAt: Number(saved.lastAmbientAt) || now(),
    lastDecayAt: Number(saved.lastDecayAt) || Number(saved.updatedAt) || now(),
    recent: Array.isArray(saved.recent) ? saved.recent.slice(-10) : []
  };

  function persist() {
    try { writeJsonAtomic(file, state); } catch { /* ignore */ }
  }

  function label() { return state.intensity > 0 ? `${state.current}（${state.intensity}/3）` : state.current; }
  function hint() { return HINTS[state.current] || HINTS['摸鱼']; }

  /** 被某件事影响心情（幅度 1，最多 3 档） */
  function bump(mood, why = '', amount = 1) {
    if (!MOODS.includes(mood)) return;
    if (state.current === mood) state.intensity = Math.min(3, state.intensity + amount);
    else { state.current = mood; state.intensity = Math.min(3, Math.max(1, amount)); }
    state.updatedAt = now();
    state.lastDecayAt = now();
    state.recent.push({ at: state.updatedAt, mood, why });
    state.recent = state.recent.slice(-10);
    log?.event('mood', `心情变成「${label()}」${why ? '（' + why + '）' : ''}`);
    persist();
  }

  /** 看一条消息里有没有明显情绪事件 */
  function observe(text = '') {
    for (const e of EVENTS) {
      if (e.re.test(text)) { bump(e.mood, `听到「${(text.match(e.re) || [''])[0]}」`); return e.type; }
    }
    return '';
  }

  /** 时间/环境带来的漂移：深夜困、饭点饿、长时间没说话就回到摸鱼 */
  function ambient(d = new Date(now())) {
    const h = d.getHours();
    const since = now() - state.lastAmbientAt;
    if (since < 10 * 60_000) return;
    state.lastAmbientAt = now();
    // 独立衰减时钟：频繁调用 ambient 不应阻止情绪自然淡去。
    const interval = Math.max(1, Number(cfg.moodDecayMins) || 30) * 60_000;
    const steps = Math.floor(Math.max(0, now() - state.lastDecayAt) / interval);
    if (steps > 0) {
      state.intensity = Math.max(0, state.intensity - steps);
      if (!state.intensity) state.current = '摸鱼';
      state.lastDecayAt += steps * interval;
    }
    // 作息只影响平静状态，不能盖过正在安慰对方或认真讨论的情绪。
    if (!state.intensity) {
      if (h >= 23 || h < 6) { state.current = '困'; state.intensity = 1; state.lastDecayAt = now(); }
      else if ((h >= 11 && h <= 13) || (h >= 17 && h <= 19)) {
        state.current = '干饭'; state.intensity = 1; state.lastDecayAt = now();
      }
    }
    persist();
  }

  /** 被主人叫到：坏情绪立刻回暖（主人不该吃它的脸色） */
  function warm(why = '主人来了') {
    if (!NEGATIVE.includes(state.current)) return false;
    state.current = '得意';
    state.intensity = 1;
    state.updatedAt = now();
    state.lastDecayAt = now();
    state.recent.push({ at: state.updatedAt, mood: '得意', why });
    state.recent = state.recent.slice(-10);
    log?.event('mood', `心情回暖：${why}（原来是坏情绪）`);
    persist();
    return true;
  }

  /** 模型在回复里自报的 mood，用它校准（它比触发词更懂上下文） */
  function adopt(moodFromModel) {
    const m = String(moodFromModel || '').trim();
    if (!MOODS.includes(m)) return;
    if (m === state.current) return;
    state.current = m;
    state.intensity = Math.max(1, Math.min(3, state.intensity || 1));
    state.updatedAt = now();
    state.lastDecayAt = now();
    state.recent.push({ at: state.updatedAt, mood: m, why: '模型自报' });
    state.recent = state.recent.slice(-10);
    persist();
  }

  return { state, label, hint, bump, observe, ambient, adopt, warm, MOODS };
}
