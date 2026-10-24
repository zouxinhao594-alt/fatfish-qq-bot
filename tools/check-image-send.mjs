// 验证：base64:// 发图到底行不行（NapCat 是否接受）
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';

const { cfg } = loadConfig('./data');
const group = process.argv[2] || (cfg.groups || [])[0];
const file = process.argv[3] || path.join('data', 'stickers', fs.readdirSync(path.join('data', 'stickers')).find((f) => f.endsWith('.webp')));

const buf = fs.readFileSync(file);
console.log(`测试图：${file}（${Math.round(buf.length / 1024)}KB）→ 群 ${group}`);

const ws = new WebSocket(cfg.napcatWs);
let seq = 0;
const waiters = new Map();

function call(action, params) {
  return new Promise((resolve, reject) => {
    const echo = `test-${++seq}`;
    waiters.set(echo, { resolve, reject });
    ws.send(JSON.stringify({ action, params, echo }));
    setTimeout(() => { if (waiters.has(echo)) { waiters.delete(echo); reject(new Error('超时')); } }, 15000);
  });
}

ws.addEventListener('message', (ev) => {
  let d = null;
  try { d = JSON.parse(String(ev.data)); } catch { return; }
  const w = d.echo && waiters.get(d.echo);
  if (!w) return;
  waiters.delete(d.echo);
  if (d.status === 'ok' || d.retcode === 0) w.resolve(d.data);
  else w.reject(new Error(`${d.retcode} ${d.wording || d.message || ''}`));
});

await new Promise((r) => ws.addEventListener('open', r, { once: true }));
console.log('已连上 NapCat');

const formats = [
  { label: 'base64://', data: { file: 'base64://' + buf.toString('base64') } },
  { label: '绝对路径', data: { file: path.resolve(file) } },
  { label: 'file:/// 路径', data: { file: 'file:///' + path.resolve(file).replace(/\\/g, '/') } }
];

for (const f of formats) {
  try {
    const r = await call('send_group_msg', { group_id: group, message: [{ type: 'image', data: f.data }] });
    console.log(`  ${f.label.padEnd(12)} → ✅ 成功 message_id=${r && r.message_id}`);
  } catch (e) {
    console.log(`  ${f.label.padEnd(12)} → ❌ ${e.message}`);
  }
}
ws.close();
