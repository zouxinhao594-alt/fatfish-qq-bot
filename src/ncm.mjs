// 网易云音乐控制（移植自 ai-companion-kit 的 ncm 模块）
//
// 两条腿：
//   1) HTTP：搜歌 / 歌词 / 评论 —— 不需要客户端，随时能用
//   2) CDP：播放 / 当前在听 / 播放控制 / 一起听房间 —— 需要 PC 版网易云
//      带 --remote-debugging-port=9222 启动，然后注入 webpackJsonp 偷出 require，
//      读写它的内部 redux store。核心模块号随版本变，所以用"扫模块缓存"的方式找，不写死。
//
// 为什么值得接：她会知道"我现在在听什么"，还能替主人点歌、报歌词。
// 注意：PC 客户端没开调试口时，只有 HTTP 那半边可用，播放类会明确报错（不假装成功）。

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36';
const NCM_HEADERS = { 'User-Agent': UA, Referer: 'https://music.163.com/' };

export const createNcm = ({ cfg = {}, log = null, fetchImpl = globalThis.fetch, wsImpl = globalThis.WebSocket, now = () => Date.now() } = {}) => {
  const port = Number(cfg.ncmCdpPort) || 9222;
  const stats = { search: 0, play: 0, now: 0, control: 0, errors: 0 };
  let coreCache = null;

  // ── CDP ────────────────────────────────────────────────
  async function cdpTargetUrl() {
    const r = await fetchImpl(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(6000) });
    const list = await r.json();
    const page = (Array.isArray(list) ? list : []).find((x) => x.type === 'page') || list[0];
    if (!page || !page.webSocketDebuggerUrl) throw new Error('找不到网易云的调试页面（客户端没带 --remote-debugging-port 启动？）');
    return page.webSocketDebuggerUrl;
  }

  function cdpEvalOnce(wsUrl, expression, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      const WS = wsImpl;
      if (typeof WS !== 'function') return reject(new Error('当前 Node 没有全局 WebSocket（需要 22+）'));
      const ws = new WS(wsUrl);
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { ws.close(); } catch { /* ignore */ }
        reject(new Error('CDP 执行超时'));
      }, timeoutMs);
      const finish = (fn, arg) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { ws.close(); } catch { /* ignore */ }
        fn(arg);
      };
      ws.onopen = () => ws.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression, returnByValue: true, awaitPromise: true, allowUnsafeEvalBlockedByCSP: true }
      }));
      ws.onmessage = (e) => {
        let d;
        try { d = JSON.parse(e.data); } catch { return; }
        if (d.id !== 1) return;
        const res = d.result || {};
        if (res.exceptionDetails) {
          const desc = (res.exceptionDetails.exception && res.exceptionDetails.exception.description) || res.exceptionDetails.text;
          finish(reject, new Error(String(desc).slice(0, 300)));
        } else {
          finish(resolve, res.result ? res.result.value : null);
        }
      };
      ws.onerror = () => finish(reject, new Error('CDP 连接失败（客户端在跑吗？调试端口开着吗？）'));
    });
  }

  const BOOT_EXPR = `(function () {
    if (!window.__ww) {
      try {
        webpackJsonp.push([[-991337], { 991337: function (m, e, require) { window.__ww = require; } }, [[991337]]]);
      } catch (err) { return 'PUSH_FAIL:' + err.message; }
    }
    if (!window.__ww) return 'NO_REQUIRE';
    return 'OK:' + Object.keys(window.__ww.c || {}).length;
  })()`;

  const FIND_CORE_EXPR = `(function () {
    var req = window.__ww;
    if (!req) return '';
    if (window.__ncmCore) return window.__ncmCore;
    var ids = Object.keys(req.c || {});
    for (var i = 0; i < ids.length; i++) {
      var ex = req.c[ids[i]] && req.c[ids[i]].exports;
      if (!ex) continue;
      var ks = Object.keys(ex);
      for (var j = 0; j < ks.length; j++) {
        var v = ex[ks[j]];
        if (v && typeof v === 'object' && typeof v.getDispatch === 'function' && typeof v.getStore === 'function') {
          window.__ncmCore = ids[i] + '.' + ks[j];
          return window.__ncmCore;
        }
      }
    }
    return '';
  })()`;

  async function ensureCore() {
    const ws = await cdpTargetUrl();
    const boot = await cdpEvalOnce(ws, BOOT_EXPR);
    if (typeof boot !== 'string' || boot.indexOf('OK') !== 0) throw new Error('注入 webpack 失败：' + boot);
    if (coreCache) return coreCache;
    const found = await cdpEvalOnce(ws, FIND_CORE_EXPR);
    if (!found) throw new Error('没找到客户端核心模块（网易云版本可能变了）');
    coreCache = found;
    return coreCache;
  }

  /** 在客户端里跑一段 JS（自动带上 req / core，可用 await） */
  async function clientEval(bodyExpr) {
    const core = await ensureCore();
    const ws = await cdpTargetUrl();
    const [mod, key] = core.split('.');
    const expr = `(async function () {
      var req = window.__ww;
      var core = req(${JSON.stringify(mod)})[${JSON.stringify(key)}];
      return await (async function (req, core) { ${bodyExpr} })(req, core);
    })()`;
    return cdpEvalOnce(ws, expr, 40000);
  }

  async function dispatch(action) {
    const core = await ensureCore();
    const ws = await cdpTargetUrl();
    const [mod, key] = core.split('.');
    const expr = `(function () {
      var req = window.__ww;
      var core = req(${JSON.stringify(mod)})[${JSON.stringify(key)}];
      return Promise.resolve(core.getDispatch()(${JSON.stringify(action)})).then(function () { return true; });
    })()`;
    return cdpEvalOnce(ws, expr);
  }

  // ── 读状态 ─────────────────────────────────────────────
  /** 现在在听什么：歌名/歌手/进度/是否在放/当前那句歌词 */
  async function nowPlaying() {
    const out = await clientEval(`
      var p = core.getStore().playing || {};
      var cur = p.curPlaying || {};
      var tr = cur.track || p.curTrack || {};
      var artists = (tr.artists || p.resourceArtists || []).map(function (a) { return a.name; }).join('/');
      return {
        songId: String(cur.resourceId || tr.id || p.resourceTrackId || ''),
        title: tr.name || p.resourceName || '',
        artist: artists,
        album: (tr.album || {}).name || '',
        duration: Number(tr.duration || p.resourceDuration || 0) / 1000,
        playing: p.playingState === 2,
        lyricLine: Number(p.playingLyricLineNumber || 0),
        lyric: String(p.playingLyric || '')
      };
    `);
    stats.now += 1;
    if (!out || !out.title) return { ok: false, error: '客户端现在没在放歌（或者读不到）', raw: out };
    log?.event('ncm', `在听：${out.title} — ${out.artist}${out.lyric ? `（${out.lyric.slice(0, 20)}）` : ''}`);
    return { ok: true, ...out };
  }

  /** 一起听房间状态 */
  async function roomState() {
    const out = await clientEval(`
      var s = core.getStore();
      var lt = s['async:listenTogether'] || {};
      var ri = lt.roomInfo || {};
      var other = lt.otherMember || {};
      var list = s['async:listenTogetherPlayList'] || {};
      return {
        status: String(lt.status || ''),
        roomId: String(ri.roomId || ''),
        creatorId: Number(ri.creatorId || 0),
        other: { id: other.userId || other.id || '', name: other.nickname || other.name || '' },
        songCount: (list.playList || list.songs || []).length
      };
    `);
    return { ok: !!(out && out.roomId), ...(out || {}) };
  }

  // ── 控制 ───────────────────────────────────────────────
  const LOCAL = { play: 'playing/resume', pause: 'playing/pause' };

  async function control(command) {
    const cmd = String(command || '').toLowerCase();
    if (cmd === 'next' || cmd === 'previous') {
      await dispatch({ type: 'playingList/jump2Track', payload: { flag: cmd === 'previous' ? -1 : 1, type: 'call', triggerScene: 'minibarController' } });
    } else if (LOCAL[cmd]) {
      await dispatch({ type: LOCAL[cmd], payload: {} });
    } else {
      throw new Error('不支持的播放命令：' + command + '（可用 play/pause/next/previous）');
    }
    stats.control += 1;
    log?.event('ncm', `播放控制：${cmd}`);
    return { ok: true, command: cmd };
  }

  // ── HTTP：搜索 / 歌词 / 评论 ────────────────────────────
  async function getJson(url) {
    const r = await fetchImpl(url, { headers: NCM_HEADERS, signal: AbortSignal.timeout(15000) });
    return r.json();
  }

  async function search(keyword, limit = 8) {
    const q = String(keyword || '').trim();
    if (!q) throw new Error('要搜什么歌？');
    const j = await getJson(`https://music.163.com/api/search/get?s=${encodeURIComponent(q)}&type=1&limit=${Math.max(1, Math.min(20, limit))}`);
    const songs = ((j && j.result && j.result.songs) || []).map((s) => ({
      id: s.id,
      name: s.name,
      artist: (s.artists || []).map((a) => a.name).join('/'),
      album: (s.album || {}).name || '',
      duration: Math.round((s.duration || 0) / 1000)
    }));
    stats.search += 1;
    log?.event('ncm', `搜歌「${q}」→ ${songs.length} 首${songs[0] ? '：' + songs[0].name : ''}`);
    return { ok: true, query: q, songs };
  }

  async function lyric(songId) {
    const j = await getJson(`https://music.163.com/api/song/lyric?id=${songId}&lv=1&kv=1&tv=-1`);
    const lrc = (j && j.lrc && j.lrc.lyric) || '';
    const lines = [];
    for (const line of lrc.split(/\r?\n/)) {
      const m = /^\[(\d{1,3}):(\d{2}(?:\.\d{1,3})?)\]\s*(.*)$/.exec(line.trim());
      if (m && m[3]) lines.push({ t: Math.round((Number(m[1]) * 60 + Number(m[2])) * 10) / 10, text: m[3] });
    }
    return { ok: true, songId, lines };
  }

  /** 纯文本歌词（给聊天用，去掉制作人那几行） */
  async function lyricText(songId, maxLines = 40) {
    const { lines } = await lyric(songId);
    return lines
      .filter((l) => !/^作词|^作曲|^编曲|^制作人|^出品|^混音|^母带|^录音|^监制|^统筹|^企划|^OP|^SP|^发行/.test(l.text))
      .slice(0, maxLines)
      .map((l) => l.text);
  }

  async function comments(songId, limit = 12) {
    const j = await getJson(`https://music.163.com/api/v1/resource/comments/R_SO_4_${songId}?limit=${Math.max(1, Math.min(50, limit))}&offset=0`);
    const fmt = (c) => ({ user: (c.user || {}).nickname || '', text: c.content || '', likes: c.likedCount || 0 });
    return { ok: true, songId, total: (j && j.total) || 0, hot: ((j && j.hotComments) || []).map(fmt) };
  }

  /** 点歌播放（本地 PC 客户端）。模块号会变，所以先试 102，再扫一遍。 */
  async function playSong(songId, title = '') {
    const core = await ensureCore();
    const ws = await cdpTargetUrl();
    const [mod, key] = core.split('.');
    const expr = `(async function () {
      var req = window.__ww;
      var core = req(${JSON.stringify(mod)})[${JSON.stringify(key)}];
      var id = ${JSON.stringify(String(songId))};
      var loader = null;
      var m102 = null;
      try { m102 = req(102); } catch (e) {}
      if (m102 && typeof m102.a === 'function') {
        try { var t0 = await m102.a([{ id: id, v: 0 }]); if (t0 && (Array.isArray(t0) ? t0.length : true)) loader = m102.a; } catch (e) {}
      }
      if (!loader) {
        var ids = Object.keys(req.m || req.c || {});
        for (var i = 0; i < ids.length; i++) {
          try {
            var mm = req(ids[i]);
            if (mm && typeof mm.a === 'function') {
              var tt = await mm.a([{ id: id, v: 0 }]);
              if (tt && (Array.isArray(tt) ? tt.length : true)) { loader = mm.a; break; }
            }
          } catch (e) {}
        }
      }
      if (!loader) return { ok: false, error: '找不到歌曲加载器（版本可能变了）' };
      var tracks = await loader([{ id: id, v: 0 }]);
      var st = core.getStore();
      var lt = st['async:listenTogether'] || {};
      var ri = lt.roomInfo || {};
      var d = core.getDispatch();
      var inRoom = !!(ri.roomId && lt.status && lt.status !== 'alone');
      if (inRoom) { try { d({ type: 'async:listenTogetherPlayStatus/setCanReport', payload: { isCanReport: false } }); } catch (e) {} }
      await Promise.resolve(d({
        type: 'playing/play',
        payload: {
          tracks: tracks,
          from: { scene: 'search', resourceType: 'track', fromInfo: {}, text: ${JSON.stringify(String(title || ''))}, href: '/song/' + id },
          options: { clear: false, play: true, playId: id, fromDoubleClick: true }
        }
      }));
      if (inRoom) {
        setTimeout(function () {
          try { d({ type: 'async:listenTogetherPlayStatus/setCanReport', payload: { isCanReport: true } }); } catch (e) {}
        }, 5000);
      }
      return { ok: true, songId: id };
    })()`;
    const r = await cdpEvalOnce(ws, expr, 30000);
    stats.play += 1;
    if (!r || !r.ok) throw new Error((r && r.error) || '点歌失败');
    log?.event('ncm', `点歌播放：${title || songId}`);
    return { ok: true, songId: String(songId), title };
  }

  /** CDP 这边通不通（给控制台和自检用） */
  async function health() {
    try {
      const core = await ensureCore();
      return { ok: true, core, port };
    } catch (e) {
      return { ok: false, port, error: e.message };
    }
  }

  /** 一个入口：给模型/控制台用 */
  async function doOp(op, params = {}) {
    const name = String(op || '').toLowerCase();
    try {
      if (name === 'search') return await search(params.text || params.keyword, Number(params.limit) || 8);
      if (name === 'now') return await nowPlaying();
      if (name === 'control') return await control(params.cmd || params.command);
      if (name === 'lyric') return await lyricText(String(params.id || params.songId), Number(params.lines) || 40);
      if (name === 'comments') return await comments(String(params.id || params.songId), Number(params.limit) || 12);
      if (name === 'room') return await roomState();
      if (name === 'play') {
        let id = String(params.id || params.songId || '').trim();
        let title = String(params.title || '');
        if (!id) {
          const found = await search(params.text || params.keyword, 1);
          if (!found.songs.length) throw new Error('没搜到这首歌');
          id = String(found.songs[0].id);
          title = found.songs[0].name + ' — ' + found.songs[0].artist;
        }
        return await playSong(id, title);
      }
      throw new Error(`网易云没这个操作：${op}（可用 search/play/now/control/lyric/comments/room）`);
    } catch (e) {
      stats.errors += 1;
      throw e;
    }
  }

  return { doOp, search, playSong, nowPlaying, control, lyric, lyricText, comments, roomState, health, stats, get port() { return port; } };
};
