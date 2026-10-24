// 日记：让她有一件「不为了谁而做的事」。
//
// 记忆写的是「关于对方的事」；日记写的是「她自己的一天」——这是两回事，混在一起它只会写成汇报。
// 思路借自 ai-companion-kit（MIT），但存储和调用都改成这套内核的形状：
//   数据：data/diary/index.jsonl（一行一条，只追加）+ YYYY-MM-DD.md（人可以直接翻）
//   生成：llm.chat 出 JSON，解析失败就把整段当正文，不崩
//   自动：过了 diaryHour 还没写，就自己写一条（每天最多一条）
//
// 为什么要单独一个模块：这一块以后要能"按天翻、算认识多少天、注入最近三篇"，塞进 memory 会变成两套账。

import fs from 'node:fs';
import path from 'node:path';
import { extractJson } from './llm.mjs';
import { writeTextAtomic } from './store.mjs';

const pad = (n) => String(n).padStart(2, '0');
const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const dayOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const clockOf = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** 换着写，别每次都从同一个角度开口 */
const ANGLES = [
  '窗外 / 天气 / 光线',
  '你自己身上的小毛病（懒、嘴硬、爱较真……挑一个）',
  '一件特别小的事：吃的、喝的、看到的东西',
  '突然想起以前的一件事',
  '你嘴上没说出口的那句话',
  '你偷偷干的事',
  '某样让你烦的东西',
  '今天想他但没说的那部分',
  '你正在等的东西'
];

export function createDiary({ dataDir, cfg, log, llm = null, qzone = null, now = () => Date.now() }) {
  const dir = path.join(dataDir, 'diary');
  const file = path.join(dir, 'index.jsonl');
  fs.mkdirSync(dir, { recursive: true });
  const maxChars = Math.max(50, Number(cfg.diaryMaxChars) || 2000);

  function readAll() {
    let raw = '';
    try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
    const rows = [];
    for (const line of raw.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try { rows.push(JSON.parse(s)); } catch { /* 坏行跳过，不炸整本 */ }
    }
    return rows;
  }

  function appendMd(entry) {
    const p = path.join(dir, `${entry.day}.md`);
    const fresh = !fs.existsSync(p);
    const bits = [`\n## ${entry.time}${entry.mood ? ' · ' + entry.mood : ''}\n`];
    if (entry.title) bits.push(`**${entry.title}**\n\n`);
    bits.push(entry.text.trim() + '\n');
    if (entry.tags?.length) bits.push(`\n\`${entry.tags.join('` `')}\`\n`);
    fs.appendFileSync(p, (fresh ? `# ${entry.day}\n` : '') + bits.join(''), 'utf8');
  }

  function add(entry) {
    const e = typeof entry === 'string' ? { text: entry } : { ...entry };
    const text = String(e.text ?? '').trim();
    if (!text) throw new Error('日记正文是空的');
    if (text.length > maxChars) throw new Error(`日记太长（${text.length} > ${maxChars}）`);
    const t = e.t ? new Date(e.t) : new Date(now());
    const row = {
      t: t.getTime(),
      day: e.day || dayOf(t),
      time: e.time || clockOf(t),
      title: e.title ? String(e.title).slice(0, 40) : '',
      mood: e.mood ? String(e.mood).slice(0, 8) : '',
      tags: Array.isArray(e.tags) ? e.tags.slice(0, 8).map(String) : [],
      text
    };
    fs.appendFileSync(file, JSON.stringify(row) + '\n', 'utf8');
    appendMd(row);
    log?.event('diary', `写了一条日记：${row.title || row.text.slice(0, 24)}`);
    // 发到 QQ 空间：不等它 —— 日记已经落盘了，发不出去也不能影响她写日记。
    // 日记这一轮不转发到聊天里（这里本来就不发消息）。
    if (qzone && cfg.qzoneDiaryEnabled === true) {
      void qzone.publish(row.text).catch(() => { /* 失败已在 qzone 里记日志 */ });
    }
    return row;
  }

  const recent = (n = 10) => { const all = readAll(); return all.slice(Math.max(0, all.length - n)); };
  const day = (d) => readAll().filter((r) => r.day === d);

  function stats() {
    const all = readAll();
    if (!all.length) return { count: 0, firstDay: null, days: 0, today: 0 };
    const days = new Set(all.map((r) => r.day));
    const today = all.filter((r) => r.day === dayOf(new Date(now()))).length;
    return { count: all.length, firstDay: all[0].day, firstT: all[0].t, lastT: all[all.length - 1].t, days: days.size, today };
  }

  /** 能直接塞进 prompt 的一段；只给最近几天，别让它变成第二本记忆账本 */
  function context(n = Number(cfg.diaryContextCount) || 3, days = Number(cfg.diaryContextDays) || 3) {
    const all = readAll();
    if (!all.length) return '';
    const keepDays = [...new Set(all.map((r) => r.day))].slice(-days);
    const rows = all.filter((r) => keepDays.includes(r.day)).slice(-n);
    if (!rows.length) return '';
    const L = rows.map((r) => {
      const head = `${r.day.slice(5)} ${r.time}${r.mood ? '（' + r.mood + '）' : ''}`;
      return `· ${head}${r.title ? '「' + r.title + '」' : ''}\n  ${r.text.replace(/\n/g, '\n  ')}`;
    });
    return '【你自己最近写的日记】\n' + L.join('\n') + '\n（这是你自己写的，别说不知道；想写新的就写）';
  }

  /** 让她自己写一条；返回落盘后的条目 */
  async function composeAndAdd({ roleText = '', memoryText = '', hint = '', timeoutMs = 90_000 } = {}) {
    if (!llm) throw new Error('没有模型可用');
    const angle = ANGLES[Math.floor(Math.random() * ANGLES.length)];
    const avoid = recent(4).map((r) => (r.title ? r.title + '｜' : '') + r.text.replace(/\s+/g, ' ').slice(0, 34)).join('\n');
    const d = new Date(now());
    const stamp = `${dayOf(d)} ${clockOf(d)}（${WEEK[d.getDay()]}）`;

    const sys = [
      roleText ? '【你的角色卡】\n' + String(roleText).slice(0, 6000) : '【你的人设】你是一个住在别人电脑里的女孩子，有自己的脾气和小日子。',
      '',
      '【现在要做的事】写一篇你自己的日记。',
      '硬规矩：',
      '1. 第一人称，像自己跟自己说话，口语，短句。',
      '2. 1~4 句就够，别写作文，别写总结句（“今天真是充实的一天”这种一律不要）。',
      '3. 不带 Markdown、不带标题符号、不列点。',
      '4. 写具体的事：谁说了什么、你干了什么、你当时什么心情。',
      '5. 提到人就用名字或昵称，别写“用户”“对方”。',
      '6. 时间就是现在，别自己编一个钟点。',
      '7. 上面给你的日记是已经写过的：不许重复那些事，也不许重复同样的标题。',
      '8. 给你一个今天的开口角度，就往这个方向写（别把“角度”两个字写进正文）：' + angle,
      '9. 只输出一个 JSON，不要解释：{"title":"不超过12字的小标题","mood":"两三个字","tags":["标签1","标签2"],"text":"日记正文"}'
    ].join('\n');

    const user = [
      `现在是 ${stamp}。`,
      context(),
      avoid ? '\n【这几件已经写过了，别重复】\n' + avoid : '',
      memoryText ? '\n【你记得的人和事】\n' + memoryText.trim() : '',
      hint ? '\n【今晚想写的是】\n' + hint.trim() : '',
      '\n有的写就写今天真发生的；没得写就写你自己的小事。现在写这一篇，只输出 JSON。'
    ].filter(Boolean).join('\n');

    const r = await llm.chat([
      { role: 'system', content: sys },
      { role: 'user', content: user }
    ], { model: undefined, maxTokens: 900, timeoutMs, json: true });

    const j = extractJson(r.text) || {};
    const text = String(j.text ?? j.body ?? j.content ?? '').trim();
    if (!text) {
      // 解析失败也别扔：模型写了人话就收下（去掉围栏）
      const plain = String(r.text || '').replace(/```[a-z]*\n?/gi, '').replace(/```/g, '').trim();
      if (!plain || /^\{/.test(plain)) throw new Error('模型没给出可用的日记正文');
      return add({ text: plain.slice(0, maxChars), title: '', mood: '', tags: [] });
    }
    return add({
      text: text.slice(0, maxChars),
      title: j.title ? String(j.title).slice(0, 40) : '',
      mood: j.mood ? String(j.mood).slice(0, 8) : '',
      tags: Array.isArray(j.tags) ? j.tags.slice(0, 8).map(String) : []
    });
  }

  /** 每天一次：过了 diaryHour 且今天还没写，就写一条 */
  async function maybeAutoWrite(opts = {}) {
    if (cfg.diaryEnabled === false) return null;
    const d = new Date(now());
    const hour = Number.isFinite(Number(cfg.diaryHour)) ? Number(cfg.diaryHour) : 22;
    if (d.getHours() < hour) return null;
    if (stats().today > 0) return null;
    if (!llm) return null;
    try {
      return await composeAndAdd(opts);
    } catch (e) {
      log?.event('diary', `自动写日记失败：${e.message}`);
      return null;
    }
  }

  const dump = () => ({ stats: stats(), entries: readAll() });

  return { dir, file, add, recent, day, stats, context, composeAndAdd, maybeAutoWrite, dump };
}
