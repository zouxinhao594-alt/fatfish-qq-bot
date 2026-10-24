// 表情包素材库：看、学、发。
//
// 「学会自己存表情包」= 三步：
//   1. 看：群里有人发表情，用视觉模型描述一遍（识图那条链路）
//   2. 学：把图和描述一起存进素材库，描述当标签 —— 以后就能按含义挑
//   3. 发：模型说"想配张图"时，用当前话题去匹配标签挑一张发出去
//
// 只存"像表情"的：GIF/WebP 一律收；图片尺寸小（长边 ≤ 800）也收；
// 大照片、长截图不收（那是内容，不是表情）。这一点很重要，否则素材库很快变成垃圾场。

import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { walkFiles, sha256, ensureDir, readJsonSafe, writeJsonAtomic } from './store.mjs';

const EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];
const INDEX = '.index.json';

function runQuiet(file, args, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const child = spawn(file, args, { stdio: 'ignore', windowsHide: true });
    const timer = setTimeout(() => { if (!done) { try { child.kill(); } catch { /* ignore */ } resolve({ timeout: true }); } }, timeoutMs);
    child.on('error', (e) => { if (!done) { done = true; clearTimeout(timer); resolve({ error: e.message }); } });
    child.on('close', (code) => { if (!done) { done = true; clearTimeout(timer); resolve({ code }); } });
  });
}

/** 中文/英文都吃的"像不像两个字"打分：给挑图用。 */
function grams(text) {
  const s = String(text || '').toLowerCase();
  const out = new Set();
  for (const w of s.replace(/[^\u4e00-\u9fa5a-z0-9]+/g, ' ').split(/\s+/)) if (/^[a-z0-9]{2,}$/.test(w)) out.add(w);
  const zh = s.replace(/[^\u4e00-\u9fa5]/g, '');
  for (let i = 0; i + 1 < zh.length; i++) out.add(zh.slice(i, i + 2));
  return out;
}

/** 把一段视觉描述压成几个短标签（短标签的检中率比整段描述高得多）。 */
function shortTags(desc) {
  const out = [];
  for (const part of String(desc || '').split(/[，。、；;,．\n]/)) {
    const t = part.replace(/^\s*(画面|整体|图中|图片|主体|风格|内容|文字)[:：]?\s*/, '').trim();
    if (!t) continue;
    out.push(t.length > 12 ? t.slice(0, 12) : t);
  }
  return [...new Set(out)].slice(0, 6);
}

export function createStickers({ cfg, dataDir, log, ffprobePath = '' }) {
  const dir = () => (cfg.stickersDir ? path.resolve(cfg.stickersDir) : path.join(dataDir, 'stickers'));
  const indexFile = () => path.join(dir(), INDEX);
  let cache = null;
  const stats = { sent: 0, empty: 0, collected: 0, duplicates: 0, rejected: 0, pruned: 0 };

  function index() {
    if (cache) return cache;
    const r = readJsonSafe(indexFile(), { items: [] });
    const items = Array.isArray(r.value && r.value.items) ? r.value.items : [];
    // 清掉"索引里有、磁盘上没了"的孤儿记录（手动删过文件、或裁剪时出错）
    const alive = items.filter((it) => {
      try { return fs.existsSync(path.join(dir(), it.file)); } catch { return false; }
    });
    // 老数据是整段描述当标签，加载时补一遍短标签（提高挑中率）
    let retag = false;
    for (const it of alive) {
      const tags = it.tags || [];
      const expanded = [...new Set([...tags, ...tags.flatMap((t) => (String(t).length > 12 ? shortTags(t) : [])), ...shortTags(it.description || '')])].slice(0, 12);
      if (expanded.length !== tags.length) { it.tags = expanded; retag = true; }
    }
    cache = { items: alive, recentPick: Array.isArray(r.value && r.value.recentPick) ? r.value.recentPick : [] };
    if (retag) { try { persist(); } catch { /* ignore */ } }
    if (alive.length !== items.length) {
      try { persist(); log?.event('sticker', `素材库索引清理了 ${items.length - alive.length} 条失效记录`); } catch { /* ignore */ }
    }
    return cache;
  }
  function persist() { ensureDir(dir()); writeJsonAtomic(indexFile(), index()); }

  function listFiles() {
    try { return walkFiles(dir(), EXTS); } catch { return []; }
  }

  /** 由 ffprobe 拿图片尺寸（同步、失败返回 null，不影响主流程）。 */
  function probeSizeSync(file) {
    const exe = ffprobePath || cfg.ffprobePath;
    if (!exe || !fs.existsSync(exe)) return null;
    try {
      const out = execFileSync(exe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file], { encoding: 'utf8', timeout: 8000, windowsHide: true });
      const [w, h] = String(out).trim().split(',').map(Number);
      return Number.isFinite(w) && Number.isFinite(h) ? { width: w, height: h } : null;
    } catch { return null; }
  }

  /**
   * 判断"像不像表情"。
   * @returns {{ok:boolean, why:string}}
   */
  function looksLikeSticker({ ext, bytes, summary, size }) {
    const maxKB = Number(cfg.stickerCollectMaxKB) || 1536;
    if (bytes > maxKB * 1024) return { ok: false, why: `太大（${Math.round(bytes / 1024)}KB）` };
    if (/表情|动画|mface/i.test(String(summary || ''))) return { ok: true, why: '标记是表情' };
    if (/gif|webp/i.test(ext)) return { ok: true, why: `${ext} 动图` };
    const limit = Number(cfg.stickerCollectMaxSide) || 800;
    if (size && Math.max(size.width, size.height) <= limit) return { ok: true, why: `尺寸 ${size.width}×${size.height}` };
    if (!size && bytes <= 400 * 1024) return { ok: true, why: '体积小，先收着' };
    return { ok: false, why: size ? `尺寸太大（${size.width}×${size.height}）` : '看着像照片/长图' };
  }

  /**
   * 全库摘要：给模型挑图用。
   * 只有"编号 + 情绪 + 场景 + 一句画面"，一行约 30 字，100 张也就 3K 字符 —— 比只给 8 张候选准得多。
   */
  function digest({ max = 150 } = {}) {
    const idx = index();
    const files = new Set(listFiles().map((f) => path.basename(f)));
    const items = idx.items.filter((i) => files.has(i.file)).slice(0, max);
    return items.map((it, i) => ({
      no: i + 1,
      hash: it.hash,
      file: path.join(dir(), it.file),   // 一定要绝对路径：裸文件名会让 NapCat 去它自己目录找
      name: it.file,
      desc: String(it.description || it.summary || '').slice(0, 24),
      emotion: (it.emotion || []).slice(0, 3),
      usage: (it.usage || []).slice(0, 2),
      line: `${i + 1}. 画面：${String(it.description || it.summary || '').slice(0, 20)}｜情绪：${(it.emotion || []).slice(0, 3).join('/') || '-'}｜适用：${(it.usage || []).slice(0, 2).join('/') || '-'}`
    }));
  }

  /** 按语境粗筛出候选（给模型二次挑选用）。 */
  function pickCandidates(query = '', k = 8) {
    const files = listFiles();
    const idx = index();
    const q = grams(query);
    const scored = files.map((f) => {
      const name = path.basename(f);
      const rec = idx.items.find((i) => i.file === name) || {};
      const parts = [rec.summary, rec.description, ...(rec.tags || []), ...(rec.emotion || []), ...(rec.usage || []), name.replace(/\.[a-z0-9]+$/i, '')].filter(Boolean);
      let score = 0;
      if (q.size) {
        for (const part of parts) {
          const g = grams(part);
          if (!g.size) continue;
          let hit = 0;
          for (const x of q) if (g.has(x)) hit += 1;
          score = Math.max(score, hit / q.size);
        }
      }
      return { file: f, name, score, rec };
    }).sort((a, b) => b.score - a.score);
    // 有命中的优先，凑不够再随机补位（让模型有得选）
    const hit = scored.filter((s) => s.score > 0);
    const rest = scored.filter((s) => s.score <= 0);
    return [...hit, ...rest].slice(0, Math.max(1, k)).map((s) => ({
      file: s.file,
      name: s.name,
      desc: s.rec.description || s.rec.summary || '',
      emotion: s.rec.emotion || [],
      usage: s.rec.usage || [],
      score: s.score,
      hash: s.rec.hash
    }));
  }

  function markSent(hash) { remember(hash); persist(); }

  /** 收进素材库（按内容 hash 去重）。 */
  function add({ file, dataUrl, ext, summary = '', tags = [], description = '', emotion = [], usage = [], from = '', source = 'collected' }) {
    const tagSet = [...tags, ...emotion, ...usage, ...shortTags(description), summary].map((t) => String(t || '').trim()).filter(Boolean);
    let buf;
    let realExt = ext;
    if (file) {
      buf = fs.readFileSync(file);
      realExt = realExt || path.extname(file).replace('.', '').toLowerCase();
    } else if (dataUrl) {
      const m = /^data:([^;]+);base64,([\s\S]*)$/.exec(dataUrl);
      if (!m) throw new Error('不是 data URL');
      const mime = m[1].toLowerCase();
      realExt = realExt || (mime.includes('gif') ? 'gif' : mime.includes('webp') ? 'webp' : mime.includes('jpeg') ? 'jpg' : 'png');
      buf = Buffer.from(m[2], 'base64');
    } else throw new Error('缺少 file 或 dataUrl');

    ensureDir(dir());
    const hash = sha256(buf).slice(0, 12);
    const name = `${hash}.${realExt}`;
    const target = path.join(dir(), name);
    const idx = index();
    const old = idx.items.find((i) => i.hash === hash);
    if (old) {
      // 已有的：补标签、补情绪、补场景，不重复存文件
      old.tags = [...new Set([...(old.tags || []), ...tagSet, ...shortTags(old.description || '')])].slice(0, 12);
      if (!old.emotion?.length && emotion.length) old.emotion = emotion.slice(0, 6);
      if (!old.usage?.length && usage.length) old.usage = usage.slice(0, 5);
      if (description && !old.description) old.description = description.slice(0, 200);
      old.hits = old.hits || 0;
      if (from && !old.from) old.from = from;
      stats.duplicates += 1;
      persist();
      return { ...old, duplicate: true };
    }
    fs.writeFileSync(target, buf);
    const rec = {
      hash, file: name, ext: realExt, bytes: buf.length,
      summary: String(summary || '').slice(0, 120),
      tags: [...new Set(tagSet)].slice(0, 12),
      description: String(description || summary || '').slice(0, 200),
      emotion: [...new Set(emotion.map((x) => String(x).trim()).filter(Boolean))].slice(0, 6),
      usage: [...new Set(usage.map((x) => String(x).trim()).filter(Boolean))].slice(0, 5),
      from, source, addedAt: Date.now()
    };
    idx.items.push(rec);
    stats.collected += 1;
    log?.event('sticker', `收了张表情：${name}（${Math.round(buf.length / 1024)}KB）${rec.tags.length ? ' 标签：' + rec.tags.join('/') : ''}`);
    prune();
    persist();
    return rec;
  }

  function prune() {
    const max = Number(cfg.stickerCollectMaxFiles) || 500;
    const idx = index();
    if (idx.items.length <= max) return;
    idx.items.sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));
    const drop = idx.items.splice(0, idx.items.length - max);
    for (const d of drop) {
      try { fs.unlinkSync(path.join(dir(), d.file)); } catch { /* ignore */ }
      stats.pruned += 1;
    }
    log?.event('sticker', `素材库超过 ${max} 张，删掉最老的 ${drop.length} 张`);
  }

  /**
   * 挑一张：按标签/摘要/文件名跟当前话题的相似度打分。
   *
   * 踩过的坑：原来拿"模型自己的回话"去当查询、又用整段 40 字描述当标签，
   * 结果命中率极低，几乎每次都是随机挑 —— 标签等于白存。
   * 现在：查询用"群里的上下文"，打分用"命中比例"，并且**避免连续发同一张**。
   */
  function pick(query = '', { random = Math.random, avoidLast = 3 } = {}) {
    const files = listFiles();
    if (!files.length) { stats.empty += 1; return null; }
    const idx = index();
    const q = grams(query);
    const recent = (cache.recentPick || []).slice(-avoidLast);

    let best = null;
    for (const f of files) {
      const name = path.basename(f);
      const rec = idx.items.find((i) => i.file === name) || {};
      const parts = [rec.summary, ...(rec.tags || []), name.replace(/\.[a-z0-9]+$/i, '')].filter(Boolean);
      let score = 0;
      if (q.size) {
        for (const part of parts) {
          const g = grams(part);
          if (!g.size) continue;
          let hit = 0;
          for (const x of q) if (g.has(x)) hit += 1;
          // 命中比例：查询里有几句话的字二组被这张图的标签覆盖了
          score = Math.max(score, hit / q.size);
        }
      }
      if (recent.includes(rec.hash)) score *= 0.4; // 刚发过的降权，别老同一张
      if (!best || score > best.score) best = { file: f, score, rec };
    }

    const threshold = Number(cfg.stickerMatchThreshold) || 0.08;
    if (best && best.score >= threshold) {
      best.rec.hits = (best.rec.hits || 0) + 1;
      remember(best.rec.hash);
      persist();
      return { file: best.file, matched: true, score: best.score, tags: best.rec.tags || [] };
    }
    // 没匹配上：随机一张，但尽量避开刚发过的
    const pool = files.filter((f) => {
      const rec = idx.items.find((i) => i.file === path.basename(f));
      return !rec || !recent.includes(rec.hash);
    });
    const list = pool.length ? pool : files;
    const f = list[Math.floor(random() * list.length) % list.length];
    const rec = idx.items.find((i) => i.file === path.basename(f)) || {};
    remember(rec.hash);
    persist();
    return { file: f, matched: false, score: 0, tags: rec.tags || [] };
  }

  /** 记住最近发过哪几张（防止连着发同一张）。 */
  function remember(hash) {
    if (!hash) return;
    const c = index();
    c.recentPick = [...(c.recentPick || []), hash].slice(-5);
  }

  function toSegment(picked) {
    if (!picked) return null;
    stats.sent += 1;
    return { type: 'image', data: { file: `file:///${picked.file.replace(/\\/g, '/')}` } };
  }

  /**
   * 从一条收到的图学一张：先判"像不像表情"，像才收，标签用视觉描述。
   * @returns {{saved:boolean, why:string}}
   */
  function learn({ dataUrl, tmpFile, ext, summary = '', description = '', from = '' }) {
    if (cfg.stickerCollectEnabled === false) return { saved: false, why: '没开自动收表情' };
    let bytes = 0;
    if (tmpFile && fs.existsSync(tmpFile)) bytes = fs.statSync(tmpFile).size;
    else if (dataUrl) bytes = Math.round((dataUrl.split(',')[1] || '').length * 0.75);
    const size = tmpFile ? probeSizeSync(tmpFile) : null;
    const verdict = looksLikeSticker({ ext, bytes, summary, size });
    if (!verdict.ok) { stats.rejected += 1; return { saved: false, why: verdict.why }; }
    const rec = add({ file: tmpFile, dataUrl, ext, summary, description, tags: [], from });
    if (stats.collected % 10 === 1) log?.event('sticker', `素材库现在有 ${listFiles().length} 张`);
    return { saved: true, why: verdict.why, record: rec };
  }

  function list(limit = 60) {
    const idx = index();
    const files = new Set(listFiles().map((f) => path.basename(f)));
    const items = idx.items.filter((i) => files.has(i.file)).sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0)).slice(0, limit);
    return { dir: dir(), files: files.size, indexed: idx.items.length, items };
  }

  return { add, learn, pick, pickCandidates, digest, markSent, list, toSegment, prune, stats, dir, probeSizeSync, looksLikeSticker };
}
