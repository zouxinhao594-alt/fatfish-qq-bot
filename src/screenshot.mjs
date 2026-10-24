// 网页截图：真 Edge/Chrome 无头 → PNG → 交给视觉通道描述（和旧版同一条路）。
// 不引入 puppeteer：直接用浏览器的 --screenshot。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ensureDir } from './store.mjs';

/** 起一个外部进程并等它退出。stdio 用 ignore：不抓输出（沙箱里管道会被拒，也不需要）。 */
function runQuiet(file, args, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const child = spawn(file, args, { stdio: 'ignore', windowsHide: true, detached: false });
    const timer = setTimeout(() => { if (!done) { try { child.kill(); } catch { /* ignore */ } resolve({ code: -1, timeout: true }); } }, timeoutMs);
    child.on('error', (e) => { if (!done) { done = true; clearTimeout(timer); resolve({ code: -2, error: e.message }); } });
    child.on('close', (code) => { if (!done) { done = true; clearTimeout(timer); resolve({ code, timeout: false }); } });
  });
}

const CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
];

export function findBrowser(cfg) {
  if (cfg?.shotBrowserPath && fs.existsSync(cfg.shotBrowserPath)) return cfg.shotBrowserPath;
  for (const p of CANDIDATES) if (fs.existsSync(p)) return p;
  return '';
}

export function createScreenshot({ cfg, log, dataDir }) {
  // 必须是绝对路径：浏览器的 --screenshot 收到相对路径时会静默不写文件（退出码还是 0）
  const outDir = ensureDir(path.join(path.resolve(dataDir), 'media', 'shot'));
  const stats = { taken: 0, failed: 0, described: 0 };

  async function capture(url, opts = {}) {
    const browser = findBrowser(cfg);
    if (!browser) { stats.failed += 1; return { ok: false, error: '本机没找到 Edge/Chrome，可在设置里填 shotBrowserPath' }; }
    if (!cfg.shotEnabled) return { ok: false, error: '截图没开' };
    const w = Number(opts.width || cfg.shotWidth || 1280);
    const h = Number(opts.height || cfg.shotHeight || 900);
    const file = path.join(outDir, `shot-${Date.now()}.png`);
    // 关键：必须给一个独立的 user-data-dir。
    // 否则当用户自己开着 Edge 时，新进程会把命令转交给已有实例后直接退出（退出码 0 但不截图）。
    const profile = path.join(os.tmpdir(), `ffshot-profile-${Date.now()}`);
    const args = [
      '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
      '--disable-extensions', '--mute-audio', '--disable-background-networking',
      `--user-data-dir=${profile}`,
      `--window-size=${w},${h}`,
      `--screenshot=${file}`,
      '--virtual-time-budget=4000',
      String(url)
    ];
    const r = await runQuiet(browser, args, (Number(cfg.shotTimeoutSecs) || 20) * 1000);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 临时目录，删不掉也不影响 */ }
    if (!fs.existsSync(file)) {
      stats.failed += 1;
      const why = r.error ? `起不来：${r.error}` : (r.timeout ? '超时' : `浏览器退出码 ${r.code}，没产出图`);
      return { ok: false, error: `截图失败（${why}）` };
    }
    if (!fs.existsSync(file) || fs.statSync(file).size < 1000) { stats.failed += 1; return { ok: false, error: '截图没产出有效文件' }; }
    stats.taken += 1;
    log?.event('shot', `截图 ${url} → ${path.basename(file)} (${Math.round(fs.statSync(file).size / 1024)} KB)`);
    if (!cfg.shotKeepFiles) setTimeout(() => { try { fs.unlinkSync(file); } catch { /* ignore */ } }, 10 * 60_000);
    return { ok: true, file, bytes: fs.statSync(file).size };
  }

  /** 截图 + 视觉描述（喂给模型的其实只有文字，图不外发到群里）。 */
  async function captureAndDescribe(url, llm) {
    const shot = await capture(url);
    if (!shot.ok) return { ok: false, error: shot.error };
    if (!cfg.visionEnabled || !llm) return { ok: true, text: '（截了一张图，但视觉没开，看不见内容）' };
    try {
      const text = await llm.describeImage(`file:///${shot.file.replace(/\\/g, '/')}`, { prompt: '这是网页截图。用中文说清页面上有什么：标题、关键信息、数字、按钮。不超过 120 字。' });
      stats.described += 1;
      return { ok: true, text, file: shot.file };
    } catch (e) {
      return { ok: true, text: `（截图成功了，但看图失败：${e.message}）`, file: shot.file };
    }
  }

  return { capture, captureAndDescribe, stats, dir: outDir, findBrowser: () => findBrowser(cfg) };
}
