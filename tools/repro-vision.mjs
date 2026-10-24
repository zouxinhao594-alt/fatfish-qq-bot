// 复现"看图失败"：把存下来的失败图重新跑一遍
// 用法：node tools/repro-vision.mjs data/media/vision-fail/xxx.gif
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { createLlm } from '../src/llm.mjs';
import { createCapabilities } from '../src/capabilities.mjs';

const file = process.argv[2];
if (!file) {
  console.log('用法：node tools/repro-vision.mjs <图片路径>');
  const dir = 'data/media/vision-fail';
  if (fs.existsSync(dir)) {
    const list = fs.readdirSync(dir);
    console.log(`现在存着 ${list.length} 张失败图：`);
    for (const f of list.slice(-10)) console.log('  ' + path.join(dir, f));
  }
  process.exit(0);
}

const dataDir = 'data';
const { cfg } = loadConfig(dataDir);
const llm = createLlm({ cfg, log: { event: (k, d) => console.log(`  [${k}]`, d) } });
const caps = createCapabilities({ cfg: { ...cfg, visionEnabled: true }, llm, log: { event: (k, d) => console.log(`  [${k}]`, d) }, dataDir });

console.log('图片：', file, Math.round(fs.statSync(file).size / 1024) + ' KB');
console.log('格式：', path.extname(file));
const notes = await caps.enrich({ images: [path.resolve(file)] });
console.log('');
if (notes.length) console.log('✅ 描述：', notes[0]);
else console.log('❌ 仍然没看到（看上面的 vision 事件里的原因）');
console.log('统计：', JSON.stringify(caps.stats));
