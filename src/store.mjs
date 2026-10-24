// 落盘工具：原子写 + 坏文件留证 + 目录遍历。全部同步，文件都很小。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

export function stamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 读 JSON：失败重试 3 次；解析失败把坏文件备份成 xxx.bad-<ts>，绝不静默吞掉。 */
export function readJsonSafe(file, fallback) {
  if (!fs.existsSync(file)) return { value: fallback, error: '', backup: '' };
  let lastErr = '';
  for (let i = 0; i < 3; i++) {
    try {
      const txt = fs.readFileSync(file, 'utf8');
      if (!txt.trim()) return { value: fallback, error: '', backup: '' };
      return { value: JSON.parse(txt), error: '', backup: '' };
    } catch (e) {
      lastErr = e.message;
      const backup = `${file}.bad-${Date.now()}`;
      try { fs.copyFileSync(file, backup); return { value: fallback, error: `配置解析失败（已备份 ${path.basename(backup)}）：${lastErr}`, backup }; }
      catch { /* 备份失败继续重试 */ }
    }
  }
  return { value: fallback, error: `读取失败：${lastErr}`, backup: '' };
}

export function writeJsonAtomic(file, obj) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

export function readTextSafe(file, fallback = '') {
  try { return fs.readFileSync(file, 'utf8'); } catch { return fallback; }
}

export function writeTextAtomic(file, text) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

export function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

/** 递归列出目录下指定扩展名的文件（跳过隐藏目录）。 */
export function walkFiles(dir, exts = ['.md', '.txt']) {
  const out = [];
  if (!dir || !fs.existsSync(dir)) return out;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let ents = [];
    try { ents = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (exts.includes(path.extname(e.name).toLowerCase())) out.push(p);
    }
  }
  return out.sort();
}
