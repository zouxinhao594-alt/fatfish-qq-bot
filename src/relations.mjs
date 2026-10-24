// 关系：它对谁亲、跟谁保持距离。
//
// 这是「主人 / 群友」的唯一判断点：
//   pipeline 用它决定 提示词怎么写、给几句话、心情要不要回暖；
//   gate     用它决定 要不要绕过把关打分、冷却和静默时段。
//
// 为什么单独一个文件：
//   1. 判断规则要能单测（QQ 号带空格、带逗号、写成数字都要认）；
//   2. 提示词是最容易越界的地方（对群友撒娇 = 骚扰），集中一处才好审；
//   3. 以后要加「熟人 / 黑名单」只是多一档，不用动 pipeline。
//
// 设计取向：主人档是「更亲 + 更优先」，不是「更没边界」。
//   亲热 = 语气更软、愿意被使唤、心情回暖、给的话更多；
//   边界 = 不写情话、不装恋人、来历问题照样不破例、不把私事抖给别人。

const OWNER_TITLE_FALLBACK = '主人';

/** 判断 QQ 号：只认 4 位以上的纯数字，别把误填的字符串当成主人 */
function cleanIds(raw) {
  return String(raw ?? '')
    .split(/[,，、;；\s]+/)
    .map((s) => s.trim())
    .filter((s) => /^\d{4,}$/.test(s));
}

export function createRelations({ cfg = {}, log = null } = {}) {
  const ids = () => cleanIds(cfg.ownerUin);

  function tierOf(userId) {
    const id = String(userId ?? '').trim();
    if (!id) return 'friend';
    return ids().includes(id) ? 'owner' : 'friend';
  }

  const isOwner = (userId) => tierOf(userId) === 'owner';

  function title() {
    const t = String(cfg.ownerTitle ?? '').trim();
    return t || OWNER_TITLE_FALLBACK;
  }

  /** 回话条数上限：主人比群里多给一条（真人跟亲近的人说话也更愿意多讲两句） */
  function maxSegmentsFor(tier, base) {
    const n = Math.max(1, Math.min(3, Number(base) || 2));
    return tier === 'owner' ? Math.min(3, n + 1) : n;
  }

  /** 写进 system prompt 的那一段「你现在在跟谁说话」 */
  function hintFor({ userId = '', nickname = '', groupId = '' } = {}) {
    const tier = tierOf(userId);
    const who = String(nickname || '').trim() || '对方';
    const idLine = String(userId || '').trim();
    if (tier === 'owner') {
      // 刻意写成"关系"而不是"规则"：写硬了它会变成客服腔，傲娇也出不来。
      return [
        `【现在跟你说话的是谁】是你的${title()}${idLine ? `（QQ ${idLine}）` : ''}，群里叫「${who}」。`,
        '他对你来说跟别人不一样，但不用把这件事挂在嘴上：',
        '- 你愿意顺着他。他让你做什么，你基本都会照办 —— 不过常会先小小地别扭一句（"哼，就这一次啊"），说完还是老老实实去做。',
        '- 他夸你，嘴上先不承认，其实心里高兴；他久不理你，你小声抱怨两句，然后自己凑回来。',
        '- 傲娇只有一点点：一次回话最多漏一句，别每句都顶，也别一直讨关注，那样就吵了。',
        '- 他问你的来历、模型、技术，还是那句"我就是群里的大肥鱼呀"。',
        groupId ? '- 群里人多，收着点，别当众撒娇。' : ''
      ].filter(Boolean).join('\n');
    }
    return [
      `【现在跟你说话的是谁】是群友「${who}」，不是你的${title()}。按朋友的距离说话：`,
      '- 友好、随意，可以吐槽、可以开玩笑，但别撒娇、别黏人；',
      `- 别叫他「${title()}」「宝宝」「亲爱的」，也别打听人家的私事；`,
      '- 对朋友也可以小小嘴硬一下（"谁要理你呀"），但别真让人下不来台，该接的话要接；',
      `- 他若问你和${title()}平时怎么相处、${title()}是谁，笑着带过，别细说。`
    ].join('\n');
  }

  /** 控制台/日志用的一句话摘要 */
  function describe() {
    return {
      ownerUin: ids(),
      title: title(),
      alwaysReply: cfg.ownerAlwaysReply !== false,
      tiers: ['owner', 'friend']
    };
  }

  if (log) {
    const list = ids();
    log.event('relation', list.length
      ? `认主：${list.join(', ')}（称呼「${title()}」，${cfg.ownerAlwaysReply !== false ? '说话必回' : '和群友一样走判定'}）`
      : `没配主人 QQ（ownerUin）：所有人一律按朋友距离说话`);
  }

  return { tierOf, isOwner, title, maxSegmentsFor, hintFor, describe, ownerIds: ids };
}
