// 唱歌：用她自己的克隆音色把歌词"唱"出来（带节奏、带伴奏）。
//
// 做法（不依赖任何新模型，就地用现有 TTS + ffmpeg + 一段纯 JS 合成）：
//   1) 每个字单独合成一小段（缓存在磁盘，重复字直接复用）
//   2) 按旋律把每段做变调，再按拍子做时长对齐（atempo）—— 这一步才有"节奏"
//   3) 用 JS 直接算一段伴奏（和弦垫 + 低音 + 底鼓 + 沙锤），和干声混在一起 —— 这一步才有"背景音"
//   4) 可选：过一遍 RVC 换音色（只换干声，不碰伴奏）
//
// 旋律用"相对半音 + 每音几拍"表示，换调只改 base 一个数。
// chords 是按小节给的根音（大三和弦），伴奏就按它铺。

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';

export const TUNES = {
  小星星: {
    notes: [0, 0, 7, 7, 9, 9, 7, 5, 5, 4, 4, 2, 2, 0],
    beats: [1, 1, 1, 1, 1, 1, 2, 1, 1, 1, 1, 1, 1, 2],
    chords: [0, 0, 5, 0, 5, 0, 7, 0]
  },
  生日快乐: {
    notes: [0, 0, 2, 0, 5, 4, 0, 0, 2, 0, 7, 5, 0, 0, 12, 9, 5, 4, 2],
    beats: [0.75, 0.25, 1, 1, 1, 2, 0.75, 0.25, 1, 1, 1, 2, 0.75, 0.25, 1, 1, 1, 1, 3],
    chords: [0, 0, 0, 0, 7, 0, 0, 0, 7, 0]
  },
  两只老虎: {
    notes: [0, 2, 4, 0, 0, 2, 4, 0, 4, 5, 7, 4, 5, 7],
    beats: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 1, 1, 2],
    chords: [0, 0, 0, 0, 7, 0, 0, 0]
  },
  欢乐颂: {
    notes: [4, 4, 5, 7, 7, 5, 4, 2, 0, 0, 2, 4, 4, 2, 2],
    beats: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1.5, 0.5, 2],
    chords: [0, 0, 0, 0, 7, 0, 0, 0]
  }
};

// 兼容老写法：数组 = 只有音高，一律按一拍算
export function tuneOf(tune) {
  if (Array.isArray(tune)) return { notes: tune.map(Number), beats: tune.map(() => 1), chords: [0] };
  if (typeof tune === 'string' && TUNES[tune]) return TUNES[tune];
  if (typeof tune === 'string' && /^[-\d,\s]+$/.test(tune)) {
    const notes = tune.split(',').map(Number).filter(Number.isFinite);
    return { notes, beats: notes.map(() => 1), chords: [0] };
  }
  return TUNES['小星星'];
}

const SR = 22050;
const BEAT_MS = 420;          // 一拍多长（约 143 BPM，适合儿歌）
const NOTE_HZ = (semi, base = 261.63) => base * Math.pow(2, semi / 12);

function run(ff, args, { timeout = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(ff, args, { timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024, encoding: 'buffer' },
      (err, stdout) => (err ? reject(new Error(String(err.message).slice(0, 160))) : resolve(stdout)));
  });
}

export function createSing({ cfg = {}, ttsDir, voiceDir, log = null, fetchImpl = globalThis.fetch, ffmpegPath = 'ffmpeg', ffprobePath = 'ffprobe', ensureRvc = null } = {}) {
  const rvcEndpoint = String(cfg.singRvcEndpoint || 'http://127.0.0.1:9885').replace(/\/+$/, '');
  const charDir = path.join(path.dirname(voiceDir || ttsDir), 'sing-chars');
  fs.mkdirSync(charDir, { recursive: true });
  const stats = { songs: 0, chars: 0, cached: 0 };

  /** 某个字的一小段音频（缓存） */
  async function charClip(ch) {
    const key = createHash('sha1').update(ch + '|' + String(cfg.ttsRefAudio || '') + '|' + String(cfg.ttsEndpoint || '')).digest('hex').slice(0, 12);
    const file = path.join(charDir, `${key}.wav`);
    if (fs.existsSync(file) && fs.statSync(file).size > 1000) { stats.cached += 1; return file; }
    const endpoint = String(cfg.ttsEndpoint || 'http://127.0.0.1:9883').replace(/\/+$/, '').replace(/\/tts$/, '') + '/tts';
    // 两种本地服务都要能喂：
    //   GPT-SoVITS api_v2 要一整套字段（缺 text_lang 直接 400）
    //   IndexTTS 那层只认 text/speed_factor 之类，多给会 400
    // 所以先发全字段，400 了再退最简
    const full = {
      text: ch,
      text_lang: 'zh',
      ref_audio_path: String(cfg.ttsRefAudio || ''),
      prompt_text: String(cfg.ttsRefText || ''),
      prompt_lang: 'zh',
      text_split_method: 'cut5',
      batch_size: 1,
      media_type: 'wav',
      streaming_mode: false,
      speed_factor: 1.0,
      temperature: Number(cfg.ttsTemperature) || 1.0
    };
    const post = (payload) => fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(Number(cfg.ttsTimeoutSecs || 60) * 1000),
      body: JSON.stringify(payload)
    });
    let r = await post(full);
    if (!r.ok) {
      try { await r.body?.cancel(); } catch { /* ignore */ }
      log?.event('sing', `引擎不接受全字段（HTTP ${r.status}），改用最简字段`);
      r = await post({ text: ch, ref_audio_path: String(cfg.ttsRefAudio || ''), prompt_text: String(cfg.ttsRefText || ''), speed_factor: 1.0 });
    }
    if (!r.ok) throw new Error(`合成「${ch}」失败：HTTP ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 1000) throw new Error(`合成「${ch}」失败：音频太小`);
    fs.writeFileSync(file, buf);
    stats.chars += 1;
    return file;
  }

  /**
   * 把一个字处理成"一个音符"：去掉首尾静音 → 变调 → 把内容拉伸到目标拍长。
   *
   * 以前的两个毛病（用户反馈"字音不连续、很死板、发音只有一下"）：
   *   1 TTS 单字前后各带 100~200 ms 空白，直接拼起来就是"一个字蹦一下"
   *   2 用 atrim 硬切到目标时长 —— 字还没唱完就被剪断，只剩个开头（"只有一下"）
   * 现在：先用 silenceremove 去掉空白，再拿"内容"去对齐拍长；不再硬切，
   * 拼接时用 25 ms 交叉淡化（见 assemblePieces），字和字之间是连着的。
   */
  async function voiceNote(src, semis, targetMs, out) {
    const ratio = Math.pow(2, semis / 12);
    // 先去静音，拿到真正的"字内容"多长
    const trimmed = out.replace(/\.wav$/, '-trim.wav');
    const trimF = 'silenceremove=start_periods=1:start_duration=0:start_threshold=-45dB:stop_periods=1:stop_duration=0.05:stop_threshold=-45dB';
    await run(ffmpegPath, ['-y', '-loglevel', 'error', '-i', src, '-af', trimF, '-ar', String(SR), '-ac', '1', '-c:a', 'pcm_s16le', trimmed]);
    let curMs = 0;
    try { curMs = await durationMs(trimmed); } catch { curMs = 0; }
    if (!(curMs > 60)) {   // 去静音去掉太多（很短的音），退回原始片段
      fs.copyFileSync(src, trimmed);
      try { curMs = await durationMs(trimmed); } catch { curMs = 0; }
    }
    const tempo = (curMs > 60 && targetMs > 60) ? Math.max(0.25, Math.min(3.5, curMs / targetMs)) : 1;
    // 只在结尾加极短淡出（8ms），不做 atrim —— 让字自己唱完，靠后续交叉淡化接上下一字
    const tail = `afade=t=in:st=0:d=0.004,afade=t=out:st=${Math.max(0, (curMs / tempo - 12) / 1000).toFixed(3)}:d=0.012`;
    if (process.env.SING_DEBUG) {
      console.log('[voiceNote] semis=' + semis + ' ratio=' + ratio.toFixed(3) + ' contentMs=' + Math.round(curMs)
        + ' targetMs=' + Math.round(targetMs) + ' tempo=' + tempo.toFixed(3) + ' engine=' + (hasRubberband() ? 'rubberband' : 'asetrate'));
    }
    if (hasRubberband()) {
      const f = `rubberband=pitch=${ratio.toFixed(6)}:tempo=${tempo.toFixed(6)}:transients=smooth:detector=compound:phase=independent`;
      try {
        await run(ffmpegPath, ['-y', '-loglevel', 'error', '-i', trimmed, '-af', `${f},${tail}`, '-ar', String(SR), '-ac', '1', '-c:a', 'pcm_s16le', out]);
        try { fs.rmSync(trimmed, { force: true }); } catch { /* ignore */ }
        return out;
      } catch (e) {
        rbCache = false;
        log?.event('sing', `rubberband 不可用，退回 asetrate：${e.message.slice(0, 60)}`);
      }
    }
    const filters = [];
    if (semis) filters.push(`asetrate=${Math.round(SR * ratio)},aresample=${SR}`);
    const at = (curMs > 60 && targetMs > 60) ? Math.max(0.5, Math.min(2, (curMs / (semis ? ratio : 1)) / targetMs)) : 1;
    filters.push(`atempo=${at.toFixed(6)}`, tail);
    await run(ffmpegPath, ['-y', '-loglevel', 'error', '-i', trimmed, '-af', filters.join(','), '-ar', String(SR), '-ac', '1', '-c:a', 'pcm_s16le', out]);
    try { fs.rmSync(trimmed, { force: true }); } catch { /* ignore */ }
    return out;
  }

  /**
   * 把每个音符的 PCM 拼成一条连续的声线：相邻两段重叠 25 ms 做线性交叉淡化。
   * 这样字与字之间是"滑过去"的，不是"一格一格蹦"。
   */
  function assemblePieces(files, outFile, overlapMs = 25) {
    const list = files.filter((f) => {
      if (typeof f === 'string' && f && fs.existsSync(f)) return true;
      log?.event('sing', `跳过一段无效音频：${String(f)}`);
      return false;
    });
    const bufs = list.map((f) => {
      const b = fs.readFileSync(f);
      return b.subarray(b.indexOf('data') + 8);
    });
    if (!bufs.length) throw new Error('没有可拼接的音频（每个字都没处理成功）');
    const overlap = Math.max(0, Math.round((overlapMs / 1000) * SR));
    let total = 0;
    for (const b of bufs) total += b.length / 2;
    total -= overlap * (bufs.length - 1);
    const pcm = Buffer.alloc(Math.max(0, total) * 2);
    let pos = 0;
    for (let k = 0; k < bufs.length; k += 1) {
      const b = bufs[k];
      const n = b.length / 2;
      const start = Math.max(0, pos);
      for (let i = 0; i < n; i += 1) {
        const dst = start + i;
        if (dst * 2 + 1 >= pcm.length) break;
        let v = b.readInt16LE(i * 2);
        // 交叉淡化：本段开头那段和上一段的尾巴渐变混合
        if (k > 0 && i < overlap) v = Math.round(v * (i / overlap) + pcm.readInt16LE(dst * 2) * (1 - i / overlap));
        v = Math.max(-32767, Math.min(32767, v));
        pcm.writeInt16LE(v, dst * 2);
      }
      pos = start + n - overlap;
    }
    const header = Buffer.alloc(44);
    header.write('RIFF'); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVEfmt ', 8);
    header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
    header.writeUInt32LE(SR, 24); header.writeUInt32LE(SR * 2, 28);
    header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36);
    header.writeUInt32LE(pcm.length, 40);
    fs.writeFileSync(outFile, Buffer.concat([header, pcm]));
    return outFile;
  }

  /** 这台 ffmpeg 有没有 rubberband（第一次问一下，之后记住） */
  let rbCache = null;
  function hasRubberband() {
    if (rbCache !== null) return rbCache;
    rbCache = true;   // 先假设有；真失败时在 voiceNote 里置 false
    return rbCache;
  }

  /**
   * 逐音换声：请求 RVC 时带上 pitch（半音），让模型自己把这个字重唱到目标音高。
   * 共振峰由模型生成，所以不会出现"元音跟着音高一起抬高"的变声器味。
   * 回来的是 40 kHz，再按拍子对齐时长。
   */
  async function voiceNoteRvc(clip, semis, targetMs, out) {
    const buf = fs.readFileSync(clip);
    const form = new FormData();
    form.append('audio', new Blob([buf], { type: 'audio/wav' }), 'note.wav');
    if (ensureRvc) { try { await ensureRvc(); } catch (e) { log?.event('sing', `拉起换声服务出错：${e.message}`); } }
    const url = `${rvcEndpoint}/convert?pitch=${Math.round(semis)}`;
    const r = await fetchImpl(url, { method: 'POST', body: form, signal: AbortSignal.timeout(120_000) });
    if (!r.ok) throw new Error(`RVC HTTP ${r.status}`);
    const converted = Buffer.from(await r.arrayBuffer());
    if (converted.length < 2000) throw new Error('RVC 返回的音频太小');
    const tmp = out.replace(/\.wav$/, '-rvc.wav');
    fs.writeFileSync(tmp, converted);
    // 去首尾静音 → 把内容拉伸到目标拍长；不硬切（硬切会让每个字只剩个开头）
    const trimmed = out.replace(/\.wav$/, '-rvctrim.wav');
    await run(ffmpegPath, ['-y', '-loglevel', 'error', '-i', tmp,
      '-af', 'silenceremove=start_periods=1:start_duration=0:start_threshold=-45dB:stop_periods=1:stop_duration=0.05:stop_threshold=-45dB',
      '-ar', String(SR), '-ac', '1', '-c:a', 'pcm_s16le', trimmed]);
    let curMs = 0;
    try { curMs = await durationMs(trimmed); } catch { curMs = 0; }
    if (!(curMs > 60)) { fs.copyFileSync(tmp, trimmed); try { curMs = await durationMs(trimmed); } catch { curMs = 0; } }
    const tempo = (curMs > 60 && targetMs > 60) ? Math.max(0.25, Math.min(3.5, curMs / targetMs)) : 1;
    await run(ffmpegPath, [
      '-y', '-loglevel', 'error', '-i', trimmed,
      '-af', `atempo=${tempo.toFixed(6)},afade=t=in:st=0:d=0.004,afade=t=out:st=${Math.max(0, (curMs / tempo - 12) / 1000).toFixed(3)}:d=0.012`,
      '-ar', String(SR), '-ac', '1', '-c:a', 'pcm_s16le', out
    ]);
    try { fs.rmSync(trimmed, { force: true }); } catch { /* ignore */ }
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    return out;
  }
  async function durationMs(file) {
    const out = await run(ffmpegPath, ['-hide_banner', '-i', file, '-f', 'null', '-']).catch(() => null);
    // ffmpeg 把信息打在 stderr；execFile 只回了 stdout，所以改用 ffprobe 更稳
    void out;
    return new Promise((resolve, reject) => {
      execFile(ffprobePath, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file],
        { timeout: 20_000, windowsHide: true }, (err, stdout) => {
          if (err) return reject(new Error(err.message.slice(0, 120)));
          const s = Number(String(stdout).trim());
          resolve(Number.isFinite(s) ? s * 1000 : 0);
        });
    });
  }

  /**
   * 伴奏：直接用 JS 算一段 wav（和弦垫 + 低音 + 底鼓 + 沙锤）。
   * 为什么不找伴奏文件：她没有版权素材，而"按小节铺大三和弦 + 简单鼓点"已经够像伴奏了。
   */
  function buildBed({ notes, beats, chords, base = 0, totalMs }) {
    const n = Math.ceil((totalMs / 1000) * SR);
    const buf = new Float32Array(n);
    const beatSec = BEAT_MS / 1000;
    const barBeats = 4;
    // 每个音符的起止（拍）
    const starts = [];
    let acc = 0;
    for (let i = 0; i < beats.length; i += 1) { starts.push(acc); acc += beats[i]; }
    const totalBeats = acc;
    const bars = Math.max(1, Math.ceil(totalBeats / barBeats));
    for (let bar = 0; bar < bars; bar += 1) {
      const rootSemi = Number(chords[bar % chords.length] ?? 0) + Number(base || 0);
      const t0 = bar * barBeats * beatSec;
      const t1 = Math.min(totalMs / 1000, (bar + 1) * barBeats * beatSec);
      // 和弦垫：大三和弦（根、三、五）+ 高八度点缀
      for (const [semi, amp, det] of [[rootSemi, 0.10, 0], [rootSemi + 4, 0.075, 0.15], [rootSemi + 7, 0.075, -0.15], [rootSemi + 12, 0.04, 0]]) {
        const f = NOTE_HZ(semi) * (1 + det / 100);
        for (let i = Math.floor(t0 * SR); i < Math.min(n, Math.floor(t1 * SR)); i += 1) {
          const t = i / SR;
          const local = t - t0;
          const env = Math.min(1, local / 0.08) * Math.max(0, Math.min(1, (t1 - t) / 0.15)); // 起落淡入淡出
          buf[i] += amp * env * Math.sin(2 * Math.PI * f * t);
        }
      }
      // 低音：每小节第一拍
      {
        const f = NOTE_HZ(rootSemi - 12);
        for (let i = Math.floor(t0 * SR); i < Math.min(n, Math.floor((t0 + beatSec) * SR)); i += 1) {
          const t = i / SR, local = t - t0;
          buf[i] += 0.16 * Math.exp(-3.2 * local) * Math.sin(2 * Math.PI * f * t);
        }
      }
      // 底鼓：1、3 拍；沙锤：2、4 拍
      for (let b = 0; b < barBeats; b += 1) {
        const bt = t0 + b * beatSec;
        if (bt >= t1) break;
        const kick = b % 2 === 0;
        const len = kick ? 0.16 : 0.05;
        for (let i = Math.floor(bt * SR); i < Math.min(n, Math.floor((bt + len) * SR)); i += 1) {
          const local = i / SR - bt;
          if (kick) {
            const env = Math.exp(-22 * local);
            const f = 120 * Math.exp(-9 * local) + 45;       // 下滑的低频，像鼓
            buf[i] += 0.22 * env * Math.sin(2 * Math.PI * f * local);
          } else {
            const env = Math.exp(-60 * local);
            buf[i] += 0.07 * env * (Math.random() * 2 - 1);   // 噪声当沙锤
          }
        }
      }
    }
    // 归一化 + 淡出
    let peak = 0;
    for (let i = 0; i < n; i += 1) peak = Math.max(peak, Math.abs(buf[i]));
    const g = peak > 0 ? 0.5 / peak : 1;
    const fade = Math.min(n, Math.floor(SR * 0.25));
    const pcm = Buffer.alloc(44 + n * 2);
    pcm.write('RIFF'); pcm.writeUInt32LE(pcm.length - 8, 4); pcm.write('WAVEfmt ', 8);
    pcm.writeUInt32LE(16, 16); pcm.writeUInt16LE(1, 20); pcm.writeUInt16LE(1, 22);
    pcm.writeUInt32LE(SR, 24); pcm.writeUInt32LE(SR * 2, 28);
    pcm.writeUInt16LE(2, 32); pcm.writeUInt16LE(16, 34); pcm.write('data', 36);
    pcm.writeUInt32LE(n * 2, 40);
    for (let i = 0; i < n; i += 1) {
      let v = buf[i] * g;
      if (i > n - fade) v *= (n - i) / fade;
      pcm.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(v * 32767))), 44 + i * 2);
    }
    return pcm;
  }

  /**
   * 唱一句。
   * text 歌词（只取汉字/字母/数字，最多 16 个字）
   * tune 旋律名（见 TUNES）或直接给半音数组
   * base 整体升降调（半音），负数更低
   * music 要不要伴奏（默认要）；beatMs 一拍多少毫秒
   */
  async function sing({ text = '', tune = '小星星', base = 0, gapMs = 0, music = true, beatMs = null } = {}) {
    const chars = Array.from(String(text || '')).filter((c) => /[\u4e00-\u9fa5a-zA-Z0-9]/.test(c)).slice(0, 16);
    if (!chars.length) throw new Error('要唱什么？给一句歌词');
    const spec = tuneOf(tune);
    const notes = spec.notes.map(Number).filter(Number.isFinite);
    if (!notes.length) throw new Error('这个旋律不认识：' + tune);
    const beat = Math.max(160, Math.min(900, Number(beatMs) || BEAT_MS));
    const outDir = ttsDir;
    fs.mkdirSync(outDir, { recursive: true });
    const workDir = path.join(outDir, 'sing-work-' + Date.now());
    fs.mkdirSync(workDir, { recursive: true });
    const gap = path.join(workDir, 'gap.wav');
    fs.writeFileSync(gap, silenceWav(Math.max(0, Math.min(400, Number(gapMs) || 0))));

    const pieces = [];
    let rvcNoteCount = 0;
    let rbDisabled = false;
    try {
      // 拍子自动定：字长了还硬塞进 420ms 就得 atempo 1.9 倍压缩，听起来又急又尖。
      // 先量一遍这首歌要唱的每个字有多长，让"一拍 ≈ 一个字"，atempo 就基本落在 1 附近。
      const clipMs = [];
      for (const ch of chars) {
        const f = await charClip(ch);
        clipMs.push(await durationMs(f).catch(() => 0));
      }
      const usable = clipMs.filter((m) => m > 120).sort((a, b) => a - b);
      let autoBeat = beat;
      if (!beatMs && usable.length) {
        const median = usable[Math.floor(usable.length / 2)];
        // 大多数旋律是一拍一个字，取中位数做一拍；限制在 320~700，免得跳成念经或拖沓
        autoBeat = Math.max(320, Math.min(700, Math.round(median / 0.94)));
      }
      const useBeat = beatMs ? beat : autoBeat;
      for (let i = 0; i < chars.length; i += 1) {
        const idx = i % notes.length;
        const semi = Number(notes[idx]) + Number(base || 0);
        const beatsForNote = Number((spec.beats || [])[idx]) || 1;
        const targetMs = Math.max(140, Math.round(beatsForNote * useBeat * 0.94));   // 留 6% 气口
        const clip = await charClip(chars[i]);
        const shifted = path.join(workDir, `n${i}.wav`);
        // 逐音换声：把"原调的那个字"直接丢给 RVC，用它的 pitch 参数把音高升上去。
        // 这样音高是模型重唱的，共振峰由模型自己生成 —— 不会像 asetrate 那样把元音一起抬高（听感"变声器"）。
        const wantRvc = cfg.singRvcEnabled !== false;
        let piece = null;
        if (wantRvc) {
          try {
            piece = await voiceNoteRvc(clip, semi, targetMs, path.join(workDir, `n${i}.wav`));
            rvcNoteCount += 1;
          } catch (e) {
            if (rvcNoteCount === 0) log?.event('sing', `逐音换声没成，这次用变调：${e.message.slice(0, 60)}`);
            rbDisabled = true;
          }
        }
        if (!piece) piece = await voiceNote(clip, semi, targetMs, path.join(workDir, `n${i}.wav`));
        if (!piece) log?.event('sing', '第 ' + (i + 1) + ' 个字没处理出来：' + chars[i]);
        pieces.push(piece);
        if (gapMs > 0 && i < chars.length - 1) pieces.push(gap);
      }
      // 拼接：不再用 ffmpeg concat（那是首尾相接，每个字之间都是硬边），
      // 改成自己按 PCM 叠 25 ms 交叉淡化 —— 字与字之间是滑过去的，才连得住。
      const outVocal = path.join(outDir, `sing-${Date.now()}.wav`);
      let file = assemblePieces(pieces, outVocal, 45);
      const plainBytes = fs.statSync(file).size;
      const plainSeconds = Math.max(0, (plainBytes - 44) / (SR * 2));
      stats.songs += 1;
      let voiced = rvcNoteCount > 0;
      let rvcMs = 0;
      // 只有在逐音换声没成功时，才退回到"整段过一次 RVC"（否则会换两遍，音色更糊）
      if (cfg.singRvcEnabled !== false && !voiced) {
        try {
          const t0 = Date.now();
          const converted = await rvcConvert(file, workDir);
          if (converted) { file = converted; voiced = true; rvcMs = Date.now() - t0; }
        } catch (e) { log?.event('sing', `RVC 换声没成（用原声）：${e.message}`); }
      }
      // 伴奏：按旋律的小节铺和弦 + 鼓点，然后和干声混一起。
      // 顺序很重要：RVC 只该换"人声"，所以先换声、再铺伴奏（反过来会把鼓也换成胡桃的声音）。
      let withMusic = false;
      if (music !== false) {
        try {
          // 注意：人声这时候可能是 RVC 出来的 40 kHz 文件，不能拿 22050 硬算时长，
          // 否则伴奏会比人声长一倍（实测 3.16 秒的人声配出 6.1 秒的成品，唱完还在响）。
          const vocalMs = await durationMs(file).catch(() => (fs.statSync(file).size - 44) / 2 / SR * 1000);
          const bedMs = Math.round(vocalMs) + 350;
          const bedFile = path.join(workDir, 'bed.wav');
          fs.writeFileSync(bedFile, buildBed({ notes, beats: spec.beats, chords: spec.chords, base, totalMs: bedMs }));
          const mixed = path.join(outDir, `sing-mix-${Date.now()}.wav`);
          await run(ffmpegPath, [
            '-y', '-loglevel', 'error',
            '-i', file, '-i', bedFile,
            // 注意 normalize=0：amix 默认会把两路都压到 1/2，人声会凭空掉 6 dB，听起来"伴奏盖过人声/人声变闷"
            // 再 atrim 到「人声长度+尾巴」：伴奏不许比人声长太多，否则唱完还有一截干响
            '-filter_complex', `[0:a]volume=1.0[v];[1:a]volume=0.55[m];[v][m]amix=inputs=2:duration=longest:normalize=0:dropout_transition=0,atrim=0:${((Math.round(vocalMs) + 300) / 1000).toFixed(3)},alimiter=limit=0.95[out]`,
            '-map', '[out]', '-ar', String(SR), '-ac', '1', '-c:a', 'pcm_s16le', mixed
          ]);
          file = mixed;
          withMusic = true;
        } catch (e) { log?.event('sing', `铺伴奏没成（只有干声）：${e.message}`); }
      }
      const bytes = fs.statSync(file).size;
      // 时长按文件头里的真实采样率算（RVC 输出是 40000，不能拿 22050 硬算）
      let seconds = Math.max(0, (bytes - 44) / (SR * 2));
      try {
        const head = Buffer.alloc(44); const fd = fs.openSync(file, 'r');
        fs.readSync(fd, head, 0, 44, 0); fs.closeSync(fd);
        const rate = head.readUInt32LE(24) || SR;
        const ch = head.readUInt16LE(22) || 1;
        const bits = head.readUInt16LE(34) || 16;
        seconds = Math.max(0, (bytes - 44) / (rate * ch * (bits / 8)));
      } catch { /* 读不到头就用估算值 */ }
      log?.event('sing', '唱了「' + chars.join('') + '」：' + tuneName(tune) + '，' + seconds.toFixed(1) + ' 秒'
        + (rvcNoteCount ? '（逐音换声 ' + rvcNoteCount + ' 个）' : (voiced ? '（整段换声）' : '（原声）')));
      return { ok: true, file, bytes, seconds: Math.round(seconds * 10) / 10, chars: chars.join(''), tune: tuneName(tune), notes: chars.length, voiced, withMusic, plainSeconds: Math.round(plainSeconds * 10) / 10, rvcMs };
    } finally {
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  function tuneName(tune) {
    if (Array.isArray(tune)) return '自定义旋律';
    return TUNES[tune] ? tune : String(tune);
  }

  /**
   * 过一遍 RVC（Retrieval-based Voice Conversion）：
   * 旋律/节奏保留，音色换成训练好的模（你自己的 RVC 模型 .pth）。
   * 服务在 9885（CPU 模式：1 秒音频约 5 秒；GPU 模式实测反而 263 秒，所以别开 CUDA）。
   */
  async function rvcConvert(srcFile, workDir) {
    if (ensureRvc) { try { await ensureRvc(); } catch (e) { log?.event('sing', `拉起换声服务出错：${e.message}`); } }
    // 拼 multipart：Node 自带 FormData/Blob
    const buf = fs.readFileSync(srcFile);
    const form = new FormData();
    form.append('audio', new Blob([buf], { type: 'audio/wav' }), 'sing.wav');
    const r = await fetchImpl(`${rvcEndpoint}/convert`, {
      method: 'POST', body: form, signal: AbortSignal.timeout(15 * 60 * 1000)
    });
    if (!r.ok) throw new Error(`RVC HTTP ${r.status}`);
    const out = Buffer.from(await r.arrayBuffer());
    if (out.length < 2000) throw new Error('RVC 返回的音频太小');
    const dst = path.join(path.dirname(srcFile), `sing-rvc-${Date.now()}.wav`);
    fs.writeFileSync(dst, out);
    return dst;
  }

  return { sing, tunes: Object.keys(TUNES), stats };
}

/** 一小段静音（wav） */
function silenceWav(ms) {
  const samples = Math.max(1, Math.round((ms / 1000) * SR));
  const b = Buffer.alloc(44 + samples * 2);
  b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(SR, 24); b.writeUInt32LE(SR * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36);
  b.writeUInt32LE(b.length - 44, 40);
  return b;
}
