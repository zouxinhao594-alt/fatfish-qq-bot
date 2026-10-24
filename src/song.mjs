// 唱别人的歌：把人声/伴奏拆开，人声换成她的音色，再和原伴奏合起来。
//
// 和 sing.mjs 的区别：
//   sing.mjs  —— 她会"唱儿歌"：自己按旋律逐字合成 + 程序伴奏（不需要素材）
//   song.mjs  —— 她会"唱这首歌"：给一个音频文件，拆人声/伴奏 → RVC 换声 → 混回去
//
// 拆人声用 Demucs（htdemucs），装在你自己配的目录里：
//   包      demucsPython 指向装 demucs 的那个 python.exe（比如某个 .venv\Scripts\python.exe）
//   权重    demucsDir/models/huggingface/...（靠 TORCH_HOME / XDG_CACHE_HOME 指过去，别落 C 盘）
//   输出    demucsDir/out、demucsDir/clips（中间产物）
// 换声用 RVC 服务（singRvcEndpoint，默认 http://127.0.0.1:9885，见 sing.mjs 里的 rvcConvert）。

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

const RUN = (exe, args, { cwd, timeout = 600_000, env = {} } = {}) => new Promise((resolve, reject) => {
  execFile(exe, args, {
    cwd, timeout, windowsHide: true, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8',
    env: { ...process.env, ...env }
  }, (err, stdout, stderr) => {
    if (err) return reject(new Error(String(stderr || err.message).slice(-400)));
    resolve({ stdout, stderr });
  });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Demucs 子进程的环境变量：权重目录 + 强制离线。
 * 为什么要离线：Demucs 启动时会去 HuggingFace 校验模型，网络一不通就永远卡住
 * （进程活着、CPU 一直 0，点歌那一轮就再也回不来）。权重早就在本地，离线最稳。
 */
export function demucsEnv(modelDir) {
  return {
    HF_HUB_OFFLINE: '1',
    TRANSFORMERS_OFFLINE: '1',
    HF_HUB_DISABLE_TELEMETRY: '1',
    HF_HUB_DISABLE_UPDATE_CHECK: '1',
    TORCH_HOME: modelDir,
    XDG_CACHE_HOME: modelDir
  };
}

export const createSong = ({ cfg = {}, log = null, fetchImpl = globalThis.fetch, dataDir = 'data', qqMusic = null, bili = null, ensureRvc = null, modelTag: injectedModelTag = '' } = {}) => {
  // 这些路径都是"作者机器上"的，公开版一律不写死：没配就报清楚让人去设置页填。
  const demucsDir = String(cfg.demucsDir || '');
  const modelDir = path.join(demucsDir, 'models');
  const outDir = path.join(demucsDir, 'out');
  const py = String(cfg.demucsPython || '');
  const model = String(cfg.demucsModel || 'htdemucs');
  const songsDir = path.join(dataDir, 'songs');
  const rvcEndpoint = String(cfg.singRvcEndpoint || 'http://127.0.0.1:9885').replace(/\/+$/, '');
  // 渲染管线版本：升调/混音逻辑一变就 bump，缓存键带上它，避免复用旧成品（踩过：改了混音还在放老文件）
  const RENDER_VERSION = 'v3-cn-name';
  const stats = { separated: 0, sung: 0, errors: 0 };

  /** Demucs 的工作目录：没配就抛清楚，别在作者机器的路径上瞎猜。 */
  function demucsRoot() {
    if (!demucsDir) throw new Error('没配 demucsDir（设置页「Demucs 目录」填一个模型/输出都放得下的目录）');
    return demucsDir;
  }

  function ensureDirs() {
    if (demucsDir) for (const d of [modelDir, outDir]) fs.mkdirSync(d, { recursive: true });
    fs.mkdirSync(songsDir, { recursive: true });
  }

  // —— 成品缓存 ——
  // 同一首歌同一个条件只跑一次：Demucs + RVC 在 CPU 上要几分钟，第二个人点同一首必须秒回。
  // 键里带源文件 mtime，源文件换了自动失效；成品被删了也自动失效（不看时间戳，只看文件在不在）。
  const stateDir = path.join(dataDir, 'state');
  const cacheFile = path.join(stateDir, 'song-cache.json');
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) || {}; } catch { cache = {}; }
  function saveCache() {
    try {
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2));
    } catch { /* 缓存写不进去不影响唱歌 */ }
  }
  function cacheGet(key) {
    const hit = cache[key];
    if (!hit || !hit.file) return null;
    try {
      if (!fs.existsSync(hit.file)) throw new Error('成品没了');
      if (fs.statSync(hit.file).size < 1000) throw new Error('成品是空文件');
    } catch {
      delete cache[key]; saveCache(); return null;
    }
    return hit;
  }
  function cachePut(key, value) {
    // stems 是中间产物，可能被清掉；缓存里不存它们，免得返回一堆已删路径
    const { stems, ...rest } = value || {};
    cache[key] = { ...rest, at: Date.now() };
    saveCache();
  }
  /** 清理 7 天前的切片（demucsDir/clips 只增不减会撑爆盘） */
  function pruneClips(maxAgeMs = 7 * 24 * 3600_000) {
    if (!demucsDir) return 0;
    const dir = path.join(demucsDir, 'clips');
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return 0; }
    let n = 0;
    for (const f of names) {
      const p = path.join(dir, f);
      try {
        if (Date.now() - fs.statSync(p).mtimeMs > maxAgeMs) { fs.rmSync(p, { force: true }); n += 1; }
      } catch { /* 单个删不掉就跳过 */ }
    }
    if (n) log?.event('song', `清掉 ${n} 个过期切片`);
    return n;
  }

  /** 列一下 data/songs 里有什么歌（给人看的） */
  function list() {
    ensureDirs();
    return fs.readdirSync(songsDir)
      .filter((f) => /\.(mp3|wav|flac|m4a|ogg|aac)$/i.test(f))
      .map((f) => ({ name: f, sizeKb: Math.round(fs.statSync(path.join(songsDir, f)).size / 1024) }));
  }

  /** 按名字在 data/songs 里找文件（也允许绝对路径） */
  function resolve(input) {
    const raw = String(input || '').trim();
    if (!raw) throw new Error('要哪首歌？把文件放进 data/songs/ 再告诉我名字');
    if (path.isAbsolute(raw) && fs.existsSync(raw)) return raw;
    ensureDirs();
    const hit = fs.readdirSync(songsDir).find((f) => f === raw || f.toLowerCase() === raw.toLowerCase());
    if (hit) return path.join(songsDir, hit);
    const loose = fs.readdirSync(songsDir).find((f) => f.includes(raw) || raw.includes(path.parse(f).name));
    if (loose) return path.join(songsDir, loose);
    throw new Error(`data/songs 里没有「${raw}」`);
  }

  /** 拆人声/伴奏（Demucs） */
  async function separate(file) {
    const root = demucsRoot();
    if (!py) throw new Error('没配 demucsPython（设置页填装了 Demucs 的那个 python.exe，比如 .venv\\Scripts\\python.exe）');
    ensureDirs();
    const src = path.resolve(file);
    if (!fs.existsSync(src)) throw new Error('找不到源文件：' + src);
    const t0 = Date.now();
    log?.event('song', `开始拆人声「${path.basename(src)}」`);
    await RUN(py, ['-m', 'demucs', '--two-stems=vocals', '-n', model, '-o', outDir, src], {
      // 卡死过一次：Demucs 启动时会去 HuggingFace 检查模型版本，网络一不通进程就永远挂着
      // （进程活着、CPU 0、点歌这一轮永远等不到）。权重本来就在本地，强制离线。
      // 注意单位：execFile 的 timeout 是毫秒，配置里写的是秒（踩过：600 直接把 Demucs 0.6 秒杀了）
      cwd: root, timeout: (Number(cfg.demucsTimeoutSecs) || 600) * 1000,
      env: { TORCH_HOME: modelDir, XDG_CACHE_HOME: modelDir, ...demucsEnv(modelDir) }
    });
    const stem = path.join(outDir, model, path.parse(src).name);
    const vocals = path.join(stem, 'vocals.wav');
    const inst = path.join(stem, 'no_vocals.wav');
    if (!fs.existsSync(vocals) || !fs.existsSync(inst)) throw new Error('Demucs 跑完了但没找到 stems');
    stats.separated += 1;
    const ms = Date.now() - t0;
    log?.event('song', `拆好了「${path.basename(src)}」：${(ms / 1000).toFixed(1)} 秒`);
    return { vocals, instrumental: inst, ms };
  }

  // 从 B站标题 / 用户点歌的话里，抠出一个干净的中文歌名，用来给成品文件命名。
  // 例：「【Hi-Res无损音质】｜《晴天》- 周杰伦 -‘故事的小黄花’」→「晴天」
  //     「晴天 周杰伦」→「晴天-周杰伦」
  function cleanSongName(raw) {
    let s = String(raw || '').trim();
    if (!s) return '';
    const book = s.match(/《([^》]{1,30})》/);
    if (book) return book[1].replace(/[\\/:*?"<>|]/g, '_').trim();
    s = s
      .replace(/【[^】]*】|\[[^\]]*\]|（[^）]*）|\([^)]*\)/g, ' ')
      .replace(/无损|音质|hi-?res|高音质|完整版|官方|动态歌词|歌词版|合集|4k|60p|hd|mv|翻唱|伴奏|纯音乐/gi, ' ')
      .replace(/[｜|/\\、,，。·•"'“”‘’]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    s = s.replace(/^[-—–·\s]+|[-—–·\s]+$/g, '');
    const parts = s.split(' ').filter(Boolean).slice(0, 3);
    return parts.join('-').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);
  }

  /** 成品文件名：唱歌-歌曲名-她-60秒-1830.wav（中文、能一眼看出是什么） */
  function songFileName({ title = '', seconds = 0, who = '她', at = Date.now() } = {}) {
    const d = new Date(at);
    const hhmm = `${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
    const name = cleanSongName(title) || '未命名';
    const secs = Number(seconds) > 0 ? `${Math.round(Number(seconds))}秒` : '';
    return ['唱歌', name, who, secs, hhmm].filter(Boolean).join('-') + '.wav';
  }

  // 换声服务现在用哪个模型（her / hutao）。缓存键必须带上它：
  // 否则换了模型，之前用旧模型唱过的歌会直接命中缓存，听到的还是旧音色（踩过）。
  let modelTag = '';
  async function currentModelTag() {
    // 测试/离线时可以直接给一个固定标签，别逼着单测去依赖 9885 在跑
    if (injectedModelTag) return String(injectedModelTag);
    if (modelTag) return modelTag;
    try {
      const r = await fetchImpl(rvcEndpoint + '/health', { signal: AbortSignal.timeout(8000) });
      const j = await r.json();
      modelTag = String(j.voice || j.model || 'unknown');
    } catch { modelTag = 'unknown'; }
    return modelTag;
  }

  /**
   * 该升/降几个半音，才能把这段人声移到"她的音区"。
   * 目标：可爱少女音大概在 280~320 Hz；男声原曲常在 120~180 Hz，
   * 不升调的话换成她的音色也还是男 key，听着就不甜了。
   * 纯函数，单测直接验；f0 拿不到就返回 0（不升调）。
   */
  /**
   * 纯函数，单测直接验；f0 拿不到就返回 0（不升调）。
   * ceiling：高音天花板。升调后"高频段（p90）"不能超过它 ——
   * 高音被推太高会超出模型训练音域，表现就是**高音发颤/发抖**（用户反馈过）。
   */
  function semitonesFor(f0Median, { target = 300, maxUp = 12, maxDown = 4, p90 = 0, ceiling = 0 } = {}) {
    const v = Number(f0Median);
    const t = Number(target);
    if (!Number.isFinite(v) || v <= 0 || !Number.isFinite(t) || t <= 0) return 0;
    const raw = 12 * Math.log2(t / v);
    let n = Math.round(raw);
    // 高音天花板：p90 升完不能超过 ceiling，否则压低升调量
    const hi = Number(p90);
    const cap = Number(ceiling);
    if (Number.isFinite(hi) && hi > 0 && Number.isFinite(cap) && cap > 0) {
      const maxByCeiling = Math.floor(12 * Math.log2(cap / hi));
      if (maxByCeiling >= 0 && maxByCeiling < n) n = maxByCeiling;
    }
    return Math.max(-Math.abs(maxDown), Math.min(Math.abs(maxUp), n));
  }

  /** 让 9885 估一下这段人声的音高；返回 { median, p10, p90 }，失败返回 null */
  async function estimateF0(file) {
    try {
      const buf = fs.readFileSync(file);
      const form = new FormData();
      form.append('audio', new Blob([buf], { type: 'audio/wav' }), 'vocals.wav');
      const r = await fetchImpl(`${rvcEndpoint}/f0`, { method: 'POST', body: form, signal: AbortSignal.timeout(180_000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      if (!j || !j.ok || !(Number(j.median) > 0)) return null;
      return { median: Number(j.median), p10: Number(j.p10) || 0, p90: Number(j.p90) || 0, method: j.method || '' };
    } catch (e) {
      log?.event('song', `音高没估出来（不升调）：${e.message}`);
      return null;
    }
  }

  /** 人声换成她的音色（走 RVC 换声服务，默认 9885）；pitch=null 时按原曲音高自动算升调 */
  async function convertVocal(vocalsFile, { pitch = null, filterRadius = null, volumeEnvelope = null } = {}) {
    if (ensureRvc) { try { await ensureRvc(); } catch (e) { log?.event('song', `拉起换声服务出错：${e.message}`); } }
    let usePitch = pitch;
    if (usePitch === null || usePitch === undefined) {
      if (cfg.songAutoPitch === false) {
        usePitch = 0;
      } else {
        const f0 = await estimateF0(vocalsFile);
        usePitch = f0 ? semitonesFor(f0.median, {
          target: Number(cfg.songPitchTargetHz) || 300,
          maxUp: Number(cfg.songPitchMaxUp) ?? 7,
          maxDown: Number(cfg.songPitchMaxDown) ?? 4,
          p90: f0.p90,
          ceiling: Number(cfg.songPitchCeilingHz) || 0
        }) : 0;
        if (f0) log?.event('song', `原曲人声 ${Math.round(f0.median)} Hz（高音段 ${Math.round(f0.p90)} Hz）→ 升调 ${usePitch > 0 ? '+' : ''}${usePitch} 半音（目标 ${Number(cfg.songPitchTargetHz) || 300} Hz，高音上限 ${Number(cfg.songPitchCeilingHz) || 0} Hz）`);
      }
    }
    const buf = fs.readFileSync(vocalsFile);
    const form = new FormData();
    form.append('audio', new Blob([buf], { type: 'audio/wav' }), 'vocals.wav');
    const qs = new URLSearchParams();
    if (usePitch) qs.set('pitch', String(usePitch));
    const fr = Number(filterRadius ?? cfg.songFilterRadius);
    if (Number.isFinite(fr) && fr > 0) qs.set('filter_radius', String(Math.round(fr)));
    const ve = Number(volumeEnvelope ?? cfg.songVolumeEnvelope);
    if (Number.isFinite(ve)) qs.set('volume_envelope', String(ve));
    // 高音发颤：f0_autotune 把音高吸附到音阶上，能压住发飘
    if (cfg.songF0Autotune !== false) {
      qs.set('f0_autotune', '1');
      qs.set('f0_autotune_strength', String(Number(cfg.songF0AutotuneStrength ?? 0.6)));
    }
    const q = qs.toString() ? '?' + qs.toString() : '';
    const r = await fetchImpl(`${rvcEndpoint}/convert${q}`, { method: 'POST', body: form, signal: AbortSignal.timeout(20 * 60 * 1000) });
    if (!r.ok) throw new Error(`RVC HTTP ${r.status}`);
    const out = Buffer.from(await r.arrayBuffer());
    if (out.length < 2000) throw new Error('RVC 返回的音频太小');
    const dst = path.join(outDir, `vocal-her-${Date.now()}.wav`);
    fs.writeFileSync(dst, out);
    return dst;
  }

  /**
   * 混音增益（纯函数，单测直接验）。
   * 为什么要算：官方伴奏通常是人声轨的 -10 dBFS 级别，人声干声却常常很小，
   * 直接 volume=1.0/1.15 叠上去就是"伴奏盖住人声"（用户反馈过"伴奏太大声"）。
   * 做法：人声拉到 targetVocalDb，伴奏固定在它下面 accompOffsetDb。
   */
  function mixGains(vocalDb, backDb, { vocalTarget = -16, accompOffset = 6, maxGain = 24 } = {}) {
    const v = Number(vocalDb);
    const b = Number(backDb);
    const t = Number(vocalTarget);
    const off = Number(accompOffset);
    if (!Number.isFinite(v) || !Number.isFinite(t)) return { vocalGainDb: 0, accompGainDb: 0 };
    const clamp = (x) => Math.max(-maxGain, Math.min(maxGain, x));
    const vocalGainDb = clamp(t - v);
    const accompGainDb = Number.isFinite(b) ? clamp((t - off) - b) : -off;
    return { vocalGainDb: Math.round(vocalGainDb * 10) / 10, accompGainDb: Math.round(accompGainDb * 10) / 10 };
  }

  /** 量一段音频的平均响度（dBFS）；失败返回 NaN */
  async function measureDb(file) {
    try {
      const ff = String(cfg.ffmpegPath || 'ffmpeg');
      const { stderr } = await RUN(ff, ['-hide_banner', '-nostats', '-i', file, '-af', 'volumedetect', '-f', 'null', '-'], { timeout: 120_000 });
      const m = /mean_volume:\s*(-?\d+(?:\.\d+)?) dB/.exec(String(stderr || ''));
      return m ? Number(m[1]) : NaN;
    } catch { return NaN; }
  }

  /** 把伴奏也升/降调（rubberband 只改音高、不改速度）。人声升调而伴奏不动 = 必然跑调。 */
  async function shiftPitch(file, semis) {
    const n = Number(semis);
    if (!Number.isFinite(n) || n === 0) return file;
    const ratio = Math.pow(2, n / 12);
    const ff = String(cfg.ffmpegPath || 'ffmpeg');
    const dst = path.join(outDir, `backing-shift-${Date.now()}.wav`);
    await RUN(ff, [
      '-y', '-loglevel', 'error', '-i', file,
      '-af', `rubberband=pitch=${ratio.toFixed(6)}:tempo=1`,
      '-ar', '44100', '-ac', '2', '-c:a', 'pcm_s16le', dst
    ], { timeout: 300_000 });
    return dst;
  }

  /**
   * 唱这首歌：拆 → 换声 →（升调时伴奏一起升）→ 按响度配平混音。
   */
  async function singSongUncached({ file, name = '', keepStems = true, accompanyFile = '', title = '' } = {}) {
    const src = resolve(file || name);
    const t0 = Date.now();
    try {
      const { vocals, instrumental, ms } = await separate(src);
      // 给干声目录留个 meta：控制台「RVC 调音台」靠它显示歌名，而不是 song-1792xxx
      try {
        fs.writeFileSync(path.join(path.dirname(vocals), 'meta.json'), JSON.stringify({
          title: cleanSongName(title) || '',          // 歌名（调音台和文件名都用它）
          source: path.basename(src), file: src, at: Date.now()
        }, null, 2));
      } catch { /* 写不进去不影响主流程 */ }
      // 官方伴奏优先：它本来就是纯伴奏，不用从原曲里拆
      const backing = accompanyFile && fs.existsSync(accompanyFile) ? accompanyFile : instrumental;

      // 1) 要不要升调（升调就必须把伴奏一起升，否则整首歌跑调 —— 用户反馈过）
      let semis = 0;
      const mode = String(cfg.songPitchMode || 'both');
      if (cfg.songAutoPitch !== false && mode !== 'off') {
        const f0 = await estimateF0(vocals);
        if (f0) {
          semis = semitonesFor(f0.median, {
            target: Number(cfg.songPitchTargetHz) || 300,
            maxUp: Number(cfg.songPitchMaxUp) ?? 7,
            maxDown: Number(cfg.songPitchMaxDown) ?? 4,
            p90: f0.p90,
            ceiling: Number(cfg.songPitchCeilingHz) || 0
          });
          log?.event('song', `原曲人声 ${Math.round(f0.median)} Hz（高音段 ${Math.round(f0.p90)} Hz）→ 升调 ${semis > 0 ? '+' : ''}${semis} 半音（目标 ${Number(cfg.songPitchTargetHz) || 300} Hz，高音上限 ${Number(cfg.songPitchCeilingHz) || 0} Hz；伴奏一起升，避免跑调）`);
        }
      }

      // 2) 换声（在目标音高上直接生成，不靠事后变速）
      let her = null;
      let voiceErr = '';
      try { her = await convertVocal(vocals, { pitch: semis }); }
      catch (e) { voiceErr = e.message; log?.event('song', `换声没成，用原人声：${e.message}`); stats.errors += 1; }

      // 3) 伴奏跟着升调
      let backingForMix = backing;
      if (semis !== 0) {
        try { backingForMix = await shiftPitch(backing, semis); log?.event('song', `伴奏同步升调 ${semis > 0 ? '+' : ''}${semis} 半音`); }
        catch (e) { log?.event('song', `伴奏升调失败（会跑调，退回不升）：${e.message}`); semis = 0; her = null; }
      }

      // 4) 按响度配平：人声拉到目标，伴奏固定压在它下面
      const vocalStem = her || vocals;
      const vDb = await measureDb(vocalStem);
      const bDb = await measureDb(backingForMix);
      const { vocalGainDb, accompGainDb } = mixGains(vDb, bDb, {
        vocalTarget: Number(cfg.songVocalTargetDb) || -16,
        accompOffset: Number(cfg.songAccompOffsetDb) ?? 6
      });
      log?.event('song', `配平：人声 ${Number.isFinite(vDb) ? vDb.toFixed(1) : '?'} dB → ${vocalGainDb > 0 ? '+' : ''}${vocalGainDb} dB；伴奏 ${Number.isFinite(bDb) ? bDb.toFixed(1) : '?'} dB → ${accompGainDb > 0 ? '+' : ''}${accompGainDb} dB（伴奏比人声低 ${Number(cfg.songAccompOffsetDb) ?? 6} dB）`);

      // 成品放 data/media/tts：控制台的 /api/voices/file?dir=tts 才取得出来
      const mediaDir = path.join(dataDir, 'media', 'tts');
      fs.mkdirSync(mediaDir, { recursive: true });
      const out = path.join(mediaDir, `her-song-${Date.now()}.wav`);
      const ff = String(cfg.ffmpegPath || 'ffmpeg');
      await RUN(ff, [
        '-y', '-loglevel', 'error',
        '-i', backingForMix, '-i', vocalStem,
        '-filter_complex', `[0:a]volume=${accompGainDb}dB[i];[1:a]volume=${vocalGainDb}dB[v];[i][v]amix=inputs=2:duration=longest:normalize=0:dropout_transition=0,alimiter=limit=0.95[out]`,
        '-map', '[out]', '-ar', '44100', '-ac', '2', '-c:a', 'pcm_s16le', out
      ], { timeout: 300_000 });
      if (!keepStems) { try { fs.rmSync(vocals, { force: true }); fs.rmSync(instrumental, { force: true }); } catch { /* ignore */ } }
      const bytes0 = fs.statSync(out).size;
      const secs0 = Math.max(0, (bytes0 - 44) / (44100 * 2 * 2));
      // 成品改成中文名：唱歌-晴天-周杰伦-她-60秒-1830.wav
      let finalFile = out;
      try {
        const cn = songFileName({ title: title || path.parse(src).name, seconds: secs0, who: '她' });
        const dst = path.join(path.dirname(out), cn);
        fs.renameSync(out, dst);
        finalFile = dst;
      } catch (e) { log?.event('song', '中文文件名没改成（不影响成品）：' + e.message); }
      const bytes = fs.statSync(finalFile).size;
      const seconds = Math.max(0, (bytes - 44) / (44100 * 2 * 2));
      stats.sung += 1;
      log?.event('song', `唱完了「${path.basename(src)}」：${seconds.toFixed(1)} 秒，换声${her ? '成功' : '失败'}，升调${semis > 0 ? '+' : ''}${semis}，总耗时 ${((Date.now() - t0) / 1000).toFixed(0)} 秒`);
      return {
        ok: true, file: finalFile, bytes, seconds: Math.round(seconds * 10) / 10, name: path.basename(finalFile),
        source: path.basename(src), voiced: !!her, voiceErr, pitch: semis,
        stems: { vocals, instrumental }, separateMs: ms
      };
    } catch (e) {
      stats.errors += 1;
      throw e;
    }
  }

  /**
   * 唱一首本地歌（带缓存）：同一首歌 + 同一份伴奏 + 源文件没换过 → 直接回上次的成品。
   * 第二条"再唱一次晴天"必须是秒回，不能让人再等几分钟。
   */
  async function singSong(opts = {}) {
    const src = resolve(opts.file || opts.name);
    const mt = (() => { try { return Math.round(fs.statSync(src).mtimeMs); } catch { return 0; } })();
    const acc = (() => {
      const f = opts.accompanyFile;
      if (!f || !fs.existsSync(f)) return '';
      try { return `${path.basename(f)}|${Math.round(fs.statSync(f).mtimeMs)}`; } catch { return ''; }
    })();
    const key = `local|${src}|${mt}|${acc}|${await currentModelTag()}|${RENDER_VERSION}`;
    const hit = cacheGet(key);
    if (hit) {
      log?.event('song', `缓存命中，不再重跑：「${path.basename(src)}」`);
      return { ...hit, cached: true };
    }
    if (opts.prune !== false) pruneClips();
    const r = await singSongUncached({ ...opts, file: src });
    cachePut(key, r);
    return r;
  }

  /**
   * 从 QQ音乐拿歌再唱：下载（要登录 cookie）→ 拆人声/伴奏 → 换声 → 保留原伴奏混回去。
   * 这条是"人声替换、保留伴奏"的完整链路。
   */
  async function singQq({ text = '', mid = '', cookie = '', accomp = false } = {}) {
    if (!qqMusic) throw new Error('QQ音乐模块没挂载');
    // 要"官方伴奏"的话：先看有没有伴奏条目，能下就用它当伴奏（比 Demucs 拆出来的干净）
    let accompFile = '';
    if (accomp) {
      try {
        const found = await qqMusic.searchAccomp(text, 3);
        const best = (found.songs || [])[0];
        if (best) {
          const d = await qqMusic.download({ mid: best.mid, text: best.name, cookie });
          accompFile = d.file;
          log?.event('song', `官方伴奏下好了「${best.name}」`);
        } else {
          log?.event('song', '没搜到官方伴奏，改用 Demucs 从原曲拆');
        }
      } catch (e) { log?.event('song', `伴奏没下成（改用 Demucs 拆）：${e.message}`); }
    }
    const got = await qqMusic.download({ text, mid, cookie });
    log?.event('song', `QQ音乐下好了「${got.title}」：${Math.round(got.bytes / 1024)} KB`);
    const r = await singSongUncached({ file: got.file, accompanyFile: accompFile, title: cleanSongName(got.title) || text });
    return { ...r, source: got.title, from: 'qqmusic', downloaded: got.name, officialAccomp: !!accompFile };
  }
  /**
   * 从 B站 抓歌再唱（不需要任何登录）：原曲 → Demucs 拆人声 → RVC 换声 → 配 B站上的官方伴奏。
   * seconds 只处理一段（默认 40 秒）：RVC 在 CPU 上约 5 倍实时，整首 5 分钟要跑半小时。
   */
  async function singBiliUncached({ text = '', seconds = 60, accomp = true, offset = -1 } = {}) {
    // 注意：别把参数命名成 bili —— 会把外层的 bili 模块变量遮住（踩过一次）
    if (!bili) throw new Error('B站模块没挂载');
    const got = await bili.fetchSong(text, { accomp });
    log?.event('song', `B站抓到了：${got.song.title.slice(0, 30)}${got.accomp ? ' + 伴奏' : '（无伴奏，用 Demucs 拆）'}`);
    const ff = String(cfg.ffmpegPath || 'ffmpeg');
    // seconds=0 → 整首（RVC 大约 2~4 分钟）；默认 60 秒，出片快
    const want = Number(seconds);
    const take = want === 0 ? Math.round(got.song.duration) : Math.max(10, Math.min(300, want || 60));
    const start = offset >= 0 ? Number(offset) : Math.max(0, Math.round(Math.min(got.song.duration, got.accomp?.duration || got.song.duration) * 0.25) - 10);
    const clipDir = path.join(demucsRoot(), 'clips');
    fs.mkdirSync(clipDir, { recursive: true });
    const tag = Date.now();
    const songClip = path.join(clipDir, `song-${tag}.wav`);
    await RUN(ff, ['-y', '-loglevel', 'error', '-ss', String(start), '-t', String(take), '-i', got.song.file, '-ar', '44100', '-ac', '2', '-c:a', 'pcm_s16le', songClip], { timeout: 180_000 });
    let accClip = '';
    if (got.accomp) {
      accClip = path.join(clipDir, `acc-${tag}.wav`);
      await RUN(ff, ['-y', '-loglevel', 'error', '-ss', String(start), '-t', String(take), '-i', got.accomp.file, '-ar', '44100', '-ac', '2', '-c:a', 'pcm_s16le', accClip], { timeout: 180_000 });
    }
    const r = await singSongUncached({ file: songClip, accompanyFile: accClip, title: cleanSongName(text) || cleanSongName(got.song.title) });
    const dur = Math.max(0, (fs.statSync(r.file).size - 44) / (44100 * 2 * 2));
    return { ...r, seconds: Math.round(dur * 10) / 10, source: got.song.title, from: 'bili', officialAccomp: !!accClip, start, take };
  }

  /**
   * 从 B站 抓歌再唱（带缓存）：同一句点歌 + 同样的秒数/伴奏设置 → 秒回上次的成品。
   */
  async function singBili(opts = {}) {
    const text = String(opts.text || '').trim();
    const seconds = Number(opts.seconds ?? 60) || 0;
    const accomp = opts.accomp !== false;
    const offset = Number(opts.offset ?? -1);
    if (!text) throw new Error('要点哪首歌？给我个歌名');
    const key = `bili|${text}|${seconds}|${accomp ? 1 : 0}|${offset}|${await currentModelTag()}|${RENDER_VERSION}`;
    const hit = cacheGet(key);
    if (hit) {
      log?.event('song', `缓存命中，不再重跑：「${text}」`);
      return { ...hit, cached: true };
    }
    pruneClips();
    const r = await singBiliUncached({ text, seconds, accomp, offset });
    cachePut(key, r);
    return r;
  }

  return { singSong, singQq, singBili, separate, convertVocal, semitonesFor, estimateF0, mixGains, measureDb, shiftPitch, list, resolve, stats, pruneClips, cacheGet, cacheFile, renderVersion: RENDER_VERSION, cleanSongName, songFileName, dirs: { demucsDir, modelDir, songsDir, outDir } };
};
