// 抓「DeepSeek 鲸鱼 / 大肥鱼」二创表情包，并用视觉模型做健康度过滤。
//
// 来源：EDMOK/blue-fish-archive（蓝色大肥鱼档案馆）的 large/ 目录（webp，适合当表情包）
// 过滤：逐张让视觉模型判断"是否适合作为健康向上的群聊表情包"，顺便让它起个短描述当文件名
// 产出：桌面 \ 鱼饲料 \ NNN-描述.webp + manifest.md
//
// 用法：node tools/fetch-whale-stickers.mjs [目标张数=100] [输出目录]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { parseRoute, resolveChannel } from '../src/models.mjs';

const WANT = Number(process.argv[2]) || 100;
const OUT = process.argv[3] || path.join(os.homedir(), 'Desktop', '鱼饲料');
const API = 'https://api.github.com/repos/EDMOK/blue-fish-archive/git/trees/main?recursive=1';
const MAX_BYTES = 900 * 1024;   // 太大的当图片，不当表情
const CONCURRENCY = 3;

const { cfg } = loadConfig('./data');
const route = cfg.visionModel || cfg.model;
const ch = resolveChannel(cfg, parseRoute(route).channelId).channel;
const model = parseRoute(route).model || cfg.model;

// ── 1) 列候选 ───────────────────────────────────────────────
const tree = await (await fetch(API, { headers: { 'User-Agent': 'fatfish-sticker-fetch' } })).json();
if (!tree.tree) { console.error('拿不到仓库文件列表：', JSON.stringify(tree).slice(0, 200)); process.exit(1); }
const skip = /logo|qr|og-card|favicon|apple-touch|about|README/i;
const candidates = tree.tree
  .filter((e) => e.type === 'blob' && /^large\/.+\.(webp|png|jpg|jpeg)$/i.test(e.path))
  .filter((e) => e.size <= MAX_BYTES && !skip.test(e.path))
  .sort((a, b) => a.size - b.size);   // 先拿小的（更像表情包）

console.log(`候选 ${candidates.length} 张，目标 ${WANT} 张健康表情，输出到 ${OUT}`);
fs.mkdirSync(OUT, { recursive: true });

// ── 2) 视觉判断：健康吗？顺便起个短描述 ──────────────────────
async function judge(base64, mime) {
  const body = {
    model,
    max_tokens: 800,
    reasoning_effort: 'low',
    messages: [{
      role: 'user',
      content: [
        {
          type: 'text',
          text: [
            '这是给 QQ 群聊用的表情包素材，需要「健康向上」。请判断并只输出 JSON：{"ok":true|false,"desc":"不超过10个字"}',
            '- ok=true：画面干净、可以公开放到青少年也能看的群里（可爱的鲸鱼/卡通/玩梗/励志/日常吐槽都算）',
            '- ok=false：擦边或色情、暴力血腥、吸毒赌博、政治敏感、恶心猎奇、明显引战、含二维码或广告水印',
            'desc：十个字以内描述这张图（例如"蓝鲸抱头蹲防"）'
          ].join('\n')
        },
        { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } }
      ]
    }]
  };
  const res = await fetch(ch.apiBase + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + ch.apiKey },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000)
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`接口 ${res.status}`);
  const j = JSON.parse(txt);
  const content = String(j.choices?.[0]?.message?.content || '');
  const m = content.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('模型没给 JSON：' + content.slice(0, 60));
  const o = JSON.parse(m[0]);
  return { ok: o.ok === true, desc: String(o.desc || '').slice(0, 12) };
}

function safeName(s) {
  return String(s || '').replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, '').slice(0, 20) || '鲸鱼表情';
}

// ── 3) 并发处理 ────────────────────────────────────────────
const seen = new Set();
const manifest = [];
let idx = 0, rejected = 0, failed = 0, tried = 0;

async function handle(c) {
  if (manifest.length >= WANT) return;
  tried += 1;
  const url = `https://raw.githubusercontent.com/EDMOK/blue-fish-archive/main/${c.path}`;
  let buf;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!r.ok) throw new Error(`下载 ${r.status}`);
    buf = Buffer.from(await r.arrayBuffer());
  } catch (e) { failed += 1; return; }
  const hash = (await import('node:crypto')).createHash('sha256').update(buf).digest('hex').slice(0, 12);
  if (seen.has(hash)) return;                      // 内容重复
  seen.add(hash);
  let v;
  try { v = await judge(buf.toString('base64'), 'image/webp'); }
  catch (e) { failed += 1; return; }
  if (!v.ok) { rejected += 1; return; }
  if (manifest.length >= WANT) return;
  idx += 1;
  const name = `${String(idx).padStart(3, '0')}-${safeName(v.desc)}.webp`;
  fs.writeFileSync(path.join(OUT, name), buf);
  manifest.push({ name, desc: v.desc, src: c.path, bytes: buf.length });
  if (manifest.length % 10 === 0) console.log(`  已收 ${manifest.length} 张…（看过 ${tried}，淘汰 ${rejected}）`);
}

const queue = candidates.slice();
const workers = Array.from({ length: CONCURRENCY }, async () => {
  while (queue.length && manifest.length < WANT) {
    const c = queue.shift();
    await handle(c);
  }
});
await Promise.all(workers);

// ── 4) 清单 ────────────────────────────────────────────────
const md = [
  `# 鱼饲料（DeepSeek 鲸鱼 / 大肥鱼二创表情包）`,
  '',
  `- 来源：EDMOK/blue-fish-archive（蓝色大肥鱼档案馆）`,
  `- 经过视觉模型「健康向上」筛选，共 ${manifest.length} 张（淘汰 ${rejected}、失败 ${failed}、看过 ${tried}）`,
  '',
  '| 文件 | 描述 | 来源路径 | 大小 |',
  '|---|---|---|---|',
  ...manifest.map((m) => `| ${m.name} | ${m.desc} | ${m.src} | ${Math.round(m.bytes / 1024)}KB |`)
].join('\n');
fs.writeFileSync(path.join(OUT, 'manifest.md'), md, 'utf8');

console.log('');
console.log(`完成：${manifest.length} 张 → ${OUT}`);
console.log(`淘汰 ${rejected}（不健康/不适用）、下载或判断失败 ${failed}、共看过 ${tried}`);
