// 长期记忆：一个 JSON 文件，按时效衰减排序（旧版 memory.json 同构，可直接迁移）。
//
// 两个坑（都是真踩过的）：
//   1 只说同一句话的不同写法会各占一条（"青色让我叫他哥哥" ×4），
//     注入时前几名全被同一件事占满 → 它翻来覆去只聊这个。所以要做近似去重。
//   2 承诺类记忆只进不出（"九点给我做番茄鱼汤泡饭" 吃完还在），
//     于是它每天追着你要那碗饭。所以承诺类最多留几条，新的挤掉旧的。

import path from 'node:path';
import { readJsonSafe, writeJsonAtomic } from './store.mjs';

const DAY = 86_400_000;

/** 归一化：去掉称呼、语气、填充词、标点，只留实词，便于判"是不是同一件事" */
function norm(s) {
  return String(s ?? '')
    .replace(/^(青色|主人|他|她|对方)/, '')
    .replace(/[，。、！？…~～\s"'“”‘’（）()【】\[\]:：;；]/g, '')
    .replace(/(得记着|别忘了|别忘|记着问|记着|要问清楚|别记岔|说话算话了|说话算话|算数)/g, '')
    .replace(/(以后|然后|之后|已经|这个|那个)/g, '')
    .replace(/喊/g, '叫')
    .replace(/(让|要|叫)(?=我)/g, '');
}

function bigrams(s) {
  const g = [];
  for (let i = 0; i < s.length - 1; i++) g.push(s.slice(i, i + 2));
  return g;
}

/** 最长公共子序列长度（句子都很短，直接 DP） */
function lcsLen(a, b) {
  if (!a || !b) return 0;
  let prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  return prev[b.length];
}

/**
 * 相似度（0~1）。光看二元组重合度不够：换个语序、插个"以后"就掉到 0.4，
 * 于是"叫我哥哥"能堆四条。所以取两种口味里大的那个：
 *   二元组重合度（看整体像不像） / 公共子序列占短句的比例（核心词是不是同一批）
 */
export function similarText(a, b) {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const minLen = Math.min(x.length, y.length);
  if (minLen >= 4 && (x.includes(y) || y.includes(x))) return 0.95;
  const gx = bigrams(x);
  const gy = new Set(bigrams(y));
  let hit = 0;
  if (gx.length && gy.size) for (const g of gx) if (gy.has(g)) hit += 1;
  const jac = (gx.length && gy.size) ? hit / Math.max(gx.length, gy.size) : 0;
  const lcs = minLen >= 6 ? lcsLen(x, y) / minLen : 0;
  return Math.max(jac, lcs);
}

// 承诺/欠条类：这类只进不出就会变成"天天追着你要"
const PROMISE = /(答应|承诺|说好|说定|记着问|给我做|给我吃|给我买|把.{0,6}给我|还算不算|作数)/;
// 已经兑现的说法：出现它，就说明前面那些欠条可以销了
const FULFILLED = /(吃到了|吃过了|已经吃到|已经给我|给了我|做给我了|送到了|办好了|说话算话)/;
// 欠条 = 像承诺，而且还没兑现（"给我吃了" 里也有"给我吃"，但那是已兑现，不算欠条）
export const isPromise = (t) => PROMISE.test(String(t || '')) && !FULFILLED.test(String(t || ''));

export function createMemory({ dataDir, cfg, log }) {
  const file = path.join(dataDir, 'memory.json');
  let state = readJsonSafe(file, { items: [] });
  let items = Array.isArray(state.value?.items) ? state.value.items : [];

  function persist() {
    writeJsonAtomic(file, { updatedAt: Date.now(), items });
  }

  function topK(k = cfg.memoryTopK || 3) {
    const half = Math.max(1, Number(cfg.memoryHalfLifeDays) || 30);
    const now = Date.now();
    return items
      .map((it) => ({ ...it, score: (Number(it.weight) || 1) * Math.pow(0.5, (now - (it.ts || now)) / DAY / half) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }

  /** 承诺类最多留几条：留太多它就只会追着要东西 */
  function trimPromises() {
    const max = Math.max(0, Number(cfg.memoryMaxPromises ?? 2));
    const promises = items.filter((it) => isPromise(it.text));
    if (promises.length <= max) return 0;
    const drop = new Set(promises.slice(0, promises.length - max));
    items = items.filter((it) => !drop.has(it));
    return drop.size;
  }

  function add(text, { weight = 1.2 } = {}) {
    const t = String(text ?? '').trim();
    if (!t) return false;
    // 近似重复：把新说法顶掉旧的那条（这本身就是"同一件事，说得更准了"）
    const near = items.find((it) => it.text === t || similarText(it.text, t) >= 0.8);
    if (near) {
      const changed = near.text !== t;
      near.text = t;
      near.ts = Date.now();
      near.weight = Math.max(Number(near.weight) || 1, weight);
      // 已经兑现的事，把同类欠条一起销掉 —— 免得它吃完饭还追着要
      let retired = 0;
      if (FULFILLED.test(t)) {
        const keep = near;
        const before = items.length;
        items = items.filter((it) => it === keep || !(isPromise(it.text) && similarText(it.text, t) >= 0.5));
        retired = before - items.length;
      }
      trimPromises();
      persist();
      if (changed) log?.event('memory', `更新记忆：${t.slice(0, 40)}${retired ? `（顺手销掉 ${retired} 张欠条）` : ''}`);
      return false;
    }
    items.push({ text: t, ts: Date.now(), weight });
    // 兑现型记忆进来时，把语义相近的旧欠条销掉
    if (FULFILLED.test(t)) {
      const before = items.length;
      items = items.filter((it) => it.text === t || !(isPromise(it.text) && similarText(it.text, t) >= 0.5));
      if (before > items.length) log?.event('memory', `销掉 ${before - items.length} 张已兑现的欠条`);
    }
    const trimmed = trimPromises();
    if (trimmed) log?.event('memory', `承诺类记忆超过上限，清掉最旧的 ${trimmed} 条`);
    if (items.length > 400) items = items.slice(-400);
    persist();
    log?.event('memory', `记住：${t.slice(0, 40)}`);
    return true;
  }

  /** 手动销一条（控制台/修数据用）：按相似度找，找到就删 */
  function forget(text) {
    const t = String(text ?? '').trim();
    if (!t) return 0;
    const before = items.length;
    items = items.filter((it) => it.text !== t && similarText(it.text, t) < 0.8);
    const n = before - items.length;
    if (n) persist();
    return n;
  }

  function all() { return items.slice(); }
  function clear() { items = []; persist(); }

  return { file, topK, add, forget, all, clear, get size() { return items.length; } };
}
