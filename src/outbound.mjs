// 出站治理：CQ → 真段、路径替换、凭据脱敏、超长切分。
// 教训来自旧版线上事故：NapCat 不解析 text 段里的 CQ 码，群里会看到字面量。

const AT_RE = /\[CQ:at,qq=(\d+)\]/g;
const CQ_ANY_RE = /\[CQ:[a-z_]+(?:,[^\]]*)?\]/gi;
const SECRET_RE = /(sk-[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._-]{12,}|(?:api[_-]?key|token|password)\s*[=:]\s*\S{6,})/gi;
const WIN_PATH_RE = /\b[A-Za-z]:\\(?:[^\\\s]+\\)*[^\\\s]*/g;

/** 去掉模型夹带的 CQ 码（at 单独处理），可选脱敏与路径替换。 */
export function sanitizeText(text, cfg) {
  let out = String(text ?? '');
  out = out.replace(AT_RE, '');           // at 由调用方转成真段
  out = out.replace(CQ_ANY_RE, '');       // 其它 CQ 一律剔除
  if (cfg.outboundBlockOnSecret) out = out.replace(SECRET_RE, '***');
  if (cfg.outboundReplacePaths) out = out.replace(WIN_PATH_RE, '<路径>');
  return out.trim();
}

// 多气泡：模型用 ||| 明确要求"分几条发"。真人聊天很少一口气一段，
// 但也不能每条都拆 —— 拆几条、隔多久，都由程序定（见 pipeline 的 bubbleGap）。
const BUBBLE_SEP = /\s*\|\|\|\s*/;

/** 把"一句|||另一句"拆成 ["一句","另一句"]。空段丢掉，不产生空消息。 */
export function splitBubbles(text, maxBubbles = 0) {
  const parts = String(text ?? '').split(BUBBLE_SEP).map((s) => s.trim()).filter(Boolean);
  const cap = Number(maxBubbles);
  return cap > 0 ? parts.slice(0, cap) : parts;
}

/** 按标点/长度切成多段（单条消息不要太长）。 */
export function splitText(text, maxChars = 1000) {
  const s = String(text ?? '').trim();
  if (!s) return [];
  if (s.length <= maxChars) return [s];
  const parts = [];
  let rest = s;
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars);
    let cut = Math.max(window.lastIndexOf('。'), window.lastIndexOf('！'), window.lastIndexOf('？'), window.lastIndexOf('\n'), window.lastIndexOf('，'));
    if (cut < maxChars * 0.5) cut = maxChars;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts.filter(Boolean);
}

/**
 * 把模型回复编译成"要发的消息列表"，每条是 OneBot 段数组。
 * @returns {Array<Array<object>>}
 */
export function buildOutbound(reply, cfg, { atUserId = '', maxMessages = 3 } = {}) {
  const messages = [];
  for (const rawSeg of reply.segments) {
    const ats = [];
    for (const m of String(rawSeg).matchAll(AT_RE)) ats.push(m[1]);
    // ||| 是"分条"的显式指令：每个气泡各自过脱敏和长度切分，绝不拼回一条
    for (const piece of splitBubbles(rawSeg)) {
      const clean = sanitizeText(piece, cfg);
      const chunks = splitText(clean, cfg.outboundSegmentChars || 1000);
      for (const chunk of chunks) {
        const segs = [];
        const atQq = ats.length ? ats.shift() : (messages.length === 0 && atUserId ? atUserId : '');
        if (atQq) segs.push({ type: 'at', data: { qq: String(atQq) } });
        if (chunk) segs.push({ type: 'text', data: { text: chunk } });
        if (segs.length) {
          messages.push(segs);
          if (messages.length >= maxMessages) return messages;
        }
      }
    }
  }
  return messages;
}

/** 把纯文本折成一条消息（控制台手动发言用）。 */
export function textMessage(text, cfg) {
  return splitText(sanitizeText(text, cfg), cfg.outboundSegmentChars || 1000).map((c) => [{ type: 'text', data: { text: c } }]);
}
