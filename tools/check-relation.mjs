// 关系自检：证明「主人没 @ 也必回、群友在同样条件下不回」是真的，不是只在单测里成立。
//
// 做法：起一个假 NapCat（test/mock-onebot.mjs），另开一个**隔离数据目录**的实例，
// 把 napcatWs 指到假服务上。于是真的走完了：收帧 → 关系判定 → 门槛 → 提示词 → 真实模型 → 出站，
// 但消息只会发到假服务里，不会进你的 QQ 群。
//
// 跑法：node tools/check-relation.mjs
//   --owner <主人QQ>   主人的 QQ（默认读 data/config.json 的 ownerUin）
//   --group <群号>     在哪个群里试（默认读白名单第一个）

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createMockOneBot } from '../test/mock-onebot.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argOf = (name, def = '') => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] || def) : def;
};

const liveCfgPath = path.join(root, 'data', 'config.json');
let live = {};
try {
  live = JSON.parse(fs.readFileSync(liveCfgPath, 'utf8')) || {};
} catch (e) {
  console.error(`读不到本地配置：${liveCfgPath}（${e.message}）`);
  console.error('这个自检要拿你本机的 data/config.json 当底（模型通道、白名单群）；先跑一次 node src/main.mjs 让它生成。');
  process.exit(1);
}
const owner = argOf('--owner', String(live.ownerUin || '').split(',')[0].trim());
const group = argOf('--group', String((live.groups || [])[0] || ''));
const friendQq = '10086';   // 一个肯定不是主人的号

if (!owner) {
  console.error('没有主人 QQ：先在设置页填「管理员（主人）QQ 号」，或用 --owner 指定');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const mock = createMockOneBot({ selfId: String(live.selfId || '10000'), nickname: '肥鱼不肥' });
const mockPort = await mock.start();

// 隔离数据目录：只复制人格和模型通道，其余用不着
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-rel-'));
for (const d of ['logs', 'kb', 'state', 'media']) fs.mkdirSync(path.join(dataDir, d), { recursive: true });
const personaSrc = path.join(root, 'data', live.personaFile || 'persona.md');
if (fs.existsSync(personaSrc)) fs.copyFileSync(personaSrc, path.join(dataDir, 'persona.md'));

const cfg = {
  ...live,
  napcatWs: `ws://127.0.0.1:${mockPort}`,
  napcatToken: '',
  consolePort: 31877,
  groups: [String(group)],
  selfId: String(live.selfId || '10000'),
  ownerUin: owner,
  dryRun: false,              // 只发到假服务，不会进群
  // 把干扰项全关掉，只留"关系"这一条变量
  quietEnabled: true, quietStart: '00:00', quietEnd: '23:59',  // 静默时段：除主人/@外谁都不接
  moodEnabled: false, proactiveEnabled: false,
  stickersEnabled: false, visionEnabled: process.argv.includes('--vision') ? (live.visionEnabled !== false) : false,
  netEnabled: process.argv.includes('--web') ? true : false,
  webSearchEnabled: true,
  shotEnabled: false, ttsEnabled: process.argv.includes('--voice'), genEnabled: false,
  humanizeEnabled: false, maxSegments: live.maxSegments ?? 2, logKeepDays: 1
};
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify(cfg, null, 2), 'utf8');

const nodeExe = process.execPath;
const child = spawn(nodeExe, [path.join(root, 'src', 'main.mjs'), '--data', dataDir], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
let childLog = '';
child.stdout.on('data', (c) => { childLog += c; });
child.stderr.on('data', (c) => { childLog += c; });

let exitCode = 0;
function cleanup() {
  try { child.kill(); } catch { /* ignore */ }
  try { mock.close(); } catch { /* ignore */ }
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

try {
  // 1) 等它连上假 NapCat
  for (let i = 0; i < 100 && !mock.connected; i++) await sleep(100);
  if (!mock.connected) throw new Error('实例没能连上假 NapCat（30 秒）\n' + childLog.slice(-1200));
  console.log(`已连上假 NapCat（端口 ${mockPort}），主人 = ${owner}，群 = ${group}`);
  console.log('注意：这个实例是隔离数据目录，消息只会发到假服务，不会进你的群。\n');

  // 2) 主人：不 @、说一句"我想你了"（正是以前被冷却挡掉的那种消息）
  const ownerText = argOf('--text', '我想你了，理我一下');
  mock.push(mock.rawMessage({ messageId: 5001, userId: owner, nickname: '青色', groupId: group, text: ownerText, mentions: [] }));
  let ownerSends = 0;
  for (let i = 0; i < 300; i++) { await sleep(100); ownerSends = mock.sends.length; if (ownerSends > 0) break; }
  await sleep(1200); // 等它把分条都发完
  const ownerMsgs = mock.sends.splice(0).map(textOf);

  // 3) 群友：同样的场景、同样不 @
  mock.push(mock.rawMessage({ messageId: 5002, userId: friendQq, nickname: '路人甲', groupId: group, text: '我想你了，理我一下', mentions: [] }));
  await sleep(6000);
  const friendMsgs = mock.sends.splice(0).map(textOf);

  // 4) 群友 @ 它：这时候必须回，但应当是对朋友的口吻（对照组）
  //    注意：文字要和上一条不同 —— 同一个人 45 秒内发一模一样的话会被内容级去重挡掉
  mock.push(mock.rawMessage({ messageId: 5003, userId: friendQq, nickname: '路人甲', groupId: group, text: '我想你了，你在不在呀', mentions: [String(live.selfId || '10000')] }));
  let friendAtSends = 0;
  for (let i = 0; i < 300; i++) { await sleep(100); friendAtSends = mock.sends.length; if (friendAtSends > 0) break; }
  await sleep(1200);
  const friendAtMsgs = mock.sends.splice(0).map(textOf);

  const events = readEvents(dataDir);
  const ownerEvent = events.find((e) => e.kind === 'relation');
  const replyEvent = events.find((e) => e.kind === 'reply' && String(e.user) === String(owner));

  console.log('【主人（没 @，静默时段）】');
  console.log(ownerMsgs.length ? ownerMsgs.map((t) => '  它说：' + t).join('\n') : '  ✗ 一句话都没发（不对）');
  console.log(`  门槛判词：${ownerEvent ? ownerEvent.detail : '（没记录）'}`);
  console.log('\n【群友（没 @，静默时段）】');
  console.log(friendMsgs.length ? friendMsgs.map((t) => '  它说：' + t).join('\n') : '  （没说话 —— 符合预期：朋友距离、静默时段不主动接）');
  console.log('\n【群友（@ 它 —— 必须回，看口吻）】');
  console.log(friendAtMsgs.length ? friendAtMsgs.map((t) => '  它说：' + t).join('\n') : '  ✗ @ 了也没回（不对）');
  const tooClose = friendAtMsgs.join(' ').match(/主人|宝宝|亲爱的|想你了/);
  console.log(tooClose ? `  ⚠ 群友的回话里出现了「${tooClose[0]}」，朋友距离没守住` : '  口吻检查：没出现主人/宝宝/亲爱的这类称呼（合格）');
  console.log(`\n本轮模型调用与耗时看日志：${path.join(dataDir, 'logs')}（临时目录，跑完就删）`);

  // 5) 连发对照：4 条、间隔 400 毫秒（以前会变成 4 个回合 = 一屏消息）
  if (process.argv.includes('--burst')) {
    mock.sends.splice(0);
    const lines = ['在吗', '问你个事', '在不在', '急'];
    for (let i = 0; i < lines.length; i++) {
      mock.push(mock.rawMessage({ messageId: 6000 + i, userId: owner, nickname: '青色', groupId: group, text: lines[i], mentions: [] }));
      await sleep(400);
    }
    await sleep(9000);
    const burst = mock.sends.splice(0).map(textOf);
    console.log(`\n【你连发 ${lines.length} 条（间隔 400 毫秒）】`);
    console.log(`  它一共发了 ${burst.length} 条消息：`);
    burst.forEach((t) => console.log('    ' + t));
    if (burst.length > 3) { console.error(`结果：还是偏多 —— ${lines.length} 条输入回了 ${burst.length} 条`); exitCode = 1; }
  }

  // 6) 语音链路：主人明确要语音时，管道应当产出一个 record 段（只是发到假服务，不进群）
  if (process.argv.includes('--voice')) {
    mock.sends.splice(0);
    mock.push(mock.rawMessage({ messageId: 7001, userId: owner, nickname: '青色', groupId: group, text: '你能用语音说一句话吗', mentions: [] }));
    let got = null;
    for (let i = 0; i < 450; i++) {
      await sleep(200);
      got = mock.sends.find((s) => (s.message || []).some((x) => x.type === 'record')) || null;
      if (got) break;
    }
    if (got) {
      const seg = (got.message || []).find((x) => x.type === 'record');
      const f = String(seg.data.file || '');
      console.log(`\n【用语音说一句】管道产出了 record 段：${f.slice(0, 24)}…（${(f.length / 1024).toFixed(0)} KB base64）`);
    } else {
      const texts = mock.sends.splice(0).map(textOf);
      console.log(`\n【用语音说一句】没产出 record 段，只发了文字：${texts.join(' / ').slice(0, 120)}`);
      exitCode = 1;
    }
  }

  // 8) 自己搜：让它真去搜一句，看日志里有没有 search 事件、回话里有没有靠近搜到的东西
  if (process.argv.includes('--web')) {
    mock.sends.splice(0);
    const ask = argOf('--ask', '帮我搜一下今天上海的天气');
    mock.push(mock.rawMessage({ messageId: 9001, userId: owner, nickname: '青色', groupId: group, text: ask, mentions: [] }));
    let said = '';
    for (let i = 0; i < 600; i++) {
      await sleep(200);
      said = mock.sends.map(textOf).join(' / ');
      if (said) break;
    }
    await sleep(1500);
    const texts = mock.sends.splice(0).map(textOf).filter(Boolean);
    const ev = readEvents(dataDir).filter((e) => e.kind === 'search');
    console.log(`\n【让它自己搜：「${ask}」】`);
    console.log('  它说的话：' + (texts.join(' / ') || '（没说话）'));
    if (ev.length) {
      for (const e of ev.slice(-4)) console.log('  搜索日志：' + String(e.detail).slice(0, 160));
      console.log('  ✅ 它真的自己去搜了');
    } else {
      console.log('  ✗ 没有搜索事件（模型没写 web 字段，或者联网没开）');
      exitCode = 1;
    }
  }


  if (!ownerMsgs.length) { console.error('\n结果：失败 —— 主人说话没回'); exitCode = 1; }
  else if (friendMsgs.length) { console.error('\n结果：可疑 —— 群友在静默时段也被接了（自主发言是不是把别人的话接上了？）'); exitCode = 1; }
  else if (!friendAtMsgs.length) { console.error('\n结果：失败 —— 群友 @ 它却没回'); exitCode = 1; }
  else if (tooClose) { console.error('\n结果：口吻不对 —— 对群友用了主人档的说法'); exitCode = 1; }
  else if (!replyEvent) { console.error('\n结果：需要人工看一眼 —— 有回话但日志里没找到 reply 事件'); exitCode = 1; }
  else console.log('\n结果：通过 —— 同样的消息，主人有回，群友不主动接；被 @ 时回得是朋友口吻。');
} catch (e) {
  console.error('\n自检失败：' + e.message);
  exitCode = 1;
} finally {
  cleanup();
  process.exit(exitCode);
}

function textOf(rec) {
  const segs = Array.isArray(rec.message) ? rec.message : [];
  return segs.filter((s) => s.type === 'text').map((s) => s.data.text).join('') || `[${segs.map((s) => s.type).join('+')}]`;
}

function readEvents(dir) {
  const logDir = path.join(dir, 'logs');
  const out = [];
  try {
    for (const f of fs.readdirSync(logDir)) {
      if (!f.endsWith('.jsonl')) continue;
      for (const line of fs.readFileSync(path.join(logDir, f), 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try { out.push(JSON.parse(line)); } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
  return out;
}
