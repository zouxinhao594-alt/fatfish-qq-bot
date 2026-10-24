// 拟人化：让回复的"节奏"像人，而不是机器秒回。
//
// 真人在群里的三个特征，都可以用参数模拟：
//   1. 不会 0 秒回 —— 读一遍、想一下、打几个字，1~6 秒是常态
//   2. 长句子打字更久 —— 按字数线性加，但有上限（没人打字十分钟）
//   3. 分成两条发的时候中间会停一下 —— 不是同一瞬间刷出两行
//
// 这里全是纯函数（可注入 random），方便测试，也不依赖任何全局状态。

export function humanizeDelay(cfg, text, index = 0, random = Math.random, mood = '') {
  if (!cfg.humanizeEnabled) return 0;
  const s = String(text || '');
  const base = Number(cfg.humanDelayBaseMs) || 0;
  const perChar = Number(cfg.humanDelayPerCharMs) || 0;
  const max = Number(cfg.humanDelayMaxMs) || 6000;
  const gap = Number(cfg.multiMessageGapMs) || 0;

  // 第一条 = 读+想+打字；后续条 = 打字间隔
  const raw = index === 0 ? base + s.length * perChar : gap + s.length * perChar * 0.4;
  // ±30% 抖动：真人不会每次都同一个节奏
  const label = String(mood).replace(/[（(].*$/, '');
  const pace = { 开心: 0.85, 得意: 0.9, 惊讶: 0.8, 温柔: 1.12, 认真: 1.08, 困: 1.25, 委屈: 1.15 }[label] || 1;
  const jittered = raw * pace * (0.7 + random() * 0.6);
  return Math.max(0, Math.min(max, Math.round(jittered)));
}

/** 只看第一条的延迟（控制台/测试里想快速知道"大概几秒"）。 */
export function estimateDelayRange(cfg, text) {
  if (!cfg.humanizeEnabled) return { min: 0, max: 0 };
  const s = String(text || '');
  const raw = (Number(cfg.humanDelayBaseMs) || 0) + s.length * (Number(cfg.humanDelayPerCharMs) || 0);
  const cap = Number(cfg.humanDelayMaxMs) || 6000;
  return { min: Math.round(Math.min(cap, raw * 0.7)), max: Math.round(Math.min(cap, raw * 1.3)) };
}
