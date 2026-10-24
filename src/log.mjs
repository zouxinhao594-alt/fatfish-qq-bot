// 事件流：内存环形（给控制台/SSE）+ 按天 jsonl 落盘（给事后查）。

import fs from 'node:fs';
import path from 'node:path';
import { ensureDir } from './store.mjs';

/**
 * 本地日期 YYYY-MM-DD。
 * 以前用 toISOString() —— 那是 **UTC**：国内早上 7~8 点写出来的日志会落进"昨天"的文件里，
 * 排查当天的现场时永远找不到（踩过：今早 07:xx 的日志全在 2026-10-22.jsonl 里）。
 */
export function localDay(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export class EventLog {
  constructor(dataDir, { ring = 500 } = {}) {
    this.dir = ensureDir(path.join(dataDir, 'logs'));
    this.ring = [];
    this.max = ring;
    this.subs = new Set();
  }

  event(kind, detail, extra = {}) {
    const ev = { ts: Date.now(), kind, detail: String(detail ?? ''), ...extra };
    this.ring.push(ev);
    if (this.ring.length > this.max) this.ring.shift();
    try {
      const day = localDay(new Date(ev.ts));
      fs.appendFileSync(path.join(this.dir, `${day}.jsonl`), JSON.stringify(ev) + '\n', 'utf8');
    } catch { /* 日志失败不阻断主流程 */ }
    for (const fn of this.subs) { try { fn(ev); } catch { /* 订阅方自己负责 */ } }
    return ev;
  }

  list(limit = 100, kind = '') {
    let out = kind ? this.ring.filter((e) => e.kind === kind) : this.ring.slice();
    return out.slice(-limit);
  }

  subscribe(fn) {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }
}
