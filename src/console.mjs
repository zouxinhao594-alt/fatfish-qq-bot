// 控制台：node:http。静态页 + JSON API + SSE 事件流。刻意零依赖、只监听回环地址。
//
// 接口一览（前端只用这几个，加接口请更新这张表）：
//   GET  /                    控制台页面（web/index.html）
//   GET  /api/status          运行状态：连接、计数、模型、能力开关、知识库概况
//   GET  /api/config          当前配置（密钥一律打码）
//   POST /api/config          只提交改动的项；返回实际生效的键名列表
//   GET  /api/fields          设置页的中文说明书（分区 + 中文名 + 一句话解释）
//   GET  /api/persona         读人格原文
//   POST /api/persona         写人格（保存即热加载）
//   GET  /api/logs            事件环形缓冲（?limit= &kind=）
//   GET  /api/events          SSE：新事件实时推给页面
//   GET  /api/kb              知识库概况（目录/文件/块数）
//   POST /api/kb/reload       强制重新扫描知识库
//   GET  /api/memory          记忆列表
//   POST /api/memory          加一条记忆 / {clear:true} 清空
//   POST /api/say             以机器人身份手动发一条（演练模式不真发）
//   POST /api/test-model      用一句话试模型通不通（返回原始回复片段）
//   GET  /api/voices          音色：引擎清单、SAPI 可选音色、参考音频、当前设置、引擎健康
//   POST /api/voices/test     按提交的参数临时合成一句（试听，不改已保存的配置）
//   POST /api/voices/use      把某个参考音频设为当前音色（同时切到本地克隆引擎）
//   POST /api/voices/ref-text 存参考音频对应的原文（GPT-SoVITS 有它更像）
//   GET  /api/voices/file     取 data/voice 或 data/media/tts 里的 wav（只认 basename）

import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, saveConfig, modelFor } from './config.mjs';
import { fieldsByGroup } from './fields.mjs';
import { PURPOSES, allModels, channelsOf, describeRoutes, mergeDiscovered, refreshModels, setPurpose } from './models.mjs';
import { discover } from './dsh.mjs';
import { splitBubbles } from './outbound.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(here, '..', 'web');

const MASK = (s) => (s ? String(s).slice(0, 4) + '****' + String(s).slice(-4) : '');

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req, limit = 2_000_000) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const chunks = [];
    req.on('data', (c) => { n += c.length; if (n > limit) { reject(new Error('请求过大')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(new Error('JSON 解析失败')); } });
    req.on('error', reject);
  });
}

export function createConsole({ cfg, dataDir, log, persona, memory, kb, guard, pipeline, llm, transport, configFile, proactive = null, mood = null, relations = null, diary = null, people = null, webSearch = null, ncm = null, qqMusic = null, sing = null, song = null, biliAudio = null, qzone = null, services = null, startedAt = Date.now() }) {
  const portState = { port: Number(cfg.consolePort) || 3092, fallback: false };
  // 默认渠道（设置页那套 apiBase/apiKey）不存进 cfg.channels，
  // 但刷新出来的模型清单要能显示，所以放内存里（重启后重新点一次"刷新"即可）
  const mem = { defaultModels: [] };

  // —— 音色模块用的小工具 ——
  const voiceDirPath = path.join(dataDir, 'voice');
  const voiceIndexFile = path.join(voiceDirPath, 'index.json');

  /** 参考音频清单（谁在这个目录里，谁就有资格当音色） */
  function listRefs() {
    const texts = readVoiceIndex();
    try {
      return fs.readdirSync(voiceDirPath)
        .filter((f) => f.toLowerCase().endsWith('.wav') && !f.startsWith('_'))
        .map((f) => {
          const st = fs.statSync(path.join(voiceDirPath, f));
          return {
            name: f,
            bytes: st.size,
            mtime: st.mtimeMs,
            text: texts[f] || '',
            selected: !!cfg.ttsRefAudio && path.resolve(String(cfg.ttsRefAudio)) === path.resolve(path.join(voiceDirPath, f)),
            url: `/api/voices/file?name=${encodeURIComponent(f)}`
          };
        })
        .sort((a, b) => b.mtime - a.mtime);
    } catch { return []; }
  }

  function readVoiceIndex() {
    try {
      // 注意：Windows PowerShell 的 -Encoding UTF8 会带 BOM，JSON.parse 直接抛 → 全当没原文。
      // 这里先剥掉 BOM 再解析，省得以后又被这个坑一次。
      const raw = fs.readFileSync(voiceIndexFile, 'utf8').replace(/^\uFEFF/, '');
      return JSON.parse(raw) || {};
    } catch { return {}; }
  }
  function writeVoiceIndex(obj) { fs.mkdirSync(voiceDirPath, { recursive: true }); fs.writeFileSync(voiceIndexFile, JSON.stringify(obj, null, 2), 'utf8'); }

  // SAPI 音色清单要起一次 PowerShell（一两秒），缓存一分钟，页面刷新不会一直卡
  let sapiCache = { at: 0, list: [] };
  function sapiVoices() {
    if (Date.now() - sapiCache.at < 60_000) return sapiCache.list;
    try {
      const script = "Add-Type -AssemblyName System.Speech; $s=New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.GetInstalledVoices() | ForEach-Object { $i=$_.VoiceInfo; if($_.Enabled){ \"$($i.Name)|$($i.Culture.Name)|$($i.Gender)\" } }; $s.Dispose()";
      const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 20_000, encoding: 'utf8' });
      const list = String(out).split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((line) => {
        const [name, culture, gender] = line.split('|');
        return { name, culture: culture || '', gender: gender || '' };
      });
      sapiCache = { at: Date.now(), list };
      return list;
    } catch { return sapiCache.list; }
  }

  /** 探一下本地克隆引擎在不在：只认回环地址 */
  async function probeEngine(endpoint) {
    if (!endpoint) return { ok: false, reason: '没配接口地址' };
    let u;
    try { u = new URL(endpoint); } catch { return { ok: false, reason: '地址格式不对' }; }
    if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) {
      return { ok: false, reason: '只接受回环地址（127.0.0.1 / localhost）' };
    }
    const base = endpoint.replace(/\/+$/, '').replace(/\/tts$/, '');
    let last = { ok: false, reason: '连不上（服务没启动？）' };
    for (const probe of ['/health', '/docs']) {
      try {
        const r = await fetch(base + probe, { signal: AbortSignal.timeout(2500) });
        if (!r.ok) { last = { ok: false, reason: `${probe} 返回 ${r.status}`, status: r.status, probe }; continue; }
        const text = probe === '/health' ? (await r.text()).slice(0, 300) : '';
        return { ok: true, status: r.status, probe, detail: text };
      } catch { last = { ok: false, reason: '连不上（服务没启动？）' }; }
    }
    return last;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const p = url.pathname;
    try {
      // 浏览器打开外站时，外站不能借本机控制台关掉保护。
      if(p.startsWith('/api/')){
        const host=String(req.headers.host||'');
        if(!/^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host))return json(res,403,{ok:false,error:'仅接受本机控制台地址'});
        if(!['GET','HEAD'].includes(req.method)){
          const origin=req.headers.origin;
          if(req.headers['sec-fetch-site']==='cross-site'||(origin&&origin!==`http://${host}`))return json(res,403,{ok:false,error:'拒绝网页跨站操作控制台'});
          if(!String(req.headers['content-type']||'').toLowerCase().startsWith('application/json'))return json(res,415,{ok:false,error:'请使用 JSON 请求'});
        }
      }
      if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
        // 每次都从磁盘读 + 禁止缓存：改完页面按一下刷新就能看到，不会拿到旧 HTML
        let html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
        html = html.replaceAll('__BUILD__', new Date(startedAt).toLocaleString('zh-CN', { hour12: false }));
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
          Pragma: 'no-cache',
          Expires: '0'
        });
        return res.end(html);
      }
      if (req.method === 'GET' && p === '/api/status') {
        return json(res, 200, {
          ok: true, version: '0.1.0', startedAt, uptimeSec: Math.round((Date.now() - startedAt) / 1000),
          consolePort: portState.port, consoleUrl: `http://127.0.0.1:${portState.port}/`,
          dataDir, configFile, personaChars: persona.load().length,
          dryRun: !!cfg.dryRun, connected: !!transport?.state?.connected, selfId: transport?.state?.selfId || cfg.selfId,
          lastPongAgoSec: transport?.state?.lastPongAt ? Math.round((Date.now() - transport.state.lastPongAt) / 1000) : null,
          halfOpenCount: transport?.state?.halfOpen || 0,
          lastConnError: transport?.state?.lastError || '',
          napcatWs: cfg.napcatWs, model: cfg.model, routes: describeRoutes(cfg),
          groups: cfg.groups, metrics: { ...pipeline.metrics }, gate: { ...(pipeline.gateStats || {}) },
          guard: { ...(guard?.counters || {}) },
          proactive: proactive ? { ...proactive.stats, lastActivityAgoSec: Math.round((Date.now() - proactive.lastActivityAt) / 1000) } : null,
          mood: mood ? { current: mood.state.current, intensity: mood.state.intensity, label: mood.label(), hint: mood.hint(), recent: mood.state.recent.slice(-5) } : null,
          relation: relations ? relations.describe() : null,
          caps: { vision: cfg.visionEnabled, gen: cfg.genEnabled, tts: cfg.ttsEnabled, ...(capsStats()), stickers2: (pipeline.caps && pipeline.caps.stickers ? pipeline.caps.stickers.list(1).files : 0) },
          memory: memory.size, kb: kb.list()
        });
      }
      if (req.method === 'GET' && p === '/api/relation') {
        // 「关系」自检：给一个 QQ 号，看它现在会被当成主人还是群友，
        // 以及真正会写进提示词的那一段是什么（改完 ownerUin 可以立刻验证，不用等群里试）
        const qq = String(url.searchParams.get('qq') || '').trim();
        if (!relations) return json(res, 200, { ok: false, error: '关系模块没挂上' });
        const tier = relations.tierOf(qq);
        return json(res, 200, {
          ok: true, qq, tier, isOwner: tier === 'owner',
          owner: relations.describe(),
          maxSegments: relations.maxSegmentsFor(tier, cfg.maxSegments),
          hint: relations.hintFor({ userId: qq, nickname: String(url.searchParams.get('nick') || '') || '这位群友', groupId: String(url.searchParams.get('group') || '') })
        });
      }
      if (req.method === 'GET' && p === '/api/config') {
        const out = {};
        for (const k of Object.keys(DEFAULTS)) out[k] = k.toLowerCase().includes('key') ? MASK(cfg[k]) : cfg[k];
        out.__hasApiKey = !!cfg.apiKey;
        return json(res, 200, { ok: true, config: out });
      }
      if (req.method === 'POST' && p === '/api/config') {
        const body = await readBody(req);
        const applied = [];
        for (const [k, v] of Object.entries(body || {})) {
          if (!(k in DEFAULTS) || k === 'dataDir') continue;
          if (typeof v === 'string' && /^\*{2,}/.test(v.trim())) continue; // 掩码值不回写
          cfg[k] = v;
          applied.push(k);
        }
        if (body?.apiKey && !/^\*/.test(body.apiKey)) cfg.apiKey = body.apiKey;
        saveConfig(dataDir, cfg);
        log.event('config', `配置已保存：${applied.join(', ') || '（无变化）'}`);
        return json(res, 200, { ok: true, applied });
      }
      if (req.method === 'POST' && p === '/api/personality/reset') {
        const body = await readBody(req);
        if (body.confirm !== true) return json(res, 400, { ok: false, error: '需要确认重置当前角色的成长记录' });
        persona.growth?.reset(persona.growthRole?.() || '');
        return json(res, 200, { ok: true });
      }
      if (req.method === 'GET' && p === '/api/persona') {
        const text = persona.load();
        return json(res, 200, { ok: true, text, chars: text.length, growth: persona.growth?.snapshot(persona.growthRole?.() || ''), role: persona.current ? persona.current() : '' });
      }
      if (req.method === 'POST' && p === '/api/persona') {
        const body = await readBody(req);
        if (typeof body.text !== 'string') return json(res, 400, { ok: false, error: '缺少 text' });
        const chars = persona.save(body.text);
        return json(res, 200, { ok: true, chars });
      }
      // 角色卡：data/roles/*.md，切完下一条消息就生效（不用重启）
      if (req.method === 'GET' && p === '/api/roles') {
        return json(res, 200, { ok: true, current: persona.current(), roles: persona.list(), dir: persona.rolesDir });
      }
      if (req.method === 'POST' && p === '/api/roles/switch') {
        const body = await readBody(req);
        try {
          const r = persona.switchTo(body.id);
          return json(res, 200, { ok: true, ...r, current: persona.current() });
        } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
      }
      if (req.method === 'POST' && p === '/api/roles/save') {
        const body = await readBody(req);
        try {
          const r = persona.saveAs(body.id, body.text ?? '');
          return json(res, 200, { ok: true, ...r, roles: persona.list() });
        } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
      }
      if (req.method === 'GET' && p === '/api/logs') {
        const limit = Math.min(500, Number(url.searchParams.get('limit')) || 100);
        const kind = url.searchParams.get('kind') || '';
        return json(res, 200, { ok: true, events: log.list(limit, kind) });
      }
      if (req.method === 'GET' && p === '/api/fields') {
        // 「设置」页的中文说明书：分区 + 每个字段的中文名/说明/类型
        return json(res, 200, { ok: true, groups: fieldsByGroup() });
      }
      if (req.method === 'GET' && p === '/api/models') {
        // 「模型」页：有哪些渠道、每个渠道有哪些模型、四个用途现在各指哪里
        const chans = channelsOf(cfg).map((c) => {
          const models = (!c.id && !(c.models || []).length ? mem.defaultModels : (c.models || []))
            .filter((m) => m && m.id)
            .map((m) => ({ id: m.id, name: m.name || m.id, input: m.input || ['text'], contextWindow: m.contextWindow || 0, maxTokens: m.maxTokens || 0 }));
          return {
            id: c.id, name: c.name, apiBase: c.apiBase || '', api: c.api || '',
            hasKey: !!c.apiKey, keyHint: c.apiKey ? String(c.apiKey).slice(0, 4) + '****' + String(c.apiKey).slice(-4) : '',
            models, modelsUpdatedAt: c.modelsUpdatedAt || 0, isDefault: !c.id
          };
        });
        return json(res, 200, {
          ok: true,
          purposes: PURPOSES,
          routes: describeRoutes(cfg),
          channels: chans,
          models: allModels(cfg),
          dshHome: process.env.DSH_HOME || ''
        });
      }
      if (req.method === 'POST' && p === '/api/models/route') {
        const body = await readBody(req);
        try {
          const value = setPurpose(cfg, String(body.purpose || ''), body.route);
          saveConfig(dataDir, cfg);
          log.event('models', `「${body.purpose}」切到 ${value || '（默认）'}`);
          return json(res, 200, { ok: true, route: value, routes: describeRoutes(cfg) });
        } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
      }
      if (req.method === 'GET' && p === '/api/models/dsh') {
        // 只「看一眼」DSH 里有什么，不写入任何配置
        const found = discover();
        return json(res, 200, {
          ok: true,
          dshHome: found.dshHome,
          defaultModel: found.defaultModel,
          warnings: found.warnings,
          channels: found.channels.map((c) => ({
            id: c.id, name: c.name, apiBase: c.apiBase, api: c.api,
            hasKey: !!c.apiKey, apiKeyFrom: c.apiKeyFrom,
            source: c.source,
            models: c.models.map((m) => ({ id: m.id, name: m.name, input: m.input, contextWindow: m.contextWindow }))
          }))
        });
      }
      if (req.method === 'POST' && p === '/api/models/import') {
        const found = discover();
        if (!found.channels.length) return json(res, 200, { ok: false, error: found.warnings.join('；') || 'DSH 里没找到渠道', warnings: found.warnings });
        const summary = mergeDiscovered(cfg, found);
        saveConfig(dataDir, cfg);
        log.event('models', `从 DSH 导入：新增 ${summary.added} 个渠道、更新 ${summary.updated} 个、共 ${summary.models} 个模型`);
        return json(res, 200, { ok: true, summary, warnings: found.warnings, routes: describeRoutes(cfg) });
      }
      if (req.method === 'POST' && p === '/api/models/refresh') {
        const report = await refreshModels(cfg, { log });
        const def = report.find((r) => !r.channelId && r.ok);
        if (def && def.ids) mem.defaultModels = def.ids.map((id) => ({ id, name: id, input: ['text'] }));
        saveConfig(dataDir, cfg);
        return json(res, 200, { ok: true, report, routes: describeRoutes(cfg) });
      }
      if (req.method === 'GET' && p === '/api/kb') {
        return json(res, 200, { ok: true, ...kb.list() });
      }
      if (req.method === 'POST' && p === '/api/kb/reload') {
        kb.reload();
        return json(res, 200, { ok: true, ...kb.list() });
      }
      if (req.method === 'GET' && p === '/api/memory') {
        return json(res, 200, { ok: true, items: memory.all() });
      }
      if (req.method === 'POST' && p === '/api/memory') {
        const body = await readBody(req);
        if (body.clear) { memory.clear(); return json(res, 200, { ok: true, cleared: true }); }
        const added = memory.add(body.text || '');
        return json(res, 200, { ok: true, added, size: memory.size });
      }
      if (req.method === 'GET' && p === '/api/stickers') {
        const st = pipeline.caps && pipeline.caps.stickers;
        if (!st) return json(res, 503, { ok: false, error: '素材库没挂载' });
        return json(res, 200, { ok: true, ...st.list(Number(url.searchParams.get('limit')) || 60), stats: st.stats });
      }
      if (req.method === 'POST' && p === '/api/stickers/add') {
        // 手动塞一张（给"我自己攒的表情包"用）：body = {url} 或 {base64, ext}
        const st = pipeline.caps && pipeline.caps.stickers;
        if (!st) return json(res, 503, { ok: false, error: '素材库没挂载' });
        const body = await readBody(req);
        try {
          let dataUrl = '';
          if (body.base64) dataUrl = `data:image/${body.ext || 'png'};base64,${body.base64}`;
          else if (body.url) {
            const r = await fetch(body.url);
            if (!r.ok) throw new Error(`下载失败 ${r.status}`);
            dataUrl = `data:image/${body.ext || 'png'};base64,${Buffer.from(await r.arrayBuffer()).toString('base64')}`;
          } else throw new Error('缺少 url 或 base64');
          const rec = st.add({ dataUrl, ext: body.ext || '', summary: body.summary || '', tags: body.tags || [], from: '控制台' });
          log.event('sticker', `控制台手动加了张表情：${rec.file}`);
          return json(res, 200, { ok: true, record: rec });
        } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
      }
      if (req.method === 'POST' && p === '/api/stickers/import') {
        // 批量教表情：给一个文件夹，逐张看、逐张收
        const caps = pipeline.caps;
        if (!caps || !caps.importStickers) return json(res, 503, { ok: false, error: '能力层没挂载' });
        const body = await readBody(req);
        try {
          const report = await caps.importStickers(body.dir, { limit: Number(body.limit) || 300 });
          return json(res, 200, { ok: true, report });
        } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
      }
      if (req.method === 'GET' && p === '/api/mood') {
        if (!mood) return json(res, 503, { ok: false, error: '心情没挂载' });
        return json(res, 200, { ok: true, current: mood.state.current, intensity: mood.state.intensity, label: mood.label(), hint: mood.hint(), recent: mood.state.recent.slice(-10), moods: mood.MOODS });
      }
      if (req.method === 'POST' && p === '/api/mood') {
        if (!mood) return json(res, 503, { ok: false, error: '心情没挂载' });
        const body = await readBody(req);
        if (body.reset) { mood.state.current = '摸鱼'; mood.state.intensity = 0; log.event('mood', '心情被手动重置'); return json(res, 200, { ok: true, label: mood.label() }); }
        if (body.mood) { mood.bump(String(body.mood), '控制台手动设置', 2); return json(res, 200, { ok: true, label: mood.label() }); }
        return json(res, 400, { ok: false, error: '给 mood 或 reset' });
      }
      if (req.method === 'GET' && p === '/api/proactive') {
        if (!proactive) return json(res, 503, { ok: false, error: '主动发起没挂载' });
        return json(res, 200, { ok: true, ...proactive.shouldFire(), stats: proactive.stats, idleSec: Math.round((Date.now() - proactive.lastActivityAt) / 1000) });
      }
      if (req.method === 'POST' && p === '/api/proactive/once') {
        if (!proactive) return json(res, 503, { ok: false, error: '主动发起没挂载' });
        const r = await proactive.fire('控制台手动触发');
        return json(res, 200, { ok: !!r.ok, ...r });
      }
      if (req.method === 'POST' && p === '/api/say/image') {
        // 手动发一张图（本地路径或 http 直链）。顺手补的能力：以前控制台只能发文字。
        if (!transport) return json(res, 503, { ok: false, error: '通道未启动' });
        const body = await readBody(req);
        const groupId = String(body.groupId || (cfg.groups || [])[0] || '');
        if (!groupId) return json(res, 400, { ok: false, error: '没有群号' });
        let file = String(body.path || '');
        try {
          if (!file && body.url) {
            const r = await fetch(String(body.url), { signal: AbortSignal.timeout(20_000) });
            if (!r.ok) throw new Error(`下载失败 ${r.status}`);
            const dir = path.join(dataDir, 'media', 'manual');
            fs.mkdirSync(dir, { recursive: true });
            const ext = (String(body.url).match(/\.(jpg|jpeg|png|gif|webp)(\?|$)/i) || [])[1] || 'jpg';
            file = path.join(dir, `manual-${Date.now()}.${ext}`);
            fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
          }
          if (!file || !fs.existsSync(file)) throw new Error('找不到图片');
          const seg = pipeline.caps?.imageSegment?.(file);
          if (!seg) throw new Error('这张图没法转成 QQ 段（体积太大或格式不支持）');
          if (cfg.dryRun) return json(res, 200, { ok: true, dryRun: true });
          await transport.send([seg], { groupId });
          let sentText = null;
          if (body.text) { await transport.send([{ type: 'text', data: { text: String(body.text).slice(0, 300) } }], { groupId }); sentText = body.text; }
          log.event('say', `手动发图到 ${groupId}：${path.basename(file)}${sentText ? ' + 一句' : ''}`);
          return json(res, 200, { ok: true, file: path.basename(file), withText: !!sentText });
        } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
      }      if (req.method === 'POST' && p === '/api/say') {
        if (!transport) return json(res, 503, { ok: false, error: '通道未启动' });
        const body = await readBody(req);
        // 给 groupId 发群里，给 userId 发私聊（自己测多气泡就用私聊，别打扰群里）
        const userId = String(body.userId || '');
        const groupId = String(body.groupId || (userId ? '' : (cfg.groups || [])[0] || ''));
        if (!groupId && !userId) return json(res, 400, { ok: false, error: '没有群号' });
        if (!body.text) return json(res, 400, { ok: false, error: '没有内容' });
        if (cfg.dryRun) return json(res, 200, { ok: true, dryRun: true, note: '演练模式：没有真发' });
        const target = userId ? { userId } : { groupId };
        // 支持 |||：和真回话一样拆成几条，间隔 0.7~2.3 秒（手动测多气泡用）
        const pieces = splitBubbles(String(body.text).slice(0, 1500));
        for (let i = 0; i < pieces.length; i++) {
          if (i > 0) await new Promise((r) => setTimeout(r, 700 + Math.floor(Math.random() * 1600)));
          await transport.send([{ type: 'text', data: { text: pieces[i] } }], target);
        }
        log.event('say', `手动发言到 ${userId ? '私聊 ' + userId : groupId}（${pieces.length} 条）：${pieces.join(' / ').slice(0, 60)}`);
        return json(res, 200, { ok: true, count: pieces.length, pieces });
      }
      if (req.method === 'POST' && p === '/api/say/voice') {
        // 真发一条语音：验证"合成 → base64 → record 段 → NapCat → QQ"这整条链路。
        // 发到 groupId 是群里，发到 userId 是私聊（自己测就用 userId，不打扰群）。
        if (!transport) return json(res, 503, { ok: false, error: '通道未启动' });
        if (!pipeline.caps?.speak) return json(res, 503, { ok: false, error: '语音没挂载' });
        const body = await readBody(req);
        const text = String(body.text || '').trim().slice(0, 120) || '主人，我在呢。';
        const groupId = String(body.groupId || '').trim();
        const userId = String(body.userId || '').trim();
        if (!groupId && !userId) return json(res, 400, { ok: false, error: '要给 groupId 或 userId' });
        const target = groupId ? { groupId } : { userId };
        const t0 = Date.now();
        try {
          const spoken = await pipeline.caps.speak(text, { mood: '' });
          const seg = [{ type: 'record', data: { file: 'base64://' + fs.readFileSync(spoken.file).toString('base64') } }];
          if (cfg.dryRun) {
            log.event('tts', '演练模式：语音合成好了但没真发');
            return json(res, 200, { ok: true, dryRun: true, ms: Math.round(spoken.ms), engine: spoken.engine, bytes: Math.round(spoken.ms * 64) });
          }
          const result = await transport.send(seg, target);
          log.event('tts', `控制台发语音到 ${groupId || userId}：${Math.round(spoken.ms)} 毫秒 / 引擎 ${spoken.engine} / NapCat 返回 ${JSON.stringify(result).slice(0, 120)}`);
          return json(res, 200, {
            ok: true, engine: spoken.engine, ms: Math.round(spoken.ms),
            synthSec: Math.round((Date.now() - t0) / 100) / 10,
            target: groupId || userId, result
          });
        } catch (e) {
          log.event('tts', `控制台发语音失败：${e.message}`);
          return json(res, 200, { ok: false, error: e.message });
        }
      }
      if (req.method === 'POST' && p === '/api/test-model') {
        const body = await readBody(req);
        try {
          const r = await llm.chat([
            { role: 'system', content: '只回 JSON：{"ok":true,"who":"大肥鱼"}' },
            { role: 'user', content: body.text || '在吗' }
          ], { maxTokens: 400, json: true, timeoutMs: 30_000 });
          return json(res, 200, { ok: true, model: r.model, raw: r.text.slice(0, 300), usage: r.usage });
        } catch (e) {
          return json(res, 200, { ok: false, error: e.message });
        }
      }
      // ── 音色 ────────────────────────────────────────────────
      // 目标：把"用什么嗓子说话"变成可以在页面上试、可以在页面上换的事。
      //   sapi  = Windows 自带离线音色（不能克隆，只能选）
      //   local = 本地克隆引擎（GPT-SoVITS /tts），靠一段参考音频零样本克隆
      if (req.method === 'GET' && p === '/api/voices') {
        const refs = listRefs();
        return json(res, 200, {
          ok: true,
          engines: [
            { id: 'sapi', name: 'Windows 离线语音', note: '装了什么音色就能选什么，不花钱、不联网；音色是系统自带的，克隆不了' },
            { id: 'local', name: '本地克隆引擎', note: 'GPT-SoVITS（9882）或 IndexTTS 2.5（9883）都行：用参考音频零样本克隆；接口里填哪个端口就用哪个' }
          ],
          sapi: sapiVoices(),
          refs,
          current: {
            enabled: !!cfg.ttsEnabled,
            engine: cfg.ttsEngine || 'sapi',
            voice: cfg.ttsVoice || '',
            endpoint: cfg.ttsEndpoint || '',
            refAudio: cfg.ttsRefAudio || '',
            refText: cfg.ttsRefText || '',
            speed: cfg.ttsSpeed ?? 1,
            perMinute: cfg.ttsPerMinute ?? 2
          },
          health: await probeEngine(String(cfg.ttsEndpoint || ''))
        });
      }
      if (req.method === 'GET' && p === '/api/voices/file') {
        // 只允许取 data/voice 和 data/media/tts 里的 .wav，名字只认 basename —— 不让 ../ 跑出去
        const dir = url.searchParams.get('dir') === 'tts' ? path.join(dataDir, 'media', 'tts') : path.join(dataDir, 'voice');
        const name = path.basename(String(url.searchParams.get('name') || ''));
        if (!name.toLowerCase().endsWith('.wav')) return json(res, 400, { ok: false, error: '只给 .wav' });
        const full = path.join(dir, name);
        if (!fs.existsSync(full)) return json(res, 404, { ok: false, error: '没有这个文件' });
        const buf = fs.readFileSync(full);
        res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
        return res.end(buf);
      }
      if (req.method === 'POST' && p === '/api/voices/test') {
        // 试听：临时套用提交的参数合成一句，不改动已保存的配置（想留下就点保存）
        const body = await readBody(req);
        if (!pipeline.caps?.speak) return json(res, 503, { ok: false, error: '能力层没挂载' });
        const text = String(body.text || '').trim().slice(0, 120) || '主人，我在呢。';
        const keys = ['ttsEnabled', 'ttsEngine', 'ttsVoice', 'ttsEndpoint', 'ttsRefAudio', 'ttsRefText', 'ttsSpeed', 'ttsCacheEnabled'];
        const backup = {};
        for (const k of keys) backup[k] = cfg[k];
        try {
          cfg.ttsEnabled = true;
          if (body.engine !== undefined) cfg.ttsEngine = String(body.engine || 'sapi');
          if (body.voice !== undefined) cfg.ttsVoice = String(body.voice || '');
          if (body.endpoint !== undefined) cfg.ttsEndpoint = String(body.endpoint || '');
          if (body.refAudio !== undefined) cfg.ttsRefAudio = String(body.refAudio || '');
          if (body.refText !== undefined) cfg.ttsRefText = String(body.refText || '');
          if (body.speed !== undefined) cfg.ttsSpeed = Number(body.speed) || 1;
          cfg.ttsCacheEnabled = false;   // 试听不落缓存，改了参数点一下就能听出区别
          const r = await pipeline.caps.speak(text, { mood: '' });
          log.event('tts', `控制台试听：引擎=${cfg.ttsEngine} 用时=${Math.round(r.ms)}毫秒 文件=${path.basename(r.file)}`);
          return json(res, 200, { ok: true, url: `/api/voices/file?dir=tts&name=${encodeURIComponent(path.basename(r.file))}`, ms: Math.round(r.ms), engine: r.engine, text });
        } catch (e) {
          log.event('tts', `控制台试听失败（引擎=${cfg.ttsEngine}）：${e.message}`);
          return json(res, 200, { ok: false, error: e.message, engine: cfg.ttsEngine });
        } finally {
          for (const k of keys) cfg[k] = backup[k];
        }
      }
      if (req.method === 'POST' && p === '/api/voices/use') {
        // 把某个参考音频设为当前音色（同时切到本地克隆引擎）
        const body = await readBody(req);
        const name = path.basename(String(body.name || ''));
        const full = path.join(dataDir, 'voice', name);
        if (!name.toLowerCase().endsWith('.wav') || !fs.existsSync(full)) return json(res, 400, { ok: false, error: '没有这个参考音频' });
        cfg.ttsRefAudio = full;
        cfg.ttsEngine = 'local';
        if (body.text !== undefined) cfg.ttsRefText = String(body.text || '');
        if (body.endpoint) cfg.ttsEndpoint = String(body.endpoint);   // 一起把接口地址定下来，省得切过去还连错服务
        saveConfig(dataDir, cfg);
        log.event('tts', `音色切到「${name}」（本地克隆引擎）`);
        return json(res, 200, { ok: true, refAudio: cfg.ttsRefAudio, engine: cfg.ttsEngine });
      }
      if (req.method === 'POST' && p === '/api/voices/ref-text') {
        // 参考音频对应的原文：GPT-SoVITS 有它音色更像，没有也能跑但会糊一点
        const body = await readBody(req);
        const name = path.basename(String(body.name || ''));
        if (!name.toLowerCase().endsWith('.wav')) return json(res, 400, { ok: false, error: '只给 .wav' });
        const idx = readVoiceIndex();
        idx[name] = String(body.text || '').slice(0, 200);
        writeVoiceIndex(idx);
        return json(res, 200, { ok: true, name, text: idx[name] });
      }
      // ── QQ空间说说（SnowLuma 的扩展动作）────────────────────
      // 本地服务（TTS/RVC）按需启停的状态：在不在跑、闲置多久、拉过几次
      if (req.method === 'GET' && p === '/api/services') {
        if (!services) return json(res, 503, { ok: false, error: '服务管家没挂载' });
        return json(res, 200, { ok: true, onDemand: services.onDemand, services: await services.status() });
      }
      // 手动拉/关，方便排查（不常驻，按需模式才有意义）
      if (req.method === 'POST' && p === '/api/services') {
        if (!services) return json(res, 503, { ok: false, error: '服务管家没挂载' });
        const body = await readBody(req);
        const name = String(body.name || '');
        if (!services.defs[name]) return json(res, 400, { ok: false, error: '没有这个服务：' + name });
        if (body.action === 'stop') { await services.stop(name, '控制台手动'); return json(res, 200, { ok: true, stopped: true }); }
        const up = await services.ensure(name);
        return json(res, 200, { ok: !!up, up: !!up });
      }
      if (req.method === 'GET' && p === '/api/qzone') {
        if (!qzone) return json(res, 503, { ok: false, error: '空间模块没挂载' });
        const n = Math.min(30, Number(url.searchParams.get('n')) || 10);
        // 线上真实列表 + 本地发过的记录都给：线上拿不到（比如网关不支持）也还有本地留档
        let live = null;
        let error = '';
        try { live = await qzone.list(n); } catch (e) { error = e.message; }
        return json(res, 200, { ok: true, enabled: cfg.qzoneDiaryEnabled === true, ugcRight: Number(cfg.qzoneUgcRight) || 1, local: qzone.history(n), live, error, stats: qzone.stats });
      }
      if (req.method === 'POST' && p === '/api/qzone') {
        if (!qzone) return json(res, 503, { ok: false, error: '空间模块没挂载' });
        const body = await readBody(req);
        try {
          const r = await qzone.publish(body.content ?? body.text ?? '', { ugcRight: body.ugcRight });
          return json(res, 200, { ok: true, ...r });
        } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
      }
      if (req.method === 'POST' && p === '/api/qzone/delete') {
        if (!qzone) return json(res, 503, { ok: false, error: '空间模块没挂载' });
        const body = await readBody(req);
        try { await qzone.del(body.tid); return json(res, 200, { ok: true }); }
        catch (e) { return json(res, 400, { ok: false, error: e.message }); }
      }
      // 改一条说说的可见范围：原地改（不删了重发，时间和评论都留着）
      if (req.method === 'POST' && p === '/api/qzone/right') {
        if (!qzone) return json(res, 503, { ok: false, error: '空间模块没挂载' });
        const body = await readBody(req);
        try {
          const r = await qzone.setRight(body.tid, body.ugcRight ?? body.ugc_right);
          // saveDefault：顺便把"以后默认发多少"也改掉（不然只改这一条，下次又变回去）
          if (body.saveDefault === true) {
            cfg.qzoneUgcRight = r.ugcRight;
            saveConfig(dataDir, cfg);
            log.event('config', `说说的默认可见范围改为 ${r.ugcRight}（${r.label}）`);
          }
          return json(res, 200, { ok: true, ...r });
        } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
      }
      // ── 日记 ────────────────────────────────────────────────
      if (req.method === 'GET' && p === '/api/diary') {
        if (!diary) return json(res, 503, { ok: false, error: '日记没挂载' });
        const n = Math.min(60, Number(url.searchParams.get('n')) || 10);
        return json(res, 200, { ok: true, stats: diary.stats(), entries: diary.recent(n), context: diary.context(), enabled: cfg.diaryEnabled !== false, hour: cfg.diaryHour, qzone: cfg.qzoneDiaryEnabled === true });
      }
      if (req.method === 'POST' && p === '/api/diary') {
        if (!diary) return json(res, 503, { ok: false, error: '日记没挂载' });
        const body = await readBody(req);
        try {
          // {write:true, hint} = 让她现在自己写一条；否则是手动记一条
          if (body.write) {
            const row = await diary.composeAndAdd({ roleText: persona.load(), memoryText: memory.topK().map((m) => '- ' + m.text).join('\n'), hint: String(body.hint || '') });
            return json(res, 200, { ok: true, entry: row });
          }
          const row = diary.add({ text: body.text || '', title: body.title || '', mood: body.mood || '', tags: body.tags || [] });
          return json(res, 200, { ok: true, entry: row });
        } catch (e) {
          return json(res, 400, { ok: false, error: e.message });
        }
      }
      // ── 按人记账 ────────────────────────────────────────────
      if (req.method === 'GET' && p === '/api/people') {
        if (!people) return json(res, 503, { ok: false, error: '按人记账没挂载' });
        return json(res, 200, { ok: true, enabled: cfg.peopleEnabled !== false, people: people.list(Number(url.searchParams.get('limit')) || 50) });
      }
      if (req.method === 'POST' && p === '/api/people') {
        if (!people) return json(res, 503, { ok: false, error: '按人记账没挂载' });
        const body = await readBody(req);
        const id = String(body.id || '').trim();
        if (!id) return json(res, 400, { ok: false, error: '要给 id（QQ 号）' });
        try {
          if (body.forget) { const ok = people.forget(id); return json(res, 200, { ok: true, removed: ok }); }
          const p = people.remember(id, { name: body.name || '', trait: body.trait || '', fact: body.fact || '', topic: body.topic || '', pending: body.pending || '' });
          log.event('people', `手动记了 ${body.name || id} 的一条账`);
          return json(res, 200, { ok: true, person: p });
        } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
      }
      // ── 唱真歌（Demucs + RVC）──────────────────────────────
      if (req.method === 'GET' && p === '/api/songs') {
        if (!song) return json(res, 503, { ok: false, error: '唱真歌模块没挂载' });
        return json(res, 200, { ok: true, enabled: cfg.songSingEnabled !== false, dir: song.dirs, list: song.list(), stats: song.stats });
      }
      if (req.method === 'POST' && p === '/api/songs') {
        if (!song) return json(res, 503, { ok: false, error: '唱真歌模块没挂载' });
        const body = await readBody(req);
        try {
          const qq = String(body.qq || '').trim();
          const bili = String(body.bili || '').trim();
          const secs = Number(body.seconds) || 40;
          const r = bili ? await song.singBili({ text: bili, seconds: secs, accomp: body.accomp !== false })
            : qq ? await song.singQq({ text: qq })
            : await song.singSong({ name: String(body.name || body.file || '') });
          return json(res, 200, {
            ok: true, ...r,
            url: '/api/voices/file?dir=tts&name=' + encodeURIComponent(path.basename(r.file))
          });
        } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
      }      // ── 唱歌 ──────────────────────────────────────────────
      if (req.method === 'POST' && p === '/api/sing') {
        if (!sing) return json(res, 503, { ok: false, error: '唱歌模块没挂载' });
        const body = await readBody(req);
        try {
          const r = await sing.sing({ text: String(body.text || ''), tune: body.tune || '小星星', base: Number(body.base) || 0 });
          return json(res, 200, { ok: true, ...r, url: `/api/voices/file?dir=tts&name=${encodeURIComponent(path.basename(r.file))}` });
        } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
      }      // ── QQ音乐 ────────────────────────────────────────────
      if (req.method === 'GET' && p === '/api/qqmusic') {
        return json(res, 200, { ok: true, enabled: cfg.qqMusicEnabled !== false, stats: qqMusic ? qqMusic.stats : null });
      }
      if (req.method === 'POST' && p === '/api/qqmusic') {
        if (!qqMusic) return json(res, 503, { ok: false, error: 'QQ音乐模块没挂载' });
        const body = await readBody(req);
        try {
          const r = await qqMusic.doOp(String(body.op || 'search'), body);
          return json(res, 200, { ok: true, ...r });
        } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
      }      // ── 网易云音乐 ─────────────────────────────────────────
      if (req.method === 'GET' && p === '/api/ncm') {
        if (!ncm) return json(res, 503, { ok: false, error: '网易云模块没挂载' });
        const h = await ncm.health();
        return json(res, 200, { ok: true, enabled: cfg.ncmEnabled !== false, port: ncm.port, client: h, stats: ncm.stats });
      }
      if (req.method === 'POST' && p === '/api/ncm') {
        if (!ncm) return json(res, 503, { ok: false, error: '网易云模块没挂载' });
        const body = await readBody(req);
        try {
          const r = await ncm.doOp(String(body.op || 'search'), body);
          return json(res, 200, { ok: true, ...r });
        } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
      }      // ── 联网搜索（让它自己查事实）──────────────────────────
      if (req.method === 'GET' && p === '/api/search') {
        return json(res, 200, {
          ok: true,
          enabled: cfg.webSearchEnabled !== false,
          engine: cfg.webSearchEngine || 'bing',
          fallback: cfg.webSearchFallback !== false,
          topK: cfg.webSearchTopK,
          netEnabled: cfg.netEnabled !== false,
          stats: webSearch ? webSearch.stats : null
        });
      }
      if (req.method === 'POST' && p === '/api/search') {
        if (!webSearch) return json(res, 503, { ok: false, error: '搜索模块没挂载' });
        const body = await readBody(req);
        const r = await webSearch.search(String(body.q || body.query || ''));
        return json(res, 200, { ok: r.ok, ...r, block: webSearch.render(r, 900) });
      }
      if (req.method === 'GET' && p === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        res.write(`retry: 3000\n\n`);
        for (const ev of log.list(50)) res.write(`data: ${JSON.stringify(ev)}\n\n`);
        const off = log.subscribe((ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`));
        const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
        req.on('close', () => { off(); clearInterval(ping); });
        return;
      }
      json(res, 404, { ok: false, error: `没有这个接口：${p}` });
    } catch (e) {
      json(res, 500, { ok: false, error: e.message });
    }
  });

  function capsStats() { return pipeline.caps?.stats || {}; }

  function listen() {
    return new Promise((resolve) => {
      let tries = 0;
      const attempt = () => {
        server.listen(portState.port, '127.0.0.1', () => {
          if (tries > 0) { portState.fallback = true; log.event('console', `端口被占，已改用 ${portState.port}`); }
          log.event('console', `控制台：http://127.0.0.1:${portState.port}/`);
          resolve(portState.port);
        }).on('error', (e) => {
          if (e.code === 'EADDRINUSE' && tries < 10) { tries += 1; portState.port += 1; attempt(); }
          else { log.event('console', `控制台启动失败：${e.message}`); resolve(0); }
        });
      };
      attempt();
    });
  }

  return { server, listen, state: portState };
}
