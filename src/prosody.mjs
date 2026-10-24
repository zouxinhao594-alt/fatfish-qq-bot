// 引擎无关的表达计划。音色/参考音频留给 TTS 配置，绝不写进情绪规则。
const profiles = {
  摸鱼: [0, 0, -1, 190], 开心: [0.08, 0.5, 0, 140], 得意: [0.06, 0.4, 0, 150],
  干饭: [0.07, 0.3, 0, 150], 腹黑: [0.02, 0.2, -1, 210], 认真: [-0.03, 0, 0, 230],
  炸毛: [0.06, 0.3, 0, 150], 委屈: [-0.08, -0.2, -2, 280], 难过: [-0.08, -0.2, -2, 280],
  温柔: [-0.07, 0.1, -2, 260], 惊讶: [0.03, 0.6, 0, 210], 困: [-0.12, -0.3, -3, 300], 无语: [-0.05, -0.2, -1, 250]
};
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
export function planProsody({ mood = '', text = '', speed = 1, enabled = true } = {}) {
  const label = String(mood).match(/^([^（(]+)/)?.[1] || '';
  const emotion = enabled && profiles[label] ? label : '';
  const strength = emotion ? Number(String(mood).match(/[（(]([123])\/3[）)]/)?.[1] || 1) : 0;
  const scale = [0, .65, .85, 1][strength];
  const [rate, pitch, gain, pause] = profiles[emotion] || [0, 0, 0, 180];
  const question = strength && /[？?]\s*$/.test(text);
  const hesitant = strength && /……|\.\.\./.test(text);
  const baseSpeed = Number.isFinite(Number(speed)) ? Number(speed) : 1;
  return {
    version: 1, emotion, strength,
    speed: clamp(baseSpeed * (1 + rate * scale - (question ? .01 : 0)), .5, 2),
    pitchSemitones: pitch * scale + (question ? .15 : 0),
    volumeDb: gain * scale,
    pauseMs: Math.round(clamp(180 + (pause - 180) * scale + (hesitant ? 80 : 0), 100, 400)),
    delivery: emotion ? `普通话自然口语，${emotion}，情绪强度 ${strength}/3；清楚断句，不夸张表演。` : '普通话自然平静，清楚断句。'
  };
}
