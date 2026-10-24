// 知识库：目录里的 md/txt 切块，用"字二元组重合度"打分（零依赖、够用、无向量库）。

import path from 'node:path';
import fs from 'node:fs';
import { walkFiles, readTextSafe } from './store.mjs';

function grams(text) {
  const s = String(text || '').toLowerCase();
  const out = new Set();
  const cjk = s.replace(/[^\u4e00-\u9fa5a-z0-9]+/g, ' ');
  for (const word of cjk.split(/\s+/).filter((w) => /^[a-z0-9]{2,}$/.test(w))) out.add(word);
  const zh = s.replace(/[^\u4e00-\u9fa5]/g, '');
  for (let i = 0; i + 1 < zh.length; i++) out.add(zh.slice(i, i + 2));
  return out;
}

export function createKb({ cfg, dataDir, log }) {
  let cache = { dir: '', files: 0, chunks: [], at: 0, sig: '' };

  function dir() {
    return cfg.kbDir ? path.resolve(cfg.kbDir) : path.join(dataDir, 'kb');
  }

  function load(force = false) {
    const d = dir();
    if (!force && cache.dir === d && cache.chunks.length && Date.now() - cache.at < 30_000) return cache;
    const chunks = [];
    for (const f of walkFiles(d, ['.md', '.txt'])) {
      const text = readTextSafe(f, '');
      if (!text.trim()) continue;
      // 先按空行切，再把过长的块按 900 字硬切
      const blocks = text.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
      for (const b of blocks) {
        if (b.startsWith('#')) continue; // 纯标题块丢掉
        if (b.length <= 900) { chunks.push({ src: path.basename(f), text: b, g: grams(b) }); continue; }
        for (let i = 0; i < b.length; i += 900) chunks.push({ src: path.basename(f), text: b.slice(i, i + 900), g: grams(b.slice(i, i + 900)) });
      }
    }
    const files = new Set(chunks.map((c) => c.src)).size;
    const sig = `${d}|${files}|${chunks.length}`;
    const changed = sig !== cache.sig;
    cache = { dir: d, files, chunks, at: Date.now(), sig };
    // 只在内容真的变了才记事件（控制台每 3 秒读一次状态，不能让它刷屏）
    if (changed) log?.event('kb', `知识库已加载：${files} 个文件 / ${chunks.length} 块`);
    return cache;
  }

  function search(query, { topK = cfg.kbTopK || 3, maxChars = cfg.kbMaxChars || 900 } = {}) {
    const { chunks } = load();
    if (!chunks.length) return [];
    const q = grams(query);
    const scored = chunks.map((c) => {
      let hit = 0;
      for (const g of q) if (c.g.has(g)) hit++;
      return { ...c, score: hit / Math.sqrt(c.g.size || 1) };
    }).filter((c) => c.score > 0.02).sort((a, b) => b.score - a.score);
    const picked = [];
    let used = 0;
    for (const c of scored.slice(0, topK)) {
      const room = maxChars - used;
      if (room <= 80) break;
      picked.push({ src: c.src, text: c.text.slice(0, room) });
      used += Math.min(c.text.length, room);
    }
    return picked;
  }

  function list(force = false) {
    const { chunks, files } = load(force);
    const bySrc = new Map();
    for (const c of chunks) bySrc.set(c.src, (bySrc.get(c.src) || 0) + 1);
    return { dir: dir(), files, sources: [...bySrc.entries()].map(([src, n]) => ({ src, chunks: n })) };
  }

  return { search, list, reload: () => { load(true); return true; } };
}

export { fs };
