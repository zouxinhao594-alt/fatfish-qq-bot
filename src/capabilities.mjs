// 能力插槽：输入侧 enrich（把非文本变成文本）+ 输出侧 act（把意图变成副作用）。
// 这一层就是"以后加功能不用动主流程"的地方。

import path from 'node:path';
import { createTts } from './tts.mjs';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { ensureDir, sha256, walkFiles } from './store.mjs';
import { createNet } from './net.mjs';
import { createScreenshot } from './screenshot.mjs';
import { createStickers } from './stickers.mjs';

/** 起外部进程并等退出；stdio 用 ignore（沙箱里管道会被拒，也不需要抓输出）。 */
function runQuiet(file, args, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const child = spawn(file, args, { stdio: 'ignore', windowsHide: true });
    const timer = setTimeout(() => { if (!done) { try { child.kill(); } catch { /* ignore */ } resolve({ timeout: true }); } }, timeoutMs);
    child.on('error', (e) => { if (!done) { done = true; clearTimeout(timer); resolve({ error: e.message }); } });
    child.on('close', (code) => { if (!done) { done = true; clearTimeout(timer); resolve({ code }); } });
  });
}

export function createCapabilities({ cfg, llm, log, dataDir, fetchImpl = globalThis.fetch, onebot = null, ffprobePath = '', services = null }) {
  const mediaDir = ensureDir(path.join(dataDir, 'media'));
  const genDir = ensureDir(path.join(mediaDir, 'gen'));
  const ttsDir = ensureDir(path.join(mediaDir, 'tts'));
  const net = createNet({ cfg, log, fetchImpl });
  const shot = createScreenshot({ cfg, log, dataDir });
  const stickers = createStickers({ cfg, dataDir, log, ffprobePath });
  const descCacheFile = path.join(mediaDir, 'vision-cache.json');
  let descCache = {};
  try { descCache = JSON.parse(fs.readFileSync(descCacheFile, 'utf8')); } catch { descCache = {}; }
  const seenAt = new Map();
  const stats = { described: 0, cached: 0, skipped: 0, drawn: 0, spoken: 0, genDay: { day: '', n: 0 } };
  // 把子能力的计数挂到同一个对象上（控制台一次就能读全）
  stats.net = net.stats;
  stats.shot = shot.stats;
  stats.stickers = stickers.stats;

  function persistCache() { try { fs.writeFileSync(descCacheFile, JSON.stringify(descCache, null, 2)); } catch { /* ignore */ } }

  function budgetOk() {
    const day = new Date().toISOString().slice(0, 10);
    if (stats.genDay.day !== day) stats.genDay = { day, n: 0 };
    const limit = Number(cfg.genDailyLimit) || 0;
    return !limit || stats.genDay.n < limit;
  }

  /**
   * 把 QQ 给的图片地址变成视觉接口能吃的东西。
   * NapCat 一般给 http(s) 的 url，但也可能给本地路径；而把远端 URL 直接丢给模型接口
   * 不可靠（有的网关不代抓），所以统一：能下载就下载，转成 data URL 再发。
   */
  /** 找 ffmpeg：配置优先 → 常见安装位置 → PATH 里的 ffmpeg。 */
  function findFfmpeg() {
    const cands = [cfg.ffmpegPath, 'C:\\ffmpeg\\bin\\ffmpeg.exe'];
    for (const c of cands) if (c && fs.existsSync(c)) return c;
    return 'ffmpeg';
  }

  /**
   * 动图/超大图先规范化成 PNG：
   *   - QQ 表情包大量是 GIF/WebP 动图，视觉接口读动图经常直接返回空内容
   *   - 太大的图也会让 reasoning token 爆掉；统一缩到 1024 宽
   */
  async function normalizeForVision(dataUrl) {
    const m = /^data:([^;]+);base64,/.exec(dataUrl);
    if (!m) return { dataUrl, mime: '', converted: false };
    const mime = m[1].toLowerCase();
    const b64 = dataUrl.slice(m[0].length);
    const tmpDir = ensureDir(path.join(mediaDir, 'tmp'));
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const srcExt = /gif/.test(mime) ? 'gif' : /webp/.test(mime) ? 'webp' : /jpe?g/.test(mime) ? 'jpg' : 'png';
    const inp = path.join(tmpDir, `in-${stamp}.${srcExt}`);
    const out = path.join(tmpDir, `out-${stamp}.png`);
    let dims = null;
    try {
      fs.writeFileSync(inp, Buffer.from(b64, 'base64'));
      // 用 ffprobe 看真实像素：只按体积判断会漏掉"体积小但像素巨大"的图
      try { dims = stickers.probeSizeSync(inp); } catch { dims = null; }
      const maxSide = Math.max(dims ? dims.width : 0, dims ? dims.height : 0);
      const sideLimit = Number(cfg.visionMaxSide) || 1280;
      const needConvert = /gif|webp|bmp|tiff/.test(mime) || b64.length > 1_600_000 || (dims && maxSide > sideLimit);
      if (!needConvert) return { dataUrl, mime, converted: false, dims };

      const r = await runQuiet(findFfmpeg(), ['-y', '-loglevel', 'error', '-i', inp, '-frames:v', '1', '-vf', `scale='min(${sideLimit},iw)':-2`, out], 25_000);
      if (fs.existsSync(out) && fs.statSync(out).size > 500) {
        const png = `data:image/png;base64,${fs.readFileSync(out).toString('base64')}`;
        log?.event('vision', `图已规范化（${srcExt}${dims ? ' ' + dims.width + '×' + dims.height : ''} → png ${Math.round(fs.statSync(out).size / 1024)}KB）`);
        return { dataUrl: png, mime: 'image/png', converted: true, dims };
      }
      return { dataUrl, mime, converted: false, dims, error: r && r.error ? r.error : '转换没产出文件' };
    } catch (e) {
      return { dataUrl, mime, converted: false, dims, error: e.message };
    } finally {
      try { fs.unlinkSync(inp); } catch { /* ignore */ }
      try { fs.unlinkSync(out); } catch { /* ignore */ }
    }
  }

  /** 把失败的图存下来，方便事后复现（最多留 20 张）。 */
  function saveFailure(dataUrl, why) {
    try {
      const dir = ensureDir(path.join(mediaDir, 'vision-fail'));
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.png') || f.endsWith('.img'));
      while (files.length >= 20) { try { fs.unlinkSync(path.join(dir, files.shift())); } catch { /* ignore */ } }
      const m = /^data:([^;]+);base64,/.exec(dataUrl);
      const ext = m && /gif/.test(m[1]) ? 'gif' : m && /webp/.test(m[1]) ? 'webp' : m && /jpe?g/.test(m[1]) ? 'jpg' : 'png';
      const file = path.join(dir, `${Date.now()}-${sha256(dataUrl).slice(0, 8)}.${ext}`);
      fs.writeFileSync(file, Buffer.from(dataUrl.slice(m ? m[0].length : 0), 'base64'));
      log?.event('vision', `失败的图已存：data/media/vision-fail/${path.basename(file)}（${why}）`);
      return file;
    } catch { return ''; }
  }

  async function imageToDataUrl(src) {
    const s = String(src || '').trim();
    if (!s) return '';
    if (s.startsWith('data:')) return s;
    const maxBytes = Number(cfg.visionMaxBytes) || 8_000_000;
    if (/^https?:\/\//i.test(s)) {
      const res = await fetchImpl(s, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`下载图片失败：${res.status}`);
      const type = String(res.headers?.get?.('content-type') || 'image/png').split(';')[0];
      if (!/^image\//i.test(type)) throw new Error(`这个链接不是图片（${type}）`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > maxBytes) throw new Error('图片太大');
      return `data:${type};base64,${buf.toString('base64')}`;
    }
    // 本地路径（可能是 file:///D:/... 或 D:\...）
    const local = s.replace(/^file:\/\/+\/?/i, '');
    const p = path.normalize(local);
    if (fs.existsSync(p)) {
      const st = fs.statSync(p);
      if (st.size > maxBytes) throw new Error('图片太大');
      const ext = path.extname(p).toLowerCase();
      const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : 'image/jpeg';
      return `data:${mime};base64,${fs.readFileSync(p).toString('base64')}`;
    }
    // 最后一招：让 NapCat 自己把图吐出来（它本地有缓存，segment 里的 file 字段就够）
    if (onebot?.call) {
      const r = await onebot.call('get_image', { file: s }, 12_000).catch(() => null);
      const b64 = r && (r.base64 || r.data);
      if (b64) return `data:${(r && r.mime) || 'image/png'};base64,${String(b64).replace(/^data:[^,]+,/, '')}`;
      if (r && r.file) {
        const p2 = path.normalize(String(r.file).replace(/^file:\/\/+\/?/i, ''));
        if (fs.existsSync(p2)) {
          const ext = path.extname(p2).toLowerCase();
          const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : 'image/jpeg';
          return `data:${mime};base64,${fs.readFileSync(p2).toString('base64')}`;
        }
      }
    }
    throw new Error('找不到本地图片文件（也没有 get_image 兜底）');
  }

  /**
   * 批量"教"表情：给一个文件夹，逐张看、逐张收。
   * 看得懂 → 描述当标签；看不懂 → 先收下挂空标签（以后同图能看懂时会补上）。
   */
  async function importStickers(dirPath, { limit = 300, trustUser = true } = {}) {
    const dir = path.resolve(dirPath);
    if (!fs.existsSync(dir)) throw new Error(`目录不存在：${dir}`);
    const files = walkFiles(dir, ['.png', '.jpg', '.jpeg', '.gif', '.webp']).slice(0, limit);
    const report = { dir, total: files.length, added: 0, duplicate: 0, untagged: 0, failed: 0, items: [] };
    for (const f of files) {
      try {
        const ext = path.extname(f).replace('.', '').toLowerCase();
        const st = fs.statSync(f);
        // 批量导入是用户明确点名要的：只拦离谱的大文件，不再套用「照片不算表情」的启发式
        const bigLimit = (Number(cfg.stickerCollectMaxKB) || 4096) * 1024 * 4;
        if (st.size > bigLimit) { report.failed += 1; report.items.push({ file: path.basename(f), ok: false, why: '文件太大（' + Math.round(st.size / 1024) + 'KB）' }); continue; }
        if (!trustUser) {
          const look = stickers.looksLikeSticker({ ext, bytes: st.size, summary: '', size: stickers.probeSizeSync(f) });
          if (!look.ok) { report.failed += 1; report.items.push({ file: path.basename(f), ok: false, why: look.why }); continue; }
        }
        const dataUrl = `data:image/${ext === 'jpg' ? 'jpeg' : ext};base64,${fs.readFileSync(f).toString('base64')}`;
        let tag = { desc: '', emotion: [], usage: [], caption: '' };
        try { tag = await llm.tagSticker(dataUrl); }
        catch (e) { log?.event('sticker', `导入时看不懂这张（先收下）：${path.basename(f)} — ${e.message}`); }
        const desc = tag.desc || '';
        const rec = stickers.add({
          file: f, ext, summary: tag.caption || '',
          description: desc, emotion: tag.emotion, usage: tag.usage,
          tags: [], from: '批量导入', source: 'import'
        });
        if (rec.duplicate) report.duplicate += 1;
        else if (desc) report.added += 1;
        else report.untagged += 1;
        report.items.push({ file: path.basename(f), ok: true, duplicate: !!rec.duplicate, tagged: !!desc });
      } catch (e) {
        report.failed += 1;
        report.items.push({ file: path.basename(f), ok: false, why: e.message });
      }
    }
    log?.event('sticker', `批量导入完成：新增 ${report.added}、重复 ${report.duplicate}、没描述 ${report.untagged}、跳过 ${report.failed}（共 ${report.total}）`);
    return report;
  }

  /**
   * 智能挑表情：先按语境粗筛 8 张候选，再让模型挑一张贴切的。
   * 两步走是因为直接把 100 张塞进上下文太贵；只靠关键词又挑不准。
   */
  async function chooseSticker({ query, recent = [], reply = '', mood = '' }) {
    if (!cfg.stickersEnabled) return null;
    const all = stickers.digest({ max: 150 });
    if (!all.length) return null;
    // 库里不多就整库给模型看（一行约 30 字，100 行也才 3K 字符）；
    // 太多就先按语境粗筛 60 张，避免上下文爆炸。
    const candidates = all.length <= 120 ? all : stickers.pickCandidates(query, 60);
    const lines = [];
    if (recent.length) {
      lines.push('最近群里说：');
      for (const r of recent.slice(-3)) lines.push(`${r.nickname}：${r.text}`);
    }
    if (mood) lines.push(`它现在的心情：${mood}`);
    if (reply) lines.push(`它准备回：${reply}`);
    const context = lines.join('\n') || query;
    try {
      const r = await llm.chooseSticker({ context, candidates });
      if (!r.pick) { log?.event('sticker', `模型决定不配图：${r.why || '都不太贴'}`); return null; }
      stickers.markSent(r.pick.hash);
      log?.event('sticker', `配图：${r.pick.name}（${r.why || '模型挑的'}）`);
      return r.pick;
    } catch (e) {
      // 模型挑失败就退回关键词匹配，别因为一次失败就不发
      log?.event('sticker', `模型挑图失败，退回关键词：${e.message}`);
      const p = stickers.pick(query);
      return p ? { file: p.file, name: path.basename(p.file) } : null;
    }
  }

  /**
   * 图片段：用 base64:// 而不是 file:///
   * NapCat 收到 "file:///D:/..." 只取文件名，然后去它自己的工作目录下找 → ENOENT：
   *   OneBot 返回失败：1200 ENOENT ... open '<网关的工作目录>\xxx.webp'
   * base64:// 是 OneBot11 标准写法，跨实现最稳；只有超过上限才退回路径。
   */
  function resolveStickerPath(file) {
    const p = String(file || '');
    if (p && fs.existsSync(p)) return p;
    // 挑图那边有时只给文件名，兜底到素材库目录找（否则 NapCat 会去它自己目录找 → ENOENT）
    try {
      const alt = path.join(stickers.dir(), path.basename(p));
      if (fs.existsSync(alt)) return alt;
    } catch { /* ignore */ }
    return p;
  }

  function imageSegment(file) {
    try {
      const p = resolveStickerPath(file);
      const buf = fs.readFileSync(p);
      const maxKB = Number(cfg.outboundImageMaxKB) || 4096;
      if (buf.length > maxKB * 1024) { log?.event('sticker', '图片超过内联上限，跳过配图'); return null; }
      return { type: 'image', data: { file: 'base64://' + buf.toString('base64') } };
    } catch (e) {
      log?.event('sticker', '读图失败（发不出去）：' + e.message);
      return null;
    }
  }

  function stickerSegment(picked) {
    if (!picked) return null;
    return imageSegment(picked.file);
  }

  /** 输入侧：把图片变成文字描述（有缓存，按分钟限流）。 */
  async function enrich(msg) {
    const notes = [];
    // 商店表情（mface）拿不到图，但知道名字就能描述个大概
    if (msg.faces?.length) notes.push(`（对方发的是 QQ 表情：${msg.faces.slice(0, 3).join('、')}）`);
    if (!msg.images?.length) return notes;
    if (!cfg.visionEnabled) { stats.skipped += msg.images.length; return notes; }
    const perMin = Number(cfg.visionPerMinute) || 3;
    const now = Date.now();
    // 最多看 4 张（群里一次发一串图很常见）
    for (let i = 0; i < Math.min(4, msg.images.length); i++) {
      const src = msg.images[i];
      const alts = (msg.imageAlternates && msg.imageAlternates[i]) || [];
      if (!String(src || '').trim()) {
        stats.skipped += 1;
        notes.push('（这张图没拿到（网关没给地址），程序没看）');
        log?.event('vision', '这张跳过：NapCat 没给 url/file，拿不到图');
        continue;
      }
      // 同一张图通常有 url 和 file 两种来源：一个拿不到/看不懂就换另一个
      const candidates = [src, ...alts.filter((a) => a && a !== src)];
      let dataUrl = '';
      let lastErr = '';
      for (const c of candidates) {
        try { dataUrl = await imageToDataUrl(c); lastErr = ''; break; }
        catch (e) { lastErr = e.message; }
      }
      if (!dataUrl) {
        stats.skipped += 1;
        notes.push('（这张图没取到，程序没看）');
        log?.event('vision', `图片取不到（不影响回话）：${lastErr} ← ${String(src).slice(0, 80)}`);
        continue;
      }
      const key = sha256(dataUrl);
      if (descCache[key]) { notes.push(descCache[key]); stats.cached += 1; log?.event('vision', `用缓存的描述：${descCache[key].slice(0, 40)}`); continue; }
      const window = [...seenAt.values()].filter((t) => now - t < 60_000);
      if (window.length >= perMin) {
        stats.skipped += 1;
        // 留一句"为什么没看"，别让模型自己编"图糊了/看不清"
        notes.push('（这张图没看：一分钟内看太多张了）');
        log?.event('vision', `这张跳过：一分钟内已经看了 ${window.length} 张（上限 ${perMin}，可在设置里调 visionPerMinute）`);
        continue;
      }
      try {
        // 动图/超大图先规范化成 PNG（QQ 表情包大量是 GIF，视觉接口读动图常常直接返回空）
        const norm = await normalizeForVision(dataUrl);
        const attempts = [];
        if (norm.dataUrl) attempts.push({ label: norm.converted ? '转 PNG 后' : '原图', url: norm.dataUrl });
        if (norm.error) attempts.push({ label: '原图', url: dataUrl });
        if (/^https?:\/\//i.test(src)) attempts.push({ label: '直接给接口抓', url: src });

        let text = '';
        let lastErr = '';
        for (const a of attempts) {
          try {
            text = await llm.describeImage(a.url, { model: cfg.visionModel || cfg.model });
            if (String(text || '').trim()) { log?.event('vision', `看图成功（${a.label}）`); break; }
          } catch (e) { lastErr = `${a.label}：${e.message}`; }
        }
        if (!String(text || '').trim()) throw new Error(lastErr || '视觉接口返回空内容');

        const one = String(text).slice(0, Number(cfg.visionMaxChars) || 400);
        notes.push(one);
        descCache[key] = one;
        seenAt.set(key, now);
        stats.described += 1;
        persistCache();
        log?.event('vision', `看图：${one.slice(0, 80)}`);

        // 学会这张表情：像表情才收，描述当标签（下次能按话题挑出来）
        if (cfg.stickerCollectEnabled !== false) {
          let tmp = '';
          try {
            const m = /^data:([^;]+);base64,/.exec(dataUrl) || [];
            const mime = String(m[1] || 'image/png').toLowerCase();
            const ext = mime.includes('gif') ? 'gif' : mime.includes('webp') ? 'webp' : mime.includes('jpeg') ? 'jpg' : 'png';
            const tmpDir = ensureDir(path.join(mediaDir, 'tmp'));
            tmp = path.join(tmpDir, `learn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.${ext}`);
            fs.writeFileSync(tmp, Buffer.from(dataUrl.slice(m[0] ? m[0].length : 0), 'base64'));
            const summary = (msg.imageMeta && msg.imageMeta[i] && msg.imageMeta[i].summary) || '';
            const learned = stickers.learn({ tmpFile: tmp, ext, summary, description: one, from: msg.nickname || '' });
            if (!learned.saved) log?.event('sticker', `这张没进素材库：${learned.why}`);
          } catch (e) {
            log?.event('sticker', `收表情失败（不影响回话）：${e.message}`);
          } finally {
            if (tmp) { try { fs.unlinkSync(tmp); } catch { /* ignore */ } }
          }
        }
      } catch (e) {
        stats.skipped += 1;
        notes.push('（这张图看了但没看懂，别再反复提它）');
        const saved = saveFailure(dataUrl, e.message);
        log?.event('vision', `看图失败（不影响回话）：${e.message}${saved ? '（已存下来方便复现）' : ''}`);
      }
    }
    return notes;
  }

  /** 生图：OpenAI images 兼容接口，落盘后返回本地文件。 */
  async function draw(prompt) {
    if (!cfg.genEnabled) throw new Error('生图没开');
    if (!budgetOk()) throw new Error('今天的画图额度用完了');
    if (!cfg.genBaseUrl) throw new Error('没配生图接口');
    const url = String(cfg.genBaseUrl).replace(/\/+$/, '') + '/images/generations';
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.genApiKey || cfg.apiKey}` },
      body: JSON.stringify({ model: cfg.genModel || undefined, prompt: String(prompt).slice(0, 800), size: cfg.genSize, n: 1, response_format: 'b64_json' }),
      signal: AbortSignal.timeout((Number(cfg.genTimeoutSecs) || 60) * 1000)
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`生图接口 ${res.status}：${text.slice(0, 160)}`);
    let data;
    try { data = JSON.parse(text); } catch { throw new Error('生图接口返回不是 JSON'); }
    const item = data?.data?.[0];
    const file = path.join(genDir, `gen-${Date.now()}.png`);
    if (item?.b64_json) fs.writeFileSync(file, Buffer.from(item.b64_json, 'base64'));
    else if (item?.url) {
      const img = await fetchImpl(item.url, { signal: AbortSignal.timeout(60_000) });
      if (!img.ok) throw new Error('下载生成的图片失败');
      fs.writeFileSync(file, Buffer.from(await img.arrayBuffer()));
    } else throw new Error('生图接口没返回图片');
    stats.genDay.n += 1;
    stats.drawn += 1;
    log?.event('gen', `画好了：${path.basename(file)}`);
    return file;
  }

  const tts = createTts({ cfg, dir: ttsDir, log, fetchImpl, ensureEngine: services ? () => services.ensure('tts') : null });
  const voiceWindows = new Map();
  async function speak(text, options = {}) {
    const result = await tts.speak(text, options);
    stats.spoken += 1;
    return result;
  }
  function reserveVoice(msg) {
    const now = Date.now();
    for (const [key, times] of voiceWindows) {
      const active = times.filter(t => now - t < 60000);
      if (active.length) voiceWindows.set(key, active); else voiceWindows.delete(key);
    }
    const key = msg.groupId ? 'group:' + msg.groupId : 'user:' + msg.userId;
    const times = voiceWindows.get(key) || [];
    const raw = Number(cfg.ttsPerMinute ?? 2);
    const limit = Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 2;
    if (times.length >= limit) { log?.event('tts', '语音限流，保留文字'); return false; }
    times.push(now); voiceWindows.set(key, times);
    return true;
  }

  /** 联网抓取：第一遍模型提议 fetch，程序代抓，正文回灌后再想一次。 */
  async function fetchUrl(url) {
    if (!cfg.netEnabled) return { ok: false, error: '联网没开' };
    return net.fetchText(url);
  }

  /** 网页截图 + 视觉描述。 */
  async function shotDescribe(url) {
    if (!cfg.shotEnabled) return { ok: false, error: '截图没开' };
    return shot.captureAndDescribe(url, llm);
  }

  /** 挑一张表情：模型只说"想要"，挑哪张由程序决定（省一次视觉调用）。 */
  function sticker(query) {
    if (!cfg.stickersEnabled) return null;
    const picked = stickers.pick(query);
    if (!picked) return null;
    log?.event('sticker', `配图：${path.basename(picked.file)}${picked.matched ? '（按内容匹配）' : '（随机）'}`);
    return stickers.toSegment(picked);
  }

  /** 输出侧：模型提议的 action → 副作用。返回要补发的段（可能为空）。 */
  async function act(reply, msg, context = {}) {
    const out = [];
    if (reply.action?.draw && cfg.genEnabled) {
      try {
        const file = await draw(reply.action.prompt || msg.text);
        const seg = imageSegment(file);
        if (seg) out.push([seg]);
      } catch (e) {
        log?.event('gen', `画不出来：${e.message}`);
        out.push([{ type: 'text', data: { text: '这张我画不出来，换个说法试试呀' } }]);
      }
    }
    if (reply.voice && cfg.ttsEnabled && reserveVoice(msg)) {
      try {
        const result = await speak(reply.segments.join(' '), { mood: cfg.moodEnabled === false ? '' : (reply.mood && String(context.mood || '').startsWith(reply.mood + '（') ? context.mood : (reply.mood || context.mood || '')) });
        try {
          const file = 'base64://' + fs.readFileSync(result.file).toString('base64');
          out.push([{ type: 'record', data: { file } }]);
        } finally {
          if (cfg.ttsCacheEnabled === false && cfg.ttsKeepFiles === false)
            fs.rmSync(result.file, { force: true });
        }
      } catch (e) {
        log?.event('tts', `语音失败（照常发文字）：${e.message}`);
      }
    }
    return out;
  }

  /**
   * 整条改用语音发：语音自动化（[语音] 前缀 / voiceChance）走的入口。
   * 成功返回 record 段，失败返回 null —— 调用方必须退回文字，不能把消息吞掉。
   */
  async function voiceSegment(text, msg, options = {}) {
    const say = String(text || '').trim();
    if (!say || !cfg.ttsEnabled) return null;
    if (!reserveVoice(msg || {})) return null;
    try {
      const result = await speak(say, options);
      const file = 'base64://' + fs.readFileSync(result.file).toString('base64');
      if (cfg.ttsCacheEnabled === false && cfg.ttsKeepFiles === false) fs.rmSync(result.file, { force: true });
      log?.event('tts', `整条改成语音发（${say.length} 字）`);
      return [{ type: 'record', data: { file } }];
    } catch (e) {
      log?.event('tts', `语音没出来，照常发文字：${e.message}`);
      return null;
    }
  }

  return {
    enrich, act, draw, speak, voiceSegment, fetchUrl, shotDescribe, sticker, importStickers, chooseSticker, stickerSegment,
    imageSegment,   // 本地图片 → 出站图片段（生图/表情都用它才发得出去）
    net, shot, stickers,
    // 注意返回的是同一个 stats 对象（不是拷贝）：控制台要和这里看到实时数字
    stats,
    dirs: { mediaDir, genDir, ttsDir }
  };
}
