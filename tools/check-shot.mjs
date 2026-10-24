// 手动验证网页截图能不能出图（换机器/换浏览器后跑一次就放心了）
// 用法：node tools/check-shot.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createScreenshot, findBrowser } from '../src/screenshot.mjs';

const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ffshot-'));
const page = path.join(d, 'p.html');
fs.writeFileSync(page, '<html><body style="font:44px sans-serif;padding:40px">大肥鱼截图测试 OK</body></html>');
const url = 'file:///' + page.replace(/\\/g, '/');

console.log('浏览器：', findBrowser({ shotBrowserPath: '' }) || '（没找到，请在设置里填 shotBrowserPath）');
const s = createScreenshot({ cfg: { shotEnabled: true, shotKeepFiles: true, shotWidth: 900, shotHeight: 600 }, log: { event: () => {} }, dataDir: d });
const r = await s.capture(url);
if (r.ok) {
  console.log('✅ 截图成功：', r.file);
  console.log('   png 大小：', fs.statSync(r.file).size, 'bytes');
} else {
  console.log('❌ 截图失败：', r.error);
  process.exit(1);
}
