// RVC 调音台：一个本机小网页，手动调换声参数（模型 / 升调 / 索引 / 保护），就地试听、存桌面。
// 不依赖任何 npm 包：Node 自带 http + fetch + FormData。
// 启动：node tools/rvc-console.mjs  → 浏览器开 http://127.0.0.1:9887/
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PORT = Number(process.env.RVC_CONSOLE_PORT || 9887);
const RVC = (process.env.RVC_ENDPOINT || 'http://127.0.0.1:9885').replace(/\/+$/, '');
const OUT_DIR = path.join(os.tmpdir(), 'rvc-console');
// 下面这些路径每台机器都不一样，一律走环境变量（不写死任何人的安装目录）：
//   RVC_STEMS   拆出来的人声目录（一般就是 demucsDir/out/htdemucs）
//   RVC_MODELS  RVC 的模型目录（*.pth / *.index）
//   RVC_TRAIN / RVC_TRAIN_PY / RVC_TRAIN_SCRIPT  训练相关（可选，不配就用不了训练页）
// 没配时落到本工具的临时目录，页面照样能打开，只是模型/干声列表是空的。
const STEMS_ROOT = process.env.RVC_STEMS || path.join(OUT_DIR, 'stems');
const MODELS_DIR = process.env.RVC_MODELS || path.join(OUT_DIR, 'models');
const TRAIN_ROOT = process.env.RVC_TRAIN || '';
const TRAIN_PY = process.env.RVC_TRAIN_PY || '';
const TRAIN_SCRIPT = process.env.RVC_TRAIN_SCRIPT || '';
const DESKTOP = path.join(os.homedir(), 'Desktop');
const MAX_UPLOAD = 200 * 1024 * 1024;

fs.mkdirSync(OUT_DIR, { recursive: true });

const results = [];   // [{ id, file, name, at, model, pitch, size }]
let seq = 0;

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req, limit = MAX_UPLOAD) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('文件太大了（上限 200MB）')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function rvcHealth() {
  try {
    const r = await fetch(RVC + '/health', { signal: AbortSignal.timeout(8000) });
    return await r.json();
  } catch (e) { return { ok: false, error: e.message }; }
}

function safeModelName(name) {
  return String(name || '').replace(/[\\/:*?"<>|]/g, '_').replace(/\.(pth|index)$/i, '').trim().slice(0, 40);
}

function listModels() {
  let names = [];
  try { names = fs.readdirSync(MODELS_DIR).filter((f) => f.toLowerCase().endsWith('.pth')).map((f) => path.basename(f, '.pth')); } catch { return []; }
  const current = modelsCurrent;
  return names.map((n) => {
    const pth = path.join(MODELS_DIR, n + '.pth');
    const idx = path.join(MODELS_DIR, n + '.index');
    const presetP = path.join(MODELS_DIR, n + '.preset.json');
    let preset = null;
    try { preset = JSON.parse(fs.readFileSync(presetP, 'utf8')); } catch { /* 没预设 */ }
    let sizeMb = 0; try { sizeMb = Math.round(fs.statSync(pth).size / 1024 / 102.4) / 10; } catch { /* ignore */ }
    return { name: n, sizeMb, hasIndex: fs.existsSync(idx), current: n === current, preset };
  });
}

let modelsCurrent = '';
let trainJob = null;   // { name, pid, startedAt, log, state, epochs, batch, sr, sourceDir }
const JOB_FILE = TRAIN_ROOT ? path.join(TRAIN_ROOT, 'logs', 'train-job.json') : '';
function saveJob() { if (!JOB_FILE) return; try { fs.mkdirSync(path.dirname(JOB_FILE), { recursive: true }); fs.writeFileSync(JOB_FILE, JSON.stringify(trainJob, null, 2), 'utf8'); } catch { /* ignore */ } }
function loadJob() { if (!JOB_FILE) return null; try { return JSON.parse(fs.readFileSync(JOB_FILE, 'utf8')); } catch { return null; } }
trainJob = loadJob();
async function refreshCurrent() {
  try { const h = await rvcHealth(); modelsCurrent = String((h && h.voice) || ''); } catch { /* ignore */ }
  return modelsCurrent;
}

const { spawn } = await import('node:child_process');

function cleanTrainLog(raw) {
  // tqdm 进度条满屏 \r，只留可读行
  return String(raw || '')
    .replace(/\r/g, '\n')
    .split('\n')
    .filter((l) => l && !/^\s*\d+%\|/.test(l) && !/it\/s\]\s*$/.test(l) && !/^\s*\|/.test(l))
    .join('\n');
}

function tailFile(file, lines = 60) {
  try {
    const txt = fs.readFileSync(file, 'utf8');
    return txt.trimEnd().split('\n').slice(-lines).join('\n');
  } catch { return ''; }
}

function trainArtifacts(name) {
  const dir = path.join(TRAIN_ROOT, 'applio', 'logs', name);
  let best = null;
  let bestEpoch = -1;
  try {
    for (const f of fs.readdirSync(dir)) {
      const m = /_(\d+)e_\d+s\.pth$/.exec(f);
      if (m) { const e = Number(m[1]); if (e > bestEpoch) { bestEpoch = e; best = f; } }
    }
  } catch { /* 还没开始训 */ }
  return { dir, best, bestEpoch, hasIndex: fs.existsSync(path.join(dir, name + '.index')) };
}

function trainStatus() {
  const j = trainJob;
  if (!j) return { ok: true, running: false, job: null };
  const logFresh = (() => { try { return Date.now() - fs.statSync(j.log).mtimeMs < 120000; } catch { return false; } })();
  const alive = (() => {
    if (!j.pid) return logFresh;            // 控制台重启过，pid 丢了：看日志是不是还在长
    try { process.kill(j.pid, 0); return true; } catch { return logFresh; }
  })();
  const art = trainArtifacts(j.name);
  const logTail = cleanTrainLog(tailFile(j.log, 200)).split('\n').slice(-25).join('\n');
  const lastEpoch = (() => {
    // 只认训练进度行 "testtone | epoch=7 | step=…"，别被 lowest_value 里的 "(epoch 2 …)" 带偏
    let raw = '';
    try { raw = fs.readFileSync(j.log, 'utf8'); } catch { /* ignore */ }
    const m = [...String(raw).matchAll(/\|\s*epoch=(\d+)\s*\|/g)].pop();
    return m ? Number(m[1]) : 0;
  })();
  const finished = /train end/.test(logTail) && !!art.best;
  if (!alive && j.state === 'running') { j.state = finished ? 'finished' : 'stopped'; saveJob(); }
  else if (alive && j.state !== 'running') { j.state = 'running'; saveJob(); }
  return { ok: true, running: alive && j.state === 'running', job: { ...j, alive, state: j.state, lastEpoch, artifacts: art, logTail } };
}

function listStems() {
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(STEMS_ROOT, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return out; }
  for (const d of dirs) {
    const p = path.join(STEMS_ROOT, d.name, 'vocals.wav');
    try {
      const st = fs.statSync(p);
      // 有 meta.json 就显示歌名（渲染时写的），没有就退回目录名
      let label = d.name;
      const tidy = (v) => String(v || '').replace(/\.(wav|mp3|m4a|flac)$/i, '').replace(/^song-\d+$/, '').trim();
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(STEMS_ROOT, d.name, 'meta.json'), 'utf8'));
        if (meta) {
          const t = tidy(meta.title) || tidy(meta.source);
          if (t) label = t;
        }
      } catch { /* 老目录没有 meta */ }
      out.push({ name: d.name, label, path: p, sizeMb: Math.round(st.size / 1024 / 102.4) / 10, mtime: st.mtimeMs });
    } catch { /* 没有 vocals 就跳过 */ }
  }
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, 40);
}

async function convertBuffer(buf, { pitch, indexRate, protect, model, filterRadius, volumeEnvelope, f0Autotune, f0AutotuneStrength }) {
  if (model) {
    const u = await fetch(`${RVC}/use?model=${encodeURIComponent(model)}`, { method: 'POST', signal: AbortSignal.timeout(300000) });
    if (!u.ok) throw new Error(`切换模型失败 HTTP ${u.status}`);
  }
  const form = new FormData();
  form.append('audio', new Blob([buf], { type: 'audio/wav' }), 'in.wav');
  const qs = new URLSearchParams({
    pitch: String(Math.round(Number(pitch) || 0)),
    index_rate: String(Number(indexRate ?? 0.2)),
    protect: String(Number(protect ?? 0.15))
  });
  if (filterRadius !== undefined && filterRadius !== null && filterRadius !== '') qs.set('filter_radius', String(Math.round(Number(filterRadius) || 0)));
  if (volumeEnvelope !== undefined && volumeEnvelope !== null && volumeEnvelope !== '') qs.set('volume_envelope', String(Number(volumeEnvelope)));
  if (f0Autotune !== undefined && f0Autotune !== null && f0Autotune !== '' && String(f0Autotune) !== 'false') {
    qs.set('f0_autotune', '1');
    qs.set('f0_autotune_strength', String(Number(f0AutotuneStrength ?? 0.6)));
  }
  const t0 = Date.now();
  const r = await fetch(`${RVC}/convert?${qs}`, { method: 'POST', body: form, signal: AbortSignal.timeout(30 * 60 * 1000) });
  if (!r.ok) throw new Error(`换声失败 HTTP ${r.status}`);
  const out = Buffer.from(await r.arrayBuffer());
  if (out.length < 2000) throw new Error('换声结果是空的');
  return { out, ms: Date.now() - t0, model: r.headers.get('x-rvc-model') || model || '' };
}

function remember(out, meta) {
  const id = String(++seq);
  const file = path.join(OUT_DIR, `rvc-${Date.now()}-${id}.wav`);
  fs.writeFileSync(file, out);
  const rec = { id, file, at: Date.now(), size: out.length, ...meta };
  results.unshift(rec);
  while (results.length > 12) {
    const old = results.pop();
    try { fs.rmSync(old.file, { force: true }); } catch { /* ignore */ }
  }
  return rec;
}

const HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>RVC 调音台</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root{--bg:#0f1420;--card:#161d2d;--line:#26314a;--fg:#e6ecf7;--muted:#8b9ab5;--accent:#4da3ff;--ok:#37c38b;--warn:#ffb454}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.6 "Microsoft YaHei",system-ui,sans-serif;padding:22px 22px 60px}
  h1{font-size:19px;margin:0 0 4px}
  .sub{color:var(--muted);margin-bottom:16px;font-size:13px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin-bottom:14px}
  .row{display:flex;gap:14px;align-items:center;flex-wrap:wrap;margin:8px 0}
  label{color:var(--muted);font-size:13px;min-width:74px}
  select,input[type=number],input[type=text]{background:#0d1320;color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:6px 8px}
  input[type=range]{width:220px;accent-color:var(--accent)}
  button{background:var(--accent);color:#06101f;border:0;border-radius:8px;padding:8px 16px;font-weight:600;cursor:pointer}
  button.ghost{background:#22304a;color:var(--fg)}
  button:disabled{opacity:.5;cursor:default}
  .val{min-width:56px;font-variant-numeric:tabular-nums;color:var(--accent)}
  .hint{color:var(--muted);font-size:12px}
  .pill{display:inline-block;padding:2px 9px;border-radius:99px;background:#22304a;font-size:12px;margin-left:6px}
  .pill.ok{background:rgba(55,195,139,.18);color:var(--ok)}
  .pill.bad{background:rgba(255,120,120,.18);color:#ff8a8a}
  audio{width:100%;margin-top:8px}
  .list{max-height:230px;overflow:auto;border-top:1px dashed var(--line);margin-top:10px}
  .item{display:flex;justify-content:space-between;gap:10px;padding:6px 2px;border-bottom:1px solid rgba(38,49,74,.5);font-size:13px}
  .item small{color:var(--muted)}
  a{color:var(--accent)}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
  @media(max-width:860px){.grid{grid-template-columns:1fr}}
</style></head><body>
<h1>RVC 调音台 <span id="state" class="pill">读状态…</span></h1>
<div class="sub">服务在本机 9885，模型目录由环境变量 <code>RVC_MODELS</code> 指定（没配就先用不了下面这些）。转完可以就地试听，也能一键存到桌面。</div>

<div class="grid">
  <div>
    <div class="card">
      <div class="row"><label>换声模型</label>
        <select id="model"></select>
        <button class="ghost" id="use">用这个模型</button>
        <span class="hint" id="modelNow"></span>
      </div>
      <div class="row"><label>升调</label>
        <input type="range" id="pitch" min="-12" max="12" step="1" value="0">
        <span class="val" id="pitchV">0 半音</span>
        <span class="hint">唱真歌时按原曲音高算，这里手调只影响本页试听</span>
      </div>
      <div class="row"><label>索引强度</label>
        <input type="range" id="ir" min="0" max="1" step="0.05" value="0.2">
        <span class="val" id="irV">0.20</span>
        <span class="hint">越大越像模型音色，太小会像原唱</span>
      </div>
      <div class="row"><label>保护</label>
        <input type="range" id="pr" min="0" max="0.5" step="0.05" value="0.15">
        <span class="val" id="prV">0.15</span>
        <span class="hint">大一点少破音、齿音更稳，但音色会淡</span>
      </div>
      <div class="row"><label>颤音平滑</label>
        <input type="range" id="fr" min="0" max="7" step="1" value="5">
        <span class="val" id="frV">5</span>
        <span class="hint">高音发抖就往上加（3→5→7），咬字会钝一点</span>
      </div>
      <div class="row"><label>自动音准</label>
        <input type="checkbox" id="at" checked>
        <input type="range" id="ats" min="0" max="1" step="0.05" value="0.6">
        <span class="val" id="atsV">0.60</span>
        <span class="hint">把音高吸附到音阶上：高音发颤/发飘时最有用，开太大会有电音味</span>
      </div>
      <div class="row"><label>音量包络</label>
        <input type="range" id="ve" min="0" max="1" step="0.05" value="0.35">
        <span class="val" id="veV">0.35</span>
        <span class="hint">越小越稳、喘气声少；高音抖就先降 0.2</span>
      </div>
    </div>


    <div class="card">
      <div class="row"><label>模型管理</label>
        <span class="hint" id="mdir"></span>
        <button class="ghost" id="mRefresh">刷新</button>
      </div>
      <div class="list" id="mlist" style="max-height:190px"></div>
      <div class="row" style="margin-top:10px">
        <input type="text" id="mName" placeholder="新模型名（例：她的声音2）" style="width:180px">
        <input type="file" id="mPth" accept=".pth" style="max-width:190px">
        <input type="file" id="mIdx" accept=".index" style="max-width:150px">
        <button id="mImport">导入 .pth</button>
      </div>
      <div class="hint">导入 RVC v2 的 .pth（index 可选）。导入后点列表里的「换过去」即可试听。</div>
    </div>

    <div class="card">
      <div class="row"><label>用歌曲干声试</label>
        <select id="stem" style="flex:1;min-width:220px"></select>
        <button id="goStem">转换这段</button>
      </div>
      <div class="row">
        <button class="ghost" id="hearStem">先听原声</button>
        <button class="ghost" id="analyze">分析音高</button>
        <span class="hint" id="f0out"></span>
      </div>
      <div class="hint">列表来自 Demucs 拆出来的 vocals.wav（点歌时留下的），最近的在前</div>
      <div class="row" style="margin-top:12px"><label>或用文件</label>
        <input type="file" id="file" accept="audio/*">
        <button id="goFile">转换文件</button>
      </div>
    </div>
  </div>

  <div>
    <div class="card">
      <div class="row"><label>试听</label><span class="hint" id="info"></span></div>
      <audio id="player" controls></audio>
      <div class="row" style="margin-top:10px">
        <input type="text" id="saveName" placeholder="存到桌面的文件名" style="flex:1">
        <button id="save">存到桌面</button>
      </div>
    </div>

    <div class="card">
      <div class="row"><label>训练新模型</label>
        <input type="text" id="trName" placeholder="模型名" style="width:120px">
        <input type="text" id="trSrc" placeholder="素材文件夹（默认用训练目录下的 dataset/raw）" style="flex:1;min-width:260px">
      </div>
      <div class="row">
        <label>epoch</label><input type="number" id="trEpochs" value="150" min="10" max="300" style="width:80px">
        <label>batch</label><input type="number" id="trBatch" value="6" min="1" max="12" style="width:70px">
        <label>采样率</label><input type="number" id="trSr" value="32000" style="width:90px">
        <button id="trStart">开始训练</button>
        <button class="ghost" id="trStop">停止</button>
        <button class="ghost" id="trInstall">装进模型库</button>
      </div>
      <div class="hint" id="trState">没在训练。素材放一个文件夹里（wav/mp3 都行），10 分钟以上音质最好。</div>
      <pre id="trLog" style="max-height:190px;overflow:auto;background:#0d1320;border:1px solid var(--line);border-radius:8px;padding:8px;font-size:12px;color:#9fb3d1;white-space:pre-wrap;display:none"></pre>
    </div>

    <div class="card">
      <div class="row"><label>最近结果</label><button class="ghost" id="refresh">刷新状态</button></div>
      <div class="list" id="list"></div>
    </div>
  </div>
</div>

<script>
const $ = (s) => document.querySelector(s);
let last = null;

async function api(p, opt) { const r = await fetch(p, opt); const t = await r.text(); try { return JSON.parse(t); } catch { return { ok:false, error:t.slice(0,200) }; } }

async function refresh() {
  const s = await api('/api/state');
  const st = $('#state');
  st.textContent = s.health && s.health.ok ? ('服务在线 · 当前模型 ' + s.health.voice) : '服务没上线';
  st.className = 'pill ' + (s.health && s.health.ok ? 'ok' : 'bad');
  const sel = $('#model');
  const models = (s.health && s.health.models) || [];
  if (sel.dataset.sig !== models.join(',')) {
    sel.innerHTML = models.map(m => '<option value="' + m + '"' + (m === (s.health||{}).voice ? ' selected' : '') + '>' + m + (m === 'her' ? '（她）' : m === 'hutao' ? '（胡桃）' : '') + '</option>').join('');
    sel.dataset.sig = models.join(',');
  }
  $('#modelNow').textContent = s.health && s.health.voice ? ('index ' + (s.health.has_index ? '已加载' : '无') + ' · ' + s.health.embedder) : '';
  const stem = $('#stem');
  stem.innerHTML = (s.stems || []).map(x => '<option value="' + x.path.replace(/"/g,'&quot;') + '">' + (x.label || x.name) + ' · ' + x.sizeMb + 'MB</option>').join('');
  renderList(s.results || []);
}

function renderList(rows) {
  $('#list').innerHTML = rows.length ? rows.map(x =>
    '<div class="item"><span>' + new Date(x.at).toLocaleTimeString('zh-CN',{hour12:false}) + ' · ' + x.model + ' · ' + x.pitch + '半音 · ' + (x.size/1024/1024).toFixed(1) + 'MB</span>' +
    '<a href="#" data-id="' + x.id + '">试听/保存</a></div>').join('') : '<div class="hint" style="padding:8px 0">还没转过东西</div>';
  document.querySelectorAll('[data-id]').forEach(a => a.onclick = async (e) => {
    e.preventDefault();
    const id = a.dataset.id;
    $('#player').src = '/out/' + id + '.wav?t=' + Date.now();
    const r = await api('/api/last?id=' + id);
    if (r.ok) { last = r.id; $('#info').textContent = r.model + ' · ' + r.pitch + ' 半音 · ' + (r.size/1024/1024).toFixed(1) + 'MB · ' + r.ms + 'ms'; $('#saveName').value = r.suggest; }
  });
}

function params() {
  return { pitch: Number($('#pitch').value), indexRate: Number($('#ir').value), protect: Number($('#pr').value), filterRadius: Number($('#fr').value), volumeEnvelope: Number($('#ve').value), f0Autotune: $('#at').checked, f0AutotuneStrength: Number($('#ats').value) };
}

async function runConvert(body, headers) {
  const info = $('#info'); info.textContent = '转换中…（CPU，几秒到几十秒）';
  const r = await fetch('/api/convert', { method: 'POST', headers: headers || {}, body });
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch { info.textContent = '失败：' + t.slice(0,160); return; }
  if (!j.ok) { info.textContent = '失败：' + j.error; return; }
  last = j.id;
  $('#player').src = '/out/' + j.id + '.wav?t=' + Date.now();
  $('#info').textContent = j.model + ' · ' + j.pitch + ' 半音 · ' + (j.size/1024/1024).toFixed(1) + 'MB · ' + j.ms + 'ms';
  $('#saveName').value = j.suggest;
  refresh();
}

$('#pitch').oninput = () => { $('#pitchV').textContent = $('#pitch').value + ' 半音'; };
$('#ir').oninput = () => { $('#irV').textContent = Number($('#ir').value).toFixed(2); };
$('#pr').oninput = () => { $('#prV').textContent = Number($('#pr').value).toFixed(2); };
$('#fr').oninput = () => { $('#frV').textContent = $('#fr').value; };
$('#ats').oninput = () => { $('#atsV').textContent = Number($('#ats').value).toFixed(2); };
$('#ve').oninput = () => { $('#veV').textContent = Number($('#ve').value).toFixed(2); };

async function loadModels() {
  const j = await api('/api/models');
  const box = $('#mlist');
  if (!j.ok) { box.innerHTML = '<div class="hint">读不到模型列表</div>'; return; }
  $('#mdir').textContent = j.dir;
  box.innerHTML = (j.models || []).map(m =>
    '<div class="item"><span>' + m.name + ' <small>' + m.sizeMb + 'MB' + (m.hasIndex ? ' · 有索引' : '') + (m.current ? ' · 当前' : '') + (m.preset ? ' · 预设 ' + m.preset.pitch + '半音' : '') + '</small></span>' +
    '<span>' +
      (m.current ? '' : '<a href="#" data-act="use" data-n="' + m.name + '">换过去</a> ') +
      '<a href="#" data-act="save" data-n="' + m.name + '">存预设</a> ' +
      '<a href="#" data-act="apply" data-n="' + m.name + '">套预设</a> ' +
      '<a href="#" data-act="ren" data-n="' + m.name + '">改名</a> ' +
      (m.current ? '' : '<a href="#" data-act="del" data-n="' + m.name + '">删除</a>') +
    '</span></div>').join('');
  document.querySelectorAll('#mlist [data-act]').forEach(a => a.onclick = async (e) => {
    e.preventDefault();
    const n = a.dataset.n, act = a.dataset.act;
    if (act === 'use') {
      const r = await api('/api/use?model=' + encodeURIComponent(n), { method:'POST' });
      if (!r.ok) alert(r.error || r.detail || '切换失败');
      refresh(); loadModels(); return;
    }
    if (act === 'save') {
      const p = params();
      const r = await api('/api/models/preset', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ name:n, ...p }) });
      if (r.ok) alert('已保存预设：' + n + '（' + p.pitch + '半音 / 索引 ' + p.indexRate + ' / 保护 ' + p.protect + '）');
      loadModels(); return;
    }
    if (act === 'apply') {
      const r = await api('/api/models/preset?name=' + encodeURIComponent(n));
      if (!r.ok || !r.preset) { alert('这个模型还没存过预设'); return; }
      $('#pitch').value = r.preset.pitch; $('#pitchV').textContent = r.preset.pitch + ' 半音';
      $('#ir').value = r.preset.indexRate; $('#irV').textContent = Number(r.preset.indexRate).toFixed(2);
      $('#pr').value = r.preset.protect; $('#prV').textContent = Number(r.preset.protect).toFixed(2);
      return;
    }
    if (act === 'ren') {
      const to = prompt('改名成：', n);
      if (!to || to === n) return;
      const r = await api('/api/models/rename', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ from:n, to }) });
      if (!r.ok) alert(r.error || '改名失败');
      loadModels(); refresh(); return;
    }
    if (act === 'del') {
      if (!confirm('删除模型 ' + n + '？（.pth/.index/预设都会删）')) return;
      const r = await api('/api/models/delete', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ name:n }) });
      if (!r.ok) alert(r.error || '删除失败');
      loadModels(); refresh(); return;
    }
  });
}

async function importModel() {
  const f = $('#mPth').files[0];
  if (!f) { alert('先选一个 .pth 文件'); return; }
  const name = ($('#mName').value || f.name.replace(/\.pth$/i, '')).trim();
  const p = await fetch('/api/models/import', { method:'POST', headers:{ 'X-Name': encodeURIComponent(name), 'X-Kind':'pth' }, body: f });
  const j = await p.json();
  if (!j.ok) { alert(j.error || '导入失败'); return; }
  const idx = $('#mIdx').files[0];
  if (idx) await fetch('/api/models/import', { method:'POST', headers:{ 'X-Name': encodeURIComponent(name), 'X-Kind':'index' }, body: idx });
  alert('导入完成：' + name + (idx ? '（含 index）' : '（无 index，音色会更飘）'));
  $('#mName').value = ''; $('#mPth').value = ''; $('#mIdx').value = '';
  loadModels(); refresh();
}


let trainTimer = null;
async function pollTrain() {
  const j = await api('/api/train/status');
  const st = $('#trState'), log = $('#trLog');
  if (!j.ok || !j.job) { st.textContent = '没在训练。'; log.style.display = 'none'; return; }
  const jb = j.job;
  const stateText = { running: '训练中', finished: '训练完成', stopped: '已停止' }[jb.state] || jb.state;
  st.textContent = jb.name + ' · ' + stateText + ' · epoch ' + (jb.lastEpoch || 0) + '/' + jb.epochs + ' · 素材 ' + jb.files + ' 个 · ' + (jb.artifacts && jb.artifacts.best ? ('最强产出 ' + jb.artifacts.best) : '还没有产出');
  log.style.display = 'block';
  log.textContent = jb.logTail || '';
  log.scrollTop = log.scrollHeight;
  clearTimeout(trainTimer);
  if (jb.running) trainTimer = setTimeout(pollTrain, 4000);
}
async function startTrain() {
  const name = ($('#trName').value || '').trim();
  if (!name) { alert('给新模型起个名字'); return; }
  const body = { name, sourceDir: ($('#trSrc').value || '').trim(), epochs: Number($('#trEpochs').value), batch: Number($('#trBatch').value), sr: Number($('#trSr').value) };
  const r = await api('/api/train', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
  if (!r.ok) { alert(r.error || '启动失败'); return; }
  alert('已开始训练：' + body.name + '（约 ' + Math.round(body.epochs * 1.2) + ' 分钟，可以关掉这个页面，任务在后台跑）');
  pollTrain();
}
$('#trStart').onclick = startTrain;
$('#trStop').onclick = async () => { if (!confirm('停止训练？')) return; const r = await api('/api/train/stop', { method:'POST' }); if (!r.ok) alert(r.error||'停止失败'); pollTrain(); };
$('#trInstall').onclick = async () => {
  const name = ($('#trName').value || '').trim();
  if (!name) { alert('填模型名'); return; }
  const r = await api('/api/train/install', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ name }) });
  if (!r.ok) { alert(r.error || '安装失败'); return; }
  alert('已装进模型库：' + r.installed + '（epoch ' + r.epoch + (r.hasIndex ? '，含 index' : '，无 index') + '）');
  loadModels(); refresh();
};
$('#mRefresh').onclick = loadModels;
$('#mImport').onclick = importModel;
$('#refresh').onclick = refresh;
$('#use').onclick = async () => { const r = await api('/api/use?model=' + encodeURIComponent($('#model').value), { method:'POST' }); if(!r.ok) alert(r.error||'切换失败'); refresh(); };
$('#hearStem').onclick = () => {
  const p = $('#stem').value;
  if (!p) return;
  $('#player').src = '/stem?path=' + encodeURIComponent(p) + '&t=' + Date.now();
  $('#info').textContent = '正在试听原声（未换声）';
};
async function analyzeStem() {
  const p = $('#stem').value;
  if (!p) return;
  $('#f0out').textContent = '分析中…';
  const j = await api('/api/f0?path=' + encodeURIComponent(p));
  if (!j.ok) { $('#f0out').textContent = '分析失败：' + (j.error || ''); return; }
  $('#f0out').textContent = '中位 ' + j.median + ' Hz（p10 ' + j.p10 + '/p90 ' + j.p90 + '，' + j.method + '）→ 建议 ' + (j.suggested > 0 ? '+' : '') + j.suggested + ' 半音';
  const btn = document.createElement('button');
  btn.className = 'ghost';
  btn.textContent = '套用建议';
  btn.onclick = () => { $('#pitch').value = j.suggested; $('#pitchV').textContent = j.suggested + ' 半音'; };
  const holder = $('#f0out');
  if (holder.nextSibling && holder.nextSibling.dataset && holder.nextSibling.dataset.sug) holder.nextSibling.remove();
  btn.dataset.sug = '1';
  holder.after(btn);
}
$('#analyze').onclick = analyzeStem;
$('#stem').onchange = () => { $('#f0out').textContent = ''; };
$('#goStem').onclick = () => runConvert(JSON.stringify({ path: $('#stem').value, ...params() }), { 'Content-Type':'application/json' });
$('#goFile').onclick = async () => {
  const f = $('#file').files[0];
  if (!f) { alert('先选一个音频文件'); return; }
  const p = params();
  await runConvert(f, { 'X-Pitch': p.pitch, 'X-Index-Rate': p.indexRate, 'X-Protect': p.protect, 'X-Filter-Radius': p.filterRadius, 'X-Volume-Envelope': p.volumeEnvelope, 'X-Filename': encodeURIComponent(f.name) });
};
$('#save').onclick = async () => {
  if (!last) { alert('先转一个'); return; }
  const name = ($('#saveName').value || 'RVC成品').replace(/[\\\\/:*?"<>|]/g,'_');
  const r = await api('/api/save', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ id: last, name }) });
  alert(r.ok ? ('已存到桌面：' + r.path) : ('保存失败：' + r.error));
};
refresh(); loadModels(); pollTrain();
</script></body></html>`;

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  const p = u.pathname;
  try {
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(HTML);
      return;
    }
    if (req.method === 'GET' && p === '/api/state') {
      const health = await rvcHealth();
      return json(res, 200, { ok: true, health, stems: listStems(), results });
    }
    if (req.method === 'POST' && p === '/api/train') {
      const j = JSON.parse((await readBody(req, 1024 * 1024)).toString('utf8'));
      const name = safeModelName(j.name);
      if (!name) return json(res, 400, { ok: false, error: '模型名不能为空' });
      if (/^(her|hutao)$/.test(name)) return json(res, 400, { ok: false, error: '别覆盖现有模型，换个名字' });
      if (trainJob && trainJob.state === 'running') {
        try { process.kill(trainJob.pid, 0); return json(res, 409, { ok: false, error: '已经有一个训练任务在跑（' + trainJob.name + '）' }); } catch { /* 已结束 */ }
      }
      const src = String(j.sourceDir || '').trim() || (TRAIN_ROOT ? path.join(TRAIN_ROOT, 'dataset', 'raw') : '');
      if (!src) return json(res, 400, { ok: false, error: '没配 RVC_TRAIN 环境变量（训练根目录），也可以直接填素材目录' });
      if (!fs.existsSync(src)) return json(res, 400, { ok: false, error: '素材目录不存在：' + src });
      let wavs = [];
      try { wavs = fs.readdirSync(src).filter((f) => /\.(wav|mp3|m4a|flac|ogg)$/i.test(f)); } catch { /* ignore */ }
      if (wavs.length < 3) return json(res, 400, { ok: false, error: '素材太少（至少 3 个音频，建议 10 分钟以上）' });
      if (!TRAIN_PY) return json(res, 500, { ok: false, error: '没配 RVC_TRAIN_PY 环境变量（训练用的 python.exe）' });
      if (!TRAIN_SCRIPT) return json(res, 500, { ok: false, error: '没配 RVC_TRAIN_SCRIPT 环境变量（训练脚本路径）' });
      if (!fs.existsSync(TRAIN_PY)) return json(res, 500, { ok: false, error: '找不到训练用的 python：' + TRAIN_PY });
      if (!fs.existsSync(TRAIN_SCRIPT)) return json(res, 500, { ok: false, error: '找不到训练脚本：' + TRAIN_SCRIPT });
      const sr = Number(j.sr) || 32000;
      const epochs = Math.max(10, Math.min(300, Number(j.epochs) || 150));
      const batch = Math.max(1, Math.min(12, Number(j.batch) || 6));
      const log = path.join(TRAIN_ROOT, 'logs', 'train-' + name + '.log');
      fs.mkdirSync(path.dirname(log), { recursive: true });
      try { fs.rmSync(log, { force: true }); } catch { /* ignore */ }
      const env = { ...process.env, MODEL: name, DATASET: src, SR: String(sr), EPOCHS: String(epochs), BATCH: String(batch), STEPS: 'all', CUDA: '0', TRAIN_LOG: log };
      const out = fs.openSync(log, 'a');
      const child = spawn(TRAIN_PY, [TRAIN_SCRIPT], { cwd: path.dirname(TRAIN_SCRIPT), env, detached: true, stdio: ['ignore', out, out], windowsHide: true });
      child.unref();
      trainJob = { name, pid: child.pid, startedAt: Date.now(), log, state: 'running', epochs, batch, sr, sourceDir: src, files: wavs.length };
      saveJob();
      return json(res, 200, { ok: true, job: { name, epochs, batch, sr, files: wavs.length, log } });
    }
    if (req.method === 'GET' && p === '/api/train/status') {
      return json(res, 200, trainStatus());
    }
    if (req.method === 'POST' && p === '/api/train/stop') {
      if (!trainJob) return json(res, 400, { ok: false, error: '没有训练任务' });
      try {
        spawn('taskkill', ['/F', '/T', '/PID', String(trainJob.pid)], { windowsHide: true });
        trainJob.state = 'stopped';
        saveJob();
      } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && p === '/api/train/install') {
      const j = JSON.parse((await readBody(req, 1024 * 1024)).toString('utf8'));
      const name = safeModelName(j.name);
      const art = trainArtifacts(name);
      if (!art.best) return json(res, 400, { ok: false, error: '这个模型还没有训练产出（.pth）' });
      fs.mkdirSync(MODELS_DIR, { recursive: true });
      fs.copyFileSync(path.join(art.dir, art.best), path.join(MODELS_DIR, name + '.pth'));
      if (art.hasIndex) fs.copyFileSync(path.join(art.dir, name + '.index'), path.join(MODELS_DIR, name + '.index'));
      return json(res, 200, { ok: true, installed: name, from: art.best, epoch: art.bestEpoch, hasIndex: art.hasIndex });
    }
    if (req.method === 'GET' && p === '/api/models') {
      await refreshCurrent();
      return json(res, 200, { ok: true, models: listModels(), current: modelsCurrent, dir: MODELS_DIR });
    }
    if (req.method === 'POST' && p === '/api/models/import') {
      // 上传自己的 .pth（可同时带 .index）：filename 用头 X-Name / X-Kind
      const kind = String(req.headers['x-kind'] || 'pth').toLowerCase();
      const raw = String(req.headers['x-name'] || '');
      const name = safeModelName(decodeURIComponent(raw));
      if (!name) return json(res, 400, { ok: false, error: '模型名不能为空' });
      const buf = await readBody(req);
      if (!buf.length) return json(res, 400, { ok: false, error: '空文件' });
      if (kind === 'index') {
        fs.writeFileSync(path.join(MODELS_DIR, name + '.index'), buf);
        return json(res, 200, { ok: true, saved: name + '.index', size: buf.length });
      }
      if (buf.length < 1024) return json(res, 400, { ok: false, error: '这个 .pth 太小，不像模型' });
      fs.mkdirSync(MODELS_DIR, { recursive: true });
      fs.writeFileSync(path.join(MODELS_DIR, name + '.pth'), buf);
      return json(res, 200, { ok: true, saved: name + '.pth', size: buf.length });
    }
    if (req.method === 'POST' && p === '/api/models/rename') {
      const j = JSON.parse((await readBody(req, 1024 * 1024)).toString('utf8'));
      const from = safeModelName(j.from);
      const to = safeModelName(j.to);
      if (!from || !to) return json(res, 400, { ok: false, error: '名字不能为空' });
      const src = path.join(MODELS_DIR, from + '.pth');
      if (!fs.existsSync(src)) return json(res, 404, { ok: false, error: '没有这个模型' });
      if (fs.existsSync(path.join(MODELS_DIR, to + '.pth'))) return json(res, 409, { ok: false, error: '新名字已存在' });
      fs.renameSync(src, path.join(MODELS_DIR, to + '.pth'));
      for (const ext of ['.index', '.preset.json']) {
        try { fs.renameSync(path.join(MODELS_DIR, from + ext), path.join(MODELS_DIR, to + ext)); } catch { /* 附件可能没有 */ }
      }
      return json(res, 200, { ok: true, from, to });
    }
    if (req.method === 'POST' && p === '/api/models/delete') {
      const j = JSON.parse((await readBody(req, 1024 * 1024)).toString('utf8'));
      const name = safeModelName(j.name);
      if (!name) return json(res, 400, { ok: false, error: '名字不能为空' });
      if (listModels().length <= 1) return json(res, 400, { ok: false, error: '至少留一个模型' });
      if (name === modelsCurrent) return json(res, 400, { ok: false, error: '正在使用的模型不能删，先切到别的' });
      for (const ext of ['.pth', '.index', '.preset.json']) {
        try { fs.rmSync(path.join(MODELS_DIR, name + ext), { force: true }); } catch { /* ignore */ }
      }
      return json(res, 200, { ok: true, name });
    }
    if (req.method === 'GET' && p === '/api/models/preset') {
      const name = safeModelName(u.searchParams.get('name') || '');
      try {
        return json(res, 200, { ok: true, preset: JSON.parse(fs.readFileSync(path.join(MODELS_DIR, name + '.preset.json'), 'utf8')) });
      } catch { return json(res, 200, { ok: true, preset: null }); }
    }
    if (req.method === 'POST' && p === '/api/models/preset') {
      const j = JSON.parse((await readBody(req, 1024 * 1024)).toString('utf8'));
      const name = safeModelName(j.name);
      if (!name) return json(res, 400, { ok: false, error: '名字不能为空' });
      const preset = { pitch: Number(j.pitch) || 0, indexRate: Number(j.indexRate ?? 0.2), protect: Number(j.protect ?? 0.15), at: Date.now() };
      fs.writeFileSync(path.join(MODELS_DIR, name + '.preset.json'), JSON.stringify(preset, null, 2), 'utf8');
      return json(res, 200, { ok: true, preset });
    }
    if (req.method === 'POST' && p === '/api/use') {
      const model = u.searchParams.get('model') || '';
      const r = await fetch(`${RVC}/use?model=${encodeURIComponent(model)}`, { method: 'POST', signal: AbortSignal.timeout(300000) });
      const t = await r.text();
      return json(res, r.ok ? 200 : 500, { ok: r.ok, detail: t.slice(0, 200) });
    }
    if (req.method === 'GET' && p === '/api/f0') {
      // 分析一段干声的音高，并给出"建议升调"（和点歌链路同一套公式）
      const src = String(u.searchParams.get('path') || '');
      if (!src || !fs.existsSync(src) || !path.resolve(src).startsWith(path.resolve(STEMS_ROOT))) {
        return json(res, 400, { ok: false, error: '只能分析拆出来的干声' });
      }
      const target = Number(u.searchParams.get('target') || 300);
      const buf = fs.readFileSync(src);
      const form = new FormData();
      form.append('audio', new Blob([buf], { type: 'audio/wav' }), 'in.wav');
      const r = await fetch(`${RVC}/f0`, { method: 'POST', body: form, signal: AbortSignal.timeout(10 * 60 * 1000) });
      const j = await r.json().catch(() => ({ ok: false, error: 'f0 返回不是 JSON' }));
      if (!j.ok) return json(res, 200, { ok: false, error: j.error || '分析失败' });
      const semis = j.median > 0 ? Math.max(-4, Math.min(7, Math.round(12 * Math.log2(target / j.median)))) : 0;
      return json(res, 200, { ok: true, median: j.median, p10: j.p10, p90: j.p90, method: j.method, target, suggested: semis });
    }
    if (req.method === 'GET' && p === '/stem') {
      // 原声试听：只允许干声目录里的文件
      const src = String(u.searchParams.get('path') || '');
      if (!src || !fs.existsSync(src) || !path.resolve(src).startsWith(path.resolve(STEMS_ROOT))) {
        res.writeHead(400); res.end('bad path'); return;
      }
      const stat = fs.statSync(src);
      res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': stat.size, 'Cache-Control': 'no-store' });
      fs.createReadStream(src).pipe(res);
      return;
    }
    if (req.method === 'POST' && p === '/api/convert') {
      let buf;
      const ct = String(req.headers['content-type'] || '');
      let opts = {};
      let stemName = '';
      let stemLabel = '';
      if (ct.includes('application/json')) {
        const j = JSON.parse((await readBody(req, 1024 * 1024)).toString('utf8'));
        const src = String(j.path || '');
        if (!src || !fs.existsSync(src)) return json(res, 400, { ok: false, error: '找不到这个干声文件' });
        buf = fs.readFileSync(src);
        stemName = path.basename(path.dirname(src));
        try {
          const meta = JSON.parse(fs.readFileSync(path.join(path.dirname(src), 'meta.json'), 'utf8'));
          if (meta) stemLabel = String(meta.title || '').trim() || String(meta.source || '').replace(/\.(wav|mp3|m4a|flac)$/i, '');
        } catch { /* 没有 meta 就用目录名 */ }
        opts = { pitch: j.pitch, indexRate: j.indexRate, protect: j.protect, model: j.model, filterRadius: j.filterRadius, volumeEnvelope: j.volumeEnvelope, f0Autotune: j.f0Autotune, f0AutotuneStrength: j.f0AutotuneStrength };
      } else {
        buf = await readBody(req);
        const dec = (v) => decodeURIComponent(String(v || ''));
        opts = {
          pitch: dec(req.headers['x-pitch']),
          indexRate: dec(req.headers['x-index-rate']),
          protect: dec(req.headers['x-protect']),
          model: dec(req.headers['x-model']),
          filterRadius: dec(req.headers['x-filter-radius']),
          volumeEnvelope: dec(req.headers['x-volume-envelope']),
          f0Autotune: dec(req.headers['x-f0-autotune']),
          f0AutotuneStrength: dec(req.headers['x-f0-autotune-strength'])
        };
      }
      if (!buf || !buf.length) return json(res, 400, { ok: false, error: '空文件' });
      const { out, ms, model } = await convertBuffer(buf, opts);
      const rec = remember(out, { pitch: Number(opts.pitch) || 0, model, ms, indexRate: Number(opts.indexRate ?? 0.2), protect: Number(opts.protect ?? 0.15) });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      return json(res, 200, {
        ok: true, id: rec.id, ms, model: rec.model, pitch: rec.pitch, size: out.length,
        url: `/out/${rec.id}.wav`,
        suggest: (function () {
          const who = rec.model === 'her' ? '她' : rec.model;
          const base = (stemLabel || stemName || '试音').replace(/\.(wav|mp3|m4a|flac)$/i, '').replace(/^song-\d+$/, '').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40) || '试音';
          const sign = rec.pitch > 0 ? '升' + rec.pitch : rec.pitch < 0 ? '降' + Math.abs(rec.pitch) : '原调';
          const d = new Date();
          const hhmm = String(d.getHours()).padStart(2, '0') + String(d.getMinutes()).padStart(2, '0');
          return `调音-${base}-${who}-${sign}-${hhmm}`;
        })()
      });
    }
    if (req.method === 'GET' && p === '/api/last') {
      const id = u.searchParams.get('id') || (results[0] && results[0].id);
      const rec = results.find((x) => x.id === id);
      if (!rec) return json(res, 404, { ok: false, error: '没有这条记录' });
      const stamp = new Date(rec.at).toISOString().replace(/[:.]/g, '-').slice(0, 19);
      return json(res, 200, { ok: true, id: rec.id, model: rec.model, pitch: rec.pitch, size: rec.size, ms: rec.ms, suggest: `RVC-${rec.model}-${rec.pitch}半音-${stamp}` });
    }
    if (req.method === 'POST' && p === '/api/save') {
      const j = JSON.parse((await readBody(req, 1024 * 1024)).toString('utf8'));
      const rec = results.find((x) => x.id === String(j.id));
      if (!rec) return json(res, 404, { ok: false, error: '没有这条记录' });
      const name = String(j.name || `RVC-${rec.model}`).replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
      const dst = path.join(DESKTOP, name.endsWith('.wav') ? name : name + '.wav');
      fs.copyFileSync(rec.file, dst);
      return json(res, 200, { ok: true, path: dst });
    }
    const m = /^\/out\/(\d+)\.wav$/.exec(p);
    if (req.method === 'GET' && m) {
      const rec = results.find((x) => x.id === m[1]);
      if (!rec || !fs.existsSync(rec.file)) { res.writeHead(404); res.end('no'); return; }
      const stat = fs.statSync(rec.file);
      res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': stat.size, 'Cache-Control': 'no-store' });
      fs.createReadStream(rec.file).pipe(res);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('没有这个接口：' + p);
  } catch (e) {
    json(res, 500, { ok: false, error: e.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`RVC 调音台: http://127.0.0.1:${PORT}/   （服务端 9885，干声目录 ${STEMS_ROOT}）`);
});
