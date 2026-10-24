// 自己搜东西：直接把搜索结果标题+摘要抓回来（走 HTTP，不需要打开浏览器）。
//
// 为什么要多引擎 + 相关性闸门（真踩过的坑）：
//   2026-10-21 实测，用 FatFishBot 的 UA 抓 cn.bing.com，同一句「鱼汤的做法 家常」
//   三次返回三批不相干的东西（4399、斗鱼、翻译插件），「番茄鱼汤泡饭」返回番茄小说。
//   这不是解析器的错，是必应对非浏览器客户端的"投毒"——它给一份看着正常的 SERP，
//   里面全是别的词的广告页。所以：**解析完必须验相关性，对不上就换引擎**，
//   绝不能把一堆 SPSS 页面喂给模型然后让它对着用户说"搜出来全是统计软件"。
//
// 分工：
//   webSearch   → 我（模型）需要事实时自己查（走 HTTP，快）

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const strip = (s) => String(s || '')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&')
  .replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'")
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/<!\[CDATA\[|\]\]>/g, '')
  .replace(/\s+/g, ' ')
  .trim();

/** 必应结果页（HTML，保留给测试与降级）：<li class="b_algo"> + <h2><a> + <p> */
export function parseBing(html, topK = 5) {
  const out = [];
  for (const b of String(html || '').split(/<li class="b_algo"/i).slice(1)) {
    const a = b.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!a) continue;
    const title = strip(a[2]);
    if (!title) continue;
    const p = b.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    out.push({ title: title.slice(0, 120), url: a[1], snippet: (p ? strip(p[1]) : '').slice(0, 200) });
    if (out.length >= topK) break;
  }
  return out;
}

/** 必应 RSS（format=rss）：比 HTML 干净得多，没有被广告位污染；<item><title><link><description> */
export function parseBingRss(xml, topK = 5) {
  const out = [];
  for (const m of String(xml || '').matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const b = m[1];
    const pick = (tag) => {
      const x = b.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i'));
      return x ? strip(x[1]) : '';
    };
    const title = pick('title');
    if (!title) continue;
    out.push({ title: title.slice(0, 120), url: pick('link'), snippet: pick('description').slice(0, 200) });
    if (out.length >= topK) break;
  }
  return out;
}

/** 360 搜索：结果的标题都在某个 <h3 ...><a href>标题</a> 里，class 有好几种变体 */
export function parseSo360(html, topK = 5) {
  const parts = String(html || '').split(/<h3[^>]*>/i);
  const out = [];
  for (let i = 1; i < parts.length && out.length < topK; i++) {
    const a = parts[i].match(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!a) continue;
    const title = strip(a[2]);
    if (!title || title.length < 4) continue;
    const snippet = strip(parts[i + 1] || '').slice(0, 200);
    out.push({ title: title.slice(0, 120), url: a[1], snippet });
  }
  return out;
}

/** 搜狗：<h3 class="vr-title"><a href>标题</a></h3>，摘要散在后面 */
export function parseSogou(html, topK = 5) {
  const out = [];
  for (const b of String(html || '').split(/<h3[^>]*>/i).slice(1)) {
    const a = b.match(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!a) continue;
    const title = strip(a[2]);
    if (!title || title.length < 4) continue;
    const snippet = strip(b.replace(/<h3[\s\S]*?<\/h3>/i, '')).slice(0, 200);
    out.push({ title: title.slice(0, 120), url: a[1].startsWith('http') ? a[1] : 'https://www.sogou.com' + a[1], snippet });
    if (out.length >= topK) break;
  }
  return out;
}

/** 百度结果页：<div class="result c-container" ...> 里 <h3><a href> + 摘要 */
export function parseBaidu(html, topK = 5) {
  const out = [];
  for (const b of String(html || '').split(/<div[^>]+class="[^"]*result[^"]*c-container/i).slice(1)) {
    const a = b.match(/<h3[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!a) continue;
    const title = strip(a[2]);
    const p = b.match(/class="[^"]*(?:content-right|c-abstract|c-span-last)[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    let snippet = p ? strip(p[1]) : '';
    if (!snippet) {
      const cands = [...b.matchAll(/>([^<>]{20,200})</g)].map((m) => strip(m[1])).filter((s) => /[\u4e00-\u9fa5]/.test(s));
      snippet = cands.sort((x, y) => y.length - x.length)[0] || '';
    }
    if (title) out.push({ title: title.slice(0, 120), url: a[1], snippet: snippet.slice(0, 200) });
    if (out.length >= topK) break;
  }
  return out;
}

export const ENGINES = {
  so360: { url: (q) => 'https://www.so.com/s?q=' + encodeURIComponent(q), parse: parseSo360 },
  bing: { url: (q) => 'https://cn.bing.com/search?q=' + encodeURIComponent(q) + '&format=rss&setlang=zh-CN', parse: parseBingRss },
  sogou: { url: (q) => 'https://www.sogou.com/web?query=' + encodeURIComponent(q), parse: parseSogou },
  baidu: { url: (q) => 'https://www.baidu.com/s?wd=' + encodeURIComponent(q) + '&rn=10', parse: parseBaidu }
};

/** 最长公共子串长度（句子都很短，直接 DP） */
function commonRun(a, b) {
  if (!a || !b) return 0;
  let best = 0;
  const prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let diag = 0;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      if (a[i - 1] === b[j - 1]) {
        prev[j] = diag + 1;
        if (prev[j] > best) best = prev[j];
      } else prev[j] = 0;
      diag = tmp;
    }
  }
  return best;
}

/**
 * 一条结果跟这句查询对不对得上：查询拆成几段，取"最长连续命中所占比例"里最好的那个。
 * 阈值 0.5 —— 「番茄鱼汤泡饭」碰上「番茄小说」只有 0.33，会被判不相关（正是要的效果）。
 */
export function relevanceOf(query, result) {
  // 风控页/加载页当结果返回的情况很常见（标题就一句"请稍候…"），直接判无关
  if (/^(请稍候|安全验证|百度安全验证|验证码|访问异常|人机验证|加载中|404|页面不存在)/.test(String(result.title || '').trim())) return 0;
  const text = `${result.title || ''} ${result.snippet || ''}`;
  const segs = String(query || '').split(/[\s,，、。？?！!]+/).map((s) => s.trim()).filter((s) => s.length >= 2);
  if (!segs.length) return 1;
  let best = 0;
  for (const seg of segs) best = Math.max(best, commonRun(seg, text) / seg.length);
  return best;
}

export function createWebSearch({ cfg, log, fetchText, fetchHtml }) {
  const stats = { queries: 0, hits: 0, empty: 0, errors: 0, poisoned: 0 };
  // 结果页必须拿到原始 HTML/XML：fetchText 会先转纯文本，标签一没了就没法分标题/摘要。
  const grab = fetchHtml || fetchText;

  function engineChain() {
    const first = String(cfg.webSearchEngine || 'so360').toLowerCase();
    const primary = ENGINES[first] ? first : 'so360';
    const order = [primary, ...Object.keys(ENGINES).filter((x) => x !== primary)];
    return cfg.webSearchFallback === false ? [primary] : order;
  }

  /**
   * 搜一句，返回 { ok, engine, results:[{title,url,snippet}], empty, error }
   * 解析不到、或者解析出来跟查询对不上（被投毒），都算这家引擎失败，换下一个。
   */
  async function search(query) {
    const q = String(query || '').trim().slice(0, 120);
    if (!q) return { ok: false, error: '要搜什么' };
    if (cfg.webSearchEnabled === false) return { ok: false, error: '联网搜索没开' };
    if (cfg.netEnabled === false) return { ok: false, error: '联网抓取没开（设置里「联网抓取」）' };
    stats.queries += 1;
    const topK = Math.max(1, Math.min(8, Number(cfg.webSearchTopK) || 5));
    const tried = [];
    for (const e of engineChain()) {
      const eng = ENGINES[e];
      try {
        const r = await grab(eng.url(q), { maxBytes: 1_500_000, maxChars: 2_000_000, userAgent: UA });
        if (!r.ok) { tried.push(`${e}:${r.error || '抓取失败'}`); continue; }
        const raw = eng.parse(r.text, topK * 2);
        if (!raw.length) { tried.push(`${e}:空页${String(r.text || '').length}字`); log?.event('search', `搜「${q}」（${e}）没解析出结果`); continue; }
        const good = raw.filter((it) => relevanceOf(q, it) >= 0.5);
        if (!good.length) {
          // 一家引擎返回的东西跟这句查询毫无关系 —— 大概率是投毒页，别喂给模型
          stats.poisoned += 1;
          tried.push(`${e}:${raw.length}条全不相关`);
          log?.event('search', `搜「${q}」（${e}）结果全不相关，换引擎（首个：${raw[0].title.slice(0, 24)}）`);
          continue;
        }
        const results = good.slice(0, topK);
        stats.hits += 1;
        log?.event('search', `搜「${q}」（${e}）→ ${results.length} 条相关：${results[0].title.slice(0, 30)}`);
        return { ok: true, engine: e, query: q, results, rawCount: raw.length };
      } catch (err) {
        tried.push(`${e}:${err.message}`);
        log?.event('search', `搜「${q}」（${e}）出错：${err.message}`);
      }
    }
    stats.empty += 1;
    return { ok: true, query: q, engine: engineChain()[0], results: [], empty: true, error: tried.join('；') };
  }

  /** 渲染成能塞进 prompt 的一段 */
  function render(res, maxChars = 900) {
    if (!res || !res.ok) return '';
    if (!res.results?.length) return `【联网搜索：${res.query}】没搜到结果（不要编，就说没查到）。`;
    const lines = res.results.map((r, i) => `${i + 1}. ${r.title}${r.snippet ? '\n   ' + r.snippet : ''}\n   ${r.url}`);
    return `【联网搜索：${res.query}（${res.engine}）】\n${lines.join('\n')}`.slice(0, maxChars);
  }

  return { search, render, stats };
}
