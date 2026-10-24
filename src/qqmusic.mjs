// QQ音乐（用户选了 QQ音乐，不用网易云）
//
// 全部走官方公开接口，不需要登录、不需要装客户端：
//   1) 搜歌 / 歌词 / 热评 —— 随时能用
//   2) 下歌 / 找伴奏 —— 给了登录 cookie（MUSIC_U）才能拿到音频
//   3) 排行榜 —— 用 musicu 统一接口（可选）
//
// 为什么不用 kit 里的 ncm：那套是靠注入网易云客户端的 webpack 偷 redux store，
// 只对网易云、且只对"带调试口启动的 PC 客户端"有效。QQ音乐没这条路，
// 所以改成走它自己的 HTTP 接口 —— 更稳，也不用装任何东西。

import fs from 'node:fs';
import path from 'node:path';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36';
const H = { 'User-Agent': UA, Referer: 'https://y.qq.com/' };

const stripTags = (s) => String(s ?? '')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&')
  .replace(/&quot;/g, '"')
  .replace(/&lt;|&gt;/g, '')
  .replace(/\s+/g, ' ')
  .trim();

export const createQqMusic = ({ cfg = {}, log = null, fetchImpl = globalThis.fetch, songsDir = 'data/songs' } = {}) => {
  const stats = { search: 0, lyric: 0, comments: 0, errors: 0 };

  async function getJson(url) {
    const r = await fetchImpl(url, { headers: H, signal: AbortSignal.timeout(15000) });
    const text = await r.text();
    try { return JSON.parse(text); } catch { throw new Error('QQ音乐返回的不是 JSON：' + text.slice(0, 80)); }
  }

  /** 搜歌 → [{mid,id,name,singer,album,duration}] */
  async function search(keyword, limit = 8) {
    const q = String(keyword || '').trim();
    if (!q) throw new Error('要搜什么歌？');
    const n = Math.max(1, Math.min(20, Number(limit) || 8));
    const j = await getJson(`https://c.y.qq.com/soso/fcgi-bin/client_search_cp?p=1&n=${n}&w=${encodeURIComponent(q)}&format=json`);
    const list = (j?.data?.song?.list) || [];
    const songs = list.map((s) => ({
      mid: s.songmid,
      id: String(s.songid),
      name: s.songname,
      singer: (s.singer || []).map((a) => a.name).join('/'),
      album: s.albumname || '',
      duration: Number(s.interval) || 0
    })).filter((s) => s.mid && s.name);
    stats.search += 1;
    log?.event('qqmusic', `搜歌「${q}」→ ${songs.length} 首${songs[0] ? '：' + songs[0].name + ' — ' + songs[0].singer : ''}`);
    return { ok: true, query: q, songs };
  }

  /** 歌词（带时间轴） */
  async function lyric(mid) {
    const m = String(mid || '').trim();
    if (!m) throw new Error('要给 songmid');
    const j = await getJson(`https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=${encodeURIComponent(m)}&format=json&nobase64=1&g_tk=5381`);
    const lrc = String(j?.lyric || '');
    if (!lrc) throw new Error(j?.retcode !== 0 ? `QQ音乐取歌词失败（retcode ${j?.retcode}）` : '这首歌没有歌词');
    const lines = [];
    for (const raw of lrc.split(/\r?\n/)) {
      const mm = /^\[(\d{1,3}):(\d{2}(?:\.\d{1,3})?)\]\s*(.*)$/.exec(raw.trim());
      if (mm && mm[3]) lines.push({ t: Math.round((Number(mm[1]) * 60 + Number(mm[2])) * 10) / 10, text: mm[3] });
    }
    stats.lyric += 1;
    return { ok: true, mid: m, lines };
  }

  /** 纯文本歌词（去掉词曲编曲那几行，适合聊天里念） */
  async function lyricText(mid, maxLines = 40) {
    const { lines } = await lyric(mid);
    const CREDIT = /^(合声|和声|吉他|贝斯|鼓|弦乐|钢琴|录音|混音|母带|制作|出品|编曲|作词|作曲|词|曲|监制|统筹|企划|OP|SP|发行|Program|Keyboard|Bass|Guitar)[：:]/i;
    return lines
      .filter((l) => !CREDIT.test(l.text))
      // 第一行通常是"歌名 - 歌手 (英文名)"，还有版权声明那种，也去掉
      .filter((l) => !/^\S{1,20}\s*-\s*\S{1,20}(\s*[（(].*[）)])?$/.test(l.text))
      .filter((l) => !/未经著作人许可|不得翻唱|翻录|版权所有/.test(l.text))
      .slice(0, maxLines)
      .map((l) => l.text);
  }

  /** 热评（按赞数排） */
  async function comments(songId, limit = 12) {
    const id = String(songId || '').trim();
    if (!id) throw new Error('要给 songid');
    const n = Math.max(1, Math.min(25, Number(limit) || 12));
    const j = await getJson('https://c.y.qq.com/base/fcgi-bin/fcg_global_comment_h5.fcg?g_tk=5381&loginUin=0&hostUin=0'
      + '&format=json&inCharset=utf8&outCharset=utf-8&notice=0&platform=yqq.json&needNewCode=0'
      + `&cid=205360772&reqtype=2&biztype=1&topid=${encodeURIComponent(id)}&cmd=8&needmusiccrit=0&pagenum=0&pagesize=${n}`);
    const hot = ((j?.hot_comment?.commentlist) || []).map((c) => ({
      user: c.nick || '',
      text: stripTags(String(c.rootcommentcontent || '')).slice(0, 160),
      likes: Number(c.praisenum) || 0
    })).filter((c) => c.text);
    stats.comments += 1;
    return { ok: true, songId: id, total: Number(j?.comment?.commenttotal) || Number(j?.commenttotal) || 0, hot };
  }

  /** 搜伴奏：官方伴奏通常是独立条目（名字里带"伴奏"/"off vocal"/"instrumental"） */
  async function searchAccomp(text, limit = 6) {
    const base = String(text || '').trim();
    if (!base) throw new Error('要搜哪首歌的伴奏？');
    const seen = new Set();
    const out = [];
    for (const q of [`${base} 伴奏`, `${base} 纯伴奏`, `${base} off vocal`]) {
      try {
        const r = await search(q, 10);
        for (const s of r.songs) {
          if (seen.has(s.mid)) continue;
          if (!/伴奏|纯音乐|off\s*vocal|instrumental|卡拉/i.test(s.name)) continue;
          seen.add(s.mid);
          out.push(s);
          if (out.length >= limit) return { ok: true, query: base, songs: out };
        }
      } catch { /* 一个关键词搜不到就换下一个 */ }
    }
    return { ok: true, query: base, songs: out, empty: out.length === 0 };
  }

  /**
   * 取音频地址并下载（需要登录 cookie：QQ音乐现在不给匿名 purl，试了六首歌全是空）。
   * cookie 只要 MUSIC_U（浏览器里 y.qq.com 登录后复制），uin 可留空 —— 从 cookie 里抠。
   */
  async function download({ text = '', mid = '', cookie = '' } = {}) {
    let jar = String(cookie || cfg.qqMusicCookie || '').trim();
    if (!jar && cfg.qqMusicAutoCookie !== false) {
      // 自动去本机浏览器里捡一次（用户不用手贴）
      try {
        const { pickQqMusicCookie } = await import('./cookiepick.mjs');
        const got = await pickQqMusicCookie();
        if (got.ok) {
          jar = got.cookie;
          log?.event('qqmusic', '从浏览器捡到登录 cookie（' + got.from + '）');
        } else {
          log?.event('qqmusic', '浏览器里没捡到 cookie：' + String(got.note || '').slice(0, 80));
        }
      } catch (e) {
        log?.event('qqmusic', '捡 cookie 失败：' + String(e.message).slice(0, 60));
      }
    }
    if (!jar) throw new Error('要下载得先有 QQ音乐的登录态：① 浏览器登录 y.qq.com（我会自动去读）② 或设置页「QQ音乐 Cookie」手贴 MUSIC_U');
    let songmid = String(mid || '').trim();
    let title = text;
    if (!songmid) {
      const found = await search(text, 1);
      const s = found.songs[0];
      if (!s) throw new Error(`没搜到「${text}」`);
      songmid = s.mid;
      title = `${s.name} - ${s.singer}`;
    }
    const uin = (/(?:^|;\s*)(?:uin|wxuin|p_uin)=o?(\d+)/.exec(jar) || [])[1]
      || String(cfg.qqMusicUin || '').replace(/\D/g, '') || '0';
    const body = {
      req_0: {
        module: 'vkey.GetVkeyServer', method: 'CgiGetVkey',
        param: { guid: '10000', songmid: [songmid], songtype: [0], uin, loginflag: 1, platform: '20' }
      },
      comm: { uin: Number(uin) || 0, format: 'json', ct: 24, cv: 0 }
    };
    const v = await fetchImpl('https://u.y.qq.com/cgi-bin/musicu.fcg?format=json', {
      method: 'POST',
      headers: { ...H, 'Content-Type': 'application/json', Cookie: jar },
      body: JSON.stringify(body), signal: AbortSignal.timeout(20000)
    }).then((r) => r.json()).catch((e) => { throw new Error('取播放地址失败：' + e.message); });
    const info = v?.req_0?.data?.midurlinfo?.[0] || {};
    const purl = info.purl || '';
    if (!purl) {
      const why = info.errtype || v?.req_0?.data?.msg || '没给 purl';
      throw new Error(`这首拿不到音频（${why}）—— cookie 过期了、或者这歌要会员`);
    }
    const sip = v?.req_0?.data?.sip?.[0] || 'https://dl.stream.qqmusic.qq.com/';
    const url = sip.replace(/^http:/, 'https:') + purl;
    const r = await fetchImpl(url, { headers: { ...H, Cookie: jar }, signal: AbortSignal.timeout(120000) });
    if (!r.ok) throw new Error(`下载失败 HTTP ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 50_000) throw new Error('下到的文件太小（' + buf.length + ' 字节）');
    fs.mkdirSync(songsDir, { recursive: true });
    const safe = String(title || songmid).replace(/[\\/:*?"<>|]/g, '_').slice(0, 40) || songmid;
    const file = path.join(songsDir, `${safe}.${/\.mp3$|\.m4a$/i.test(purl) ? purl.split('.').pop().toLowerCase() : 'm4a'}`);
    fs.writeFileSync(file, buf);
    stats.download = (stats.download || 0) + 1;
    log?.event('qqmusic', `下载完成：${path.basename(file)}（${Math.round(buf.length / 1024)} KB）`);
    return { ok: true, file, name: path.basename(file), title, songmid, bytes: buf.length };
  }
  async function doOp(op, params = {}) {
    const name = String(op || '').toLowerCase();
    try {
      if (name === 'search') return await search(params.text || params.keyword, Number(params.limit) || 8);
      if (name === 'lyric') {
        let mid = String(params.mid || params.songmid || '').trim();
        if (!mid) { const f = await search(params.text || params.keyword, 1); mid = f.songs[0]?.mid || ''; }
        const lines = await lyricText(mid, Number(params.lines) || 40);
        return { ok: true, mid, lines };
      }
      if (name === 'comments') {
        let id = String(params.id || params.songid || '').trim();
        if (!id) { const f = await search(params.text || params.keyword, 1); id = f.songs[0]?.id || ''; }
        return await comments(id, Number(params.limit) || 12);
      }
      if (name === 'download') return await download(params);
      if (name === 'accomp') return await searchAccomp(params.text || params.keyword, Number(params.limit) || 6);
      throw new Error(`QQ音乐没这个操作：${op}（可用 search/lyric/comments/download/accomp）`);
    } catch (e) {
      stats.errors += 1;
      throw e;
    }
  }

  return { doOp, search, searchAccomp, download, lyric, lyricText, comments, stats };
};
