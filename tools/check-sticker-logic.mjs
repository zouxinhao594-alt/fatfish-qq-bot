// 验收：表情库的语义标签 + 按语境挑图是否"符合逻辑"
import fs from 'node:fs';
import { loadConfig } from '../src/config.mjs';
import { createLlm } from '../src/llm.mjs';
import { createCapabilities } from '../src/capabilities.mjs';

const { cfg } = loadConfig('./data');
const llm = createLlm({ cfg, log: null });
const caps = createCapabilities({
  cfg: { ...cfg, stickersEnabled: true, visionEnabled: true },
  llm, log: null, dataDir: './data',
  // ffprobe 每台机器都不一样：用环境变量 FFPROBE 指定，或者留空走配置/PATH
  ffprobePath: process.env.FFPROBE || ''
});

const lib = caps.stickers.list(500);
console.log(`素材库：${lib.files} 张（索引 ${lib.indexed}）\n`);

console.log('=== 标签样本（画面 / 情绪 / 适用场景）===');
for (const it of lib.items.slice(0, 8)) {
  console.log(`  ${it.file}`);
  console.log(`    描述：${(it.description || '').slice(0, 40)}`);
  console.log(`    情绪：${(it.emotion || []).join('/') || '（无）'}   场景：${(it.usage || []).join('/') || '（无）'}`);
}

const cases = [
  { label: '她有点委屈', recent: [{ nickname: '小红', text: '今天被老师骂了，好难过' }], reply: '别难过啦，抱一下～' },
  { label: '哈哈太好笑了', recent: [{ nickname: '小明', text: '哈哈哈哈你怎么这么搞笑' }], reply: '笑死我了哈哈哈哈哈' },
  { label: '要去睡了', recent: [{ nickname: '小红', text: '我先去睡啦，晚安' }], reply: '晚安呀，好梦' },
  { label: '加班到十点', recent: [{ nickname: '小明', text: '今天加班到十点，累死了' }], reply: '快去躺平吧，明天再说' },
  { label: '随便闲聊', recent: [{ nickname: '小红', text: '今天中午吃了个超大的鸡腿' }], reply: '听起来就香，羡慕了' },
  { label: '吐槽作业多', recent: [{ nickname: '小明', text: '作业多到写不完，烦' }], reply: '先写能写的，别硬撑' },
  { label: '纯正事', recent: [{ nickname: '小明', text: '帮我把那个文件发一下，急用' }], reply: '好的，这就发' },
  { label: '催它干活', recent: [{ nickname: '小明', text: '快点把作业写了' }], reply: '好嘞，我这就去' }
];

console.log('\n=== 按语境挑图（模型从整个表情库里挑）===');
for (const c of cases) {
  const query = [c.recent.map((r) => r.text).join(' '), c.reply].join(' ');
  const picked = await caps.chooseSticker({ query, recent: c.recent, reply: c.reply });
  if (!picked) { console.log(`  「${c.label}」→ 决定不配图`); continue; }
  const rec = (lib.items.find((i) => i.file.replace(/\\/g, '/').endsWith(picked.name)) || {});
  console.log(`  「${c.label}」→ ${picked.name}`);
  console.log(`      画面：${(rec.description || '').slice(0, 36)}`);
  console.log(`      情绪：${(rec.emotion || []).join('/') || '—'}   场景：${(rec.usage || []).join('/') || '—'}`);
}
