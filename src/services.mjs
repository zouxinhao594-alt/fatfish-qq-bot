// 本地服务管家：TTS（9882）/ RVC（9885）/ 调音台（9887）改成「用时拉起、闲置自动关」。
//
// 为什么：TTS 和 RVC 各占几百 MB 到 1~2 GB 内存，平时她只是聊天，不需要一直挂后台。
// 代价：闲置太久之后第一次用要等模型加载（TTS 冷启动实测 3~4 分钟，RVC 约 20~30 秒），
// 所以「闲置多久才关」要留够（默认 TTS 20 分钟、RVC 10 分钟），聊着聊着不会突然变慢。
// 调音台不吃模型内存，默认不自动关（idleMins = 0）。
//
// 设计要点：
//   - ensure() 幂等：已经在跑就只更新时间戳；正在起就复用同一个 promise，不会重复拉
//   - 关的时候按端口找 pid，再 taskkill /T，整棵杀干净
//   - 起不来只是返回 false，调用方照常降级（TTS→SAPI，RVC→原人声）

import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import { spawn, execFile } from 'node:child_process';

const DEFAULT_PORTS = { tts: 9882, rvc: 9885, console: 9887 };

/** 从 http://127.0.0.1:9882 里抠端口 */
export function portOf(endpoint, fallback) {
  try {
    const u = new URL(String(endpoint || ''));
    if (u.port) return Number(u.port);
    return u.protocol === 'https:' ? 443 : 80;
  } catch { return fallback; }
}

/** TCP 探活：端口在听就算起来（比 HTTP /health 稳，服务刚绑端口时 /health 可能还没好） */
export function portOpen(port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port: Number(port) || 0 });
    let done = false;
    const finish = (v) => { if (!done) { done = true; try { sock.destroy(); } catch { /* ignore */ } resolve(v); } };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
  });
}

/** 端口 → 监听它的 pid（解析 netstat，比 Get-NetTCPConnection 快很多） */
export function pidOnPort(port, { exec = execFile } = {}) {
  return new Promise((resolve) => {
    exec('netstat', ['-ano', '-p', 'TCP'], { windowsHide: true, timeout: 8000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err || !stdout) return resolve(0);
      const want = `:${Number(port)}`;
      for (const line of String(stdout).split(/\r?\n/)) {
        if (!line.includes('LISTENING')) continue;
        const cols = line.trim().split(/\s+/);
        if (cols.length < 5) continue;
        if (!cols[1].endsWith(want)) continue;
        const pid = Number(cols[4]);
        if (Number.isFinite(pid) && pid > 0) return resolve(pid);
      }
      resolve(0);
    });
  });
}

export function createServices({ cfg = {}, log = null, dataDir = 'data', fetchImpl = globalThis.fetch } = {}) {
  const ttsPort = portOf(cfg.ttsEndpoint, DEFAULT_PORTS.tts);
  const rvcPort = portOf(cfg.singRvcEndpoint, DEFAULT_PORTS.rvc);
  const conPort = Number(cfg.rvcConsolePort) || DEFAULT_PORTS.console;
  const stateDir = path.join(dataDir, 'media', 'services');
  const botDir = String(cfg.botDir || process.cwd());
  try { fs.mkdirSync(stateDir, { recursive: true }); } catch { /* ignore */ }

  function openLog(name) {
    try { return fs.openSync(path.join(stateDir, name + '.log'), 'a'); } catch { return 'ignore'; }
  }

  const defs = {
    tts: {
      name: 'tts',
      label: '语音合成',
      port: ttsPort,
      idleMins: Math.max(0, Number(cfg.ttsIdleStopMins ?? 20)),
      startTimeoutMs: Math.max(10, Number(cfg.ttsStartTimeoutSecs ?? 300)) * 1000,
      logFile: path.join(stateDir, 'tts.log'),
      start() {
        // 语音服务的启动脚本是本机相关的（要写你自己的 GPT-SoVITS 路径）：
        //   1) 设置页填「语音服务启动脚本」（ttsStartScript）→ 用它
        //   2) 不放脚本就把「本地语音/换声按需启动」关掉，自己先把 9882 起好
        const custom = String(cfg.ttsStartScript || '').trim();
        const ps1 = custom || path.join(botDir, 'tools', 'start-voice.ps1');
        if (!fs.existsSync(ps1)) {
          throw new Error('找不到语音服务启动脚本：' + ps1 + '（在设置页填「语音服务启动脚本」，或关掉按需启动、自己先把 9882 起好）');
        }
        const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', ps1], {
          windowsHide: true, detached: true, stdio: 'ignore'
        });
        child.unref();
        return 'powershell -File ' + ps1;
      }
    },
    rvc: {
      name: 'rvc',
      label: '唱歌换声',
      port: rvcPort,
      idleMins: Math.max(0, Number(cfg.rvcIdleStopMins ?? 10)),
      startTimeoutMs: Math.max(10, Number(cfg.rvcStartTimeoutSecs ?? 150)) * 1000,
      logFile: path.join(stateDir, 'rvc.log'),
      start() {
        // 这两个路径只有你自己机器上才有：没配就报清楚，别去猜作者的安装目录。
        const py = String(cfg.rvcPython || '');
        const script = String(cfg.rvcScript || '');
        if (!py) throw new Error('没配 rvcPython（设置页「RVC Python」填 .venv 里的 python.exe）');
        if (!script) throw new Error('没配 rvcScript（设置页「RVC 服务脚本」填 sing_rvc_cpu.py 的完整路径）');
        const cwd = path.dirname(script);
        if (!fs.existsSync(py)) throw new Error('找不到 python：' + py);
        if (!fs.existsSync(script)) throw new Error('找不到脚本：' + script);
        const out = openLog('rvc');
        const env = { ...process.env, PYTHONUTF8: '1', OMP_NUM_THREADS: '4', MKL_NUM_THREADS: '4' };
        const ff = String(cfg.ffmpegDir || '');
        if (ff && fs.existsSync(ff)) env.PATH = ff + ';' + (env.PATH || '');
        const child = spawn(py, [script, String(this.port)], { cwd, windowsHide: true, detached: true, stdio: ['ignore', out, out], env });
        child.unref();
        return 'python ' + script;
      }
    },
    // 调音台（tools/rvc-console.mjs）：手动调音色/试听的本地小网页，不吃模型内存。
    // idleMins 默认 0 = 不自动关（本来就是个想打开才打开的工具页）。
    console: {
      name: 'console',
      label: 'RVC 调音台',
      port: conPort,
      idleMins: Math.max(0, Number(cfg.rvcConsoleIdleStopMins ?? 0)),
      startTimeoutMs: 30_000,
      logFile: path.join(stateDir, 'rvc-console.log'),
      start() {
        const nodeExe = String(cfg.nodeExe || process.execPath);
        const script = path.join(botDir, 'tools', 'rvc-console.mjs');
        if (!fs.existsSync(script)) throw new Error('找不到调音台脚本：' + script);
        const out = openLog('rvc-console');
        const child = spawn(nodeExe, [script], { cwd: botDir, windowsHide: true, detached: true, stdio: ['ignore', out, out] });
        child.unref();
        return 'node tools/rvc-console.mjs';
      }
    }
  };

  const runtime = {};   // name -> { lastUsed, startedAt, starting, lastError, starts, stops }
  for (const k of Object.keys(defs)) runtime[k] = { lastUsed: 0, startedAt: 0, starting: null, lastError: '', starts: 0, stops: 0 };

  function touch(name) { if (runtime[name]) runtime[name].lastUsed = Date.now(); }

  async function waitPort(port, timeoutMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (await portOpen(port)) return true;
      await new Promise((r) => setTimeout(r, 700));
    }
    return false;
  }

  /**
   * 确保服务在跑。返回 true = 可用。
   * 已经在跑：只 touch，几乎零开销（一次 TCP 探测）。
   */
  async function ensure(name, { timeoutMs = 0 } = {}) {
    const def = defs[name];
    const rt = runtime[name];
    if (!def || !rt) return false;
    if (cfg.voiceOnDemand === false && name !== 'console') return true;
    if (await portOpen(def.port)) { touch(name); return true; }
    if (rt.starting) return rt.starting;

    const limit = timeoutMs > 0 ? timeoutMs : def.startTimeoutMs;
    rt.starting = (async () => {
      const t0 = Date.now();
      try {
        const how = def.start();
        rt.starts += 1;
        rt.startedAt = Date.now();
        log?.event('svc', `拉起${def.label}（${def.port}）：${how}，等它加载…`);
      } catch (e) {
        rt.lastError = e.message;
        log?.event('svc', `${def.label}拉不起来：${e.message}`);
        return false;
      }
      const ok = await waitPort(def.port, limit);
      const secs = Math.round((Date.now() - t0) / 1000);
      if (ok) {
        touch(name);
        log?.event('svc', `${def.label}就绪（${secs} 秒）`);
      } else {
        rt.lastError = `${def.label} ${secs} 秒还没就绪`;
        log?.event('svc', `${def.label}超过 ${secs} 秒还没起来，放弃（调用方会降级；它可能还在加载，下次再用就是热的）`);
      }
      return ok;
    })().finally(() => { rt.starting = null; });
    return rt.starting;
  }

  /** 关掉服务（找端口上的 pid，整棵杀） */
  async function stop(name, why = '') {
    const def = defs[name];
    const rt = runtime[name];
    if (!def) return false;
    const pid = await pidOnPort(def.port);
    if (!pid) { if (rt) rt.lastUsed = 0; return false; }
    await new Promise((resolve) => {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 10_000 }, () => resolve());
    });
    if (rt) { rt.lastUsed = 0; rt.stops += 1; }
    log?.event('svc', `关掉${def.label}（${def.port}，pid ${pid}）${why ? '：' + why : ''}`);
    return true;
  }

  /** 闲置回收：每分钟看一次，超过 idleMins 没被用过就关 */
  let timer = null;
  function startReaper() {
    if (timer) return timer;
    timer = setInterval(async () => {
      for (const name of Object.keys(defs)) {
        const def = defs[name];
        const rt = runtime[name];
        if (!def.idleMins || !rt.lastUsed) continue;
        if (rt.starting) continue;
        const idleMs = Date.now() - rt.lastUsed;
        if (idleMs < def.idleMins * 60_000) continue;
        if (!(await portOpen(def.port))) { rt.lastUsed = 0; continue; }
        await stop(name, `闲置 ${Math.round(idleMs / 60000)} 分钟`);
      }
    }, 60_000);
    if (timer.unref) timer.unref();
    return timer;
  }

  function stopReaper() { if (timer) { clearInterval(timer); timer = null; } }

  /** 给控制台/状态接口看的快照 */
  async function status() {
    const out = [];
    for (const name of Object.keys(defs)) {
      const def = defs[name];
      const rt = runtime[name];
      out.push({
        name, label: def.label, port: def.port,
        up: await portOpen(def.port),
        idleSec: rt.lastUsed ? Math.round((Date.now() - rt.lastUsed) / 1000) : 0,
        idleMins: def.idleMins, starts: rt.starts, stops: rt.stops,
        starting: !!rt.starting, lastError: rt.lastError
      });
    }
    return out;
  }

  const onDemand = cfg.voiceOnDemand !== false;
  return { defs, ensure, touch, stop, status, startReaper, stopReaper, onDemand, runtime };
}
