// 禁自曝守卫（V2 的核心新增）：提示词兜不住的，这里兜。
// 三层里的第 2 层（出站正则 + 可选模型判定）与第 3 层（对外文案白名单）。

/** 可疑命中 = 需要人工/模型再看一眼，不直接判死，避免把"讲个故事里的模型"也拦掉。 */
export const EXPOSURE_RULES = [
  { re: /\b(deepseek|深度求索|openai|gpt-?\s?\d|claude|gemini|qwen|通义|豆包|doubao|kimi|moonshot|glm|chatglm|llama|mistral|grok|sora|midjourney|stable\s?diffusion)\b/i, why: '厂商/模型名' },
  { re: /(大模型|语言模型|多模态模型|神经网络|参数量?|上下文(窗口|长度)|token\s*数|提示词|微调|训练数据|temperature|api\s*key|apikey|模型名|部署方式)/i, why: '技术栈术语' },
  { re: /(我是.{0,10}(模型|AI|人工智能|机器人助理))|(作为一个.{0,8}(AI|人工智能|语言模型))|(我由.{0,16}(开发|训练|部署|构建))|(我的训练数据)/i, why: '自述身份' },
  { re: /(os error|errno|127\.0\.0\.1|localhost|https?:\/\/[^\s]*(api|openai|deepseek)[^\s]*|\.exe\b|C:\\\\|[A-Z]:\\\\)/i, why: '本机路径/接口/报错' }
];

/** 对外话术白名单：任何异常都必须经这里才允许出现在群里。 */
export function userFacing(error) {
  const m = String(error?.message || error || '');
  if (/超时|timeout|abort/i.test(m)) return '我这边有点卡，等下再来呀';
  if (/apiKey|401|403|key/i.test(m)) return '我这会儿有点犯迷糊，等下再说呀';
  if (/未连接|通道/i.test(m)) return '我这边有点卡，等下再来呀';
  return '我这边有点卡，等下再来呀';
}

export function createGuard({ cfg, llm, log, stats }) {
  const counters = stats || { checked: 0, blocked: 0, rewritten: 0, judged: 0 };

  function regexCheck(text) {
    for (const r of EXPOSURE_RULES) {
      const m = r.re.exec(text);
      if (m) return { hit: true, why: r.why, matched: m[0] };
    }
    return { hit: false };
  }

  /**
   * 返回 { blocked, why }。
   * - guardModel 配了：可疑句交给廉价模型判"是否在暴露技术身份"，判是才拦（少误伤）
   * - 没配：可疑即拦（宁可少说一句，不可漏底）
   */
  async function check(text) {
    counters.checked += 1;
    const r = regexCheck(text);
    if (!r.hit) return { blocked: false };
    if (!cfg.guardModel) { counters.blocked += 1; log?.event('guard', `拦下一句（${r.why}：${r.matched}）`); return { blocked: true, why: r.why }; }
    counters.judged += 1;
    try {
      const out = await llm.chat([
        { role: 'system', content: '你是一个出站过滤器。只判断这句话是否暴露了"说话者使用的模型、厂商、技术栈、内部实现"。只输出 JSON：{"expose":true|false,"why":"不超过10字"}。' },
        { role: 'user', content: text }
      ], { model: cfg.guardModel, maxTokens: 400, timeoutMs: 15000, json: true });
      const j = JSON.parse(out.text.replace(/^[^{]*/, '').replace(/[^}]*$/, '') || '{}');
      if (j.expose) { counters.blocked += 1; log?.event('guard', `模型判定自曝，拦下（${j.why || r.why}）`); return { blocked: true, why: j.why || r.why }; }
      return { blocked: false };
    } catch (e) {
      // 判定失败 → 保守拦截（这层就是干这个的）
      counters.blocked += 1;
      log?.event('guard', `判定失败，保守拦下：${e.message}`);
      return { blocked: true, why: r.why };
    }
  }

  return { check, regexCheck, counters };
}
