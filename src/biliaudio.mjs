// 从 B站 取音频（不需要登录）——用来做"人声替换、保留伴奏"。
//
// 为什么走 B站 而不是 QQ音乐：
//   QQ音乐 现在匿名不给 purl，要 MUSIC_U；而 Edge 127+ 的 cookie 是 v20「应用绑定加密」，
//   外部解不开（DPAPI 拿不到那把钥匙），Edge 136+ 又不许在默认 profile 上开远程调试。
//   B站 的 playurl 匿名可用：view 拿 cid → playurl?fnval=16 拿 dash 音轨 → 直接下载。
//
// 用法：
//   原曲：{"song":{"bili":"起风了 买辣椒也用券"}}   → 抓原曲 → Demucs 拆人声 → RVC 换声 → 配伴奏
//   只要伴奏：bili.downloadAccomp("起风了")          → 抓 B站上现成的伴奏视频音轨
//
// 注意：B站 用户上传的音源，音质取决于那个视频；只用音频、不传播视频本身。

import fs from 'node:fs';
import path from 'node:path';

const H = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
  Referer: 'https://www.bilibili.com/'
};

/** B站搜索结果的时长有时是 "5:22"、有时是秒数，统一成秒 */
function parseDur(v) {
  if (typeof v === 'number') return v;
  const s = String(v || '').trim();
  if (/^\d+$/.test(s)) return Number(s);
  const m = /^(\d+):(\d{1,2})$/.exec(s);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  return 0;
}

export const createBiliAudio = ({ cfg = {}, log = null, fetchImpl = globalThis.fetch, songsDir = 'data/songs' } = {}) => {
  const stats = { search: 0, download: 0, errors: 0 };

  let buvid = '';
  /** B站匿名风控认 buvid3/buvid4；不带就返回一张 HTML 风险页 */
  async function ensureBuvid() {
    if (buvid) return buvid;
    try {
      const r = await fetchImpl('https://api.bilibili.com/x/frontend/finger/spi', { headers: H, signal: AbortSignal.timeout(15000) });
      const j = await r.json();
      const b3 = j?.data?.b_3 || '';
      const b4 = j?.data?.b_4 || '';
      if (b3) buvid = 'buvid3=' + b3 + (b4 ? '; buvid4=' + b4 : '');
    } catch { /* 拿不到就裸奔，可能被风控 */ }
    return buvid;
  }

  function headers() {
    return buvid ? { ...H, Cookie: buvid } : { ...H };
  }

  async function getJson(url) {
    await ensureBuvid();
    const r = await fetchImpl(url, { headers: headers(), signal: AbortSignal.timeout(20000) });
    const t = await r.text();
    try { return JSON.parse(t); } catch { throw new Error('B站返回的不是 JSON：' + t.slice(0, 80)); }
  }

  /** 搜视频：返回 [{bvid,title,author,duration}] */
  async function search(keyword, limit = 12) {
    const q = String(keyword || '').trim();
    if (!q) throw new Error('要搜什么？');
    const j = await getJson('https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=' + encodeURIComponent(q));
    if (j.code !== 0) throw new Error('B站搜索失败：' + (j.message || j.code));
    const list = ((j.data && j.data.result) || []).map((v) => ({
      bvid: v.bvid,
      title: String(v.title || '').replace(/<[^>]+>/g, ''),
      author: v.author || '',
      duration: parseDur(v.duration)
    }));
    stats.search += 1;
    log?.event('bili', `搜「${q}」→ ${list.length} 条${list[0] ? '：' + list[0].title.slice(0, 30) : ''}`);
    return list.slice(0, limit);
  }

  /** 拿 dash 音轨地址 */
  async function audioUrl(bvid) {
    const view = await getJson('https://api.bilibili.com/x/web-interface/view?bvid=' + encodeURIComponent(bvid));
    if (view.code !== 0) throw new Error('取视频信息失败：' + (view.message || view.code));
    const cid = view.data?.pages?.[0]?.cid;
    if (!cid) throw new Error('这个视频没有分P/cid');
    const p = await getJson(`https://api.bilibili.com/x/player/playurl?bvid=${encodeURIComponent(bvid)}&cid=${cid}&fnval=16&fnver=0&fourk=1`);
    if (p.code !== 0) throw new Error('取播放地址失败：' + (p.message || p.code));
    const audio = ((p.data?.dash?.audio) || []).sort((a, b) => b.bandwidth - a.bandwidth)[0];
    if (!audio) throw new Error('没有 dash 音轨（可能需要登录或视频无音轨）');
    return { url: audio.baseUrl || audio.base_url, bandwidth: audio.bandwidth, title: view.data.title, duration: Number(view.data.duration) || 0 };
  }

  /** 下载音轨到 data/songs，返回本地文件 */
  async function download(bvid, { name = '' } = {}) {
    const info = await audioUrl(bvid);
    await ensureBuvid();
    const r = await fetchImpl(info.url, { headers: headers(), signal: AbortSignal.timeout(300000) });
    if (!r.ok) throw new Error('下载音轨失败 HTTP ' + r.status);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 50_000) throw new Error('音轨太小（' + buf.length + ' 字节）');
    fs.mkdirSync(songsDir, { recursive: true });
    const safe = String(name || info.title || bvid).replace(/[\\/:*?"<>|]/g, '_').slice(0, 48);
    const file = path.join(songsDir, `${safe}__bili.m4a`);
    fs.writeFileSync(file, buf);
    stats.download += 1;
    log?.event('bili', `下好「${info.title.slice(0, 30)}」：${Math.round(buf.length / 1024)} KB（${info.duration} 秒，${Math.round(info.bandwidth / 1000)} kbps）`);
    return { ok: true, file, title: info.title, duration: info.duration, bytes: buf.length, bvid };
  }

  /**
   * 找一首歌的原曲：优先时长接近完整歌（120~600 秒）、标题像官方/原唱、不要"伴奏/翻唱/纯音乐"。
   */
  async function findSong(text) {
    const list = await search(text, 12);
    const score = (v) => {
      let s = 0;
      if (v.duration >= 120 && v.duration <= 600) s += 3;
      if (/原唱|官方|MV|无损|高音质|完整版/.test(v.title)) s += 2;
      if (/伴奏|纯音乐|翻唱|鬼畜|循环|钢琴|吉他|消音/.test(v.title)) s -= 5;
      if (v.title.includes(text.split(' ')[0])) s += 1;
      return s;
    };
    const best = list.map((v) => ({ v, s: score(v) })).sort((a, b) => b.s - a.s)[0];
    return best ? best.v : null;
  }

  /** 找现成的伴奏视频 */
  async function findAccomp(text) {
    const base = String(text || '').trim();
    if (!base) return null;
    const list = await search(base + ' 伴奏', 12);
    const hit = list.filter((v) => /伴奏|instrumental|纯音乐|off\s*vocal|消音/i.test(v.title) && v.duration >= 60)
      .sort((a, b) => {
        // 时长越接近完整歌越好；标题里同时出现歌名更好
        const ka = (base.split(' ')[0] && a.title.includes(base.split(' ')[0]) ? 2 : 0) + (a.duration >= 120 ? 2 : 0);
        const kb = (base.split(' ')[0] && b.title.includes(base.split(' ')[0]) ? 2 : 0) + (b.duration >= 120 ? 2 : 0);
        return kb - ka;
      })[0];
    return hit || null;
  }

  /** 一步到位：抓原曲（+ 可选伴奏） */
  async function fetchSong(text, { accomp = true } = {}) {
    const main = await findSong(text);
    if (!main) throw new Error(`B站上没搜到「${text}」`);
    const song = await download(main.bvid, { name: main.title });
    let acc = null;
    if (accomp) {
      try {
        const a = await findAccomp(text);
        if (a && Math.abs(a.duration - main.duration) < 90) {
          acc = await download(a.bvid, { name: a.title });
          log?.event('bili', `官方伴奏对上了：「${a.title.slice(0, 30)}」`);
        } else if (a) {
          log?.event('bili', `找到的伴奏时长差太多（${a.duration}s vs ${main.duration}s），不用它，改用 Demucs 拆`);
        }
      } catch (e) { log?.event('bili', `伴奏没抓到（用 Demucs 拆）：${e.message.slice(0, 60)}`); }
    }
    return { song, accomp: acc };
  }

  return { search, audioUrl, download, findSong, findAccomp, fetchSong, stats, dirs: { songsDir } };
};
