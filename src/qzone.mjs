// QQ空间说说：发她自己的"日记"到机器人号的 QQ 空间。
//
// 走的是 SnowLuma 的 OneBot 扩展动作（标准 OneBot11 里没有这几个）：
//   send_qzone_msg        发表说说（纯文字，可选图片，ugc_right 控制谁能看）
//   get_qzone_msg_list    读自己的说说列表（顺便当"接口在不在"的探针）
//   delete_qzone_msg      按 tid 删一条
// 换别的网关（比如纯 NapCat）可能没这几个动作 —— 所以每个失败都把原因写进日志，不猜。

import fs from 'node:fs';
import path from 'node:path';

// ugc_right：1 所有人可见 / 4 好友可见 / 16 部分好友 / 64 仅自己 / 128 部分好友不可见
export const QZONE_UGC = { all: 1, friends: 4, partial: 16, self: 64, hideFrom: 128 };
const ALLOWED = new Set([1, 4, 16, 64, 128]);

/** 可见范围的中文名（日志/控制台都用它，别再拿 1 和 4 都叫"公开"） */
export function rightLabel(right) {
  const n = Number(right);
  if (n === QZONE_UGC.all) return '所有人可见';
  if (n === QZONE_UGC.friends) return '好友可见';
  if (n === QZONE_UGC.partial) return '部分好友可见';
  if (n === QZONE_UGC.self) return '仅自己可见';
  if (n === QZONE_UGC.hideFrom) return '部分好友不可见';
  return String(right);
}

export function createQzone({ cfg = {}, log = null, onebot = null, dataDir = 'data' } = {}) {
  const dir = path.join(dataDir, 'qzone');
  const logFile = path.join(dir, 'posts.jsonl');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* 建不出来也不影响发 */ }
  const stats = { published: 0, failed: 0, lastError: '', lastTid: '' };

  function append(entry) {
    try { fs.appendFileSync(logFile, JSON.stringify(entry) + '\n', 'utf8'); } catch { /* 本地留档失败不挡正事 */ }
  }

  /** 本地发过的记录（新的在前） */
  function history(n = 20) {
    let raw = '';
    try { raw = fs.readFileSync(logFile, 'utf8'); } catch { return []; }
    const rows = [];
    for (const line of raw.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try { rows.push(JSON.parse(s)); } catch { /* 坏行跳过 */ }
    }
    return rows.slice(-Math.max(1, n)).reverse();
  }

  function rightOf(value) {
    const v = Number(value ?? cfg.qzoneUgcRight);
    return ALLOWED.has(v) ? v : QZONE_UGC.all;
  }

  /** 发一条说说。失败会抛出带人话的错误（调用方决定退不退回本地日记）。 */
  async function publish(content, { ugcRight, images } = {}) {
    const text = String(content ?? '').trim();
    if (!text) throw new Error('说说正文是空的');
    if (!onebot) throw new Error('QQ 通道还没连上');
    const right = rightOf(ugcRight);
    const params = { content: text.slice(0, 1000), ugc_right: right };
    if (Array.isArray(images) && images.length) params.images = images.slice(0, 9).map(String);
    try {
      const r = await onebot.call('send_qzone_msg', params, 30_000);
      const tid = String((r && (r.tid || r.data?.tid)) || '');
      stats.published += 1;
      stats.lastTid = tid || stats.lastTid;
      append({ at: Date.now(), tid, text: text.slice(0, 500), ugc: right, ok: true });
      log?.event('qzone', `说说发出去了（${rightLabel(right)}${tid ? '，tid ' + tid : ''}）`);
      return { ok: true, tid, text, ugcRight: right };
    } catch (e) {
      stats.failed += 1;
      stats.lastError = e.message;
      append({ at: Date.now(), text: text.slice(0, 500), ugc: right, ok: false, error: e.message });
      log?.event('qzone', `说说没发出去：${e.message}`);
      throw e;
    }
  }

  /** 读自己的说说列表（控制台展示 + 探针） */
  async function list(num = 10) {
    if (!onebot) throw new Error('QQ 通道还没连上');
    try {
      const r = await onebot.call('get_qzone_msg_list', { pos: 0, num: Math.max(1, Math.min(100, Number(num) || 10)) }, 15_000);
      const msglist = Array.isArray(r?.msglist) ? r.msglist.map((m) => ({
        tid: String(m.tid || ''),
        content: String(m.content || ''),
        time: Number(m.time || 0) * 1000,
        comments: Number(m.comment_num || 0),
        isPrivate: !!m.is_private,
        images: Array.isArray(m.images) ? m.images.length : 0
      })) : [];
      return { total: Number(r?.total || msglist.length || 0), items: msglist };
    } catch (e) {
      // SnowLuma 在"一条说说都没有"时会把 msglist 返回成 null，然后它自己判定"结构异常"。
      // 这不是错，就是空的 —— 当成 0 条，控制台才不会一进来就报红。
      if (/msglist|结构异常|无法获取空间说说列表|响应结构异常/.test(e.message)) {
        log?.event('qzone', '空间列表是空的（可能一条说说都没有）');
        return { total: 0, items: [], empty: true };
      }
      throw e;
    }
  }

  async function del(tid) {
    const id = String(tid || '').trim();
    if (!id) throw new Error('要删哪条？给我 tid');
    if (!onebot) throw new Error('QQ 通道还没连上');
    const r = await onebot.call('delete_qzone_msg', { tid: id }, 15_000);
    log?.event('qzone', `删掉了一条说说：${id}`);
    return r;
  }

  /**
   * 改一条已发说说的可见范围（原地改，不删了重发：时间、评论、点赞都还在）。
   * 非法值直接报错，不像发说说那样退回"公开" —— 把本想藏起来的东西发成公开，
   * 比报个错严重得多。
   */
  async function setRight(tid, ugcRight) {
    const id = String(tid || '').trim();
    if (!id) throw new Error('要改哪条？给我 tid');
    const right = Number(ugcRight);
    if (!ALLOWED.has(right)) throw new Error(`可见范围只能是 1/4/16/64/128，收到 ${ugcRight}`);
    if (!onebot) throw new Error('QQ 通道还没连上');
    const r = await onebot.call('set_qzone_msg_right', { tid: id, ugc_right: right }, 20_000);
    const label = rightLabel(right);
    append({ at: Date.now(), tid: id, right, action: 'setRight' });
    log?.event('qzone', `说说 ${id} 的可见范围改成「${label}」`);
    return { ok: true, tid: id, ugcRight: right, label };
  }

  /** 接口在不在（读一条列表就知道；不猜、不瞎报） */
  async function available() {
    try { await list(1); return true; } catch (e) { stats.lastError = e.message; return false; }
  }

  return { dir, logFile, publish, list, del, setRight, available, history, stats };
}
