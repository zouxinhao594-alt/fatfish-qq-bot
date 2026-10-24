import { planCompact, compactSilence } from './compact.mjs';
import { joinPcm16 } from './pcm-compact.mjs';
import { planProsody } from './prosody.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';

const hash = value => createHash('sha256').update(value).digest('hex');
const number = (value, fallback, min, max) => Number.isFinite(Number(value))
  ? Math.min(max, Math.max(min, Number(value))) : fallback;
const MAX_BYTES = 32 * 1024 * 1024;

// 只接受完整的 PCM16 WAV，输出统一 WAV；时长上限在采样边界截断。
export function normalizeWav(buf, seconds = 60) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' ||
      buf.toString('ascii', 8, 12) !== 'WAVE' || buf.readUInt32LE(4) + 8 !== buf.length)
    throw new Error('不是完整 WAV');
  let fmt, audio;
  for (let p = 12; p + 8 <= buf.length;) {
    const size = buf.readUInt32LE(p + 4), end = p + 8 + size;
    if (end > buf.length) throw new Error('WAV 数据截断');
    const id = buf.toString('ascii', p, p + 4);
    if (id === 'fmt ') fmt = buf.subarray(p + 8, end);
    if (id === 'data') audio = buf.subarray(p + 8, end);
    p = end + (size & 1);
  }
  if (!fmt || fmt.length < 16 || !audio?.length || fmt.readUInt16LE(0) !== 1 ||
      fmt.readUInt16LE(14) !== 16) throw new Error('需要 PCM16 WAV');
  const channels = fmt.readUInt16LE(2), rate = fmt.readUInt32LE(4);
  const align = fmt.readUInt16LE(12), bytes = fmt.readUInt32LE(8);
  if (channels < 1 || channels > 2 || rate < 8000 || rate > 192000 ||
      align !== channels * 2 || bytes !== rate * align || audio.length % align)
    throw new Error('WAV 参数无效');
  const size = Math.min(audio.length, Math.floor(seconds * rate) * align);
  if (!size) throw new Error('WAV 没有音频');
  const out = Buffer.alloc(44 + size);
  out.write('RIFF'); out.writeUInt32LE(out.length - 8, 4); out.write('WAVEfmt ', 8);
  out.writeUInt32LE(16, 16); fmt.copy(out, 20, 0, 16);
  out.write('data', 36); out.writeUInt32LE(size, 40); audio.copy(out, 44, 0, size);
  return { buffer: out, ms: size / bytes * 1000 };
}

async function sapi({ text, file, voice, speed, timeout, prosody }) {
  if (process.platform !== 'win32') throw new Error('SAPI 需要 Windows');
  const quote = value => String(value).replace(/'/g, "''");
  const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Speech; $s=New-Object System.Speech.Synthesis.SpeechSynthesizer; try { if ('${quote(voice)}') { try { $s.SelectVoice('${quote(voice)}') } catch { $s.SelectVoice('Microsoft Huihui Desktop') } }; $s.Volume=${Math.round(100 * 10 ** ((prosody?.volumeDb || 0) / 20))}; $s.Rate=${Math.round(Math.log2(speed) * 10)}; $s.SetOutputToWaveFile('${quote(file)}'); $s.Speak('${quote(text)}') } finally { $s.Dispose() }`;
  await new Promise((resolve, reject) => execFile('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { windowsHide: true, timeout, maxBuffer: 65536 },
    error => error ? reject(new Error('SAPI 合成失败或超时')) : resolve()));
}

export function createTts({ cfg, dir, log, fetchImpl = globalThis.fetch, sapiImpl = sapi, runner = null, ensureEngine = null }) {
  dir = path.resolve(dir);
  fs.mkdirSync(dir, { recursive: true });
  const pending = new Map();
  // 串行执行合成，避免本地模型并行耗尽显存，也避免关闭缓存时共享临时文件。
  let tail = Promise.resolve();

  /**
   * 把本地语音服务拉起来（只有回环地址才允许，且只认我们自己装的那两个端口）。
   * 返回 true = 端口通了，可以重来一次；false = 拉不起来。
   * 触发场景：开机后计划任务是 Ready 但没跑，机器人这边只会看到 "fetch failed"，
   * 然后悄悄降级成 Windows 自带语音 —— 听起来就是"语音坏了"。
   */
  async function reviveLocalEngine(endpoint) {
    let url;
    try { url = new URL(String(endpoint || '')); } catch { return false; }
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return false;
    const port = Number(url.port || 80);
    const task = { 9883: 'FF-Voice-9883', 9882: 'FF-Voice-9882' }[port];
    if (!task) return false;
    const run = runner || ((args) => new Promise((resolve) => {
      execFile('schtasks', args, { windowsHide: true, timeout: 20_000 }, (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || '') + String(stderr || '') }));
    }));
    const start = await run(['/run', '/tn', task]);
    log?.event('tts', `试着启动本地语音服务 ${task}：${start.ok ? '已触发' : '触发失败 ' + String(start.out).slice(0, 80)}`);
    if (!start.ok) return false;
    // 加载模型要时间（IndexTTS 8G 显存约 40 秒），轮询端口
    for (let i = 0; i < 40; i += 1) {
      await new Promise((r) => setTimeout(r, 1500));
      const alive = await fetchImpl(`${url.origin}/health`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok).catch(() => false);
      if (alive) return true;
    }
    return false;
  }
  async function synthesize(text, engine, options) {
    let reference = '';
    if (engine === 'local') {
      const url = new URL(options.endpoint);
      if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
          url.username || url.password || url.search || url.hash) throw new Error('本地引擎只接受回环 HTTP 地址');
      if (options.ref) {
        if (!path.isAbsolute(options.ref)) throw new Error('参考音频需要绝对路径');
        if (fs.statSync(options.ref).size > MAX_BYTES) throw new Error('参考音频过大');
        reference = hash(fs.readFileSync(options.ref));
      }
    }
    const key = hash(JSON.stringify({ version: 5, engine, text, ...options, reference }));
    const cached = path.join(dir, `${key}.wav`);
    if (options.cache && fs.existsSync(cached)) {
      try {
        if (fs.statSync(cached).size > MAX_BYTES) throw new Error('缓存过大');
        const { ms } = normalizeWav(fs.readFileSync(cached), options.seconds);
        log?.event('tts', `缓存命中（${engine}）`);
        return { file: cached, ms, engine };
      } catch { fs.rmSync(cached, { force: true }); }
    }
    const temp = path.join(dir, `${randomUUID()}.wav`);
    try {
      if (engine === 'sapi') {
        await sapiImpl({ text, file: temp, ...options });
      } else if (engine === 'local') {
        const base = options.endpoint.replace(/\/+$/, '').replace(/\/tts$/, '') + '/tts';
        const post = (payload) => fetchImpl(base, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(options.timeout),
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        // 两种本地服务都要能接：
        //   1) GPT-SoVITS api_v2 —— 认这一整套字段（含参考音频/参考原文）
        //   2) 自己包的一层简单服务 —— 只认 text/speed_factor/emotion，收到多余字段会 4xx/5xx
        //      （实测那个胡桃服务收到完整字段直接 502，所以失败后用最简字段再试一次）
        const full = {
          text, text_lang: 'zh', ref_audio_path: options.ref,
          emotion: options.emotion, emotion_strength: options.strength, prosody: options.prosody, fragment_interval: options.prosody.pauseMs / 1000, prompt_text: options.refText, prompt_lang: 'zh', speed_factor: options.speed, temperature: options.temperature,
          media_type: 'wav', streaming_mode: false, text_split_method: 'cut5', batch_size: 1
        };
        let res = await post(full);
        if (!res.ok) {
          await res.body?.cancel().catch(() => {});
          log?.event('tts', `本地引擎 ${base} 不接受完整参数（HTTP ${res.status}），改用最简字段重试`);
          res = await post({ text, speed_factor: options.speed, emotion: options.emotion });
        }
        if (!res.ok) { await res.body?.cancel(); throw new Error(`本地 TTS HTTP ${res.status}`); }
        const reader = res.body?.getReader();
        if (!reader) throw new Error('本地 TTS 返回空响应');
        const chunks = []; let size = 0;
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_BYTES) throw new Error('本地 TTS 响应过大');
            chunks.push(Buffer.from(value));
          }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        fs.writeFileSync(temp, Buffer.concat(chunks));
      } else throw new Error('cloud 引擎尚未配置适配器');
      if (fs.statSync(temp).size > MAX_BYTES) throw new Error('语音文件过大');
      let { buffer, ms } = normalizeWav(fs.readFileSync(temp), options.seconds);
      if(options.compact){
        try { buffer = joinPcm16([{buffer,gainDb:0,pauseAfterMs:0}]).buffer; }
        catch(e) { if(e.message !== '片段没有有效语音') throw e; }
        const processed=compactSilence(buffer);
        ({buffer,ms}=normalizeWav(processed.buffer,options.seconds));
        log?.event('tts', '紧凑处理：压缩内部长静音 '+Math.round(processed.removedMs)+' 毫秒');
      }
      fs.writeFileSync(temp, buffer);
      const file = options.cache ? cached : path.join(dir, `${randomUUID()}.wav`);
      fs.renameSync(temp, file);
      log?.event('tts', `合成成功（${engine}，${Math.round(ms)} 毫秒）`);
      return { file, ms, engine };
    } finally { fs.rmSync(temp, { force: true }); }
  }

  function speak(raw, { mood = '' } = {}) {
    if (!cfg.ttsEnabled) return Promise.reject(new Error('语音没开'));
    const text = Array.from(String(raw ?? '').trim()).slice(0, number(cfg.ttsMaxChars, 200, 1, 2000)).join('');
    if (!text) return Promise.reject(new Error('语音文本为空'));
    const engine = String(cfg.ttsEngine || 'sapi');
    const compact=cfg.ttsCompactEnabled !== false;
    const planOptions={mood,text,speed:number(cfg.ttsSpeed,1,0.5,2),enabled:cfg.ttsEmotionEnabled !== false};
    const prosody=compact ? planCompact(text,planOptions) : planProsody(planOptions);
    const {emotion, strength} = prosody;
    const options = {
      emotion, strength, prosody, compact,
      voice: String(cfg.ttsVoice || ''), speed: prosody.speed,
      timeout: number(cfg.ttsTimeoutSecs, 60, 1, 300) * 1000,
      seconds: number(cfg.ttsMaxSeconds, 60, 1, 60),
      endpoint: String(cfg.ttsEndpoint || ''), ref: String(cfg.ttsRefAudio || ''),
      refText: String(cfg.ttsRefText || ''), cache: cfg.ttsCacheEnabled !== false,
      temperature: Number(cfg.ttsTemperature) || 1.0
    };
    const request = JSON.stringify({ text, engine, options });
    if (options.cache && pending.has(request)) return pending.get(request);
    const task = tail.catch(() => {}).then(async () => {
      // 按需模式：先把服务拉起来（已在跑只是一次 TCP 探测，几乎零开销）。
      // 冷启动要等模型加载，所以这里可能等几十秒 —— 拿不到就照常走下面的降级。
      if (ensureEngine && engine !== 'sapi') {
        try {
          const ok = await ensureEngine();
          if (!ok) log?.event('tts', '语音服务没拉起来，先直接试一次合成');
        } catch (e) {
          log?.event('tts', `拉起语音服务出错：${e.message}`);
        }
      }
      try { return await synthesize(text, engine, options); }
      catch (e) {
        if (engine === 'sapi') throw e;
        log?.event('tts', `主引擎失败：${e.message}`);
        // 本地引擎（9882/9883）经常是"服务没在跑"，而不是真的坏了。
        // 有 ensureEngine（按需服务管家）时它已经负责拉起 —— 这里再调 schtasks 会起第二个实例，
        // 两个都抢 9882，反而永远起不来（实测踩过）。老路径（没有管家）才用计划任务兜底。
        if (!ensureEngine && /fetch failed|ECONNREFUSED|socket hang up|超时|timeout/i.test(e.message || '')) {
          let revived = false;
          try { revived = await reviveLocalEngine(options.endpoint); }
          catch (e2) { log?.event('tts', `拉本地语音服务没成：${e2.message}`); }
          if (revived) {
            log?.event('tts', '本地语音服务已拉起来，重新合成');
            try { return await synthesize(text, engine, options); }
            catch (e3) { log?.event('tts', `服务起来了但合成还是失败：${e3.message}`); }
          }
        }
        // 默认不拿系统自带语音兜底：音色完全不对，比没声音更糟（用户明确要求）。
        // 想要兜底就把 ttsAllowSapiFallback 打开，或者直接把引擎设成 sapi。
        if (cfg.ttsAllowSapiFallback !== true) throw e;
        log?.event('tts', '本地引擎失败，按配置回落系统自带语音');
        return synthesize(text, 'sapi', options);
      }
    });
    tail = task;
    if (!options.cache) return task;
    pending.set(request, task);
    task.then(() => pending.delete(request), () => pending.delete(request));
    return task;
  }
  return { speak };
}
