// 按人记账的记忆：一本账挂在一个 QQ 号上，而不是挂在会话上。
//
// 为什么不用现有的 memory.mjs：
//   memory 是一个平铺的池子（谁说的都往一块扔，靠重要性和时间衰减排序）。
//   问题是同一个人换个群、换私聊，读到的就不像"同一个人"了。
//   这里按人分账：他是什么脾气、说过什么事实、聊过哪些话题、你心里还记着没说的话、见过几次。
//
// 数据：data/people.json（按 QQ 号分键）
// 写入口径：模型在对话里自报的 memory → 当作事实；称呼变化 → 更新名字；每轮互动 → 次数 +1

import path from 'node:path';
import fs from 'node:fs';
import { readJsonSafe, writeJsonAtomic } from './store.mjs';
import { similarText } from './memory.mjs';

const clean = (v, n = 160) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/** 话题过滤：一个字、"?"、"嗯"、"好的" 这种记下来只会污染上下文 */
function worthTopic(s) {
  const t = String(s || '').trim();
  if (!t) return false;
  const core = t.replace(/[\s?？!！。，,…~～、"'“”‘’()（）]/g, '');
  if (core.length <= 1) return false;
  if (/^(嗯+|哦+|呃+|啊+|哈+|诶+|欸+|额+|好的|好|行|可以|在吗|在不在|是|对)$/.test(core)) return false;
  return /[\u4e00-\u9fa5a-zA-Z0-9]/.test(core);
}

export function createPeople({ dataDir, cfg, log }) {
  const file = path.join(dataDir, 'people.json');
  const maxTopics = Math.max(1, Number(cfg.peopleMaxTopics) || 20);
  const maxTraits = Math.max(1, Number(cfg.peopleMaxTraits) || 40);
  const maxFacts = Math.max(1, Number(cfg.peopleMaxFacts) || 60);

  function readAll() {
    const v = readJsonSafe(file, {}).value;
    return v && typeof v === 'object' ? v : {};
  }
  function writeAll(obj) { writeJsonAtomic(file, obj); }

  function blank(name, key) {
    return {
      name: name || key,
      traits: [], facts: [], topics: [], pending: [],
      interactions: 0,
      firstSeenAt: Date.now(),
      lastSeenAt: Date.now()
    };
  }

  /** 取一个人的账（没有就建） */
  function person(id, { name } = {}) {
    const key = String(id ?? '').trim();
    if (!key) return null;
    const all = readAll();
    let p = all[key];
    if (!p || typeof p !== 'object') { p = blank(name, key); all[key] = p; }
    for (const k of ['traits', 'facts', 'topics', 'pending']) if (!Array.isArray(p[k])) p[k] = [];
    if (name && p.name !== name) p.name = clean(name, 40);
    writeAll(all);
    return p;
  }

  /** 往某人账上写一条：重复的挪到最新，别在列表里堆两条一样的 */
  function remember(id, { trait, fact, topic, pending, name } = {}) {
    const key = String(id ?? '').trim();
    if (!key) return null;
    const all = readAll();
    let p = all[key];
    if (!p || typeof p !== 'object') p = blank(name, key);
    for (const k of ['traits', 'facts', 'topics', 'pending']) if (!Array.isArray(p[k])) p[k] = [];
    if (name) p.name = clean(name, 40);

    const put = (arr, v, max) => {
      const s = clean(v, 160);
      if (!s) return;
      // 换了个说法的同一件事要顶掉旧的，否则账上会堆四条"让我叫他哥哥"
      const near = arr.findIndex((x) => x === s || similarText(x, s) >= 0.8);
      if (near >= 0) arr.splice(near, 1);
      arr.push(s);
      while (arr.length > max) arr.shift();
    };
    if (trait) put(p.traits, trait, maxTraits);
    if (fact) put(p.facts, fact, maxFacts);
    if (topic && worthTopic(topic)) put(p.topics, topic, maxTopics);
    if (pending) put(p.pending, pending, 12);

    p.lastSeenAt = Date.now();
    p.interactions = (Number(p.interactions) || 0) + 1;
    all[key] = p;
    writeAll(all);
    return p;
  }

  /** 只记一次互动（不加内容） */
  function touch(id, { name } = {}) {
    const key = String(id ?? '').trim();
    if (!key) return null;
    const all = readAll();
    let p = all[key];
    if (!p || typeof p !== 'object') { p = blank(name, key); all[key] = p; }
    p.lastSeenAt = Date.now();
    p.interactions = (Number(p.interactions) || 0) + 1;
    if (name) p.name = clean(name, 40);
    writeAll(all);
    return p;
  }

  /** 渲染成能塞进 system 的一段（刻意短：这本账是"语气"用的，不是资料库） */
  function renderPerson(id) {
    const key = String(id ?? '').trim();
    const p = readAll()[key];
    if (!p) return '';
    const L = [];
    if (p.traits?.length) L.push('他这个人：' + p.traits.slice(-8).join('；'));
    if (p.facts?.length) L.push('他告诉过你：' + p.facts.slice(-8).join('；'));
    if (p.topics?.length) L.push('你们聊过：' + p.topics.slice(-5).join('；'));
    if (p.pending?.length) L.push('你心里还记着没说的话：' + p.pending.slice(-3).join('；'));
    if (Number(p.interactions) > 1) L.push(`你们已经聊过 ${p.interactions} 次`);
    if (!L.length) return '';
    const who = p.name && p.name !== key ? `${p.name}（${key}）` : key;
    return `【你和他的一本账 · ${who}】\n${L.join('\n')}\n（这些是你自己记的，别装作不认识，也别一条条念出来）`;
  }

  /** 控制台列表用 */
  function list(limit = 50) {
    const all = readAll();
    return Object.entries(all)
      .map(([id, p]) => ({ id, name: p.name || id, interactions: Number(p.interactions) || 0, lastSeenAt: Number(p.lastSeenAt) || 0, traits: (p.traits || []).slice(-3), facts: (p.facts || []).slice(-3), topics: (p.topics || []).slice(-3), pending: p.pending || [] }))
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
      .slice(0, Math.max(1, limit));
  }

  function forget(id) {
    const key = String(id ?? '').trim();
    const all = readAll();
    if (!all[key]) return false;
    delete all[key];
    writeAll(all);
    return true;
  }

  return { file, person, remember, touch, renderPerson, list, forget, dump: readAll };
}
