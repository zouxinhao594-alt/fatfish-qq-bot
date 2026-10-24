// 模型通道：OpenAI 兼容 /chat/completions。可注入 fetch 以便测试，不发请求也能跑。
//
// 支持多渠道：传入的 model 可以是 "渠道id/模型名"（例如 deepseek/deepseek-flash），
// 不带渠道就走配置里的默认 apiBase + apiKey。这样切换模型只改一个字符串。

import { parseRoute, resolveChannel } from './models.mjs';
import { modelFor } from './config.mjs';

export function createLlm({ cfg, log, fetchImpl = globalThis.fetch }) {
  /** 把 "渠道/模型" 解析成实际要打的地址、密钥、模型名。 */
  function target(modelRoute) {
    const { channelId, model } = parseRoute(modelRoute || cfg.model);
    const { channel, fallback } = resolveChannel(cfg, channelId);
    return {
      base: String(channel.apiBase || '').replace(/\/+$/, ''),
      key: channel.apiKey || '',
      model: model || cfg.model,
      channelName: channel.name || '默认渠道',
      fallback
    };
  }

  async function raw(messages, { model, timeoutMs = 30_000, maxTokens = 900, json = true, effort = null } = {}) {
    const t = target(model);
    if (!t.key) throw new Error(`渠道「${t.channelName}」没有配密钥（设置页或环境变量 FATFISH_API_KEY）`);
    if (!t.base) throw new Error(`渠道「${t.channelName}」没有配接口地址`);
    const url = `${t.base}/chat/completions`;
    const body = { model: t.model, messages, max_tokens: maxTokens, temperature: 0.8 };
    if (json) body.response_format = { type: 'json_object' };
    // 视觉等短任务可以要求"少想点"：reasoning 会吃掉 max_tokens 的额度
    if (effort) body.reasoning_effort = effort;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      let res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t.key}` },
        body: JSON.stringify(body),
        signal: ctl.signal
      });
      // 有的渠道不认 response_format：去掉再试一次（失败才算失败）
      if (!res.ok && res.status === 400 && body.response_format) {
        delete body.response_format;
        res = await fetchImpl(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t.key}` },
          body: JSON.stringify(body),
          signal: ctl.signal
        });
      }
      const text = await res.text();
      if (!res.ok) throw new Error(`${t.channelName}/${t.model} 返回 ${res.status}：${text.slice(0, 200)}`);
      let data;
      try { data = JSON.parse(text); } catch { throw new Error(`模型返回不是 JSON：${text.slice(0, 120)}`); }
      const content = data?.choices?.[0]?.message?.content ?? '';
      if (!content) throw new Error('模型返回空内容');
      return { text: content, usage: data.usage ?? null, model: data.model || t.model, channel: t.channelName };
    } finally { clearTimeout(timer); }
  }

  /** 带重试的调用：一次失败等一下再试，最多 2 次。 */
  async function chat(messages, opts = {}) {
    let lastErr;
    for (let i = 0; i < 2; i++) {
      try { return await raw(messages, opts); }
      catch (e) {
        lastErr = e;
        log?.event('llm', `第 ${i + 1} 次调用失败：${e.message}`);
        if (i === 0) await new Promise((r) => setTimeout(r, 800));
      }
    }
    throw lastErr;
  }

  /**
   * 视觉：把图片交给多模态通道描述。
   *
   * 稳定性是这里最大的坑：同一个接口、同一个模型，偶尔会返回**空内容**
   * （reasoning 把 token 吃光，或内容触发静默拒绝）。所以不指望一次成功：
   *   1. 换预算：900 → 1600 → 2600
   *   2. 换推理档：默认 → low → minimal（少想点，正文才有位置）
   *   3. 每次重试之间等一下（瞬时抖动）
   *   4. 还不行就换备用视觉模型（visionFallbackModels，逗号分隔）
   */
  async function describeImage(imageUrl, { model, prompt } = {}) {
    const descPrompt = prompt || [
      '你是给群聊机器人"当眼睛"的。请把这张图看清楚，用中文描述，供它自然地接话。',
      '要说清：① 画面主体是什么（人/物/界面/表情包）② 在做什么、什么表情或动作',
      '③ 图里的文字：**逐字念出来**（有字就抄下来，别概括）④ 整体风格（照片/动漫/表情包/截图）',
      '要求：具体、不要用"好像""大概""似乎"这类含糊词；看不清的部分直接写"这部分看不清"，不要猜。',
      '不超过 120 字。'
    ].join('\n');
    const messages = [{
      role: 'user',
      content: [
        { type: 'text', text: descPrompt },
        { type: 'image_url', image_url: { url: imageUrl } }
      ]
    }];

    const primary = model || cfg.visionModel || cfg.model;
    const fallbacks = String(cfg.visionFallbackModels || '').split(',').map((s) => s.trim()).filter(Boolean);
    const attempts = [
      { label: '默认档', model: primary, maxTokens: 900, effort: null },
      { label: '加预算', model: primary, maxTokens: 1600, effort: 'low' },
      { label: '少思考', model: primary, maxTokens: 2600, effort: 'minimal' },
      ...fallbacks.map((m, i) => ({ label: `备用模型${i + 1}`, model: m, maxTokens: 1600, effort: 'low' }))
    ];

    let lastErr = '';
    for (let i = 0; i < attempts.length; i++) {
      const a = attempts[i];
      try {
        const r = await raw(messages, { model: a.model, maxTokens: a.maxTokens, json: false, timeoutMs: 35_000, effort: a.effort });
        const t = String(r.text || '').trim();
        if (t) {
          if (i > 0) log?.event('vision', `看图重试成功（第 ${i + 1} 次：${a.label}，${a.model}）`);
          return t;
        }
        lastErr = `${a.label}：返回空内容`;
      } catch (e) {
        lastErr = `${a.label}：${e.message}`;
      }
      if (i < attempts.length - 1) await new Promise((res) => setTimeout(res, 400));
    }
    throw new Error(`视觉通道多次重试仍失败（${lastErr}）`);
  }

  /**
   * 给表情包"建语义"：一次调用同时拿到画面描述 + 情绪/场景标签。
   * 只有画面描述的话，挑图永远挑不准（"蓝发女仆端着盆"和"她生气了"对不上）。
   */
  async function tagSticker(imageUrl) {
    const messages = [{
      role: 'user',
      content: [
        {
          type: 'text',
          text: [
            '你在给 QQ 群聊的表情包建索引，方便以后按语境挑出来发。只看画面，如实回答，只输出 JSON：',
            '{"desc":"画面是什么，不超过20字","emotion":["情绪词"],"usage":["适合什么时候发"],"caption":"图里的字（没有就空字符串）"}',
            '要求：',
            '- emotion 用简短中文词，如：开心、委屈、生气、无语、害羞、得意、困、饿、摸鱼、震惊、敷衍',
            '- usage 写"在什么语境下适合发"，2~3 条，如：安慰别人、被夸之后、催人干活、道晚安、表示认输',
            '- 不要臆测画面以外的东西；看不清就不写'
          ].join('\n')
        },
        { type: 'image_url', image_url: { url: imageUrl } }
      ]
    }];
    const r = await raw(messages, { model: cfg.visionModel || cfg.model, maxTokens: 900, json: true, timeoutMs: 40_000, effort: 'low' });
    const t = extractJson(r.text) || {};
    return {
      desc: String(t.desc || '').slice(0, 40),
      emotion: Array.isArray(t.emotion) ? t.emotion.map(String).slice(0, 5) : [],
      usage: Array.isArray(t.usage) ? t.usage.map(String).slice(0, 4) : [],
      caption: String(t.caption || '').slice(0, 30)
    };
  }

  /**
   * 从候选里挑一张最贴当前语境的表情（挑不到就 none）。
   * 比关键词匹配准得多：模型看得懂"她委屈了"该配哪张。
   */
  async function chooseSticker({ context, candidates }) {
    const list = candidates.map((c, i) => c.line || `${i + 1}. ${c.desc || c.name || c.file}`).join('\n');
    const messages = [
      {
        role: 'system',
        content: [
          '你在给群聊的回话挑一张表情包。只输出 JSON：{"pick":编号或0,"why":"不超过10字"}。',
          '判断标准：',
          '- 日常闲聊、开心、吐槽、惊讶、犯困、被催：情绪对上就配一张，别过度谨慎；',
          '- 对方在难过/委屈/抱怨/受挫时：只挑"陪伴、软萌、安慰"这一类（画风温柔、情绪贴合）；',
          '  不要用大笑、比耶、炫耀、翻白眼、看戏这类——会显得在嘲弄。库里有合适的就配，没有就 pick=0；',
          '- 纯信息、严肃（报错、正事、"说正事"的场合）：pick=0；',
          '- 情绪但凡不冲突，优先配一张，让话更活；只有明显不合适才空着。'
        ].join('\n')
      },
      { role: 'user', content: `【当前语境】\n${context}\n\n【表情库】\n${list}` }
    ];
    const r = await raw(messages, { model: modelFor(cfg, 'gate'), maxTokens: 700, json: true, timeoutMs: 25_000, effort: 'low' });
    const o = extractJson(r.text) || {};
    const idx = Number(o.pick);
    if (!idx || idx < 1 || idx > candidates.length) return { pick: null, why: String(o.why || '') };
    return { pick: candidates[idx - 1], why: String(o.why || '') };
  }

  /** 当前实际会打到哪个渠道（控制台/排查用）。 */
  function describeRoute(modelRoute) {
    const t = target(modelRoute);
    return { channel: t.channelName, base: t.base, model: t.model, hasKey: !!t.key, fallback: t.fallback };
  }

  return { chat, describeImage, tagSticker, chooseSticker, describeRoute };
}

/** 从模型输出里抠出 JSON（容忍 ```json 围栏、前后废话）。 */
export function extractJson(text) {
  const s = String(text ?? '').trim();
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : s;
  const start = body.indexOf('{');
  if (start < 0) return null;
  // 从第一个 { 起做括号配对，避免尾部多余字符干扰
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < body.length; i++) {
    const ch = body[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(body.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

export function normalizeReply(parsed, maxSegments = 3) {
  if (!parsed || typeof parsed !== 'object') return null;
  const segs = Array.isArray(parsed.segments) ? parsed.segments : [];
  const out = segs.map((s) => (typeof s === 'string' ? s : (s && typeof s.text === 'string' ? s.text : ''))).map((s) => s.trim()).filter(Boolean);
  if (!out.length) return null;
  const limit = Math.max(1, Math.min(3, Number(maxSegments) || 3));
  const clipped = out.slice(0, limit);
  const memory = Array.isArray(parsed.memory) ? parsed.memory.map((m) => String(m).trim()).filter(Boolean).slice(0, 3) : [];
  // 动作：既接受 {"action":{...}}，也接受契约里的顶层 fetch / shot / draw 简写
  const action = parsed.action && typeof parsed.action === 'object' ? { ...parsed.action } : {};
  if (typeof parsed.fetch === 'string' && parsed.fetch) action.fetch = parsed.fetch;
  if (typeof parsed.shot === 'string' && parsed.shot) action.shot = parsed.shot;
  if (typeof parsed.draw === 'string' && parsed.draw) action.draw = { prompt: parsed.draw };
  if (typeof parsed.voice === 'boolean' && parsed.voice) action.voice = true;
  // 唱歌：模型经常把 song / sing 写在顶层（契约里就是这么教的），不认就会白丢一次点歌
  if (!action.song && parsed.song) {
    if (typeof parsed.song === 'string') action.song = { name: parsed.song };
    else if (typeof parsed.song === 'object') action.song = parsed.song;
  }
  if (!action.sing && parsed.sing) {
    if (typeof parsed.sing === 'string') action.sing = { text: parsed.sing };
    else if (typeof parsed.sing === 'object') action.sing = parsed.sing;
  }
  // 联网搜索：契约里是顶层 "web":{"query":"…"}，也容忍直接写字符串或塞进 action
  const wb = parsed.web || (parsed.action && parsed.action.web) || parsed.search;
  if (typeof wb === 'string' && wb.trim()) action.web = { query: wb.trim() };
  else if (wb && typeof wb === 'object') {
    const q = wb.query || wb.q || wb.text || wb.keyword;
    if (typeof q === 'string' && q.trim()) action.web = { query: q.trim() };
  }
  return {
    segments: clipped,
    mood: typeof parsed.mood === 'string' ? parsed.mood.slice(0, 8) : '',
    sticker: parsed.sticker === 'auto' ? 'auto' : 'none',
    // 补一句：模型可选给一句"说完突然想起的"，由管道决定发不发（看 followUpChance）
    follow: typeof parsed.follow === 'string' ? parsed.follow.trim().slice(0, 40) : '',
    memory,
    action: Object.keys(action).length ? action : null,
    voice: action.voice === true || parsed.voice === true
  };
}
