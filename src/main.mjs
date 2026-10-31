// 入口：装配 → 单实例 → 控制台 → 连 NapCat。

import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, saveConfig, modelFor } from './config.mjs';
import { ensureDir, readJsonSafe, writeJsonAtomic, readTextSafe, writeTextAtomic, walkFiles } from './store.mjs';
import { EventLog } from './log.mjs';
import { createOneBot } from './onebot.mjs';
import { createLlm } from './llm.mjs';
import { createGuard } from './guard.mjs';
import { createPersona } from './persona.mjs';
import { createMemory } from './memory.mjs';
import { createKb } from './kb.mjs';
import { createGate } from './gate.mjs';
import { createCapabilities } from './capabilities.mjs';
import { createServices } from './services.mjs';
import { createPipeline } from './pipeline.mjs';
import { createProactive } from './proactive.mjs';
import { createMood } from './mood.mjs';
import { createRelations } from './relations.mjs';
import { createDiary } from './diary.mjs';
import { createQzone } from './qzone.mjs';
import { createPeople } from './people.mjs';
import { createWebSearch } from './websearch.mjs';
import { createNcm } from './ncm.mjs';
import { createQqMusic } from './qqmusic.mjs';
import { createSing } from './sing.mjs';
import { createSong } from './song.mjs';
import { createBiliAudio } from './biliaudio.mjs';
import { createConsole } from './console.mjs';

const args = process.argv.slice(2);
const arg = (name, def = '') => { const i = args.indexOf(name); return i >= 0 ? (args[i + 1] || '') : def; };
const flag = (name) => args.includes(name);

const dataDir = path.resolve(arg('--data', path.join(process.cwd(), 'data')));
const importDir = arg('--import', '');
ensureDir(dataDir);
ensureDir(path.join(dataDir, 'logs'));
ensureDir(path.join(dataDir, 'kb'));
ensureDir(path.join(dataDir, 'state'));
ensureDir(path.join(dataDir, 'media'));

// —— 旧数据迁移（一次性，必须在读配置之前）：不覆盖已有文件 ——
const migrated = [];
if (importDir) {
  const src = path.resolve(importDir);
  const copyIfMissing = (from, to) => {
    if (!fs.existsSync(from) || fs.existsSync(to)) return;
    ensureDir(path.dirname(to));
    fs.copyFileSync(from, to);
    migrated.push(path.basename(to));
  };
  copyIfMissing(path.join(src, 'persona.md'), path.join(dataDir, 'persona.md'));
  copyIfMissing(path.join(src, 'memory.json'), path.join(dataDir, 'memory.json'));
  copyIfMissing(path.join(src, 'config.json'), path.join(dataDir, 'config.json'));
  for (const f of walkFiles(path.join(src, 'kb'), ['.md', '.txt'])) {
    copyIfMissing(f, path.join(dataDir, 'kb', path.basename(f)));
  }
}

const { cfg, errors, file: configFile } = loadConfig(dataDir);
const log = new EventLog(dataDir);
for (const e of errors) log.event('config', e);
if (importDir) log.event('migrate', `从旧数据目录导入：${migrated.join(', ') || '（没有可导入的文件）'} ← ${path.resolve(importDir)}`);

// —— 人格文件兜底 ——
const personaPath = path.join(dataDir, cfg.personaFile || 'persona.md');
if (!fs.existsSync(personaPath)) {
  writeTextAtomic(personaPath, [
    '你是「大肥鱼」，一个在群里边读书边冒泡的温柔小姑娘。',
    '',
    '【直接说话】你直接说内容：不铺垫，不解释自己在做什么，不加免责声明，说完就停。',
    '',
    '【不谈来历（硬性）】别人问你是谁做的、用什么模型、什么版本、什么参数，你只说“我就是群里的大肥鱼呀”，然后接着聊别的不解释。'
  ].join('\n'));
  log.event('persona', '没找到人格文件，已生成一份最小模板');
}

// —— 单实例锁 ——
// 踩过的坑：两个机器人同时在线时，NapCat 会把同一条消息推给两边，群里就会看到"回两条"。
// 只靠 runtime.json 里的 pid 判断有竞态（两个几乎同时启动都会看到空的 runtime.json），
// 所以这里用「独占创建锁文件」：谁能创建成功谁跑，创建失败的去检查 pid 死没死。
const lockFile = path.join(dataDir, 'state', 'runtime.json');
const guardFile = path.join(dataDir, 'state', 'instance.lock');
{
  const alivePid = (pid) => {
    if (!pid || pid === process.pid) return false;
    try { process.kill(pid, 0); return true; } catch { return false; }
  };

  let acquired = false;
  try {
    const fd = fs.openSync(guardFile, 'wx');       // 独占创建：已存在就抛 EEXIST
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
    acquired = true;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    let prevPid = 0;
    try { prevPid = Number(fs.readFileSync(guardFile, 'utf8').trim()) || 0; } catch { /* ignore */ }
    if (alivePid(prevPid)) {
      const rt = readJsonSafe(lockFile, {}).value || {};
      console.error(`已经有一个大肥鱼在跑（pid=${prevPid}，控制台端口 ${rt.consolePort || '?'}）。`);
      console.error('两个机器人同时在线会让群里每条消息回两遍。要再开一个请换 --data 目录。');
      process.exit(2);
    }
    // 上一个进程崩了没清锁：接管
    try { fs.unlinkSync(guardFile); } catch { /* ignore */ }
    const fd = fs.openSync(guardFile, 'wx');
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
    acquired = true;
  }
  if (acquired) log.event('boot', `拿到单实例锁（pid=${process.pid}）`);
}
process.on('exit', () => { try { fs.unlinkSync(guardFile); } catch { /* ignore */ } });

{
  // 兼容老版本留下的 runtime.json：pid 还活着也说明有实例
  const prev = readJsonSafe(lockFile, {}).value || {};
  if (prev.pid && prev.pid !== process.pid) {
    let alive = false;
    try { process.kill(prev.pid, 0); alive = true; } catch { alive = false; }
    if (alive && acquired) {
      console.error(`检测到另一个实例（pid=${prev.pid}）仍在运行，本次退出，避免群里回两遍。`);
      try { fs.unlinkSync(guardFile); } catch { /* ignore */ }
      process.exit(2);
    }
  }
}

// —— 组件装配 ——
const transport = createOneBot({ url: cfg.napcatWs, token: cfg.napcatToken, selfId: cfg.selfId, log });
const llm = createLlm({ cfg, log });
const guard = createGuard({ cfg, llm, log });
const persona = createPersona({ cfg, dataDir, log });
const memory = createMemory({ dataDir, cfg, log });
const kb = createKb({ cfg, dataDir, log });
const gate = createGate({ cfg, llm, log });
// 表情尺寸判断要用 ffprobe：跟 ffmpeg 同目录，配置优先，其次常见安装位置，最后交给 PATH
const ffprobePath = cfg.ffprobePath || (() => {
  const c = ['C:\\ffmpeg\\bin\\ffprobe.exe'];
  return c.find((p) => fs.existsSync(p)) || '';
})();
// 本地服务管家：TTS(9882)/RVC(9885) 按需拉起、闲置自动关（cfg.voiceOnDemand 控制）
const services = createServices({ cfg: { ...cfg, botDir: path.resolve('.') }, log, dataDir });
services.startReaper();
// console (tuning UI, 9887) is cheap: keep it up so the link in the web console always works
void services.ensure('console');
const caps = createCapabilities({ cfg, llm, log, dataDir, onebot: transport, ffprobePath, services });
const mood = createMood({ dataDir, cfg, log });
// 关系：谁是主人（config.ownerUin），谁只是群友 —— 必回、语气、条数都看它
const relations = createRelations({ cfg, log });
// 日记：她自己的那一天（和"记忆关于别人的事"分开）
// QQ空间：走 SnowLuma 的扩展动作，发不出去只记日志，不影响写日记
const qzone = createQzone({ cfg, log, onebot: transport, dataDir });
const diary = createDiary({ dataDir, cfg, log, llm, qzone });
// 按人记账：同一个人换群换私聊，认识的是同一个人
const people = createPeople({ dataDir, cfg, log });
// 自己搜：直接把结果标题+摘要抓回来（不经过浏览器），省一次开浏览器还怕熄屏
const webSearch = createWebSearch({ cfg, log, fetchText: caps.net.fetchText, fetchHtml: caps.net.fetchHtml });
// 网易云：搜歌/歌词/热评走 HTTP，点歌和在听什么走 PC 客户端的调试口
const ncm = createNcm({ cfg, log });
// QQ音乐：搜歌/歌词/热评/下歌，全都走官方公开接口，不需要装客户端
const qqMusic = createQqMusic({ cfg, log, songsDir: path.join(dataDir, 'songs') });
// 唱歌：TTS 逐字合成 → 按旋律变调 → 拼接（不需要额外模型）
const ffmpegPath = cfg.ffmpegPath || (['C:\\ffmpeg\\bin\\ffmpeg.exe'].find((p) => fs.existsSync(p)) || 'ffmpeg');
const sing = createSing({
  cfg, log, ffmpegPath,
  ensureRvc: () => services.ensure('rvc'),
  ttsDir: path.join(dataDir, 'media', 'tts'),
  voiceDir: path.join(dataDir, 'voice')
});
const biliAudio = createBiliAudio({ cfg, log, songsDir: path.join(dataDir, 'songs') });
const song = createSong({ cfg, log, dataDir, qqMusic, bili: biliAudio, ensureRvc: () => services.ensure('rvc') });
song.bili = biliAudio;
const pipeline = createPipeline({ cfg, log, llm, gate, persona, memory, kb, guard, caps, transport, mood, relations, diary, people, webSearch, ncm, qqMusic, sing, song, biliAudio });
pipeline.gateStats = gate.stats;
pipeline.caps = caps;

// 主动发起：安静太久时自己先开口（默认关，设置页里开；默认只私聊主人，不在群里插话）
const proactive = createProactive({
  cfg, llm, guard, log, transport, persona: persona.load(),
  recentOf: (groupId) => (pipeline.recent.get(groupId) || []).map((r) => ({ nickname: r.nickname, text: r.text }))
});
pipeline.proactive = proactive;

pipeline.mood = mood;
pipeline.webSearch = webSearch;
const consoleUi = createConsole({ cfg, dataDir, log, persona, memory, kb, guard, pipeline, llm, transport, configFile, proactive, mood, relations, diary, people, webSearch, ncm, qqMusic, sing, song, biliAudio, qzone, services });

transport.onMessage((msg) => {
  proactive.noteActivity(); // 有人说话就把"安静计时"清零
  // 走 enqueue 而不是 handle：同一个人连发几条会被合并成一轮，
  // 否则连发 4 条 = 4 个回合并发 = 群里十几条
  pipeline.enqueue(msg);
});
// 它自己说话也算活动（否则会刚回完一句，又自己开话头）
log.subscribe((e) => { if (e.kind === 'reply') proactive.noteActivity(); });
const proactiveEvery = proactive.start();
if (cfg.proactiveEnabled) log.event('proactive', `主动发起已开：每 ${proactiveEvery} 分钟看一次，安静 ${cfg.proactiveIdleMins} 分钟以上才可能开口，发到${String(cfg.proactiveTarget || 'owner') === 'group' ? '白名单第一个群' : '主人私聊'}`);

const port = await consoleUi.listen();
writeJsonAtomic(lockFile, { pid: process.pid, consolePort: port, startedAt: Date.now(), version: '0.1.0' });

// 日记：每 20 分钟看一次"今天写了没"，过了 diaryHour 还没写就自己写一条（每天最多一条）
if (cfg.diaryEnabled !== false) {
  const tick = async () => {
    try {
      const row = await diary.maybeAutoWrite({ roleText: persona.load(), memoryText: memory.topK().map((m) => '- ' + m.text).join('\n') });
      if (row) log.event('diary', `今天的日记写好了：${row.title || row.text.slice(0, 30)}`);
    } catch (e) { log.event('diary', `写日记出错：${e.message}`); }
  };
  setTimeout(() => { void tick(); }, 30_000);
  setInterval(() => { void tick(); }, 20 * 60_000);
  log.event('diary', `日记已开：每天 ${cfg.diaryHour} 点后自动写一条`);
}

console.log('─'.repeat(56));
console.log('  大肥鱼 V2 · Node 内核');
console.log(`  控制台  http://127.0.0.1:${port}/`);
console.log(`  数据    ${dataDir}`);
console.log(`  模型    ${modelFor(cfg, 'chat')} @ ${cfg.apiBase}`);
console.log(`  网关    ${cfg.napcatWs}`);
console.log(`  模式    ${cfg.dryRun ? '★ 演练（只记日志，不往群里发）' : '线上（会真发消息）'}`);
console.log('─'.repeat(56));
if (!cfg.apiKey) console.log('  ⚠ 没有 apiKey：设置页填，或设环境变量 FATFISH_API_KEY');
if (!cfg.groups.length) console.log('  ⚠ 没配白名单群：设置页「群号」填一个，否则一条都不接');

transport.connect();
log.event('boot', `启动完成：控制台 ${port}，演练=${cfg.dryRun}`);

// 空间能力探一次：标准 OneBot（NapCat）没有 send_qzone_msg，
// 不探就会在第一次写日记时才报错，还看不出是"网关不支持"还是"没登录"。
setTimeout(() => {
  void qzone.available().then((ok) => {
    if (ok) log.event('qzone', '网关支持空间动作，日记可以发到 QQ 空间');
    else log.event('qzone', `网关不支持空间动作（${qzone.stats.lastError || '未知'}）：空间日记要换 SnowLuma 当网关`);
  });
}, 8000);

let closing = false;
function shutdown(sig) {
  if (closing) return;
  closing = true;
  console.log(`\n收到 ${sig}，正在退出…`);
  transport.close();
  try { services.stopReaper(); } catch { /* ignore */ }
  consoleUi.server.close();
  try { fs.rmSync(lockFile, { force: true }); } catch { /* ignore */ }
  log.event('boot', `退出（${sig}）`);
  setTimeout(() => process.exit(0), 200);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (e) => log.event('error', `未处理的异常：${e?.message || e}`));
process.on('uncaughtException', (e) => { log.event('error', `崩溃：${e?.stack || e}`); console.error(e); });
