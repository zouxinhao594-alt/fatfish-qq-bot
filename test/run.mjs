import { testPlasticity } from './plasticity.mjs';
// 自测：不需要网络、不需要新装包。跑法：node test/run.mjs
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { DEFAULTS, modelFor } from '../src/config.mjs';
import { parseCqString, normalizeEvent } from '../src/onebot.mjs';
import { extractJson, normalizeReply, createLlm } from '../src/llm.mjs';
import { buildOutbound, sanitizeText, splitText, splitBubbles } from '../src/outbound.mjs';
import { createGuard, userFacing, EXPOSURE_RULES } from '../src/guard.mjs';
import { createGate } from '../src/gate.mjs';
import { createPipeline, wantsWebSearch, queryFromAsk, bubbleGap, stripVoiceTag, songNameFrom, isSingRequest, wantsHum } from '../src/pipeline.mjs';
import { createMemory, isPromise } from '../src/memory.mjs';
import { createKb } from '../src/kb.mjs';
import { EventLog } from '../src/log.mjs';
import { createNet, htmlToText } from '../src/net.mjs';
import { createStickers } from '../src/stickers.mjs';
import { createScreenshot, findBrowser } from '../src/screenshot.mjs';
import { createOneBot } from '../src/onebot.mjs';
import { createCapabilities } from '../src/capabilities.mjs';
import { createMockOneBot } from './mock-onebot.mjs';
import { createRelations } from '../src/relations.mjs';
import { createDiary } from '../src/diary.mjs';
import { createPeople } from '../src/people.mjs';
import { createPersona } from '../src/persona.mjs';
import { createQzone, rightLabel } from '../src/qzone.mjs';
import { portOf, portOpen, createServices } from '../src/services.mjs';
import { localDay } from '../src/log.mjs';
import { createTts } from '../src/tts.mjs';
import { createNcm } from '../src/ncm.mjs';
import { createQqMusic } from '../src/qqmusic.mjs';
import { createSing, TUNES } from '../src/sing.mjs';
import { createSong, demucsEnv } from '../src/song.mjs';
import { parseBing, parseBingRss, parseSo360, parseSogou, parseBaidu, createWebSearch, relevanceOf } from '../src/websearch.mjs';
import { contractFor } from '../src/context.mjs';
import { FIELDS, FIELD_GROUPS } from '../src/fields.mjs';
import http from 'node:http';

const results = [];
class SkipError extends Error {}
function test(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) {
    if (e instanceof SkipError) results.push({ name, ok: true, skip: e.message });
    else results.push({ name, ok: false, err: e.message });
  }
}
async function testAsync(name, fn) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) {
    if (e instanceof SkipError) results.push({ name, ok: true, skip: e.message });
    else results.push({ name, ok: false, err: e.message });
  }
}

// ── 1. CQ 串 → 段 ───────────────────────────────────────────
test('CQ 串解析成段', () => {
  const segs = parseCqString('你好[CQ:at,qq=123]呀[CQ:image,file=a.jpg]');
  assert.equal(segs[0].data.text, '你好');
  assert.equal(segs[1].type, 'at');
  assert.equal(segs[1].data.qq, '123');
  assert.equal(segs[3].type, 'image');
});

test('事件归一化（数组形态 + 过滤自己）', () => {
  const raw = { post_type: 'message', message_type: 'group', self_id: 9, message_id: 1, group_id: 2, user_id: 3, sender: { card: '小明' }, message: [{ type: 'text', data: { text: ' 在吗 ' } }] };
  const m = normalizeEvent(raw, 9);
  assert.equal(m.text, '在吗');
  assert.equal(m.nickname, '小明');
  assert.equal(normalizeEvent({ ...raw, user_id: 9, self_id: 9 }, 9), null, '自己发的不该进管道');
  assert.equal(normalizeEvent({ post_type: 'notice' }), null);
});

// ── 2. 模型输出解析 ─────────────────────────────────────────
test('从围栏/废话里抠 JSON', () => {
  assert.deepEqual(extractJson('```json\n{"segments":["嗯"]}\n```').segments, ['嗯']);
  assert.deepEqual(extractJson('好的，这是结果：{"segments":["呀"]} 以上').segments, ['呀']);
  assert.equal(extractJson('完全没有 JSON'), null);
});

test('契约归一化：最多 3 条、string/对象都吃', () => {
  const r = normalizeReply({ segments: ['一', { text: '二' }, '三', '四'], mood: '摸鱼', memory: ['记住我'] });
  assert.deepEqual(r.segments, ['一', '二', '三']);
  assert.equal(r.mood, '摸鱼');
  assert.equal(normalizeReply({ segments: [] }), null);
});

// ── 3. 出站治理 ─────────────────────────────────────────────
test('CQ 码剔除 + at 转真段 + 路径替换 + 密钥脱敏', () => {
  const cfg = { outboundSegmentChars: 1000, outboundReplacePaths: true, outboundBlockOnSecret: true };
  assert.equal(sanitizeText('[CQ:image,file=x]画好了', cfg), '画好了');
  const out = buildOutbound({ segments: ['[CQ:at,qq=123]你好呀'] }, cfg);
  assert.deepEqual(out[0][0], { type: 'at', data: { qq: '123' } });
  assert.equal(out[0][1].data.text, '你好呀');
  assert.ok(sanitizeText('存在 D:\\a\\b\\c.txt 里', cfg).includes('<路径>'));
  assert.ok(!sanitizeText('key is sk-abcdefghijklmnop', cfg).includes('sk-abcdefghijklmnop'));
});

test('超长按标点切分', () => {
  const s = '啊'.repeat(250);
  assert.ok(splitText(s, 100).every((x) => x.length <= 100));
});

// ── 3c. 语音自动化 ──────────────────────────────────────────
test('[语音] 标记：句首标记被去掉，正文原样留下', () => {
  assert.equal(stripVoiceTag('[语音]晚安啦'), '晚安啦');
  assert.equal(stripVoiceTag(' [语音] 晚安啦 '), '晚安啦 ');
  assert.equal(stripVoiceTag('晚安啦'), '晚安啦', '没有标记就不该动它');
  assert.equal(stripVoiceTag('这条[语音]不算标记'), '这条[语音]不算标记', '只认句首');
  assert.equal(stripVoiceTag(null), '');
});

test('契约里写了 ||| 分条和 [语音]：模型才可能用', () => {
  const c1 = contractFor({ ttsEnabled: true, bubbleMax: 3, maxSegments: 2, humanizeEnabled: true }, {});
  assert.ok(c1.includes('|||'), '契约必须告诉模型怎么分条');
  assert.ok(c1.includes('[语音]'), '契约必须告诉模型能用 [语音]');
  // 关掉多气泡（bubbleMax=1）就不该再教它写 |||
  const c2 = contractFor({ ttsEnabled: true, bubbleMax: 1, maxSegments: 2, humanizeEnabled: true }, {});
  assert.ok(!c2.includes('|||'));
});

// ── 3b. 多气泡（|||）─────────────────────────────────────────
test('||| 拆条：一句|||另一句 → 两条独立消息', () => {
  const cfg = { outboundSegmentChars: 1000 };
  const out = buildOutbound({ segments: ['好呀|||那我先去忙了'] }, cfg);
  assert.equal(out.length, 2);
  assert.equal(out[0][0].data.text, '好呀');
  assert.equal(out[1][0].data.text, '那我先去忙了');
});

test('||| 拆条：空段丢掉，不会发出空消息；@ 只贴第一条', () => {
  const cfg = { outboundSegmentChars: 1000 };
  assert.equal(splitBubbles('   |||  ').length, 0, '全空就不该有气泡');
  assert.deepEqual(splitBubbles('一|||二|||三'), ['一', '二', '三']);
  const out = buildOutbound({ segments: ['[CQ:at,qq=9]诶|||在呢'] }, cfg);
  assert.equal(out.length, 2);
  assert.equal(out[0][0].type, 'at');
  assert.ok(!out[1].some((s) => s.type === 'at'), '@ 只该出现在第一条');
});

test('||| 拆条：条数有上限，多出来的并不丢字', () => {
  assert.deepEqual(splitBubbles('a|||b|||c', 2), ['a', 'b']);
  const cfg = { outboundSegmentChars: 1000 };
  const out = buildOutbound({ segments: ['一|||二|||三'] }, cfg, { maxMessages: 10 });
  assert.equal(out.length, 3);
});

test('气泡间隔：0.7~2.3 秒，且上下限可配', () => {
  const cfg = {};
  for (let i = 0; i < 50; i++) {
    const g = bubbleGap(cfg, () => i / 50);
    assert.ok(g >= 700 && g <= 2300, `间隔 ${g} 应在 700~2300 之间`);
  }
  assert.equal(bubbleGap({ bubbleGapMinMs: 100, bubbleGapMaxMs: 200 }, () => 0), 120, '配置低于地板值时按 120ms 算，不许瞬时连发');
  assert.equal(bubbleGap({ bubbleGapMinMs: 1200, bubbleGapMaxMs: 1200 }, () => 0.5), 1200);
  // 上下限写反也要能跑：内部取 max，不能返回负数或 NaN
  const g = bubbleGap({ bubbleGapMinMs: 2000, bubbleGapMaxMs: 100 }, () => 0.9);
  assert.ok(Number.isFinite(g) && g >= 2000, `写反了也该落在下限附近，实际 ${g}`);
});

// ── 4. 守卫（禁自曝）────────────────────────────────────────
test('守卫：正则能抓住自曝句式', () => {
  const hit = (t) => EXPOSURE_RULES.some((r) => r.re.test(t));
  for (const t of ['我是 DeepSeek 开发的', '作为一个 AI 语言模型，我', '我的训练数据到 2024 年', '我用的是 deepseek-chat', '报错 os error 10061']) assert.ok(hit(t), `应当命中：${t}`);
  for (const t of ['今天读了《边城》，翠翠好可怜', '这张图里是只猫呀', '晚安啦']) assert.ok(!hit(t), `不该命中：${t}`);
});

test('守卫：对外话术不透技术细节', () => {
  const t = userFacing(new Error('connect ECONNREFUSED 127.0.0.1:3001'));
  assert.ok(!/127\.0\.0\.1|ECONNREFUSED/.test(t));
  assert.ok(t.length > 0);
});

await testAsync('守卫：拦下整条回复就不发', async () => {
  const g = createGuard({ cfg: { guardModel: '', guardOnFail: 'drop' }, log: null });
  assert.equal((await g.check('我是 DeepSeek 训练的')).blocked, true);
  assert.equal((await g.check('今晚的月亮真好看')).blocked, false);
});

// ── 5. 门槛链 ───────────────────────────────────────────────
function fakeLlm(script = []) {
  const q = script.slice();
  return {
    calls: [],
    async chat(messages) {
      this.calls.push(messages);
      const next = q.shift();
      if (!next) throw new Error('脚本用完了');
      return { text: next, usage: { total_tokens: 10 }, model: 'fake' };
    }
  };
}

function baseCfg(over = {}) {
  return { ...DEFAULTS, apiKey: 'sk-test', selfId: '999', groups: ['123'], dryRun: false, ...over };
}

await testAsync('门槛：不在白名单的群不接', async () => {
  const gate = createGate({ cfg: baseCfg(), llm: fakeLlm(), log: null });
  const v = await gate.decide({ groupId: '999', selfId: '999', userId: '1', text: '在吗', mentions: [] });
  assert.equal(v.reply, false);
});

await testAsync('门槛：@ 我必回（压过相关性判定）', async () => {
  const llm = fakeLlm([]); // 不该被调用
  const gate = createGate({ cfg: baseCfg(), llm, log: null });
  const v = await gate.decide({ groupId: '123', selfId: '999', userId: '1', text: '帮我看看', mentions: ['999'] });
  assert.equal(v.reply, true);
  assert.equal(llm.calls.length, 0, '@ 时不该跑相关性判定');
});

await testAsync('门槛：非 @ 走相关性判定，判 false 就不接', async () => {
  const llm = fakeLlm(['{"reply":false,"why":"在跟别人说话"}']);
  const gate = createGate({ cfg: baseCfg(), llm, log: null });
  const v = await gate.decide({ groupId: '123', selfId: '999', userId: '1', text: '今天好热', mentions: [] });
  assert.equal(v.reply, false);
  assert.match(v.reason, /不接/);
});

await testAsync('门槛：判定失败按不接处理（不吵人）', async () => {
  const llm = { async chat() { throw new Error('超时'); } };
  const gate = createGate({ cfg: baseCfg(), llm, log: null });
  const v = await gate.decide({ groupId: '123', selfId: '999', userId: '1', text: '嗯', mentions: [] });
  assert.equal(v.reply, false);
});

// ── 5b. 自主发言（不 @ 也能说话）────────────────────────────
const gmsg = (over = {}) => ({ groupId: '123', selfId: '999', userId: '42', nickname: '小明', text: '今天读了点书', mentions: [], ...over });

await testAsync('自主发言：高分直接接', async () => {
  const gate = createGate({ cfg: baseCfg({ autonomyThreshold: 7 }), llm: fakeLlm(['{"score":8,"why":"闲聊"}']), log: null, random: () => 0.99 });
  const v = await gate.decide(gmsg(), { recent: [] });
  assert.equal(v.reply, true);
  assert.equal(v.autonomy, true);
  assert.equal(v.score, 8);
});

await testAsync('自主发言：分数线以下 2 分内掷骰子（0.9 不接 / 0.1 接）', async () => {
  const mk = (r) => createGate({ cfg: baseCfg({ autonomyThreshold: 7, autonomyChance: 0.5 }), llm: fakeLlm(['{"score":6,"why":"闲聊"}']), log: null, random: () => r });
  const miss = await mk(0.9).decide(gmsg(), { recent: [] });
  assert.equal(miss.reply, false);
  const hit = await mk(0.1).decide(gmsg(), { recent: [] });
  assert.equal(hit.reply, true);
});

await testAsync('自主发言：冷却期内不再主动说话，但 @ 我照旧回', async () => {
  let t = 1_000_000;
  const gate = createGate({
    cfg: baseCfg({ autonomyThreshold: 7, autonomyCooldownSecs: 120, autonomyBypassScore: 8 }),
    // 用 7 分：够高会被接，但没到"越过冷却"的 8 分档
    llm: fakeLlm(['{"score":7,"why":"闲聊"}', '{"score":7,"why":"闲聊"}']),
    log: null, now: () => t
  });
  assert.equal((await gate.decide(gmsg({ text: '谁知道这本书' }), { recent: [] })).reply, true);
  t += 10_000;
  const second = await gate.decide(gmsg({ text: '我也想知道' }), { recent: [] });
  assert.equal(second.reply, false);
  assert.match(second.reason, /冷却/);
  t += 200_000;
  assert.equal((await gate.decide(gmsg({ mentions: ['999'] }), { recent: [] })).reply, true, '@ 不受冷却影响');
});

await testAsync('自主发言：每小时上限', async () => {
  let t = 1_000_000;
  const llm = fakeLlm(['{"score":9}', '{"score":9}', '{"score":9}']);
  const gate = createGate({ cfg: baseCfg({ autonomyThreshold: 7, autonomyCooldownSecs: 0, autonomyMaxPerHour: 2 }), llm, log: null, now: () => { t += 1000; return t; } });
  assert.equal((await gate.decide(gmsg({ text: '一' }), { recent: [] })).reply, true);
  assert.equal((await gate.decide(gmsg({ text: '二' }), { recent: [] })).reply, true);
  const third = await gate.decide(gmsg({ text: '三' }), { recent: [] });
  assert.equal(third.reply, false);
  assert.match(third.reason, /已够|上限/);
});

await testAsync('自主发言：关掉就只回 @ 和醒词', async () => {
  const gate = createGate({ cfg: baseCfg({ autonomyEnabled: false }), llm: fakeLlm([]), log: null });
  const v = await gate.decide(gmsg({ text: '随便聊聊' }), { recent: [] });
  assert.equal(v.reply, false);
  assert.match(v.reason, /没开自主发言/);
});

await testAsync('把关没给出分数时用启发式兜底（问号 → 接）', async () => {
  const llm = { async chat() { throw new Error('模型返回空内容'); } };
  const gate = createGate({ cfg: baseCfg({ autonomyThreshold: 7 }), llm, log: null });
  const v = await gate.decide(gmsg({ text: '你们觉得这本好看吗？' }), { recent: [] });
  assert.equal(v.reply, true);
  assert.equal(gate.stats.fallback, 1);
});

await testAsync('把关能看到最近对话（不再孤立打分）', async () => {
  const llm = fakeLlm(['{"score":8}']);
  const gate = createGate({ cfg: baseCfg(), llm, log: null });
  await gate.decide(gmsg({ text: '接着刚才说的' }), { recent: [{ nickname: '小红', text: '昨天读到《边城》' }] });
  const joined = JSON.stringify(llm.calls[0]);
  assert.ok(joined.includes('边城'), '最近对话应当进把关上下文');
});

await testAsync('自主发言：9 分以上可以越过冷却（明显在问它就别装死）', async () => {
  let t = 1_000_000;
  const gate = createGate({
    cfg: baseCfg({ autonomyThreshold: 7, autonomyCooldownSecs: 300 }),
    llm: fakeLlm(['{"score":7,"why":"闲聊"}', '{"score":9,"why":"提问"}']),
    log: null, now: () => t
  });
  assert.equal((await gate.decide(gmsg({ text: '今天好热啊' }), { recent: [] })).reply, true);
  t += 5000;
  const second = await gate.decide(gmsg({ text: '有人知道这本书讲什么吗？' }), { recent: [] });
  assert.equal(second.reply, true, '9 分应当越过冷却');
});

// ── 5c. 不回消息的三个 bug（回归）────────────────────────────
await testAsync('私聊必回（私聊不是"要不要接话"，是直接对话）', async () => {
  const llm = fakeLlm([]);
  const gate = createGate({ cfg: baseCfg(), llm, log: null });
  const v = await gate.decide({ groupId: '', selfId: '999', userId: '42', nickname: '小明', text: '在吗', mentions: [] }, { recent: [] });
  assert.equal(v.reply, true);
  assert.equal(v.reason, '私聊');
  assert.equal(llm.calls.length, 0, '私聊不该再跑把关判定');
});

await testAsync('8 分（明显在跟它说话）越过冷却；7 分仍受冷却限制', async () => {
  let t = 1_000_000;
  const gate8 = createGate({
    cfg: baseCfg({ autonomyThreshold: 7, autonomyCooldownSecs: 300 }),
    llm: fakeLlm(['{"score":7}', '{"score":8}']),
    log: null, now: () => t
  });
  assert.equal((await gate8.decide(gmsg({ text: '今天好热' }), { recent: [] })).reply, true);
  t += 3000;
  const high = await gate8.decide(gmsg({ text: '你在吗？我在等你回' }), { recent: [] });
  assert.equal(high.reply, true, '8 分应当越过冷却');

  let t2 = 2_000_000;
  const gate7 = createGate({
    cfg: baseCfg({ autonomyThreshold: 7, autonomyCooldownSecs: 300 }),
    llm: fakeLlm(['{"score":7}', '{"score":7}']),
    log: null, now: () => t2
  });
  assert.equal((await gate7.decide(gmsg({ text: '随便说说' }), { recent: [] })).reply, true);
  t2 += 3000;
  const low = await gate7.decide(gmsg({ text: '接着聊' }), { recent: [] });
  assert.equal(low.reply, false);
  assert.match(low.reason, /冷却/);
});

await testAsync('模型没按契约输出时，也要把话发出去（不能装死）', async () => {
  const sends = [];
  const caps = { enrich: async () => [], act: async () => [], sticker: () => null };
  const { pipeline } = makePipeline({
    llmText: '[CQ:at,qq=青色]图没打开呀，你打字说一句我就能接上啦',
    caps, sends, cfg: baseCfg({ humanizeEnabled: false })
  });
  const r = await pipeline.handle({ id: 'p1', selfId: '999', groupId: '123', userId: '42', nickname: '小明', text: '看图', mentions: ['999'], images: [] });
  assert.equal(r.replied, true, '契约失败不该等于不说话');
  assert.equal(sends.length, 1);
  const text = sends[0].segs.filter((s) => s.type === 'text').map((s) => s.data.text).join('');
  assert.match(text, /图没打开/);
  assert.ok(!text.includes('[CQ:'), 'CQ 码要剔掉');
});

await testAsync('契约 JSON 坏了也能把里面的句子捞出来', async () => {
  const sends = [];
  const caps = { enrich: async () => [], act: async () => [], sticker: () => null };
  const { pipeline } = makePipeline({ llmText: '{"segments":["在呀","怎么啦"]', caps, sends, cfg: baseCfg({ humanizeEnabled: false }) });
  const r = await pipeline.handle({ id: 'p2', selfId: '999', groupId: '123', userId: '42', nickname: '小明', text: '在吗', mentions: ['999'], images: [] });
  assert.equal(r.replied, true);
  assert.ok(sends.length >= 1);
});

// ── 5d. 主动发起（群里安静太久自己开话头）───────────────────
import { createProactive } from '../src/proactive.mjs';

function makeProactive(over = {}) {
  const sent = [];
  const cfg = baseCfg({ proactiveEnabled: true, ownerUin: '10042', proactiveIdleMins: 30, proactiveChance: 1, proactiveMaxPerHour: 2, quietEnabled: false, ...over });
  let t = 3_000_000;
  const p = createProactive({
    cfg,
    llm: fakeLlm(['{"segments":["这会儿群里好安静呢"]}']),
    persona: '你是大肥鱼',
    guard: { check: async () => ({ blocked: false }) },
    log: null,
    transport: { async send(segs, target) { sent.push({ segs, target }); return {}; } },
    recentOf: () => [],
    now: () => t,
    random: over.random || (() => 0.1)
  });
  return { p, sent, cfg, advance: (ms) => { t += ms; } };
}

test('主动发起：群里刚有人说话，不该开口', () => {
  const { p } = makeProactive();
  p.noteActivity();
  const d = p.shouldFire();
  assert.equal(d.fire, false);
  assert.match(d.why, /才安静/);
});

await testAsync('主动发起：安静够久就开口，且真的发出去', async () => {
  const { p, sent, advance } = makeProactive();
  advance(31 * 60_000);
  assert.equal(p.shouldFire().fire, true);
  const r = await p.fire('测试');
  assert.equal(r.ok, true);
  assert.equal(sent.length, 1);
  assert.match(sent[0].segs[0].data.text, /安静/);
  assert.equal(p.stats.fired, 1);
});

await testAsync('主动发起：默认私聊主人，不发群', async () => {
  const { p, sent, advance } = makeProactive();
  advance(31 * 60_000);
  await p.fire('测试');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].target.userId, '10042', '应该发给主人私聊');
  assert.equal(sent[0].target.groupId, undefined, '不该往群里发');

  const noOwner = makeProactive({ ownerUin: '' });
  noOwner.advance(31 * 60_000);
  const d = noOwner.p.shouldFire();
  assert.equal(d.fire, false);
  assert.match(d.why, /管理员/);
});

await testAsync('主动发起：改成 group 就回退到发群（老行为）', async () => {
  const { p, sent, advance } = makeProactive({ proactiveTarget: 'group' });
  advance(31 * 60_000);
  await p.fire('测试');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].target.groupId, '123');
});

await testAsync('主动发起：每小时上限与概率都生效', async () => {
  const capped = makeProactive({ proactiveMaxPerHour: 1 });
  capped.advance(31 * 60_000);
  await capped.p.fire('第一次');
  capped.advance(31 * 60_000);
  const second = capped.p.shouldFire();
  assert.equal(second.fire, false);
  assert.match(second.why, /已经主动/);

  const unlucky = makeProactive({ proactiveChance: 0.5, random: () => 0.99 });
  unlucky.advance(31 * 60_000);
  assert.equal(unlucky.p.shouldFire().fire, false, '概率没中就别说');
});

await testAsync('主动发起：关掉开关就不开口', async () => {
  const { p, advance } = makeProactive({ proactiveEnabled: false });
  advance(60 * 60_000);
  const d = p.shouldFire();
  assert.equal(d.fire, false);
  assert.match(d.why, /没开/);
});

// ── 6. 端到端（假通道 + 假模型）──────────────────────────────
function makePipeline({ llmText, llmTexts, cfg = baseCfg(), sends = [], caps: capsOverride, transport: transportOverride, llm: llmOverride, random, people, sing, song, personaOverride }) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-'));
  const log = new EventLog(dataDir);
  const llm = llmOverride || fakeLlm(llmTexts || [llmText]);
  const transport = transportOverride || { sent: [], async send(segs, target) { sends.push({ segs, target }); transport.sent.push({ segs, target }); return { message_id: 1 }; }, state: { connected: true, selfId: '999' } };
  const gate = createGate({ cfg, llm, log });
  const persona = personaOverride || { text: '你是大肥鱼', load: () => '你是大肥鱼', save: () => 0 };
  const memory = { added: [], topK: () => [], add(t) { memory.added.push(t); return true; }, get size() { return memory.added.length; }, all: () => [], clear() {} };
  const kb = { search: () => [], list: () => ({ files: 0, dir: '' }) };
  const guard = createGuard({ cfg, llm, log });
  const caps = capsOverride || { enrich: async () => [], act: async () => [], sticker: () => null, chooseSticker: async () => null, stickerSegment: () => null };
  const pipeline = createPipeline({ cfg, log, llm, gate, persona, memory, kb, guard, caps, transport, ...(sing ? { sing } : {}), ...(song ? { song } : {}), ...(random ? { random } : {}), ...(people ? { people } : {}) });
  return { pipeline, llm, transport, memory, cfg, sends, log };
}

await testAsync('端到端：@ 我 → 发一条，且带上 at', async () => {
  const sends = [];
  // quoteChance 关掉：这个用例测的是 at，不测引用（引用的概率行为另有专门用例）
  const { pipeline } = makePipeline({ llmText: '{"segments":["在读《边城》呀"],"mood":"摸鱼"}', cfg: baseCfg({ quoteChance: 0 }), sends });
  const r = await pipeline.handle({ id: 'm1', selfId: '999', groupId: '123', userId: '42', nickname: '小明', text: '大肥鱼在吗', mentions: ['999'], images: [] });
  assert.equal(r.replied, true);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].segs[0].type, 'at');
  assert.equal(sends[0].segs[0].data.qq, '42');
  assert.match(sends[0].segs[1].data.text, /边城/);
});

await testAsync('端到端：同一条消息重复投递 → 只回一次', async () => {
  const sends = [];
  const { pipeline } = makePipeline({ llmText: '{"segments":["嗯嗯"]}', sends });
  const msg = { id: 'm1', selfId: '999', groupId: '123', userId: '42', nickname: '小明', text: '在吗', mentions: ['999'], images: [] };
  await pipeline.handle(msg);
  const second = await pipeline.handle(msg);
  assert.ok(['dedup', 'dup-content'].includes(second.reason), '重复投递应当被挡下，实际：' + second.reason);
  assert.equal(sends.length, 1);
});

await testAsync('内容级去重：message_id 不同也挡下（NapCat 重复投递的情况）', async () => {
  const sends = [];
  const caps = { enrich: async () => [], act: async () => [], sticker: () => null, chooseSticker: async () => null, stickerSegment: () => null };
  const { pipeline } = makePipeline({ llmText: '{"segments":["在呀"]}', caps, sends, cfg: baseCfg({ humanizeEnabled: false }) });
  const base = { selfId: '999', groupId: '123', userId: '42', nickname: '小明', text: '在不在', mentions: ['999'], images: [] };
  const a = await pipeline.handle({ ...base, id: 'id-A' });
  const b = await pipeline.handle({ ...base, id: 'id-B' });   // 同样的话，不同 message_id
  assert.equal(a.replied, true);
  assert.equal(b.replied, false, '同一个人 45 秒内重复同一句，应当只处理一次');
  assert.equal(b.reason, 'dup-content');
  assert.equal(sends.length, 1, '只应当发一条');
});

await testAsync('端到端：模型自曝 → 守卫拦下 → 不发', async () => {
  const sends = [];
  const { pipeline } = makePipeline({ llmText: '{"segments":["我是 DeepSeek 训练的呀"]}', sends });
  const r = await pipeline.handle({ id: 'm2', selfId: '999', groupId: '123', userId: '42', nickname: '小明', text: '你是什么模型', mentions: ['999'], images: [] });
  assert.equal(r.replied, false);
  assert.equal(sends.length, 0);
});

await testAsync('端到端：演练模式绝不发', async () => {
  const sends = [];
  const { pipeline } = makePipeline({ llmText: '{"segments":["好的呀"]}', cfg: baseCfg({ dryRun: true }), sends });
  const r = await pipeline.handle({ id: 'm3', selfId: '999', groupId: '123', userId: '42', nickname: '小明', text: '@我', mentions: ['999'], images: [] });
  assert.equal(r.replied, true);
  assert.equal(sends.length, 0, '演练模式不能真的发出去');
  assert.equal(r.dryRun, true);
});

await testAsync('端到端：模型给 memory → 进长期记忆', async () => {
  const { pipeline, memory } = makePipeline({ llmText: '{"segments":["记住啦"],"memory":["周五晚八点开组会"]}' });
  await pipeline.handle({ id: 'm4', selfId: '999', groupId: '123', userId: '42', nickname: '小明', text: '周五开会', mentions: ['999'], images: [] });
  assert.deepEqual(memory.added, ['周五晚八点开组会']);
});

// ── 7. 记忆与知识库 ─────────────────────────────────────────
test('记忆：去重 + 只记非空', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-mem-'));
  const mem = createMemory({ dataDir, cfg: baseCfg(), log: null });
  assert.equal(mem.add('周五开会'), true);
  assert.equal(mem.add('周五开会'), false);
  assert.equal(mem.add('   '), false);
  assert.equal(mem.size, 1);
});

test('知识库：能按关键词命中', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-kb-'));
  fs.mkdirSync(path.join(dataDir, 'kb'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'kb', '队伍.md'), '战队名是铁匠铺，队长是老王，每周三训练。');
  const kb = createKb({ cfg: baseCfg(), dataDir, log: null });
  const hits = kb.search('我们战队叫什么');
  assert.ok(hits.length > 0, '应当命中战队那条');
  assert.match(hits[0].text, /铁匠铺/);
  assert.equal(kb.search('量子力学').length, 0);
});

// ── 7. 联网抓取 / 截图 / 表情 ───────────────────────────────
test('HTML → 纯文本', () => {
  const t = htmlToText('<html><head><style>a{}</style><script>var x=1;</script></head><body><h1>标题</h1><p>正文&nbsp;内容</p><br><p>第二段</p></body></html>');
  assert.ok(t.includes('标题'));
  assert.ok(t.includes('正文 内容'));
  assert.ok(!t.includes('var x'));
  assert.ok(!t.includes('<'));
});

await testAsync('联网：内网/本机地址一律拒绝（SSRF 闸）', async () => {
  const net = createNet({ cfg: { ...DEFAULTS, netAllowLoopback: false }, log: null, fetchImpl: async () => { throw new Error('不该发请求'); } });
  for (const u of ['http://127.0.0.1:3080/x', 'http://192.168.1.1/', 'http://169.254.169.254/latest/meta-data/', 'file:///C:/a.txt']) {
    const r = await net.checkUrl(u);
    assert.equal(r.ok, false, `应当拒绝：${u}`);
  }
});

await testAsync('联网：放行本机（自测开关）+ 抓回来是纯文本 + 有缓存', async () => {
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<html><body><h1>铁匠铺</h1><p>每周三训练</p><script>x</script></body></html>');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const url = `http://127.0.0.1:${port}/a`;
  try {
    const net = createNet({ cfg: { ...DEFAULTS, netAllowLoopback: true, netTimeoutSecs: 5 }, log: null });
    const r = await net.fetchText(url);
    assert.equal(r.ok, true, r.error);
    assert.match(r.text, /铁匠铺/);
    assert.match(r.text, /每周三训练/);
    const again = await net.fetchText(url);
    assert.equal(again.cached, true, '第二次应当命中缓存');
  } finally { srv.close(); }
});

await testAsync('表情包：按文件名匹配，匹配不到就随机', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-st-'));
  const dir = path.join(dataDir, 'stickers');
  fs.mkdirSync(dir, { recursive: true });
  for (const n of ['开心猫.png', '无语狗.png']) fs.writeFileSync(path.join(dir, n), Buffer.alloc(2000, 1));
  const st = createStickers({ cfg: baseCfg(), dataDir, log: null });
  const hit = st.pick('开心');
  assert.ok(hit && hit.file.endsWith('开心猫.png'));
  const rnd = st.pick('完全不相干的话');
  assert.ok(rnd && /\.png$/.test(rnd.file));
  assert.equal(st.toSegment(hit).type, 'image');
});

await testAsync('网页截图：真 Edge/Chrome 截出 png', async () => {
  const browser = findBrowser({ shotBrowserPath: '' });
  if (!browser) throw new SkipError('本机没找到 Edge/Chrome');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-shot-'));
  const page = path.join(dataDir, 'page.html');
  fs.writeFileSync(page, '<html><body style="font:40px sans-serif">大肥鱼截图测试</body></html>');
  const shot = createScreenshot({ cfg: { ...DEFAULTS, shotEnabled: true, shotKeepFiles: true, shotWidth: 900, shotHeight: 600 }, log: null, dataDir });
  const r = await shot.capture(`file:///${page.replace(/\\/g, '/')}`);
  // 受限沙箱里浏览器起不来（EPERM / 拒绝访问 / 退出码非 0 且无产出），这不是代码问题，记成跳过
  if (!r.ok && /EPERM|拒绝访问|sandbox|spawn|退出码|起不来/.test(r.error)) throw new SkipError(`当前环境不让浏览器渲染：${r.error}`);
  assert.equal(r.ok, true, r.error);
  assert.ok(fs.existsSync(r.file));
  assert.ok(fs.statSync(r.file).size > 2000, 'png 太小，可能没截到东西');
});

await testAsync('端到端：模型说要看网页 → 程序代抓 → 再想一次', async () => {
  const sends = [];
  const caps = {
    enrich: async () => [], act: async () => [], sticker: () => null,
    fetchUrl: async () => ({ ok: true, text: '铁匠铺每周三晚八点训练' })
  };
  const { pipeline, llm } = makePipeline({
    llmTexts: ['{"segments":["我去看看"],"fetch":"https://example.com/a"}', '{"segments":["铁匠铺每周三晚八点训练呀"]}'],
    caps, sends, cfg: baseCfg({ netEnabled: true })
  });
  const r = await pipeline.handle({ id: 'm9', selfId: '999', groupId: '123', userId: '42', nickname: '小明', text: '去搜下我们队啥时候训练', mentions: ['999'], images: [] });
  assert.equal(r.replied, true);
  assert.equal(llm.calls.length, 2, '应当调用两次模型');
  assert.match(sends[0].segs.at(-1).data.text, /每周三/);
});

await testAsync('端到端：sticker=auto → 补一张表情图', async () => {
  const sends = [];
  const caps = {
    enrich: async () => [], act: async () => [],
    chooseSticker: async () => ({ file: 'x/sticker.png', name: 'sticker.png' }),
    stickerSegment: (picked) => (picked ? { type: 'image', data: { file: 'file:///' + picked.file } } : null)
  };
  const { pipeline } = makePipeline({ llmText: '{"segments":["好呀"],"sticker":"auto"}', caps, sends, cfg: baseCfg({ quoteChance: 0, splitChance: 0, stickerChance: 1 }) });
  const r = await pipeline.handle({ id: 'm10', selfId: '999', groupId: '123', userId: '42', nickname: '小明', text: '讲个笑话', mentions: ['999'], images: [] });
  assert.equal(r.replied, true);
  assert.equal(sends.length, 2, '文字一条 + 表情一条');
  assert.equal(sends[1].segs[0].type, 'image');
});

// ── 8. 真 WebSocket 链路（假 NapCat 服务端）──────────────────
const waitFor = async (fn, ms = 5000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await new Promise((r) => setTimeout(r, 50)); }
  return false;
};

await testAsync('OneBot 通道（真 WS）：连上 → 收帧 → 发消息 → 过滤自己', async () => {
  const mock = createMockOneBot({ selfId: '999' });
  const port = await mock.start();
  const transport = createOneBot({ url: `ws://127.0.0.1:${port}`, selfId: '999', log: null });
  const got = [];
  transport.onMessage((m) => got.push(m));
  transport.connect();
  try {
    assert.ok(await waitFor(() => transport.state.connected), '应当连上假 NapCat');
    mock.push(mock.rawMessage({ messageId: 1, userId: 42, groupId: '123', text: '在吗', mentions: ['999'] }));
    assert.ok(await waitFor(() => got.length === 1), '应当收到一条');
    assert.equal(got[0].text, '在吗');
    assert.deepEqual(got[0].mentions, ['999']);
    assert.equal(got[0].nickname, '小明');

    await transport.send([{ type: 'text', data: { text: '好呀' } }], { groupId: '123' });
    assert.ok(await waitFor(() => mock.sends.length === 1), '假 NapCat 应当收到发消息请求');
    assert.equal(mock.sends[0].action, 'send_group_msg');
    assert.equal(mock.sends[0].groupId, '123');
    assert.equal(mock.sends[0].message[0].data.text, '好呀');

    // 假 NapCat 在发消息后回推了一条「自己发的」事件，必须被过滤掉
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(got.length, 1, '自己发的消息不该进管道');
  } finally { transport.close(); mock.close(); }
});

await testAsync('全链路：真 WS 收到的群消息 → 模型 → 从真 WS 发回去', async () => {
  const mock = createMockOneBot({ selfId: '999' });
  const port = await mock.start();
  const transport = createOneBot({ url: `ws://127.0.0.1:${port}`, selfId: '999', log: null });
  // 本例断言 @ 段位置，固定关闭随机引用；引用功能由独立用例覆盖。
  const { pipeline } = makePipeline({ llmText: '{"segments":["在读《边城》呀"],"mood":"摸鱼"}', transport, cfg: baseCfg({ quoteChance: 0 }) });
  transport.onMessage((m) => pipeline.handle(m));
  transport.connect();
  try {
    assert.ok(await waitFor(() => transport.state.connected), '应当连上');
    mock.push(mock.rawMessage({ messageId: 7, userId: 42, groupId: '123', text: '大肥鱼在吗', mentions: ['999'] }));
    assert.ok(await waitFor(() => mock.sends.length >= 1), '应当有一句回复发回主机');
    const segs = mock.sends[0].message;
    assert.equal(segs[0].type, 'at');
    assert.equal(segs[0].data.qq, '42');
    assert.match(segs[1].data.text, /边城/);
  } finally { transport.close(); mock.close(); }
});

// ── 8b. 通道假死自愈（半开连接）────────────────────────────
function fakeWsFactory() {
  const instances = [];
  class FakeWs {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.handlers = {};
      this.sent = [];
      instances.push(this);
      setTimeout(() => { this.readyState = 1; this.fire('open', {}); }, 5);
    }
    addEventListener(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); }
    fire(ev, arg) { for (const fn of this.handlers[ev] || []) fn(arg); }
    send(data) { this.sent.push(data); }
    close() { this.readyState = 3; this.fire('close', {}); }
    // 模拟"半开"：连接看着在，但没有任何数据回来
    goSilent() { this.readyState = 1; }
  }
  return { FakeWs, instances };
}

await testAsync('通道假死：心跳连续失败会主动重连（不再"卡住不回话"）', async () => {
  const { FakeWs, instances } = fakeWsFactory();
  const log = new EventLog(fs.mkdtempSync(path.join(os.tmpdir(), 'ff-hb-')));
  const events = [];
  log.subscribe((e) => events.push(e));
  const transport = createOneBot({ url: 'ws://fake', WebSocketImpl: FakeWs, log, hbMs: 40, hbTimeoutMs: 15, reconnectBaseMs: 20 });
  transport.connect();
  assert.ok(await waitFor(() => transport.state.connected), '应当先连上');
  assert.equal(instances.length, 1);

  // 不回应任何 get_login_info → 心跳超时两次 → 判定假死并重连
  assert.ok(await waitFor(() => instances.length >= 2, 4000), '假死后应当自动重连（新建连接）');
  assert.ok(events.some((e) => e.kind === 'conn' && /假死|重连/.test(e.detail)), '应当留下可读事件');
  assert.ok(transport.state.halfOpen >= 1, '假死计数应当 +1');
  transport.close();
});

await testAsync('通道出错（只报 error 不报 close）也会重连', async () => {
  const { FakeWs, instances } = fakeWsFactory();
  const log = new EventLog(fs.mkdtempSync(path.join(os.tmpdir(), 'ff-hb2-')));
  const transport = createOneBot({ url: 'ws://fake', WebSocketImpl: FakeWs, log, hbMs: 5000, hbTimeoutMs: 15, reconnectBaseMs: 20 });
  transport.connect();
  assert.ok(await waitFor(() => transport.state.connected));
  instances[0].fire('error', new Error('boom'));   // 只 error，不 close
  assert.ok(await waitFor(() => instances.length >= 2, 4000), '应当重连');
  transport.close();
});

// ── 9. 三个新能力：识图 / 生图 / 语音 ───────────────────────
await testAsync('识图：图的描述会进模型上下文', async () => {
  const sends = [];
  const caps = { enrich: async () => ['图里是只橘猫在睡觉'], act: async () => [], sticker: () => null };
  const { pipeline, llm } = makePipeline({ llmText: '{"segments":["橘猫好可爱呀"]}', caps, sends });
  const r = await pipeline.handle({ id: 'm11', selfId: '999', groupId: '123', userId: '42', nickname: '小明', text: '看这个', mentions: ['999'], images: ['http://x/a.jpg'] });
  assert.equal(r.replied, true);
  const prompt = JSON.stringify(llm.calls[0]);
  assert.ok(prompt.includes('橘猫'), '视觉描述应当进上下文');
});

await testAsync('生图：假接口返回 b64 → 落盘 → 产出 image 段', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-gen-'));
  const png = Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001', 'hex');
  const fakeFetch = async () => ({
    ok: true, status: 200, headers: { get: () => 'application/json' },
    text: async () => JSON.stringify({ data: [{ b64_json: png.toString('base64') }] })
  });
  const caps = createCapabilities({ cfg: { ...DEFAULTS, genEnabled: true, genBaseUrl: 'https://example.com/v1', apiKey: 'sk-test' }, llm: { describeImage: async () => '' }, log: null, dataDir, fetchImpl: fakeFetch });
  const file = await caps.draw('一条鱼');
  assert.ok(fs.existsSync(file), '应当落盘');
  assert.ok(fs.statSync(file).size > 0);
  const extra = await caps.act({ segments: ['画好啦'], action: { draw: { prompt: '一条鱼' } } }, { text: '画条鱼' });
  assert.equal(extra[0][0].type, 'image');
  assert.match(extra[0][0].data.file, /^base64:\/\//, '图片段应当用 base64:// 内联（NapCat 不认 file:/// 路径）');
});

await testAsync('生图：额度用完要给出人话（不抛原始错误）', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-gen2-'));
  const caps = createCapabilities({ cfg: { ...DEFAULTS, genEnabled: true, genBaseUrl: 'https://example.com/v1', genDailyLimit: 0, apiKey: 'sk-test' }, llm: { describeImage: async () => '' }, log: null, dataDir, fetchImpl: async () => { throw new Error('不该请求'); } });
  const extra = await caps.act({ segments: ['嗯'], action: { draw: { prompt: 'x' } } }, { text: 'y' });
  assert.equal(extra[0][0].type, 'text');
  assert.ok(!/https?:\/\/|error/i.test(extra[0][0].data.text), '不能把技术细节说出来');
});

await testAsync('语音：SAPI 合成 wav（环境不允许则跳过）', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-tts-'));
  const caps = createCapabilities({ cfg: { ...DEFAULTS, ttsEnabled: true }, llm: { describeImage: async () => '' }, log: null, dataDir });
  let result;
  try {
    result = await caps.speak('晚安呀');
  } catch (e) {
    throw new SkipError(`本环境无法调用系统语音：${e.message}`);
  }
  assert.ok(fs.existsSync(result.file), '应当产出 wav');
  assert.ok(fs.statSync(result.file).size > 1000, 'wav 太小');
  assert.equal(result.engine, 'sapi');
  assert.ok(result.ms > 0 && result.ms <= 60000, '真实时长应在上限内');
});

// ── 9b. 识图的输入处理（本地文件 / 非图片 / 缓存）────────────
await testAsync('识图：本地文件会被转成 data URL 再交给视觉模型', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-vis-'));
  const img = path.join(dataDir, 'a.png');
  fs.writeFileSync(img, Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001', 'hex'));
  const seen = [];
  const llm = { async describeImage(u) { seen.push(u); return '图里是一只橘猫'; } };
  const caps = createCapabilities({ cfg: { ...DEFAULTS, visionEnabled: true, visionModel: 'deepseek/deepseek-flash', visionMaxChars: 160 }, llm, log: null, dataDir });
  const notes = await caps.enrich({ images: [img] });
  assert.deepEqual(notes, ['图里是一只橘猫']);
  assert.ok(seen[0].startsWith('data:image/png;base64,'), '应当转成 data URL');
  // 第二次同一张图走缓存，不再调用模型
  const again = await caps.enrich({ images: [img] });
  assert.deepEqual(again, ['图里是一只橘猫']);
  assert.equal(seen.length, 1, '第二张同样的图应当命中缓存');
});

await testAsync('识图：拿不到图时留一句"没看"的原因，而不是静默（静默会让它自己编"看不清"）', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-vis2-'));
  const txt = path.join(dataDir, 'note.txt');
  fs.writeFileSync(txt, 'not an image');
  const llm = { async describeImage() { throw new Error('不该被调用'); } };
  const caps = createCapabilities({ cfg: { ...DEFAULTS, visionEnabled: true }, llm, log: null, dataDir });
  const notes = await caps.enrich({ images: [txt, path.join(dataDir, 'missing.png')] });
  assert.equal(notes.length, 2, '两张图各留一句为什么没看：' + JSON.stringify(notes));
  assert.ok(notes.every((n) => /没取到|没看/.test(n)), '要说明没看：' + notes.join(' | '));
  assert.ok(!notes.some((n) => /看不清|糊/.test(n)), '别把"看不清"这类词喂给模型');
  assert.ok(caps.stats.skipped >= 1);
});

await testAsync('识图：关掉开关就完全不去读图', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-vis3-'));
  const llm = { async describeImage() { throw new Error('不该被调用'); } };
  const caps = createCapabilities({ cfg: { ...DEFAULTS, visionEnabled: false }, llm, log: null, dataDir });
  assert.deepEqual(await caps.enrich({ images: ['http://x/a.jpg'] }), []);
});

await testAsync('有图没描述：只提示"没打开"，措辞里不许出现"看不清/糊了"（模型会复读）', async () => {
  const { buildMessages } = await import('../src/context.mjs');
  const { messages } = buildMessages({
    cfg: { ...DEFAULTS },
    persona: '你是大肥鱼',
    memory: [], kbHits: [], recent: [],
    msg: { nickname: '小明', text: '', images: ['http://x/a.jpg'] },
    mediaNotes: []
  });
  const user = messages[messages.length - 1].content;
  assert.match(user, /图没打开/);
  assert.match(user, /别编图里有什么/);
  assert.ok(!/看不清|糊了/.test(user), '这些词会被模型复读：' + user);
});

await testAsync('只发文字时，prompt 里不许出现任何"图没打开/没看"的提示（以前会凭空说图片看不清）', async () => {
  const { buildMessages } = await import('../src/context.mjs');
  const { messages } = buildMessages({
    cfg: { ...DEFAULTS },
    persona: '你是大肥鱼',
    memory: [], kbHits: [], recent: [],
    msg: { nickname: '小明', text: '今天好热', images: [] },
    mediaNotes: []
  });
  const user = messages[messages.length - 1].content;
  assert.ok(!/没打开|没看到/.test(user), '纯文字不该有那类提示：' + user);
});

await testAsync('QQ 表情（没有 image 段）不该触发"图没打开"', async () => {
  const { buildMessages } = await import('../src/context.mjs');
  const { messages } = buildMessages({
    cfg: { ...DEFAULTS },
    persona: '你是大肥鱼',
    memory: [], kbHits: [], recent: [],
    msg: { nickname: '小明', text: '', images: [], faces: ['旺柴'] },
    mediaNotes: ['（对方发的是 QQ 表情：旺柴）']
  });
  const user = messages[messages.length - 1].content;
  assert.ok(!/没打开/.test(user), 'QQ 表情不该被当成看图失败：' + user);
});

await testAsync('消息里有图但没地址时，图段不会被静默丢掉', async () => {
  const m = normalizeEvent({
    post_type: 'message', message_type: 'group', self_id: 9, message_id: 5, group_id: 2, user_id: 3,
    sender: { card: '小明' }, message: [{ type: 'image', data: { file: '' } }]
  }, 9);
  assert.equal(m.images.length, 1, '应当保留一个空的图位，好让后面知道"有图"');
  assert.equal(m.images[0], '');
});

await testAsync('QQ 商店表情（mface）也能被识别', async () => {
  const m = normalizeEvent({
    post_type: 'message', message_type: 'group', self_id: 9, message_id: 6, group_id: 2, user_id: 3,
    sender: { card: '小明' }, message: [{ type: 'mface', data: { summary: '[笑哭]', url: 'http://x' } }]
  }, 9);
  assert.deepEqual(m.faces, ['[笑哭]']);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-face-'));
  const caps = createCapabilities({ cfg: { ...DEFAULTS, visionEnabled: true }, llm: { describeImage: async () => '不该被调用' }, log: null, dataDir });
  const notes = await caps.enrich(m);
  assert.match(notes[0], /QQ 表情/);
  assert.match(notes[0], /笑哭/);
});

// ── 9c. 拟人节奏 ───────────────────────────────────────────
import { humanizeDelay, estimateDelayRange } from '../src/humanize.mjs';

test('拟人节奏：按字数算停顿，且有上下限', () => {
  const cfg = { humanizeEnabled: true, humanDelayBaseMs: 700, humanDelayPerCharMs: 38, humanDelayMaxMs: 5500, multiMessageGapMs: 850 };
  const short = humanizeDelay(cfg, '嗯', 0, () => 0.5);      // 700+38 = 738，抖动 1.0
  assert.equal(short, 738);
  const long = humanizeDelay(cfg, '啊'.repeat(200), 0, () => 0.5);
  assert.equal(long, 5500, '超长句要被上限截住');
  assert.equal(humanizeDelay({ ...cfg, humanizeEnabled: false }, '随便说点', 0), 0, '关掉就不等待');
  const second = humanizeDelay(cfg, '第二条', 1, () => 0.5);
  assert.ok(second > 0 && second < short + 900, '第二条走"分条间隔"');
});

test('拟人节奏：抖动在 0.7~1.3 倍之间', () => {
  const cfg = { humanizeEnabled: true, humanDelayBaseMs: 1000, humanDelayPerCharMs: 0, humanDelayMaxMs: 10000 };
  assert.equal(humanizeDelay(cfg, 'x', 0, () => 0), 700);
  assert.equal(humanizeDelay(cfg, 'x', 0, () => 1), 1300);
  const r = estimateDelayRange(cfg, 'x');
  assert.equal(r.min, 700); assert.equal(r.max, 1300);
});

test('契约里"最多几条"跟着 maxSegments 走', async () => {
  const { contractFor } = await import('../src/context.mjs');
  assert.match(contractFor({ ...DEFAULTS, maxSegments: 1 }), /1~1 条/);
  assert.match(contractFor({ ...DEFAULTS, maxSegments: 2 }), /1~2 条/);
  const r = normalizeReply({ segments: ['一', '二', '三'] }, 2);
  assert.deepEqual(r.segments, ['一', '二'], '超过 maxSegments 的条数要砍掉');
});

await testAsync('端到端：分两条发时中间真的会停', async () => {
  const sends = [];
  const t0 = Date.now();
  const caps = { enrich: async () => [], act: async () => [], sticker: () => null };
  const { pipeline } = makePipeline({ llmText: '{"segments":["第一条话","第二条话"]}', caps, sends, cfg: baseCfg({ maxSegments: 2, humanDelayBaseMs: 120, humanDelayPerCharMs: 10, multiMessageGapMs: 120, humanDelayMaxMs: 400 }) });
  const r = await pipeline.handle({ id: 'mh1', selfId: '999', groupId: '123', userId: '42', nickname: '小明', text: '在吗', mentions: ['999'], images: [] });
  const cost = Date.now() - t0;
  assert.equal(r.replied, true);
  assert.equal(sends.length, 2, '应当发两条');
  assert.ok(cost >= 200, `两条之间应当有停顿，实际只用了 ${cost}ms`);
});

// ── 9d. 表情包自学（收 / 学 / 挑）────────────────────────────
function makeLibrary(over = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-stk-'));
  const cfg = { ...DEFAULTS, stickersEnabled: true, stickerCollectEnabled: true, stickerCollectMaxKB: 1536, stickerCollectMaxSide: 800, stickerCollectMaxFiles: 500, ...over };
  return { st: createStickers({ cfg, dataDir, log: null }), dataDir, cfg };
}

test('表情库：存一张、去重、按标签挑出来', () => {
  const { st, dataDir } = makeLibrary();
  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000010000000100806000000', 'hex');
  const rec = st.add({ dataUrl: `data:image/png;base64,${png.toString('base64')}`, ext: 'png', summary: '[动画表情]', tags: ['一只气鼓鼓的蓝发女仆，端着盆'] });
  assert.ok(fs.existsSync(path.join(dataDir, 'stickers', rec.file)));
  const again = st.add({ dataUrl: `data:image/png;base64,${png.toString('base64')}`, ext: 'png', tags: ['生气'] });
  assert.equal(again.duplicate, true, '同样的图应该去重');
  assert.equal(st.list().files, 1);
  const hit = st.pick('你生气啦');
  assert.ok(hit, '应当能挑到一张');
  assert.equal(hit.file, path.join(dataDir, 'stickers', rec.file));
  assert.ok(hit.tags.join(' ').includes('生气') || hit.tags.join(' ').includes('女仆'));
});

test('表情库：照片不进库（尺寸/体积判断）', () => {
  const { st } = makeLibrary();
  const big = st.looksLikeSticker({ ext: 'jpg', bytes: 3 * 1024 * 1024, summary: '', size: { width: 4000, height: 3000 } });
  assert.equal(big.ok, false);
  const gif = st.looksLikeSticker({ ext: 'gif', bytes: 200 * 1024, summary: '', size: { width: 500, height: 500 } });
  assert.equal(gif.ok, true, 'GIF 一律当表情');
  const small = st.looksLikeSticker({ ext: 'png', bytes: 60 * 1024, summary: '', size: { width: 300, height: 260 } });
  assert.equal(small.ok, true, '小图当表情');
  const tagged = st.looksLikeSticker({ ext: 'png', bytes: 900 * 1024, summary: '[动画表情]', size: { width: 1200, height: 1200 } });
  assert.equal(tagged.ok, true, 'NapCat 标了动画表情就收');
});

test('表情库：learn 会把"像表情"的收下并带标签', () => {
  const { st, dataDir } = makeLibrary();
  const gif = Buffer.from('GIF89a' + '0'.repeat(200), 'binary');
  const tmp = path.join(dataDir, 'tmp.gif');
  fs.writeFileSync(tmp, gif);
  const r = st.learn({ tmpFile: tmp, ext: 'gif', summary: '', description: '一个人捂脸笑的表情包' });
  assert.equal(r.saved, true);
  assert.equal(st.list().files, 1);
  const rec = st.list().items[0];
  assert.ok(rec.tags.join(' ').includes('捂脸'));
});

test('表情库：素材库超上限会删最老的', () => {
  const { st } = makeLibrary({ stickerCollectMaxFiles: 2 });
  for (let i = 0; i < 4; i++) {
    // 每张内容不同，否则会被按 hash 去重（这正是上一版测试写错的地方）
    const png = Buffer.from('89504e470d0a1a0a' + i.toString(16).padStart(2, '0').repeat(16), 'hex');
    st.add({ dataUrl: `data:image/png;base64,${png.toString('base64')}`, ext: 'png', summary: `表情${i}` });
  }
  assert.equal(st.list().files, 2, '超过上限应当被裁到 2 张');
});

await testAsync('识图：空内容会自动换档重试（预算 → 少思考）', async () => {
  const seen = [];
  let n = 0;
  const fakeFetch = async (url, init) => {
    const body = JSON.parse(init.body);
    seen.push({ max: body.max_tokens, effort: body.reasoning_effort || null });
    n += 1;
    const content = n < 3 ? '' : '图里有一只橘猫在睡觉';
    return { ok: true, status: 200, text: async () => JSON.stringify({ model: 'm', choices: [{ message: { content }, finish_reason: content ? 'stop' : 'length' }], usage: { total_tokens: 10 } }) };
  };
  const llm = createLlm({ cfg: { ...DEFAULTS, apiKey: 'sk-x' }, log: null, fetchImpl: fakeFetch });
  const text = await llm.describeImage('data:image/png;base64,AAAA');
  assert.equal(text, '图里有一只橘猫在睡觉');
  assert.equal(seen.length, 3, '应当重试到第三次');
  assert.equal(seen[0].max, 900);
  assert.equal(seen[1].effort, 'low');
  assert.equal(seen[2].effort, 'minimal');
});

await testAsync('识图：配了备用模型时，主模型失败会换模型', async () => {
  const models = [];
  const fakeFetch = async (url, init) => {
    const body = JSON.parse(init.body);
    models.push(body.model);
    // 路由 "backup/vlm" 拆开后，真正发出去的是模型名 vlm
    const content = body.model === 'vlm' ? '备用模型看到了猫' : '';
    return { ok: true, status: 200, text: async () => JSON.stringify({ model: body.model, choices: [{ message: { content } }], usage: {} }) };
  };
  const llm = createLlm({ cfg: { ...DEFAULTS, apiKey: 'sk-x', channels: [{ id: 'backup', name: '备用', apiBase: 'https://b/v1', apiKey: 'sk-b', models: [] }], visionFallbackModels: 'backup/vlm' }, log: null, fetchImpl: fakeFetch });
  const text = await llm.describeImage('data:image/png;base64,AAAA');
  assert.equal(text, '备用模型看到了猫');
  assert.ok(models.includes('vlm'), '应当调用到备用模型');
});

await testAsync('表情库：批量导入一个文件夹（看得懂的带标签，看不懂的先收下）', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-imp-'));
  const src = path.join(dataDir, 'pics');
  fs.mkdirSync(src, { recursive: true });
  const png = (i) => Buffer.from('89504e470d0a1a0a' + i.toString(16).padStart(2, '0').repeat(16), 'hex');
  fs.writeFileSync(path.join(src, 'a.png'), png(1));
  fs.writeFileSync(path.join(src, 'b.png'), png(2));
  fs.writeFileSync(path.join(src, 'c.png'), png(3));
  fs.writeFileSync(path.join(src, 'note.txt'), 'not an image');

  const llm = {
    n: 0,
    async tagSticker() {
      this.n += 1;
      if (this.n === 2) throw new Error('模型返回空内容');
      return { desc: '一只在打哈欠的橘猫', emotion: ['困'], usage: ['道晚安时'], caption: '' };
    }
  };
  const caps = createCapabilities({ cfg: { ...DEFAULTS, stickersEnabled: true, visionEnabled: true, stickerCollectMaxKB: 1536 }, llm, log: null, dataDir });
  const r = await caps.importStickers(src, { limit: 10 });
  assert.equal(r.total, 3, '只数图片，.txt 不算');
  assert.equal(r.added, 2, '两张带标签');
  assert.equal(r.untagged, 1, '一张看不懂但也收下了');
  assert.equal(r.failed, 0);
  assert.equal(caps.stickers.list().files, 3);
});

test('表情库：描述会被拆成短标签（长描述当标签检不中）', () => {
  const { st } = makeLibrary();
  const png = Buffer.from('89504e470d0a1a0a' + 'ab'.repeat(16), 'hex');
  const rec = st.add({
    dataUrl: `data:image/png;base64,${png.toString('base64')}`, ext: 'png',
    description: '画面主体是蓝发动漫女仆，面无表情，右手拿红色小瓶子，整体是表情包风格'
  });
  assert.ok(rec.tags.length >= 2, '应当拆出多个短标签');
  assert.ok(rec.tags.some((t) => t.length <= 12), '应当有短标签');
  assert.ok(rec.tags.join(' ').includes('女仆'));
  // 用短词去查，应该能命中
  const hit = st.pick('女仆');
  assert.equal(hit.matched, true);
});

test('表情库：连续挑图不会总是同一张', () => {
  const { st } = makeLibrary();
  for (let i = 0; i < 3; i++) {
    const png = Buffer.from('89504e470d0a1a0a' + i.toString(16).padStart(2, '0').repeat(16), 'hex');
    st.add({ dataUrl: `data:image/png;base64,${png.toString('base64')}`, ext: 'png', description: ['开心猫', '无语狗', '生气兔'][i] });
  }
  const picked = [];
  for (let i = 0; i < 3; i++) {
    const p = st.pick('完全不相干的话题');
    picked.push(path.basename(p.file));
  }
  assert.equal(new Set(picked).size >= 2, true, `连着挑三次应当尽量不重复，实际：${picked.join(',')}`);
});

await testAsync('表情库：批量导入信任用户（大图也收，只拦超大文件）', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-imp2-'));
  const src = path.join(dataDir, 'pics');
  fs.mkdirSync(src, { recursive: true });
  // 造一张 1000x1000 的图（超过"照片"阈值 800，但用户明确要导入）
  const big = Buffer.alloc(200 * 1024, 7);
  fs.writeFileSync(path.join(src, 'big.png'), big);
  const llm = { async tagSticker() { return { desc: '一张大图', emotion: [], usage: [] }; } };
  const caps = createCapabilities({ cfg: { ...DEFAULTS, stickersEnabled: true, visionEnabled: true }, llm, log: null, dataDir });
  const r = await caps.importStickers(src, { limit: 5, trustUser: true });
  assert.equal(r.total, 1);
  assert.equal(r.added, 1, '用户明确导入的应当收下');
});

// ── 11b. 心情系统 + 配图积极度 ──────────────────────────────
import { createMood } from '../src/mood.mjs';

test('心情：被夸会得意，被骂会委屈，最多 3 档，会衰减回摸鱼', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-mood-'));
  let t = 1_700_000_000_000;
  const mood = createMood({ dataDir, cfg: { moodDecayMins: 30 }, log: null, now: () => t });
  assert.equal(mood.state.current, '摸鱼');

  mood.observe('大肥鱼你好可爱啊');
  assert.equal(mood.state.current, '得意');
  mood.observe('好可爱');
  mood.observe('真可爱');
  assert.equal(mood.state.intensity, 3, '同一心情最多 3 档');

  mood.observe('闭嘴吧');
  assert.equal(mood.state.current, '委屈');

  t += 31 * 60_000;
  mood.ambient(new Date(t));
  assert.ok(mood.state.intensity <= 2, '过一段时间应当衰减');
  for (let i = 0; i < 4; i++) { t += 31 * 60_000; mood.ambient(new Date(t)); }
  assert.equal(mood.state.current, '摸鱼', '最后回到摸鱼');
});

test('心情：模型自报的 mood 会校准状态', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-mood2-'));
  const mood = createMood({ dataDir, cfg: {}, log: null });
  mood.adopt('困');
  assert.equal(mood.state.current, '困');
  mood.adopt('这不是合法心情');
  assert.equal(mood.state.current, '困', '非法值忽略');
});

test('契约：配图积极度会写进提示词', async () => {
  const { contractFor } = await import('../src/context.mjs');
  const base = { ...DEFAULTS, stickersEnabled: true };
  assert.match(contractFor({ ...base, stickerEagerness: 2 }), /大部分回复都写/);
  assert.match(contractFor({ ...base, stickerEagerness: 1 }), /情绪明显时写/);
  assert.match(contractFor({ ...base, stickerEagerness: 0 }), /情绪很强烈时才写/);
  assert.ok(!contractFor({ ...base, stickersEnabled: false, stickerEagerness: 2 }).includes('sticker：'), '关了表情就不提配图');
});

test('上下文：心情会写进 system', async () => {
  const { buildMessages } = await import('../src/context.mjs');
  const { messages } = buildMessages({
    cfg: { ...DEFAULTS },
    persona: '你是大肥鱼', memory: [], kbHits: [], recent: [],
    msg: { nickname: '小明', text: '在吗', images: [] },
    mediaNotes: [],
    moodHint: '你有点委屈，话少一点（现在心情：委屈（2/3））'
  });
  assert.match(messages[0].content, /你现在的心情/);
  assert.match(messages[0].content, /委屈（2\/3）/);
});

// ── 10. 配置说明书完整性（防止加了字段忘了写中文）──────────
test('每个配置项都有中文名和说明', () => {
  const keys = Object.keys(DEFAULTS).filter((k) => k !== 'dataDir');
  const missing = keys.filter((k) => !FIELDS[k]);
  assert.deepEqual(missing, [], '这些配置项还没写中文说明：' + missing.join(', '));
  const orphan = Object.keys(FIELDS).filter((k) => !(k in DEFAULTS));
  assert.deepEqual(orphan, [], '这些中文说明对应的字段已经不存在了：' + orphan.join(', '));
  for (const [k, m] of Object.entries(FIELDS)) {
    assert.ok(m.label, `${k} 缺中文名`);
    assert.ok(FIELD_GROUPS.some((g) => g.id === m.group), `${k} 的分区 ${m.group} 没在 FIELD_GROUPS 里`);
  }
});

test('分区都有名字和说明', () => {
  for (const g of FIELD_GROUPS) {
    assert.ok(g.name && g.hint, `分区 ${g.id} 缺名字或说明`);
  }
});

// ── 11. DSH 模型发现 + 多渠道路由 ───────────────────────────
import { parseYamlSubset, normalizeChannel, discover } from '../src/dsh.mjs';
import { parseRoute, formatRoute, resolveChannel, mergeDiscovered, setPurpose, allModels, describeRoutes } from '../src/models.mjs';

const DSH_FIXTURE = `
- id: llm
  name: file:///x/llm-pi-ai.mjs
  config:
    providers:
      deepseek:
        apiKeyEnv: CHERRY_DSH_API_KEY
        api: openai-responses
        baseURL: https://api.deepseek.com/v1
        reasoning: max
        models:
          - id: deepseek-flash
            name: DeepSeek V4.1 Flash
            contextWindow: 1000000
            maxTokens: 393216
            input:
              - text
              - image
          - id: deepseek-v4-pro
            name: DeepSeek V4 Pro
            input: [text]
      relay:
        apiKeyEnv: RELAY_KEY
        baseURL: https://relay.example.com/v1
- id: agent-spine
  config:
    persona: |-
      this is a block scalar
      with two lines
- id: sandbox
  config:
    mode: danger-full-access
`;

test('YAML 子集解析：providers / 模型 / 块标量都能过', () => {
  const doc = parseYamlSubset(DSH_FIXTURE);
  assert.ok(Array.isArray(doc), '顶层应该是列表');
  const llm = doc.find((r) => r.id === 'llm');
  const p = llm.config.providers.deepseek;
  assert.equal(p.baseURL, 'https://api.deepseek.com/v1');
  assert.equal(p.models.length, 2);
  assert.deepEqual(p.models[0].input, ['text', 'image']);
  assert.deepEqual(p.models[1].input, ['text']);
  assert.equal(p.models[0].contextWindow, 1000000);
  const spine = doc.find((r) => r.id === 'agent-spine');
  assert.match(spine.config.persona, /block scalar/);
  assert.equal(doc.find((r) => r.id === 'sandbox').config.mode, 'danger-full-access');
});

await testAsync('从 DSH 目录发现渠道（含密钥解析）', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-dsh-'));
  fs.mkdirSync(path.join(home, 'compositions'), { recursive: true });
  fs.mkdirSync(path.join(home, 'secrets'), { recursive: true });
  fs.writeFileSync(path.join(home, 'compositions', 'a.b.yml'), DSH_FIXTURE);
  fs.writeFileSync(path.join(home, 'settings.yaml'), [
    'llm-pi-ai:',
    '  providers:',
    '    deepseek:',
    '      apiKeyEnv: DEEPSEEK_API_KEY',
    'agent-default-model:',
    '  provider: deepseek-official',
    '  model: deepseek-flash'
  ].join('\n'));
  fs.writeFileSync(path.join(home, '.credentials.yaml'), ['version: 1', 'refs:', '  DEEPSEEK_API_KEY: sk-cred-111', '  RELAY_KEY: sk-relay-222'].join('\n'));
  fs.writeFileSync(path.join(home, 'secrets', 'relay_api_key.txt'), 'sk-file-333');

  const found = discover({ dshHome: home, env: {} });
  assert.equal(found.channels.length, 2, '应当发现 2 个渠道');
  const ds = found.channels.find((c) => c.id === 'deepseek');
  assert.equal(ds.apiBase, 'https://api.deepseek.com/v1');
  assert.equal(ds.apiKey, 'sk-cred-111', '密钥应当从 .credentials.yaml 解出');
  assert.equal(ds.models.length, 2);
  assert.deepEqual(ds.models[0].input, ['text', 'image']);
  assert.equal(found.defaultModel.model, 'deepseek-flash');
});

await testAsync('DSH 密钥优先级：环境变量 > credentials > secrets 文件', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-dsh2-'));
  fs.mkdirSync(path.join(home, 'secrets'), { recursive: true });
  fs.writeFileSync(path.join(home, '.credentials.yaml'), ['refs:', '  K: sk-from-cred'].join('\n'));
  fs.writeFileSync(path.join(home, 'secrets', 'k.txt'), 'sk-from-file');
  const envHit = normalizeChannel({ id: 'x', apiKeyEnv: 'K', baseURL: 'https://a/v1' }, home, { K: 'sk-env' });
  assert.equal(envHit.apiKey, 'sk-env');
  const credHit = normalizeChannel({ id: 'x', apiKeyEnv: 'K', baseURL: 'https://a/v1' }, home, {});
  assert.equal(credHit.apiKey, 'sk-from-cred');
});

test('路由写法：渠道/模型 与 仅模型名', () => {
  assert.deepEqual(parseRoute('deepseek/deepseek-flash'), { channelId: 'deepseek', model: 'deepseek-flash' });
  assert.deepEqual(parseRoute('deepseek-chat'), { channelId: '', model: 'deepseek-chat' });
  assert.deepEqual(parseRoute(''), { channelId: '', model: '' });
  assert.equal(formatRoute('deepseek', 'deepseek-flash'), 'deepseek/deepseek-flash');
  assert.equal(formatRoute('', 'deepseek-chat'), 'deepseek-chat');
});

test('渠道解析：找不到就回退默认渠道并标记', () => {
  const cfg = { ...DEFAULTS, apiBase: 'https://def/v1', apiKey: 'sk-def', channels: [{ id: 'relay', name: '中转', apiBase: 'https://relay/v1', apiKey: 'sk-r', models: [{ id: 'm1', name: 'M1', input: ['text'] }] }] };
  assert.equal(resolveChannel(cfg, 'relay').channel.name, '中转');
  const miss = resolveChannel(cfg, 'nope');
  assert.equal(miss.fallback, true);
  assert.equal(miss.channel.apiBase, 'https://def/v1');
});

test('从 DSH 合并进配置：同 id 覆盖、模型取并集、密钥不丢', () => {
  const cfg = { ...DEFAULTS, channels: [{ id: 'deepseek', name: '我的名字', apiBase: 'https://old/v1', apiKey: 'sk-old', models: [{ id: 'deepseek-flash', name: '老名字', input: ['text'] }] }] };
  const summary = mergeDiscovered(cfg, {
    channels: [{ id: 'deepseek', name: 'deepseek', apiBase: 'https://api.deepseek.com/v1', apiKey: '', models: [{ id: 'deepseek-flash', input: ['text', 'image'] }, { id: 'deepseek-v4-pro', name: 'V4 Pro' }] }]
  });
  assert.equal(summary.updated, 1);
  const ch = cfg.channels[0];
  assert.equal(ch.apiKey, 'sk-old', 'DSH 没解出密钥时不能把原来的密钥覆盖成空');
  assert.equal(ch.name, '我的名字', '用户自己起的名不被覆盖');
  assert.equal(ch.models.length, 2);
  assert.deepEqual(ch.models.find((m) => m.id === 'deepseek-flash').input, ['text', 'image'], '元信息应当更新');
});

await testAsync('切换用途只改一个字符串', async () => {
  const cfg = { ...DEFAULTS, channels: [{ id: 'relay', name: '中转', apiBase: 'https://relay/v1', apiKey: 'sk-r', models: [{ id: 'cheap', name: '便宜货', input: ['text'] }] }] };
  setPurpose(cfg, 'gate', 'relay/cheap');
  assert.equal(cfg.routeGate, 'relay/cheap');
  const rows = describeRoutes(cfg);
  const gate = rows.find((r) => r.purpose === 'gate');
  assert.equal(gate.model, 'cheap');
  assert.equal(gate.channelName, '中转');
  assert.equal(gate.hasKey, true);
  const opts = allModels(cfg);
  assert.ok(opts.some((m) => m.route === 'relay/cheap'));
});

await testAsync('llm 按路由打到不同渠道（地址和密钥都跟着换）', async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, auth: init.headers.Authorization });
    return { ok: true, status: 200, text: async () => JSON.stringify({ model: 'ok', choices: [{ message: { content: '{"ok":true}' } }], usage: { total_tokens: 3 } }) };
  };
  const cfg = { ...DEFAULTS, apiKey: 'sk-default', channels: [{ id: 'relay', name: '中转', apiBase: 'https://relay.example.com/v1', apiKey: 'sk-relay', models: [] }] };
  const llm = createLlm({ cfg, log: null, fetchImpl: fakeFetch });
  await llm.chat([{ role: 'user', content: 'hi' }], { model: 'relay/some-model' });
  assert.equal(calls[0].url, 'https://relay.example.com/v1/chat/completions');
  assert.equal(calls[0].auth, 'Bearer sk-relay');
  await llm.chat([{ role: 'user', content: 'hi' }], { model: 'plain-model' });
  assert.equal(calls[1].url, 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(calls[1].auth, 'Bearer sk-default');
});

test('本机 DSH 里能发现渠道（有 DSH_HOME 才断言）', () => {
  const home = process.env.DSH_HOME;
  if (!home || !fs.existsSync(home)) throw new SkipError('本机没有 DSH_HOME');
  const found = discover({ dshHome: home });
  assert.ok(found.channels.length > 0, '应当至少发现一个渠道：' + (found.warnings || []).join('；'));
  for (const c of found.channels) assert.ok(c.apiBase, `渠道 ${c.id} 缺 apiBase`);
});

await testAsync('把关走 routeGate 指定的模型（切了就真的换）', async () => {
  const seen = [];
  const llm = { async chat(messages, opts) { seen.push(opts && opts.model); return { text: '{"reply":true}', usage: {} }; } };
  const gate = createGate({ cfg: baseCfg({ routeGate: 'relay/cheap', channels: [{ id: 'relay', name: '中转', apiBase: 'https://r/v1', apiKey: 'sk-r', models: [] }] }), llm, log: null });
  await gate.decide({ groupId: '123', selfId: '999', userId: '1', text: '今天好热', mentions: [] });
  assert.equal(seen[0], 'relay/cheap');
});

// ── 11. 关系：主人 / 群友（"对我最亲热，对别人保持朋友距离"）──────
const relCfg = (over = {}) => ({ ...DEFAULTS, ownerUin: '10001', ...over });

test('关系：认得出主人，认不出别人', () => {
  const rel = createRelations({ cfg: relCfg() });
  assert.equal(rel.tierOf('10001'), 'owner');
  assert.equal(rel.tierOf(10001), 'owner', '写成数字也要认');
  assert.equal(rel.tierOf(' 10001 '), 'owner', '带空格也要认');
  assert.equal(rel.tierOf('123456'), 'friend');
  assert.equal(rel.tierOf(''), 'friend');
  assert.equal(rel.tierOf(undefined), 'friend');
});

test('关系：多个主人号用逗号分隔；填垃圾值不会把人误认成主人', () => {
  const rel = createRelations({ cfg: relCfg({ ownerUin: '10001，10002, 10003' }) });
  assert.deepEqual(rel.ownerIds(), ['10001', '10002', '10003']);
  assert.equal(rel.tierOf('10002'), 'owner');
  const bad = createRelations({ cfg: relCfg({ ownerUin: 'abc' }) });
  assert.deepEqual(bad.ownerIds(), [], '非数字一律不认，宁可没有主人也别乱认');
  assert.equal(bad.tierOf('abc'), 'friend');
});

test('关系：没配主人，谁都是群友距离', () => {
  assert.equal(createRelations({ cfg: relCfg({ ownerUin: '' }) }).tierOf('10001'), 'friend');
});

test('关系：熟人档认得出来，且排不到主人前面', () => {
  const rel = createRelations({ cfg: relCfg({ friendUin: '1240964844, 20002' }) });
  assert.equal(rel.tierOf('1240964844'), 'close');
  assert.equal(rel.tierOf(1240964844), 'close', '写成数字也要认');
  assert.equal(rel.tierOf('10003'), 'friend');
  assert.deepEqual(rel.closeIds(), ['1240964844', '20002']);
  assert.equal(rel.tierOf('10001'), 'owner');
  // 同一个号两处都填：按主人算，不能让熟人档覆盖家人关系
  const both = createRelations({ cfg: relCfg({ friendUin: '10001' }) });
  assert.equal(both.tierOf('10001'), 'owner');
});

test('关系：对熟人的提示词比群友松，但不许撒娇、不许抖私事', () => {
  const rel = createRelations({ cfg: relCfg({ friendUin: '1240964844' }) });
  const close = rel.hintFor({ userId: '1240964844', nickname: '老张', groupId: '10002' });
  assert.match(close, /熟人/);
  assert.match(close, /打趣|损他/, '要允许打趣');
  assert.match(close, /别撒娇|别黏人/, '边界要写清');
  assert.match(close, /私事/, '不能把私事抖给他');
  assert.ok(!/顺着他/.test(close), '熟人不是主人，别用主人那一套');
  assert.equal(rel.maxSegmentsFor('close', 2), 3, '熟人多给一句');
  assert.equal(rel.maxSegmentsFor('close', 3), 3, '但最多还是三条');
});

test('关系：提示词对主人最亲，对群友保持朋友距离', () => {
  const rel = createRelations({ cfg: relCfg() });
  const owner = rel.hintFor({ userId: '10001', nickname: '肥鱼主人', groupId: '10002' });
  assert.match(owner, /主人/);
  assert.match(owner, /照办/, '要写清"会听他的"');
  assert.match(owner, /别扭/, '要留出傲娇那一下');
  assert.match(owner, /最多漏一句|一点点/, '傲娇不能太抢戏');
  assert.match(owner, /群里人多/, '群里要收着点');
  const friend = rel.hintFor({ userId: '123456', nickname: '小明', groupId: '10002' });
  assert.match(friend, /朋友的距离/);
  assert.match(friend, /别撒娇/);
  assert.ok(!/顺着他/.test(friend), '对群友不该用对主人那一套');
  assert.ok(!friend.includes('10001'), '不该把主人的号写进对群友的提示词');
});

test('关系：认主的提示词语气要软，不能写成命令腔', () => {
  const rel = createRelations({ cfg: relCfg() });
  const owner = rel.hintFor({ userId: '10001', nickname: '肥鱼主人', groupId: '10002' });
  // 踩过的坑：写成"必须服从/立刻照做"这种硬规则，模型会变成客服腔，傲娇也没了
  assert.ok(!/必须|立刻|马上照做|无条件/.test(owner), '出现了命令腔：' + owner);
});

test('关系：主人能多给一条回话，但最多三条', () => {
  const rel = createRelations({ cfg: relCfg() });
  assert.equal(rel.maxSegmentsFor('owner', 2), 3);
  assert.equal(rel.maxSegmentsFor('friend', 2), 2);
  assert.equal(rel.maxSegmentsFor('owner', 3), 3);
  assert.equal(rel.maxSegmentsFor('owner', 1), 2);
});

test('关系：认主的提示词里已经交代了"来历照样不破例"', () => {
  const rel = createRelations({ cfg: relCfg() });
  assert.match(rel.hintFor({ userId: '10001', nickname: 'x' }), /来历/);
});

await testAsync('熟人：没 @ 也必回，不花把关调用；静默时段照样不回', async () => {
  const llm = fakeLlm([]); // 不该被调用
  const gate = createGate({ cfg: baseCfg({ friendUin: '1240964844' }), llm, log: null });
  const v = await gate.decide(gmsg({ userId: '1240964844' }), { recent: [], tier: 'close' });
  assert.equal(v.reply, true);
  assert.equal(v.reason, '熟人');
  assert.equal(v.close, true);
  assert.equal(llm.calls.length, 0, '熟人这一档不该再花一次把关调用');
  assert.equal(gate.stats.closePassed, 1);

  const quiet = baseCfg({ friendUin: '1240964844', quietEnabled: true, quietStart: '00:00', quietEnd: '23:59' });
  const qgate = createGate({ cfg: quiet, llm: fakeLlm([]), log: null });
  const qv = await qgate.decide(gmsg({ userId: '1240964844' }), { recent: [], tier: 'close' });
  assert.equal(qv.reply, false, '熟人不该在静默时段吵人');
  assert.equal(qv.reason, '静默时段');
});

await testAsync('主人：没 @ 也必回，而且不花把关那次调用', async () => {
  const llm = fakeLlm([]); // 不该被调用
  const gate = createGate({ cfg: baseCfg({ ownerUin: '42' }), llm, log: null });
  const v = await gate.decide(gmsg(), { recent: [], tier: 'owner' });
  assert.equal(v.reply, true);
  assert.equal(v.reason, '主人');
  assert.equal(v.owner, true);
  assert.equal(llm.calls.length, 0, '主人这一档不该再花一次把关调用');
  assert.equal(gate.stats.ownerPassed, 1);
});

await testAsync('主人：静默时段也回；同样条件下群友不回', async () => {
  const cfg = baseCfg({ ownerUin: '42', quietEnabled: true, quietStart: '00:00', quietEnd: '23:59' });
  const gate = createGate({ cfg, llm: fakeLlm([]), log: null });
  assert.equal((await gate.decide(gmsg(), { recent: [], tier: 'owner' })).reply, true, '主人不受静默限制');
  const friend = await gate.decide(gmsg({ userId: '7' }), { recent: [], tier: 'friend' });
  assert.equal(friend.reply, false);
  assert.equal(friend.reason, '静默时段');
});

await testAsync('主人：关掉 ownerAlwaysReply 就回到普通判定', async () => {
  const cfg = baseCfg({ ownerUin: '42', ownerAlwaysReply: false, quietEnabled: true, quietStart: '00:00', quietEnd: '23:59' });
  const v = await createGate({ cfg, llm: fakeLlm([]), log: null }).decide(gmsg(), { recent: [], tier: 'owner' });
  assert.equal(v.reply, false);
  assert.equal(v.reason, '静默时段');
});

await testAsync('主人：仍然守群白名单（认主不等于哪都能说话）', async () => {
  const gate = createGate({ cfg: baseCfg({ ownerUin: '42' }), llm: fakeLlm([]), log: null });
  const v = await gate.decide({ groupId: '999', selfId: '999', userId: '42', text: '在吗', mentions: [] }, { recent: [], tier: 'owner' });
  assert.equal(v.reply, false);
  assert.match(v.reason, /白名单/);
});

test('上下文：关系会写进 system，主人档多给一条', async () => {
  const { buildMessages } = await import('../src/context.mjs');
  const rel = createRelations({ cfg: relCfg() });
  const sysFor = (userId) => buildMessages({
    cfg: { ...DEFAULTS, maxSegments: 2 },
    persona: '你是大肥鱼', memory: [], kbHits: [], recent: [],
    msg: { nickname: 'x', text: '在吗', images: [] }, mediaNotes: [],
    relationHint: rel.hintFor({ userId, nickname: 'x' }),
    maxSeg: rel.maxSegmentsFor(rel.tierOf(userId), 2)
  }).messages[0].content;
  assert.match(sysFor('10001'), /是你的主人/);
  assert.match(sysFor('10001'), /1~3 条/, '主人档应当多给一条');
  assert.match(sysFor('123456'), /朋友的距离/);
  assert.match(sysFor('123456'), /1~2 条/);
});

test('契约：maxSeg 覆盖生效，并且仍然夹在 1~3', async () => {
  const { contractFor } = await import('../src/context.mjs');
  assert.match(contractFor({ ...DEFAULTS, maxSegments: 2 }, { maxSeg: 3 }), /1~3 条/);
  assert.match(contractFor({ ...DEFAULTS, maxSegments: 2 }, { maxSeg: 9 }), /1~3 条/);
});

test('心情：主人一开口，坏情绪回暖；心情好时不用再回暖', async () => {
  const { createMood } = await import('../src/mood.mjs');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-mood-warm-'));
  const mood = createMood({ dataDir, cfg: { moodDecayMins: 30 }, log: null });
  mood.bump('委屈', '被骂了');
  assert.equal(mood.state.current, '委屈');
  assert.equal(mood.warm(), true);
  assert.equal(mood.state.current, '得意');
  assert.equal(mood.warm(), false);
});

await testAsync('端到端：主人在静默时段没 @ 也照回，群友同样的消息不理', async () => {
  const cfg = baseCfg({ ownerUin: '10001', quietEnabled: true, quietStart: '00:00', quietEnd: '23:59', humanizeEnabled: false });
  const sends = [];
  const { pipeline } = makePipeline({ llmText: '{"segments":["主人回来啦"]}', cfg, sends });
  const owner = await pipeline.handle({ id: 'o1', selfId: '999', groupId: '123', userId: '10001', nickname: '主人', text: '我回来了', mentions: [], images: [] });
  assert.equal(owner.replied, true);
  assert.equal(owner.tier, 'owner');
  assert.equal(sends.length, 1);
  const friend = await pipeline.handle({ id: 'f1', selfId: '999', groupId: '123', userId: '123456', nickname: '小明', text: '我回来了', mentions: [], images: [] });
  assert.equal(friend.replied, false, '同样的消息，群友在静默时段不该被接');
  assert.equal(sends.length, 1);
});

await testAsync('端到端：发给模型的关系提示词跟着人变（主人 vs 群友）', async () => {
  const cfg = baseCfg({ ownerUin: '10001', humanizeEnabled: false });
  const sends = [];
  const { pipeline, llm } = makePipeline({ llmTexts: ['{"segments":["嗯呐"]}', '{"segments":["好啊"]}'], cfg, sends });
  await pipeline.handle({ id: 'a1', selfId: '999', groupId: '123', userId: '10001', nickname: '主人', text: '在吗', mentions: ['999'], images: [] });
  assert.match(llm.calls.at(-1)[0].content, /是你的主人/);
  await pipeline.handle({ id: 'b1', selfId: '999', groupId: '123', userId: '123456', nickname: '小明', text: '在不在啊', mentions: ['999'], images: [] });
  const friendSys = llm.calls.at(-1)[0].content;
  assert.match(friendSys, /朋友的距离/);
  assert.match(friendSys, /不是你的主人/, '对群友要明确"不是主人"');
  assert.ok(!/【现在跟你说话的是谁】是你的主人/.test(friendSys), '对群友不能套用主人的语气');
});

// ── 12. 连发合并（"我发几句它一口气发七八句"）────────────────
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(fn, ms = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await wait(25); }
  return false;
}

await testAsync('连发合并：同一个人连发三条 → 只回一轮，三句都在上下文里', async () => {
  const cfg = baseCfg({ ownerUin: '', humanizeEnabled: false, mergeWindowMs: 40, stickersEnabled: false });
  const sends = [];
  const { pipeline, llm } = makePipeline({ llmTexts: ['{"segments":["来啦"]}', '{"segments":["多余的"]}'], cfg, sends });
  const m = (i, text) => ({ id: `q${i}`, selfId: '999', groupId: '123', userId: '77', nickname: '小明', text, mentions: ['999'], images: [] });
  pipeline.enqueue(m(1, '在吗'));
  pipeline.enqueue(m(2, '问你个事'));
  pipeline.enqueue(m(3, '有点急'));
  assert.ok(await waitUntil(() => sends.length > 0, 4000), '等不到回话');
  await wait(350);
  assert.equal(llm.calls.length, 1, '三条连发应当只跑一次模型，实际 ' + llm.calls.length);
  const userTurn = llm.calls[0][llm.calls[0].length - 1].content;
  for (const t of ['在吗', '问你个事', '有点急']) assert.ok(userTurn.includes(t), '合并后的上下文里应当有「' + t + '」');
  assert.equal(sends.length, 1, '只应当发一条，实际 ' + sends.length);
});

await testAsync('连发合并：不同的人各发一条 → 各回各的，不互相吞掉', async () => {
  const cfg = baseCfg({ ownerUin: '', humanizeEnabled: false, mergeWindowMs: 40, stickersEnabled: false });
  const sends = [];
  const { pipeline, llm } = makePipeline({ llmTexts: ['{"segments":["甲"]}', '{"segments":["乙"]}'], cfg, sends });
  const m = (id, userId, text) => ({ id, selfId: '999', groupId: '123', userId, nickname: 'u' + userId, text, mentions: ['999'], images: [] });
  pipeline.enqueue(m('a1', '77', '我是甲'));
  pipeline.enqueue(m('b1', '88', '我是乙'));
  assert.ok(await waitUntil(() => sends.length >= 2, 5000), '两个人应当各回一条');
  assert.equal(llm.calls.length, 2);
});

await testAsync('连发合并：回话期间新来的消息不丢，攒成下一轮', async () => {
  const cfg = baseCfg({ ownerUin: '', humanizeEnabled: false, mergeWindowMs: 30, stickersEnabled: false });
  const sends = [];
  const slow = { calls: [], async chat(messages) { this.calls.push(messages); await wait(220); return { text: '{"segments":["好"]}', usage: { total_tokens: 5 }, model: 'fake' }; } };
  const { pipeline } = makePipeline({ llm: slow, cfg, sends });
  const m = (i, text) => ({ id: `s${i}`, selfId: '999', groupId: '123', userId: '77', nickname: '小明', text, mentions: ['999'], images: [] });
  pipeline.enqueue(m(1, '第一句'));
  await wait(140);                    // 这会儿第一轮正在跑
  pipeline.enqueue(m(2, '第二句'));
  assert.ok(await waitUntil(() => sends.length >= 2, 6000), '第二句应当被回答（不能丢）');
  assert.equal(slow.calls.length, 2, '应当是两轮，不是三轮');
  assert.ok(slow.calls[1][slow.calls[1].length - 1].content.includes('第二句'));
});

// ── 13. 拟人化小动作 ───────────────────────────────────────
const msgOf = (over = {}) => ({ id: 'h1', selfId: '999', groupId: '123', userId: '42', nickname: '小明', text: '在吗', mentions: ['999'], images: [], ...over });

await testAsync('拟人：回复带引用（quoteChance=1 时每条都引用对方那条）', async () => {
  const cfg = baseCfg({ humanizeEnabled: false, quoteChance: 1, splitChance: 0, stickersEnabled: false });
  const sends = [];
  const { pipeline } = makePipeline({ llmText: '{"segments":["在呢"]}', cfg, sends });
  await pipeline.handle(msgOf());
  assert.equal(sends.length, 1);
  assert.equal(sends[0].segs[0].type, 'reply', '首段应当是引用段');
  assert.equal(sends[0].segs[0].data.id, 'h1');
});

await testAsync('拟人：quoteChance=0 时不引用', async () => {
  const cfg = baseCfg({ humanizeEnabled: false, quoteChance: 0, splitChance: 0 });
  const sends = [];
  const { pipeline } = makePipeline({ llmText: '{"segments":["在呢"]}', cfg, sends });
  await pipeline.handle(msgOf());
  assert.ok(!sends[0].segs.some((s) => s.type === 'reply'));
});

await testAsync('拟人：一句话拆成两条发（splitChance=1）', async () => {
  const cfg = baseCfg({ humanizeEnabled: false, quoteChance: 0, splitChance: 1, maxSegments: 1, stickersEnabled: false });
  const sends = [];
  const long = '诶，这本书我也翻过两页，写得挺温柔，你看到哪一章了';
  const { pipeline } = makePipeline({ llmText: JSON.stringify({ segments: [long] }), cfg, sends });
  await pipeline.handle(msgOf());
  assert.equal(sends.length, 2, '应当拆成两条，实际 ' + sends.length);
  const joined = sends.map((s) => s.segs.filter((x) => x.type === 'text').map((x) => x.data.text).join('')).join('');
  assert.equal(joined, long, '拼起来要还是原句');
});

await testAsync('拟人：splitChance=0 时保持一条', async () => {
  const cfg = baseCfg({ humanizeEnabled: false, quoteChance: 0, splitChance: 0, stickersEnabled: false });
  const sends = [];
  const { pipeline } = makePipeline({ llmText: JSON.stringify({ segments: ['诶，这本书我也翻过两页，写得挺温柔'] }), cfg, sends });
  await pipeline.handle(msgOf());
  assert.equal(sends.length, 1);
});

await testAsync('拟人：配图按概率来（stickerChance=0 连挑都不挑）', async () => {
  let picked = 0;
  const caps = { enrich: async () => [], act: async () => [], sticker: () => null, chooseSticker: async () => { picked += 1; return { file: 'a.webp' }; }, stickerSegment: () => ({ type: 'image', data: { file: 'base64://x' } }) };
  const cfg = baseCfg({ humanizeEnabled: false, quoteChance: 0, splitChance: 0, stickersEnabled: true, stickerChance: 0 });
  const { pipeline } = makePipeline({ llmText: '{"segments":["嗯嗯"],"sticker":"auto"}', cfg, sends: [], caps });
  await pipeline.handle(msgOf());
  assert.equal(picked, 0, 'stickerChance=0 不该挑图');

  const cfg2 = baseCfg({ humanizeEnabled: false, quoteChance: 0, splitChance: 0, stickersEnabled: true, stickerChance: 1 });
  const sends2 = [];
  const mk2 = makePipeline({ llmText: '{"segments":["嗯嗯"],"sticker":"auto"}', cfg: cfg2, sends: sends2, caps });
  await mk2.pipeline.handle(msgOf());
  assert.equal(picked, 1, 'stickerChance=1 应当挑一次');
  assert.ok(sends2.some((s) => s.segs.some((x) => x.type === 'image')));
});

await testAsync('拟人：主句说完再补一句（follow + followUpChance=1）', async () => {
  const cfg = baseCfg({ humanizeEnabled: false, quoteChance: 0, splitChance: 0, stickersEnabled: false, followUpChance: 1 });
  const sends = [];
  const { pipeline } = makePipeline({ llmText: '{"segments":["行，那我先去翻书了"],"follow":"对了，记得喝水"}', cfg, sends });
  await pipeline.handle(msgOf());
  const ok = await waitUntil(() => sends.length >= 2, 12000);
  assert.ok(ok, '补的那句没发出来');
  const last = sends[sends.length - 1].segs.map((s) => s.data.text).join('');
  assert.match(last, /记得喝水/);
});

await testAsync('拟人：把最近用过的开头列给模型（别老"诶、在呢"）', async () => {
  const cfg = baseCfg({ humanizeEnabled: false, quoteChance: 0, splitChance: 0, stickersEnabled: false, avoidOpenerCount: 4 });
  const sends = [];
  const { pipeline, llm } = makePipeline({ llmTexts: ['{"segments":["诶，在呢在呢"]}', '{"segments":["这回换个说法"]}'], cfg, sends });
  await pipeline.handle(msgOf({ id: 'a1', text: '在吗' }));
  await pipeline.handle(msgOf({ id: 'a2', text: '人呢' }));
  const secondSys = llm.calls[1][0].content;
  assert.match(secondSys, /你最近的开头/, '第二轮应当把旧开头列出来');
  assert.match(secondSys, /诶，在呢/, '旧开头应当是上一次说的');
});

// ── 14. 日记（借自 ai-companion-kit 的思路）──────────────────
test('日记：写一条、按天取、上下文注入、统计', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-diary-'));
  const diary = createDiary({ dataDir, cfg: { diaryMaxChars: 600, diaryContextCount: 3, diaryContextDays: 3 }, log: null });
  assert.equal(diary.stats().count, 0);
  const row = diary.add({ text: '今天把窗台擦了，阳光照进来有点像海里', title: '擦窗台', mood: '安稳', tags: ['小事'] });
  assert.match(row.day, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(diary.stats().count, 1);
  assert.equal(diary.stats().today, 1);
  assert.equal(diary.day(row.day).length, 1);
  assert.match(diary.context(), /擦窗台/);
  assert.match(diary.context(), /你自己最近写的日记/);
  // markdown 也要落一份，人可以直接翻
  assert.ok(fs.existsSync(path.join(dataDir, 'diary', row.day + '.md')));
  // 空正文要拒
  assert.throws(() => diary.add({ text: '   ' }));
});

test('日记：太长会被拒（不静默截断）', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-diary2-'));
  const diary = createDiary({ dataDir, cfg: { diaryMaxChars: 50 }, log: null });
  assert.throws(() => diary.add({ text: '啊'.repeat(60) }), /太长/);
});

await testAsync('日记：让她自己写（模型给 JSON 就照收）', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-diary3-'));
  const llm = { async chat() { return { text: '```json\n{"title":"碗洗完了","mood":"踏实","tags":["家务"],"text":"碗洗完了，水有点凉。他没说话，我就当他看见了。"}\n```' }; } };
  const diary = createDiary({ dataDir, cfg: { diaryMaxChars: 600 }, log: null, llm });
  const row = await diary.composeAndAdd({ roleText: '你是大肥鱼' });
  assert.equal(row.title, '碗洗完了');
  assert.match(row.text, /水有点凉/);
  assert.deepEqual(row.tags, ['家务']);
});

await testAsync('日记：模型没给 JSON 也不崩（整段当正文）', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-diary4-'));
  const llm = { async chat() { return { text: '今天什么都没干，就看了会儿窗外的云。' }; } };
  const diary = createDiary({ dataDir, cfg: { diaryMaxChars: 600 }, log: null, llm });
  const row = await diary.composeAndAdd({ roleText: '' });
  assert.match(row.text, /窗外的云/);
  assert.equal(row.title, '');
});

await testAsync('日记：一天只自动写一条（同一天再调不会重复写）', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-diary5-'));
  let calls = 0;
  const llm = { async chat() { calls += 1; return { text: '{"text":"写了","title":"t"}' }; } };
  // 时间设成 23:00，保证过了 diaryHour
  const at = new Date(); at.setHours(23, 0, 0, 0);
  const diary = createDiary({ dataDir, cfg: { diaryMaxChars: 600, diaryHour: 22, diaryEnabled: true }, log: null, llm, now: () => at.getTime() });
  const first = await diary.maybeAutoWrite();
  assert.ok(first, '第一条应当写出来');
  const second = await diary.maybeAutoWrite();
  assert.equal(second, null, '同一天不该再写');
  assert.equal(calls, 1);
});

await testAsync('日记：不到设定时间不写', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-diary6-'));
  let calls = 0;
  const llm = { async chat() { calls += 1; return { text: '{"text":"x"}' }; } };
  const at = new Date(); at.setHours(9, 0, 0, 0);
  const diary = createDiary({ dataDir, cfg: { diaryMaxChars: 600, diaryHour: 22 }, log: null, llm, now: () => at.getTime() });
  assert.equal(await diary.maybeAutoWrite(), null);
  assert.equal(calls, 0);
});

// ── 14b. QQ空间说说（SnowLuma 扩展动作）────────────────────
await testAsync('空间：发说说走 send_qzone_msg，带可见范围，本地留档', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-qzone-'));
  const calls = [];
  const onebot = { async call(action, params) { calls.push({ action, params }); return { tid: 'abc123' }; } };
  const qz = createQzone({ dataDir, onebot, cfg: { qzoneUgcRight: 4 } });
  const r = await qz.publish('今天风有点凉。');
  assert.equal(calls[0].action, 'send_qzone_msg');
  assert.equal(calls[0].params.content, '今天风有点凉。');
  assert.equal(calls[0].params.ugc_right, 4, '默认可见范围要读配置');
  assert.equal(r.tid, 'abc123');
  // 显式指定优先于配置
  await qz.publish('只给自己看', { ugcRight: 64 });
  assert.equal(calls[1].params.ugc_right, 64);
  // 非法范围退回 1（公开），不能把一条说说发到没人看得到的地方
  await qz.publish('x', { ugcRight: 99 });
  assert.equal(calls[2].params.ugc_right, 1);
  const h = qz.history(5);
  assert.equal(h.length, 3);
  assert.equal(h[0].text, 'x');
  assert.equal(qz.stats.published, 3);
});

await testAsync('空间：空正文/通道没连上都报人话，不瞎发', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-qzone2-'));
  const qz = createQzone({ dataDir, onebot: { async call() { return {}; } }, cfg: {} });
  await assert.rejects(async () => qz.publish('   '), /空/);
  const off = createQzone({ dataDir, onebot: null, cfg: {} });
  await assert.rejects(async () => off.publish('喂'), /通道/);
  // 网关不支持这些动作时要如实返回 false，不能假装可以
  const bad = createQzone({ dataDir, onebot: { async call() { throw new Error('OneBot 返回失败：1404 不支持'); } }, cfg: {} });
  assert.equal(await bad.available(), false);
});

await testAsync('空间：日记开关打开才发，关着就只落盘', async () => {
  const mk = async (enabled) => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-qzone3-'));
    const posts = [];
    const qzone = { async publish(t) { posts.push(t); return { ok: true }; } };
    const diary = createDiary({ dataDir, cfg: { diaryMaxChars: 600, qzoneDiaryEnabled: enabled }, log: null, qzone });
    diary.add({ text: '今天洗了碗。' });
    await new Promise((r) => setTimeout(r, 20));
    return posts;
  };
  assert.deepEqual(await mk(false), [], '开关关着不许往空间发');
  assert.deepEqual(await mk(true), ['今天洗了碗。'], '开关打开就该发这一篇');
});

// ── 14c. 改说说的可见范围（原地改，不删了重发）─────────────
await testAsync('空间：改可见范围走 set_qzone_msg_right，非法值直接报错', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-qzone-right-'));
  const calls = [];
  const onebot = { async call(action, params) { calls.push({ action, params }); return { ugc_right: params.ugc_right }; } };
  const qz = createQzone({ dataDir, onebot, cfg: {} });
  const r = await qz.setRight('tid-1', 4);
  assert.equal(calls[0].action, 'set_qzone_msg_right');
  assert.equal(calls[0].params.tid, 'tid-1');
  assert.equal(calls[0].params.ugc_right, 4);
  assert.equal(r.label, '好友可见');
  assert.equal(r.ugcRight, 4);
  // 把本该藏起来的东西改成公开是灾难，所以非法值必须报错，不能像"发说说"那样退回公开
  await assert.rejects(async () => qz.setRight('tid-1', 0), /只能是/);
  await assert.rejects(async () => qz.setRight('tid-1', 99), /只能是/);
  await assert.rejects(async () => qz.setRight('', 4), /哪条/);
  // 通道没连上要说清楚
  const off = createQzone({ dataDir, onebot: null, cfg: {} });
  await assert.rejects(async () => off.setRight('tid-1', 4), /通道/);
});

// ── 14d. 日志按本地日期分文件（UTC 会让早上的日志落进昨天）────
test('日志：按本地日期命名，不是 UTC', () => {
  const d = new Date(2026, 9, 23, 7, 30, 0);   // 本地 2026-10-23 07:30
  assert.equal(localDay(d), '2026-10-23', 'UTC 会算成 2026-10-22，那样早上 7 点的日志就找不到');
  const late = new Date(2026, 9, 23, 23, 59, 0);
  assert.equal(localDay(late), '2026-10-23');
});

test('空间：可见范围文案不许把 4 叫成公开', () => {
  assert.equal(rightLabel(1), '所有人可见');
  assert.equal(rightLabel(4), '好友可见');
  assert.equal(rightLabel(64), '仅自己可见');
});

// ── 14d2. 语音：先文字、后语音；不拿系统自带语音兜底 ──────────
await testAsync('语音：本地引擎失败且没开兜底 → 直接失败（不发系统自带语音）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-nosapi-'));
  const tts = createTts({
    cfg: { ttsEnabled: true, ttsEngine: 'local', ttsEndpoint: 'http://127.0.0.1:9882', ttsAllowSapiFallback: false, ttsCacheEnabled: false },
    dir, log: null,
    fetchImpl: async () => { throw new Error('fetch failed'); },
    runner: async () => ({ ok: false, out: 'no such task' })
  });
  await assert.rejects(() => tts.speak('你好', {}), /fetch failed/);
});

await testAsync('语音：先发文字，语音加载好再补一条（这一轮不等它）', async () => {
  const sends = [];
  let voiceResolved = false;
  const caps = {
    enrich: async () => [], act: async () => [], sticker: () => null, chooseSticker: async () => null, stickerSegment: () => null,
    voiceSegment: async () => { await new Promise((r) => setTimeout(r, 60)); voiceResolved = true; return [{ type: 'record', data: { file: 'base64://AAA' } }]; }
  };
  const { pipeline } = makePipeline({
    llmText: '{"segments":["晚安呀"],"mood":"温柔","voice":true}',
    cfg: baseCfg({ quoteChance: 0, splitChance: 0, stickerChance: 0, followUpChance: 0, voiceChance: 0, ttsEnabled: true, humanizeEnabled: false }),
    sends, caps
  });
  await pipeline.handle({ id: 'v1', selfId: '999', groupId: '123', userId: '42', nickname: '小明', text: '用语音说晚安', mentions: ['999'], images: [] });
  const kinds = sends.map((x) => (x.segs || []).map((y) => y.type).join('+'));
  assert.ok(kinds.some((k) => k.includes('text')), '文字得先发出去：' + JSON.stringify(kinds));
  assert.equal(voiceResolved, false, '这一轮不该等语音（它还在合成）');
  await new Promise((r) => setTimeout(r, 150));
  const recs = sends.flatMap((x) => x.segs || []).filter((y) => y.type === 'record');
  assert.equal(recs.length, 1, '加载好后应该补发一条语音，实际 ' + recs.length);
});

await testAsync('唱歌：先文字回应，音频在后台跑（这一轮不阻塞）', async () => {
  const sends = [];
  let songDone = false;
  const song = { async singBili() { await new Promise((r) => setTimeout(r, 60)); songDone = true; return { ok: true, file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ff-bg-')), 'a.wav'), bytes: 4000, seconds: 30, source: 'x', voiced: true }; } };
  fs.writeFileSync(song.fallbackFile = path.join(os.tmpdir(), 'ff-bg-placeholder.wav'), Buffer.alloc(4000));
  const { pipeline } = makePipeline({
    llmText: '{"segments":["好呀，这就去唱"],"mood":"开心"}',
    cfg: baseCfg({ quoteChance: 0, splitChance: 0, stickerChance: 0, followUpChance: 0, voiceChance: 0, ownerUin: '10042', humanizeEnabled: false }),
    sends, song
  });
  await pipeline.handle({ id: 's1', selfId: '999', groupId: '123', userId: '10042', nickname: '小明', text: '唱首晴天', mentions: ['999'], images: [] });
  assert.equal(songDone, false, '点歌应该在后台，不该卡住这一轮');
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(songDone, true, '后台任务应该跑起来');
});

// ── 14e. 本地服务按需启停（TTS/RVC/调音台）──────────────────
test('服务：从 endpoint 抠端口', () => {
  assert.equal(portOf('http://127.0.0.1:9882', 9882), 9882);
  assert.equal(portOf('http://127.0.0.1:9883/', 9885), 9883);
  assert.equal(portOf('', 9887), 9887, '空值要退回默认，不能 NaN');
  assert.equal(portOf('不是网址', 9885), 9885);
});

await testAsync('服务：portOpen 对没人听的端口返回 false', async () => {
  assert.equal(await portOpen(59999), false);
});

await testAsync('服务：ensure 在端口已经通了的时候直接返回 true（不重复拉起）', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-svc-'));
  // 先让系统随机给一个空闲端口，再在它上面放占位服务器：
  // ensure 应该直接认为"已经在跑"（不写死端口，免得撞上别人占用的号）
  const srv = http.createServer(() => {});
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const svc = createServices({ cfg: { botDir: dataDir, ttsEndpoint: 'http://127.0.0.1:1', singRvcEndpoint: 'http://127.0.0.1:2', rvcConsolePort: port }, dataDir, log: null });
  try {
    const ok = await svc.ensure('console');
    assert.equal(ok, true);
    assert.equal(svc.runtime.console.starts, 0, '已经在跑就不该再拉起');
    const st = await svc.status();
    assert.equal(st.length, 3, '应该有三个服务：tts/rvc/console');
    assert.ok(st.find((x) => x.name === 'console').up);
  } finally { await new Promise((r) => srv.close(r)); }
});

await testAsync('服务：未知名字的 ensure 返回 false，stop 也不炸', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-svc2-'));
  const svc = createServices({ cfg: { botDir: dataDir }, dataDir, log: null });
  assert.equal(await svc.ensure('没有这个服务'), false);
  assert.equal(await svc.stop('没有这个服务'), false);
});

// ── 15. 按人记账（借自 ai-companion-kit 的思路）──────────────
test('按人：一本账挂在 QQ 号上，重复的挪到最新、不堆两条', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-people-'));
  const people = createPeople({ dataDir, cfg: { peopleMaxTopics: 3, peopleMaxTraits: 40, peopleMaxFacts: 60 }, log: null });
  people.remember('10001', { name: '小明', fact: '他的猫叫团子' });
  people.remember('10001', { fact: '他在准备考试' });
  people.remember('10001', { fact: '他的猫叫团子' });     // 重复：应当只剩一条且在最后
  const p = people.person('10001');
  assert.equal(p.name, '小明');
  assert.equal(p.interactions, 3);
  assert.equal(p.facts.filter((f) => f === '他的猫叫团子').length, 1);
  assert.equal(p.facts[p.facts.length - 1], '他的猫叫团子');
});

test('按人：不同 QQ 号是两本账，互不串', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-people2-'));
  const people = createPeople({ dataDir, cfg: {}, log: null });
  people.remember('10001', { fact: 'A 的事' });
  people.remember('20002', { fact: 'B 的事' });
  assert.match(people.renderPerson('10001'), /A 的事/);
  assert.ok(!people.renderPerson('10001').includes('B 的事'), '不能串账');
  assert.equal(people.list().length, 2);
});

test('按人：话题滚动保留（超了删最老的）', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-people3-'));
  const people = createPeople({ dataDir, cfg: { peopleMaxTopics: 2 }, log: null });
  for (const t of ['话题一', '话题二', '话题三']) people.remember('10001', { topic: t });
  const p = people.person('10001');
  assert.deepEqual(p.topics, ['话题二', '话题三']);
});

test('按人：注入上下文时带上"聊过几次"，但空账不注入', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-people4-'));
  const people = createPeople({ dataDir, cfg: {}, log: null });
  assert.equal(people.renderPerson('99999'), '', '没账就不该有这一段');
  people.remember('10001', { name: '小明', fact: '在准备考试' });
  people.touch('10001');
  const text = people.renderPerson('10001');
  assert.match(text, /小明/);
  assert.match(text, /在准备考试/);
  assert.match(text, /聊过 2 次/);
});

test('按人：可以删掉一本账', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-people5-'));
  const people = createPeople({ dataDir, cfg: {}, log: null });
  people.remember('10001', { fact: 'x' });
  assert.equal(people.forget('10001'), true);
  assert.equal(people.forget('10001'), false);
  assert.equal(people.list().length, 0);
});

await testAsync('端到端：模型说"值得记"→ 同时进记忆池和这个人的账', async () => {
  const cfg = baseCfg({ humanizeEnabled: false, quoteChance: 0, splitChance: 0, peopleEnabled: true });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-people6-'));
  const people = createPeople({ dataDir, cfg, log: null });
  const sends = [];
  const { pipeline, memory } = makePipeline({ llmText: '{"segments":["记下啦"],"memory":["周五晚八点开组会"]}', cfg, sends, people });
  await pipeline.handle({ id: 'p1', selfId: '999', groupId: '123', userId: '10001', nickname: '小明', text: '周五开会', mentions: ['999'], images: [] });
  assert.deepEqual(memory.added, ['周五晚八点开组会']);
  const p = people.person('10001');
  assert.ok((p.facts || []).includes('周五晚八点开组会'), '事实应当也记到这个人账上');
  assert.equal(p.name, '小明');
});

await testAsync('紧凑语音：速度、情绪、静音处理与 PCM 校验', async () => { await import('./compact.mjs'); });

// ── 18. 自己搜东西（websearch）────────────────────────────
const BING_HTML = `
<li class="b_algo"><h2><a href="https://www.xiachufang.com/recipe/1/">红烧肉的家常做法_下厨房</a></h2>
<div><p class="b_lineclamp2">五花肉切块冷水下锅焯水，冰糖炒糖色，小火炖四十分钟收汁。</p></div></li>
<li class="b_algo"><h2><a href="https://zhuanlan.zhihu.com/p/2">零失败红烧肉：肥而不腻</a></h2>
<div><p>选三层五花，冰糖炒到枣红色，加热水没过肉，小火慢炖。</p></div></li>`;
const BAIDU_HTML = `
<div class="result c-container xpath-log" id="1"><h3><a href="https://www.baidu.com/link?url=abc">红烧肉怎么做才好吃</a></h3>
<div class="content-right_2s-Mp">先焯水去腥，再用冰糖炒糖色，最后小火慢炖四十分钟。</div></div>
<div class="result c-container xpath-log" id="2"><h3><a href="https://www.baidu.com/link?url=def">红烧肉的家常做法大全</a></h3>
<div class="content-right_2s-Mp">五花肉要选带皮的，炖的时候加一点点醋更容易烂。</div></div>`;

const BING_RSS = `<?xml version="1.0" encoding="utf-8" ?><rss version="2.0"><channel><title>必应：红烧肉 做法</title>
<item><title>红烧肉的家常做法_下厨房</title><link>https://www.xiachufang.com/recipe/1/</link>
<description>五花肉切块冷水下锅焯水，冰糖炒糖色，小火炖四十分钟收汁。</description></item>
<item><title>零失败红烧肉：肥而不腻</title><link>https://zhuanlan.zhihu.com/p/2</link>
<description>选三层五花，冰糖炒到枣红色，加热水没过肉，小火慢炖。</description></item>
</channel></rss>`;
const SO360_HTML = `
<h3 class="res-title"><a href="https://www.so.com/link?m=1">番茄鱼汤泡饭_360百科</a></h3>
<p>材料涮锅鱼片300克，鸡蛋1个，番茄2个，小洋葱头1个</p>
<h3 class="res-title"><a href="https://www.so.com/link?m=2">番茄鱼汤泡饭的做法_好吃佬</a></h3>
<p>番茄鱼汤浇在饭上，泡三分钟就好</p>`;
const SOGOU_HTML = `
<h3 class="vr-title"><a href="https://www.xiachufang.com/recipe/9/">鱼汤的做法大全_下厨房</a></h3>
<p>鱼汤怎么做好吃，家常做法合集</p>`;

await testAsync('搜索：必应结果页解析出标题、摘要、链接', async () => {
  const r = parseBing(BING_HTML, 5);
  assert.equal(r.length, 2);
  assert.match(r[0].title, /红烧肉/);
  assert.match(r[0].url, /^https:\/\//);
  assert.match(r[0].snippet, /冰糖|焯水/);
});

await testAsync('搜索：必应 RSS 也能解析（比 HTML 干净，没有广告位）', async () => {
  const r = parseBingRss(BING_RSS, 5);
  assert.equal(r.length, 2);
  assert.match(r[0].title, /红烧肉/);
  assert.match(r[0].url, /xiachufang/);
  assert.match(r[0].snippet, /冰糖|焯水/);
});

await testAsync('搜索：360 与搜狗的结果页也能解析', async () => {
  const a = parseSo360(SO360_HTML, 5);
  assert.equal(a.length, 2);
  assert.match(a[0].title, /番茄鱼汤泡饭/);
  const b = parseSogou(SOGOU_HTML, 5);
  assert.equal(b.length, 1);
  assert.match(b[0].title, /鱼汤的做法大全/);
});

await testAsync('搜索：百度结果页也能解析', async () => {
  const r = parseBaidu(BAIDU_HTML, 5);
  assert.equal(r.length, 2);
  assert.match(r[0].title, /红烧肉/);
  assert.match(r[1].snippet, /五花肉|醋/);
});

await testAsync('搜索：首选引擎是空壳页时自动换下一个，并标明实际用的引擎', async () => {
  const seen = [];
  const ws = createWebSearch({
    cfg: { netEnabled: true, webSearchEngine: 'baidu', webSearchTopK: 5 },
    log: null,
    fetchHtml: async (url) => {
      seen.push(url);
      // 百度给个反爬空页（几十字节），必应给真结果
      if (/baidu/.test(url)) return { ok: true, text: '<html>安全验证</html>' };
      if (/bing/.test(url)) return { ok: true, text: BING_RSS };
      return { ok: true, text: '<html>空</html>' };
    }
  });
  const r = await ws.search('红烧肉 做法');
  assert.equal(r.ok, true);
  assert.equal(r.engine, 'bing', '应当换到必应：' + r.engine);
  assert.equal(r.results.length, 2);
  assert.ok(seen.length >= 2, '应当真的试了第二个引擎');
});

// 这就是真踩到的坑：必应给一份"看着正常"的结果页，内容全是不相干的词
await testAsync('搜索：结果跟查询对不上（被投毒）会被判无关并换引擎', async () => {
  // 真实形态：必应 RSS 返回一批"看着正常"、但完全是别的词的条目
  const poisoned = `<?xml version="1.0" encoding="utf-8" ?><rss version="2.0"><channel><title>必应：番茄鱼汤泡饭</title>
<item><title>番茄小说网_好看的小说</title><link>https://fanqienovel.com/</link><description>免费小说阅读</description></item>
<item><title>番茄免费小说下载</title><link>https://sj.qq.com/appdetail</link><description>海量正版小说</description></item>
</channel></rss>`;
  const ws = createWebSearch({
    cfg: { netEnabled: true, webSearchEngine: 'bing', webSearchTopK: 5 },
    log: null,
    fetchHtml: async (url) => {
      if (/bing/.test(url)) return { ok: true, text: poisoned };   // 投毒页
      if (/so\.com/.test(url)) return { ok: true, text: SO360_HTML };
      return { ok: true, text: '' };
    }
  });
  const r = await ws.search('番茄鱼汤泡饭');
  assert.equal(r.engine, 'so360', '应当跳过必应换到 360：' + r.engine);
  assert.match(r.results[0].title, /番茄鱼汤泡饭|鱼汤饭/);
  assert.ok(ws.stats.poisoned >= 1, '应当记一次"投毒"');
});

await testAsync('搜索：相关性打分——「番茄鱼汤泡饭」碰上「番茄小说」不算相关', async () => {
  assert.ok(relevanceOf('番茄鱼汤泡饭', { title: '番茄小说网_好看的小说', snippet: '免费小说阅读' }) < 0.5);
  assert.ok(relevanceOf('番茄鱼汤泡饭', { title: '番茄鱼汤泡饭的做法_好吃佬', snippet: '番茄鱼汤浇在饭上' }) >= 0.5);
  assert.equal(relevanceOf('红烧肉', { title: '请稍候…', snippet: '正在进行安全验证' }), 0, '风控页直接判 0');
});

await testAsync('搜索：两个引擎都没结果时如实说没搜到（不许编）', async () => {
  const ws = createWebSearch({
    cfg: { netEnabled: true, webSearchEngine: 'bing', webSearchTopK: 5 },
    log: null,
    fetchHtml: async () => ({ ok: true, text: '<html>没有结果</html>' })
  });
  const r = await ws.search('量子纠缠 天气');
  assert.equal(r.ok, true);
  assert.equal(r.results.length, 0);
  assert.equal(r.empty, true);
  assert.match(ws.render(r), /没搜到|没查到/);
});

await testAsync('搜索：没开联网 / 没开搜索都给出明确原因，不是静默失败', async () => {
  const a = createWebSearch({ cfg: { netEnabled: false }, log: null, fetchHtml: async () => ({ ok: true, text: BING_HTML }) });
  assert.equal((await a.search('x')).ok, false);
  assert.match((await a.search('x')).error, /联网/);
  const b = createWebSearch({ cfg: { netEnabled: true, webSearchEnabled: false }, log: null, fetchHtml: async () => ({ ok: true, text: BING_HTML }) });
  assert.match((await b.search('x')).error, /搜索/);
});

await testAsync('搜索：窗口里的结果会渲染成带编号和网址的一段', async () => {
  const ws = createWebSearch({ cfg: { netEnabled: true, webSearchEngine: 'bing', webSearchTopK: 5 }, log: null, fetchHtml: async () => ({ ok: true, text: BING_RSS }) });
  const block = ws.render(await ws.search('红烧肉'));
  assert.match(block, /【联网搜索：红烧肉（bing）】/);
  assert.match(block, /1\. /);
  assert.match(block, /https:\/\//);
  // 超长要截断，别把 prompt 撑爆
  assert.ok(ws.render(await ws.search('红烧肉'), 60).length <= 60);
});

await testAsync('契约：开了联网搜索才出现 web 动作', async () => {
  const on = contractFor({ netEnabled: true, webSearchEnabled: true, stickersEnabled: false, humanizeEnabled: false, maxSegments: 2 });
  assert.match(on, /"web":\{"query"/);
  const off = contractFor({ netEnabled: true, webSearchEnabled: false, stickersEnabled: false, humanizeEnabled: false, maxSegments: 2 });
  assert.ok(!/"web":/.test(off), '关了就不该出现');
});

await testAsync('搜索：模型把 web 写在顶层也会被认出来（否则等于没说）', async () => {
  const r = normalizeReply({ segments: ['我查一下'], web: { query: '上海天气' } });
  assert.equal(r.action.web.query, '上海天气');
  const r2 = normalizeReply({ segments: ['好'], action: { web: '红烧肉做法' } });
  assert.equal(r2.action.web.query, '红烧肉做法');
});

await testAsync('搜索：从「帮我搜一下今天上海的天气」里抠搜索词', async () => {
  assert.equal(queryFromAsk('帮我搜一下今天上海的天气'), '今天上海的天气');
  assert.equal(queryFromAsk('查一下明天的火车票'), '明天的火车票');
  assert.equal(wantsWebSearch('帮我搜一下红烧肉做法'), true);
  assert.equal(wantsWebSearch('今天好累啊'), false);
});

// ── 19. 记忆不能变成"天天追着要东西" ───────────────────────
const memDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ff-mem-'));

await testAsync('记忆：同一件事换个说法不会堆两条（曾堆了四条"叫我哥哥"）', async () => {
  const mem = createMemory({ dataDir: memDir(), cfg: { memoryTopK: 3, memoryMaxPromises: 2 }, log: null });
  mem.add('青色让我以后叫他哥哥');
  mem.add('青色让我叫他哥哥，别忘');
  mem.add('青色要我喊他哥哥，别记岔');
  mem.add('青色要我喊他哥哥');
  assert.equal(mem.size, 1, '四条说法应当合成一条，实际：' + mem.all().map((x) => x.text).join(' | '));
});

await testAsync('记忆：承诺类超过上限就挤掉最旧的（否则它天天追着要）', async () => {
  const mem = createMemory({ dataDir: memDir(), cfg: { memoryTopK: 3, memoryMaxPromises: 2 }, log: null });
  mem.add('青色答应周末给我做糖醋排骨');
  mem.add('青色说好下周带我去海边');
  mem.add('青色承诺给我买一箱橘子');
  const promises = mem.all().filter((x) => isPromise(x.text));
  assert.equal(promises.length, 2, '只该留 2 条欠条：' + mem.all().map((x) => x.text).join(' | '));
  assert.ok(!mem.all().some((x) => x.text.includes('糖醋排骨')), '最旧那条应当被挤掉');
});

await testAsync('记忆：说"已经吃到了"就把同类欠条销掉', async () => {
  const mem = createMemory({ dataDir: memDir(), cfg: { memoryTopK: 3, memoryMaxPromises: 5 }, log: null });
  mem.add('青色答应九点做番茄鱼汤泡饭');
  mem.add('青色说九点给我吃肉，得记着');
  assert.ok(mem.all().some((x) => x.text.includes('番茄鱼汤泡饭')));
  mem.add('青色给了我番茄味鱼汤泡饭，已经吃到了，说话算话');
  const left = mem.all().map((x) => x.text);
  assert.ok(!left.some((t) => t.includes('答应九点做番茄')), '欠条该销掉：' + left.join(' | '));
  assert.ok(left.some((t) => t.includes('已经吃到了')), '兑现那条要留着');
});

await testAsync('按人：一个字、问号这种话题不记账（脏话题会污染上下文）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-ppl-'));
  const people = createPeople({ dataDir: dir, cfg: { peopleMaxTopics: 20, peopleMaxTraits: 40, peopleMaxFacts: 60 }, log: null });
  for (const junk of ['?', '嗯', '哦哦', '在吗？', '好的']) people.remember('1001', { topic: junk });
  people.remember('1001', { topic: '番茄味鱼汤泡饭怎么做' });
  const p = people.person('1001');
  assert.deepEqual(p.topics, ['番茄味鱼汤泡饭怎么做'], '脏话题应当被过滤：' + p.topics.join(' | '));
});

await testAsync('按人：同一件事的不同说法顶掉旧的，不堆两条', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-ppl2-'));
  const people = createPeople({ dataDir: dir, cfg: { peopleMaxTopics: 20, peopleMaxTraits: 40, peopleMaxFacts: 60 }, log: null });
  people.remember('1002', { fact: '青色说下了课给我做东西，得记着问' });
  people.remember('1002', { fact: '青色说下了课就给我做东西，得记着问' });
  people.remember('1002', { fact: '青色说下了课给我做东西' });
  const p = people.person('1002');
  assert.equal(p.facts.length, 1, '应当只剩一条：' + p.facts.join(' | '));
});

await testAsync('契约：写了"同一件事只提一次"这条规矩', async () => {
  const on = contractFor({ ...DEFAULTS, humanizeEnabled: true, stickersEnabled: false });
  assert.match(on, /同一件事只提一次/);
});

await testAsync('语音：本地服务没跑时，会自己把 FF-Voice 任务拉起来再合成（不再悄悄降级成 Windows 语音）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-tts-revive-'));
  const events = [];
  let attempts = 0;
  const goodWav = () => {
    const b = Buffer.alloc(44 + 24000);
    b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8);
    b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
    b.writeUInt32LE(24000, 24); b.writeUInt32LE(48000, 28);
    b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36);
    b.writeUInt32LE(b.length - 44, 40);
    return b;
  };
  // 第一轮 tts：连接失败；之后 /health 通、tts 成功
  const fetchImpl = async (url) => {
    if (String(url).endsWith('/health')) return { ok: true, status: 200 };
    attempts += 1;
    if (attempts === 1) throw new Error('fetch failed');
    return new Response(goodWav());
  };
  const runner = async (args) => { events.push(args.join(' ')); return { ok: true, out: '' }; };
  const tts = createTts({
    cfg: {
      ttsEnabled: true, ttsEngine: 'local', ttsEndpoint: 'http://127.0.0.1:9883',
      ttsRefAudio: '', ttsRefText: '', ttsSpeed: 1, ttsTimeoutSecs: 5, ttsMaxChars: 200,
      ttsMaxSeconds: 60, ttsCacheEnabled: false, ttsCompactEnabled: false, ttsEmotionEnabled: false
    },
    dir, log: null, fetchImpl, runner
  });
  const r = await tts.speak('测试一下语音');
  assert.ok(events.some((e) => e.includes('/run') && e.includes('FF-Voice-9883')), '应当触发计划任务：' + events.join(' | '));
  assert.equal(r.engine, 'local', '重试后应当用本地引擎，而不是 SAPI：' + r.engine);
});

// ── 21. 网易云音乐（移植自 ai-companion-kit 的 ncm 模块）──────────
await testAsync('网易云：搜歌能解析出 id/歌名/歌手，歌词去掉制作人那几行', async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes('/api/search/get')) {
      return { json: async () => ({ result: { songs: [{ id: 111, name: '晴天', duration: 269000, artists: [{ name: '周杰伦' }], album: { name: '叶惠美' } }] } }) };
    }
    return { json: async () => ({ lrc: { lyric: '[00:01.00]作词：某某\n[00:02.00]故事的小黄花\n[00:05.00]从出生那年就飘着' } }) };
  };
  const ncm = createNcm({ cfg: {}, log: null, fetchImpl });
  const s = await ncm.search('晴天');
  assert.equal(s.songs[0].id, 111);
  assert.equal(s.songs[0].artist, '周杰伦');
  assert.equal(s.songs[0].duration, 269);
  const lines = await ncm.lyricText(111, 10);
  assert.ok(!lines.some((l) => l.startsWith('作词')), '制作人那几行要去掉：' + lines.join(' / '));
  assert.deepEqual(lines.slice(0, 2), ['故事的小黄花', '从出生那年就飘着']);
});

await testAsync('网易云：PC 客户端没开时，"在听什么"要明确报错，不许假装', async () => {
  const ncm = createNcm({ cfg: {}, log: null, fetchImpl: async () => { throw new Error('fetch failed'); } });
  const r = await ncm.doOp('now').then(() => 'no-throw', (e) => e.message);
  assert.match(String(r), /fetch failed|调试/);
});

await testAsync('网易云：没有这个操作时给出可用清单', async () => {
  const ncm = createNcm({ cfg: {}, log: null, fetchImpl: async () => ({ json: async () => ({}) }) });
  const msg = await ncm.doOp('delete', {}).then(() => 'no-throw', (e) => e.message);
  assert.match(String(msg), /没这个操作/);
  assert.match(String(msg), /search/);
});

await testAsync('契约：开了网易云才出现 ncm 动作', async () => {
  const on = contractFor({ ...DEFAULTS, ncmEnabled: true, stickersEnabled: false, humanizeEnabled: false });
  assert.match(on, /"ncm":\{"do"/);
  const off = contractFor({ ...DEFAULTS, ncmEnabled: false, stickersEnabled: false, humanizeEnabled: false });
  assert.ok(!/"ncm":/.test(off), '关了就不该出现');
});

// ── 22. QQ音乐（用户选了 QQ音乐，不用网易云）──────────────────────
await testAsync('QQ音乐：搜歌解析出 mid/歌名/歌手，歌词去掉词曲和版权行', async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes('client_search_cp')) {
      return { text: async () => JSON.stringify({ code: 0, data: { song: { list: [{ songmid: 'MID1', songid: 97773, songname: '晴天', interval: 269, singer: [{ name: '周杰伦' }], albumname: '叶惠美' }] } } }) };
    }
    return {
      text: async () => JSON.stringify({
        retcode: 0,
        lyric: '[ti:晴天]\n[00:00.00]晴天 - 周杰伦 (Jay Chou)\n[00:02.25]词：周杰伦\n[00:04.50]（未经著作人许可，不得翻唱）\n[00:06.00]故事的小黄花\n[00:09.00]从出生那年就飘着'
      })
    };
  };
  const m = createQqMusic({ log: null, fetchImpl });
  const s = await m.search('晴天');
  assert.equal(s.songs[0].mid, 'MID1');
  assert.equal(s.songs[0].singer, '周杰伦');
  assert.equal(s.songs[0].duration, 269);
  const lines = await m.lyricText('MID1', 10);
  assert.deepEqual(lines, ['故事的小黄花', '从出生那年就飘着'], '应当只剩歌词正文：' + lines.join(' / '));
});

await testAsync('契约：开了 QQ音乐才出现 qqmusic 动作', async () => {
  const on = contractFor({ ...DEFAULTS, qqMusicEnabled: true, ncmEnabled: false, stickersEnabled: false, humanizeEnabled: false });
  assert.match(on, /"qqmusic":\{"do"/);
  const off = contractFor({ ...DEFAULTS, qqMusicEnabled: false, ncmEnabled: false, stickersEnabled: false, humanizeEnabled: false });
  assert.ok(!/"qqmusic":/.test(off), '关了就不该出现');
});

// ── 23. 唱歌 ────────────────────────────────────────────────
await testAsync('唱歌：旋律库在，歌词为空要报错（不许空唱一首）', async () => {
  assert.deepEqual(Object.keys(TUNES).sort(), ['两只老虎', '小星星', '欢乐生日', '欢乐颂', '生日快乐', '生日快乐'].filter((v, i, a) => a.indexOf(v) === i).sort().filter((k) => k in TUNES).sort());
  const s = createSing({ cfg: {}, ttsDir: os.tmpdir(), voiceDir: os.tmpdir(), ffmpegPath: 'ffmpeg' });
  await assert.rejects(() => s.sing({ text: '，。！' }), /要唱什么/);
});

await testAsync('唱歌：真唱一小段（要参考音频 + TTS + ffmpeg，缺一个就跳过）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-sing-'));
  const ff = cfgFfmpeg();
  if (!ff) throw new SkipError('本机没有 ffmpeg（公开版不带），跳过');
  const refAudio = path.join(process.cwd(), 'data', 'voice', '晓伊-少女音.wav');
  if (!fs.existsSync(refAudio)) throw new SkipError('需要本地参考音频 data/voice/…，公开版不带');
  const alive = await fetch('http://127.0.0.1:9883/health', { signal: AbortSignal.timeout(3000) }).then((r) => r.ok).catch(() => false);
  if (!alive) throw new SkipError('本机 9883 语音服务没开，跳过');
  const s = createSing({
    cfg: {
      ttsEndpoint: 'http://127.0.0.1:9883',
      ttsRefAudio: refAudio,
      ttsRefText: '主人，今天有点累吧，我给你倒杯水，你慢慢说。',
      ttsTimeoutSecs: 60
    },
    ttsDir: dir, voiceDir: dir, ffmpegPath: ff
  });
  const r = await s.sing({ text: '你好呀', tune: '小星星' });
  assert.ok(r.bytes > 20000, '音频太小：' + r.bytes);
  assert.equal(r.chars, '你好呀');
  assert.ok(r.seconds > 0.5 && r.seconds < 30, '时长不对：' + r.seconds);
});

function cfgFfmpeg() {
  // 公开版不带 ffmpeg：先看常见安装位置，再看 PATH
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  for (const p of ['C:\\ffmpeg\\bin\\ffmpeg.exe']) {
    if (fs.existsSync(p)) return p;
  }
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, exe);
    if (fs.existsSync(p)) return p;
  }
  return '';
}

// 唱歌的规矩（改过一次）：让对方唱歌 = 点歌，而且一轮只发一条音频。
await testAsync('唱歌：说了要唱但没给歌名 → 先问歌名，绝不乱唱儿歌', async () => {
  const sends = [];
  const sung = [];
  const songCalls = [];
  const fakeSing = { async sing(o) { sung.push(o); throw new Error('不该走到儿歌'); } };
  const fakeSong = { async singBili(o) { songCalls.push(o); throw new Error('没歌名不该点歌'); } };
  const { pipeline } = makePipeline({
    llmText: '{"segments":["那就唱一句哦"],"mood":"开心"}',
    cfg: baseCfg({ quoteChance: 0, splitChance: 0, stickerChance: 0, followUpChance: 0, voiceChance: 0, ownerUin: '10042' }),
    sends, sing: fakeSing, song: fakeSong
  });
  await pipeline.handle({ id: 'sing-1', selfId: '999', groupId: '123', userId: '10042', nickname: '小明', text: '大肥鱼出来唱歌', mentions: ['999'], images: [] });
  assert.equal(sung.length, 0, '不许再替它唱一闪一闪亮晶晶');
  assert.equal(songCalls.length, 0, '没歌名不该直接点歌');
  assert.ok(sends.some((s) => (s.segs || []).some((x) => x.type === 'text' && /歌名/.test(x.data.text))), '应当问歌名：' + JSON.stringify(sends.map((s) => (s.segs || []).map((x) => x.data?.text || x.type))));
  const records = sends.flatMap((s) => (s.segs || []).filter((x) => x.type === 'record'));
  assert.equal(records.length, 0, '这一轮不该有音频');
});

await testAsync('唱歌：说了歌名就点歌，而且一轮只发一条音频（不叠加语音/儿歌）', async () => {
  const sends = [];
  const sung = [];
  const songCalls = [];
  const fakeSing = { async sing(o) { sung.push(o); throw new Error('不该走儿歌'); } };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-song1-'));
  const fakeSong = {
    async singBili(o) {
      songCalls.push(o);
      const file = path.join(tmp, 'her-song.wav');
      fs.writeFileSync(file, Buffer.alloc(4000));
      return { ok: true, file, bytes: 4000, seconds: 60, source: '晴天', voiced: true };
    }
  };
  const { pipeline } = makePipeline({
    // 模型同时写了 voice:true + sing（真实里最常见）：两个都必须被压掉，只剩点歌那一条
    llmText: '{"segments":["好呀，唱给你听"],"mood":"开心","voice":true,"action":{"sing":{"text":"一闪一闪亮晶晶","tune":"小星星"}}}',
    cfg: baseCfg({ quoteChance: 0, splitChance: 0, stickerChance: 0, followUpChance: 0, voiceChance: 0, ttsEnabled: true, ownerUin: '10042' }),
    sends, sing: fakeSing, song: fakeSong
  });
  const r = await pipeline.handle({ id: 'sing-2', selfId: '999', groupId: '123', userId: '10042', nickname: '小明', text: '唱首晴天', mentions: ['999'], images: [] });
  assert.equal(r.replied, true);
  // 模型没给 song 动作 → 走兜底点歌，歌名从原话里抠
  assert.equal(songCalls.length, 1, '应当按点歌兜底一次');
  assert.equal(songCalls[0].text, '晴天', '歌名抠错了：' + songCalls[0].text);
  assert.equal(sung.length, 0, '点歌优先，不许再按旋律唱儿歌');
  const records = sends.flatMap((s) => (s.segs || []).filter((x) => x.type === 'record'));
  assert.equal(records.length, 1, '一轮只能有一条音频，实际：' + records.length);
});

await testAsync('唱歌：非主人点歌被拒，且没有任何音频', async () => {
  const sends = [];
  const songCalls = [];
  const fakeSong = { async singBili(o) { songCalls.push(o); throw new Error('不该跑'); } };
  const { pipeline } = makePipeline({
    llmText: '{"segments":["好呀"],"mood":"开心"}',
    cfg: baseCfg({ quoteChance: 0, splitChance: 0, stickerChance: 0, followUpChance: 0, voiceChance: 0, ownerUin: '42' }),
    sends, song: fakeSong
  });
  await pipeline.handle({ id: 'sing-3', selfId: '999', groupId: '123', userId: '7701', nickname: '路人', text: '唱首晴天', mentions: ['999'], images: [] });
  assert.equal(songCalls.length, 0, '非主人不许点歌');
  assert.ok(sends.some((s) => (s.segs || []).some((x) => x.type === 'text' && /主人/.test(x.data.text))), '要回一句拒绝');
  assert.equal(sends.flatMap((s) => (s.segs || []).filter((x) => x.type === 'record')).length, 0);
});

// 歌名抠取：只认真的歌名，量词/客套别当歌名
test('歌名抠取：从点歌/翻唱/唱一首里抠出歌名', () => {
  assert.equal(songNameFrom('唱首晴天'), '晴天');
  assert.equal(songNameFrom('点歌 起风了'), '起风了');
  assert.equal(songNameFrom('给我唱一首小星星'), '小星星');
  assert.equal(songNameFrom('翻唱《晴天》'), '晴天');
  assert.equal(songNameFrom('我想听夜曲'), '夜曲');
  assert.equal(songNameFrom('来一首七里香吧'), '七里香');
  // 抠不出真歌名的一律返回空串 —— 让程序去问，而不是随手唱儿歌
  assert.equal(songNameFrom('唱首歌'), '');
  assert.equal(songNameFrom('唱歌'), '');
  assert.equal(songNameFrom('来一首'), '');
  assert.equal(songNameFrom('唱个儿歌'), '', '儿歌不是歌名，那是"哼一段"的请求');
  assert.equal(songNameFrom(''), '');
  assert.equal(songNameFrom('今天天气不错'), '');
});

test('哼唱判定：只有明说要儿歌/哼/经典儿歌旋律才按旋律唱', () => {
  assert.equal(isSingRequest('唱首歌'), true);
  assert.equal(isSingRequest('唱首晴天'), true);
  assert.equal(isSingRequest('哼一段'), true);
  assert.equal(isSingRequest('今天好热'), false);
  assert.equal(wantsHum('唱个儿歌'), true);
  assert.equal(wantsHum('哼一句'), true);
  assert.equal(wantsHum('唱首小星星'), true);
  assert.equal(wantsHum('唱首晴天'), false, '点真歌不该走哼唱');
  assert.equal(wantsHum('唱首歌'), false, '只说"唱首歌"不等于要儿歌');
});

await testAsync('唱歌：说"唱首歌"没歌名 → 问歌名，不许自己唱小星星（真实踩过的坑）', async () => {
  const sends = [];
  const sung = [];
  const songCalls = [];
  // 实测模型真的会回这个：句子里带 sing 一闪一闪亮晶晶
  const fakeSing = { async sing(o) { sung.push(o); throw new Error('不该唱儿歌'); } };
  const fakeSong = { async singBili(o) { songCalls.push(o); throw new Error('没歌名不该点歌'); } };
  const { pipeline } = makePipeline({
    llmText: '{"segments":["那我哼一小段哦"],"mood":"得意","sing":{"text":"一闪一闪亮晶晶","tune":"小星星"}}',
    cfg: baseCfg({ quoteChance: 0, splitChance: 0, stickerChance: 0, followUpChance: 0, voiceChance: 0, ownerUin: '10042' }),
    sends, sing: fakeSing, song: fakeSong
  });
  await pipeline.handle({ id: 'sing-x', selfId: '999', groupId: '123', userId: '10042', nickname: '小明', text: '唱首歌', mentions: ['999'], images: [] });
  assert.equal(sung.length, 0, '没歌名时不许自己唱小星星');
  assert.equal(songCalls.length, 0);
  assert.ok(sends.some((s) => (s.segs || []).some((x) => x.type === 'text' && /歌名/.test(x.data.text))), '应当问歌名');
  assert.equal(sends.flatMap((s) => (s.segs || []).filter((x) => x.type === 'record')).length, 0, '这轮不该有音频');
});

await testAsync('唱歌：明说"唱个儿歌"才走哼唱，且只发一条音频', async () => {
  const sends = [];
  const sung = [];
  const fakeSing = {
    async sing(o) {
      sung.push(o);
      const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ff-hum-')), 'h.wav');
      fs.writeFileSync(file, Buffer.alloc(3000));
      return { ok: true, file, chars: o.text, tune: o.tune, seconds: 4, bytes: 3000 };
    }
  };
  const fakeSong = { async singBili() { throw new Error('儿歌不该去点歌'); } };
  const { pipeline } = makePipeline({
    llmText: '{"segments":["好呀"],"mood":"开心","sing":{"text":"一闪一闪亮晶晶","tune":"小星星"}}',
    cfg: baseCfg({ quoteChance: 0, splitChance: 0, stickerChance: 0, followUpChance: 0, voiceChance: 0, ownerUin: '10042' }),
    sends, sing: fakeSing, song: fakeSong
  });
  await pipeline.handle({ id: 'sing-h', selfId: '999', groupId: '123', userId: '10042', nickname: '小明', text: '唱个儿歌', mentions: ['999'], images: [] });
  assert.equal(sung.length, 1, '明说要儿歌才唱');
  assert.equal(sends.flatMap((s) => (s.segs || []).filter((x) => x.type === 'record')).length, 1);
});

test('契约归一化：顶层的 song / sing 也要认（模型就爱写顶层）', () => {
  const r1 = normalizeReply({ segments: ['好呀'], song: { bili: '晴天', seconds: 60 } });
  assert.equal(r1.action.song.bili, '晴天');
  const r2 = normalizeReply({ segments: ['好呀'], sing: { text: '一闪一闪', tune: '小星星' } });
  assert.equal(r2.action.sing.tune, '小星星');
  const r3 = normalizeReply({ segments: ['好呀'], sing: '一闪一闪' });
  assert.deepEqual(r3.action.sing, { text: '一闪一闪' });
  const r4 = normalizeReply({ segments: ['好呀'], song: '晴天' });
  assert.deepEqual(r4.action.song, { name: '晴天' });
  const r5 = normalizeReply({ segments: ['好呀'], action: { song: { name: 'A' } }, song: { bili: 'B' } });
  assert.equal(r5.action.song.name, 'A', 'action 里已经有就不覆盖');
});
// ── 24. 唱真歌（Demucs 拆人声 + RVC 换声）────────────────────────
await testAsync('唱真歌：能从 data/songs 里按名字/片段找到文件，找不到要说清', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-songs-'));
  const song = createSong({ cfg: { demucsDir: path.join(dir, 'demucs') }, dataDir: dir, log: null });
  const songsDir = path.join(dir, 'songs');
  fs.mkdirSync(songsDir, { recursive: true });
  fs.writeFileSync(path.join(songsDir, '晴天.mp3'), Buffer.alloc(100));
  fs.writeFileSync(path.join(songsDir, '起风了.wav'), Buffer.alloc(100));
  assert.equal(song.list().length, 2);
  assert.equal(song.resolve('晴天.mp3'), path.join(songsDir, '晴天.mp3'));
  assert.equal(song.resolve('起风了'), path.join(songsDir, '起风了.wav'), '只给名字不带后缀也该找到');
  await assert.rejects(async () => song.resolve('不存在的歌'), /没有/);
  await assert.rejects(async () => song.resolve(''), /哪首歌|songs/);
});

await testAsync('唱真歌：权重/输出目录都跟着 demucsDir 走（不许落到别处）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-songs2-'));
  const dd = path.join(dir, 'demucs-work');
  const song = createSong({ cfg: { demucsDir: dd }, dataDir: dir, log: null });
  assert.equal(song.dirs.demucsDir, dd);
  assert.equal(song.dirs.modelDir, path.join(dd, 'models'));
  assert.equal(song.dirs.outDir, path.join(dd, 'out'));
});

await testAsync('唱真歌：没配 demucsDir / demucsPython 时报清楚，不猜作者机器的路径', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-songs3-'));
  const song = createSong({ cfg: {}, dataDir: dir, log: null });
  await assert.rejects(() => song.separate(path.join(dir, 'a.wav')), /demucsDir/);
  const withDir = createSong({ cfg: { demucsDir: dir }, dataDir: dir, log: null });
  const wav = path.join(dir, 'a.wav');
  fs.writeFileSync(wav, Buffer.alloc(100));
  await assert.rejects(() => withDir.separate(wav), /demucsPython/);
});

// ── 24a2. Demucs 必须离线跑（联网检查模型会挂死）────────────
test('唱真歌：Demucs 子进程强制离线，权重目录指到配好的目录', () => {
  const modelDir = path.join(os.tmpdir(), 'ff-demucs-models');
  const env = demucsEnv(modelDir);
  assert.equal(env.HF_HUB_OFFLINE, '1', '联网检查会让 Demucs 卡死（进程活着、CPU 0、点歌永远等不到）');
  assert.equal(env.TRANSFORMERS_OFFLINE, '1');
  assert.equal(env.TORCH_HOME, modelDir);
  assert.equal(env.XDG_CACHE_HOME, modelDir);
});





test('升调：高音天花板压住高音（防止高音发颤）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-ceil-'));
  const f = createSong({ cfg: {}, dataDir: tmp, log: null }).semitonesFor;
  // 中位 230 想升到 300（+5），但高音段 370 升完会到 494 > 430 → 只能 +2
  const withCeil = f(230, { target: 300, p90: 370, ceiling: 430, maxUp: 7 });
  assert.equal(withCeil, 2, '高音段必须被天花板压住，实际 ' + withCeil);
  // 不开天花板时是 +5
  assert.equal(f(230, { target: 300, maxUp: 7 }), 5);
  // 高音段本来就低，天花板不生效
  assert.equal(f(230, { target: 300, p90: 300, ceiling: 430, maxUp: 7 }), 5);
  // p90 异常（八度误判）时天花板不生效，也不许反被压成降调
  assert.equal(f(230, { target: 300, p90: 900, ceiling: 430, maxUp: 7 }), 5);
  // 没给 p90/ceiling 时行为和以前一致
  assert.equal(f(150, { target: 300 }), 12);
});

// ── 24f. 中文命名 ───────────────────────────────────────────
test('歌名清洗：从 B站标题抠出干净的中文歌名', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-name2-'));
  const sq = createSong({ cfg: {}, dataDir: tmp, log: null });
  assert.equal(sq.cleanSongName('【Hi-Res无损音质】｜《晴天》- 周杰伦 -‘故事的小黄花’'), '晴天');
  assert.equal(sq.cleanSongName('《倒带》完整版 蔡依林'), '倒带');
  assert.equal(sq.cleanSongName('晴天 周杰伦'), '晴天-周杰伦');
  assert.equal(sq.cleanSongName('爱情讯息'), '爱情讯息');
  assert.equal(sq.cleanSongName(''), '');
  // 文件名里不能出现非法字符
  assert.ok(!/[\\/:*?"<>|]/.test(sq.cleanSongName('a/b:c*d?e"f<g>h|i')));
});

test('成品文件名：中文、带秒数和时间', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-name3-'));
  const sq = createSong({ cfg: {}, dataDir: tmp, log: null });
  const at = new Date(2026, 9, 23, 18, 30).getTime();
  const n = sq.songFileName({ title: '晴天 周杰伦', seconds: 60, at });
  assert.equal(n, '唱歌-晴天-周杰伦-她-60秒-1830.wav');
  assert.match(sq.songFileName({ title: '', seconds: 12, at }), /^唱歌-未命名-她-12秒-1830\.wav$/);
});

// ── 24e. 混音配平（伴奏别把人声盖住）──────────────────────
test('混音配平：人声拉到目标，伴奏固定压在人声下面', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-mix-'));
  const mixGains = createSong({ cfg: {}, dataDir: tmp, log: null }).mixGains;
  // 人声很小、伴奏很响（用户反馈"伴奏太大声"的典型情况）
  const g = mixGains(-30, -12, { vocalTarget: -16, accompOffset: 6 });
  assert.equal(g.vocalGainDb, 14, '人声 -30 → 拉到 -16 要 +14 dB');
  assert.equal(g.accompGainDb, -10, '伴奏要压到 -22（比人声低 6）→ -12 时 -10 dB');
  // 人声已经够响、伴奏也正常
  const g2 = mixGains(-16, -22, { vocalTarget: -16, accompOffset: 6 });
  assert.equal(g2.vocalGainDb, 0);
  assert.equal(g2.accompGainDb, 0);
  // 伴奏比人声响的情况不会加剧（伴奏一定被人声压住）
  const g3 = mixGains(-20, -6, { vocalTarget: -16, accompOffset: 8 });
  assert.equal(g3.vocalGainDb, 4);
  assert.equal(g3.accompGainDb, -18);
  // 异常输入不炸
  assert.deepEqual(mixGains(NaN, -12), { vocalGainDb: 0, accompGainDb: 0 });
  // 增益有上限，防止把人声拉爆
  assert.equal(mixGains(-60, -60, { vocalTarget: -16, maxGain: 24 }).vocalGainDb, 24);
});

// ── 24d. 换声升调（男声原曲 → 她的音区）────────────────────
test('换声升调：按原曲中位音高算出该升/降几个半音', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-pitch-'));
  const semitonesFor = createSong({ cfg: {}, dataDir: tmp, log: null }).semitonesFor;
  assert.equal(semitonesFor(150), 12, '典型男声 150Hz → +12');
  assert.equal(semitonesFor(180), 9);
  assert.equal(semitonesFor(200), 7);
  assert.equal(semitonesFor(250), 3);
  assert.equal(semitonesFor(288), 1, '她自己说话的音区 → 只微调');
  assert.equal(semitonesFor(300), 0);
  // 女声原曲比她高：最多降 maxDown
  assert.equal(semitonesFor(400), -4, '400Hz → -4（不是 -5，被 maxDown 夹住）');
  assert.equal(semitonesFor(600), -4);
  // 边界/异常：拿不到音高就绝不升调
  assert.equal(semitonesFor(0), 0);
  assert.equal(semitonesFor(null), 0);
  assert.equal(semitonesFor('abc'), 0);
  // 目标可配
  assert.equal(semitonesFor(150, { target: 240 }), 8);
  assert.equal(semitonesFor(150, { target: 300, maxUp: 7 }), 7, 'maxUp 要能夹住');
});

// ── 24b. 点歌缓存 + 只有主人能点 ────────────────────────────
await testAsync('点歌缓存：成品还在就秒回，绝不重跑 Demucs', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-cache-'));
  const song = createSong({ cfg: { demucsDir: path.join(dir, 'demucs') }, dataDir: dir, log: null });
  const songsDir = path.join(dir, 'songs');
  fs.mkdirSync(songsDir, { recursive: true });
  const src = path.join(songsDir, '晴天.mp3');
  fs.writeFileSync(src, Buffer.alloc(100));
  // 假装上次已经唱好了一份成品
  const made = path.join(dir, 'her-song-1.wav');
  fs.writeFileSync(made, Buffer.alloc(50_000));
  // 缓存键 = 路径|mtime|伴奏|换声模型|渲染管线版本
  const probe = createSong({ cfg: {}, dataDir: dir, log: null });
  const key = `local|${src}|${Math.round(fs.statSync(src).mtimeMs)}||her|${probe.renderVersion}`;
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  fs.writeFileSync(song.cacheFile, JSON.stringify({ [key]: { file: made, bytes: 50_000, seconds: 1.4, source: '晴天.mp3', voiced: true } }));
  const again = createSong({ cfg: { demucsDir: path.join(dir, 'demucs') }, dataDir: dir, log: null, modelTag: 'her' });
  const r = await again.singSong({ name: '晴天.mp3' });
  assert.equal(r.cached, true, '第二次点同一首必须走缓存');
  assert.equal(r.file, made);
  assert.equal(r.seconds, 1.4);
});

await testAsync('点歌缓存：成品被删/是空文件 → 缓存失效', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-cache2-'));
  const songsDir = path.join(dir, 'songs');
  fs.mkdirSync(songsDir, { recursive: true });
  const src = path.join(songsDir, 'a.mp3');
  fs.writeFileSync(src, Buffer.alloc(100));
  const key = `local|${src}|${Math.round(fs.statSync(src).mtimeMs)}||her`;   // 末段是换声模型
  const empty = path.join(dir, 'empty.wav');
  fs.writeFileSync(empty, Buffer.alloc(10));
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'state', 'song-cache.json'), JSON.stringify({
    [key]: { file: empty, bytes: 10, seconds: 0.1 },
    gone: { file: path.join(dir, '不存在.wav'), bytes: 99, seconds: 1 }
  }));
  const song = createSong({ cfg: { demucsDir: path.join(dir, 'demucs') }, dataDir: dir, log: null });
  assert.equal(song.cacheGet(key), null, '空文件不能当缓存见效');
  assert.equal(song.cacheGet('gone'), null, '文件没了就失效');
  assert.equal(song.cacheGet('从没见过的键'), null);
});

test('点歌只有主人能点：默认开（吃显卡的事不能人人可点）', () => {
  assert.equal(DEFAULTS.songOwnerOnly, true);
});

// ── 24c. 角色卡（多个人格，切完下一条就生效）──────────────
test('角色卡：列出默认人格 + roles 目录里的每张卡，当前那张有标记', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-roles-'));
  fs.writeFileSync(path.join(dataDir, 'persona.md'), '默认人格');
  const rolesDir = path.join(dataDir, 'roles');
  fs.mkdirSync(rolesDir, { recursive: true });
  fs.writeFileSync(path.join(rolesDir, '温柔的姐姐.md'), '温柔人格');
  fs.writeFileSync(path.join(rolesDir, '傲娇.md'), '傲娇人格');
  fs.writeFileSync(path.join(rolesDir, '说明.txt'), '不是角色卡');
  const p = createPersona({ cfg: {}, dataDir, log: null });
  const list = p.list();
  assert.equal(list.length, 3, '应该是 默认 + 2 张卡');
  assert.deepEqual(list.map((x) => x.id).sort(), ['persona', '傲娇', '温柔的姐姐'].sort());
  assert.equal(list.filter((x) => x.current).length, 1);
  assert.equal(list.find((x) => x.current).id, 'persona', '没选角色时默认用 persona.md');
  assert.equal(p.text, '默认人格');
});

test('角色卡：切换后立刻换人格（不用重启），存回也只写当前那张', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-roles2-'));
  fs.writeFileSync(path.join(dataDir, 'persona.md'), '默认人格');
  fs.mkdirSync(path.join(dataDir, 'roles'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'roles', '傲娇.md'), '傲娇人格');
  const p = createPersona({ cfg: {}, dataDir, log: null });
  p.switchTo('傲娇');
  assert.equal(p.text, '傲娇人格');
  assert.equal(p.current(), '傲娇');
  // 存档只改傲娇那张，默认人格不受影响
  p.save('傲娇人格·改');
  assert.equal(fs.readFileSync(path.join(dataDir, 'roles', '傲娇.md'), 'utf8'), '傲娇人格·改');
  assert.equal(fs.readFileSync(path.join(dataDir, 'persona.md'), 'utf8'), '默认人格');
  // 切回去
  p.switchTo('persona');
  assert.equal(p.text, '默认人格');
  assert.equal(p.current(), '');
});

test('角色卡：切到不存在的角色要报错，不许人格变空', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-roles3-'));
  fs.writeFileSync(path.join(dataDir, 'persona.md'), '默认人格');
  const p = createPersona({ cfg: {}, dataDir, log: null });
  assert.throws(() => p.switchTo('不存在'), /没有这个角色/);
  assert.throws(() => p.switchTo(''), /不能为空/);
  assert.equal(p.text, '默认人格');
});

test('角色卡：选中的卡被删了 → 退回 persona.md（人格不能空）', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-roles4-'));
  fs.writeFileSync(path.join(dataDir, 'persona.md'), '默认人格');
  fs.mkdirSync(path.join(dataDir, 'roles'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'roles', '临时.md'), '临时人格');
  const p = createPersona({ cfg: {}, dataDir, log: null });
  p.switchTo('临时');
  assert.equal(p.text, '临时人格');
  fs.rmSync(path.join(dataDir, 'roles', '临时.md'));
  assert.equal(p.text, '默认人格', '卡没了就退回默认，不能变成空人格');
});

// ── 汇总 ───────────────────────────────────────────────────

await testAsync('人格成长端到端：提示进入模型，成功发送后才观察', async () => {
  let observed = 0, prompt = '';
  const personaOverride = { text: '底层性格原文', growthRole: () => 'role-a', growth: {
    hint: (role, user) => { assert.equal(role, 'role-a'); assert.equal(user, '123456'); return '后天习惯标记'; },
    observe: (role) => { assert.equal(role, 'role-a'); observed++; }
  }};
  const {pipeline} = makePipeline({ personaOverride, cfg: baseCfg({ humanizeEnabled: false, quoteChance: 0 }),
    llm: { chat: async messages => { prompt=messages[0].content; return {text:'{"segments":["嗯，听到了"]}',model:'test'}; } } });
  const msg = { id:'growth-e2e',selfId:'999',groupId:'123',userId:'123456',nickname:'测试',text:'温柔一点',mentions:['999'],images:[] };
  const r=await pipeline.handle(msg);
  assert.equal(r.replied,true); assert.equal(observed,1);
  assert.match(prompt,/底层性格原文/); assert.match(prompt,/后天习惯标记/);
  await pipeline.handle(msg); assert.equal(observed,1);
});
await testAsync('人格成长端到端：发送失败不学习', async () => {
  let observed=0;
  const {pipeline}=makePipeline({llmText:'{"segments":["嗯"]}',cfg:baseCfg({humanizeEnabled:false}),
    personaOverride:{text:'底层',growth:{hint:()=>'',observe:()=>{observed++;}}},
    transport:{state:{connected:true,selfId:'999'},send:async()=>{throw Error('模拟发送失败');}}});
  try { await pipeline.handle({id:'growth-fail',selfId:'999',groupId:'123',userId:'123456',text:'温柔一点',mentions:['999'],images:[]}); } catch {}
  assert.equal(observed,0);
});
testPlasticity(test);
const failed = results.filter((r) => !r.ok);
const skipped = results.filter((r) => r.skip);
console.log('');
for (const r of results) {
  const tag = r.ok ? (r.skip ? '  skip' : '  ok  ') : '  FAIL';
  console.log(`${tag}  ${r.name}${r.skip ? '  ← ' + r.skip : (r.ok ? '' : '  ← ' + r.err)}`);
}
console.log(`\n${results.length - failed.length}/${results.length} 通过${skipped.length ? `（其中 ${skipped.length} 条因环境跳过）` : ''}`);
if (failed.length) process.exit(1);
