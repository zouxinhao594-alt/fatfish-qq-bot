// 联网抓取：模型提议 → 程序代抓 → 正文回灌。
// 安全闸（SSRF）：只放行 http/https、DNS 复查、私网/回环/云元数据一律拒绝、限大小限跳转限时间。

import dns from 'node:dns/promises';
import net from 'node:net';

export function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function ipIsPrivate(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const v = ip.toLowerCase();
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('::ffff:127.') || v.startsWith('::ffff:10.') || v.startsWith('::ffff:192.168.');
}

function hostAllowed(hostname, cfg) {
  const list = String(cfg.netAllowHosts || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!list.length) return null; // 没配 = 不限制域名（靠 IP 闸兜底）
  const h = hostname.toLowerCase();
  return list.some((x) => h === x || h.endsWith('.' + x)) ? true : false;
}

export function createNet({ cfg, log, fetchImpl = globalThis.fetch }) {
  const cache = new Map(); // url -> {at, value}
  const stats = { fetched: 0, blocked: 0, cached: 0, failed: 0, bytes: 0 };

  async function resolveSafe(hostname) {
    if (net.isIP(hostname)) return hostname;
    const addrs = await dns.lookup(hostname, { all: true });
    return addrs.map((a) => a.address);
  }

  async function checkUrl(rawUrl) {
    let u;
    try { u = new URL(rawUrl); } catch { return { ok: false, error: '不是合法网址' }; }
    if (!/^https?:$/.test(u.protocol)) return { ok: false, error: '只支持 http/https' };
    const allowed = hostAllowed(u.hostname, cfg);
    if (allowed === false) return { ok: false, error: '这个域名不在白名单里' };
    const ips = await resolveSafe(u.hostname);
    const list = Array.isArray(ips) ? ips : [ips];
    const loopback = list.every((ip) => ip === '127.0.0.1' || ip === '::1');
    const priv = list.some((ip) => ipIsPrivate(ip));
    if (priv && !(loopback && cfg.netAllowLoopback)) {
      stats.blocked += 1;
      return { ok: false, error: '目标是内网/本机地址，拒绝' };
    }
    return { ok: true, url: u };
  }

  async function readLimited(res, maxBytes) {
    const reader = res.body?.getReader?.();
    if (!reader) {
      const buf = Buffer.from(await res.arrayBuffer());
      return buf.subarray(0, maxBytes);
    }
    const chunks = [];
    let n = 0;
    while (n < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
      n += value.length;
    }
    try { await reader.cancel(); } catch { /* ignore */ }
    return Buffer.concat(chunks).subarray(0, maxBytes);
  }

  /** 抓一个网页 → 纯文本。 */
  /**
   * 同 fetchText，但**保留原始 HTML**（不转纯文本）。
   * 搜索引擎结果页要按结构解析，转成纯文本就没法区分标题/摘要/链接了。
   */
  async function fetchHtml(rawUrl, opts = {}) {
    const r = await fetchText(rawUrl, { ...opts, __wantHtml: true });
    return r;
  }

  async function fetchText(rawUrl, opts = {}) {
    const maxBytes = Number(opts.maxBytes || cfg.netMaxBytes || 5_000_000);
    const timeoutMs = Number(opts.timeoutMs || (cfg.netTimeoutSecs || 10) * 1000);
    const ttl = Number(cfg.netCacheTtlSecs || 300) * 1000;
    const ckey = rawUrl + (opts.__wantHtml ? '#html' : '');
    const cached = cache.get(ckey);
    if (cached && Date.now() - cached.at < ttl) { stats.cached += 1; return { ...cached.value, cached: true }; }

    let url = rawUrl;
    let hops = 0;
    const maxHops = Number(cfg.netMaxHops || 2);
    try {
      for (;;) {
        const chk = await checkUrl(url);
        if (!chk.ok) return { ok: false, ...chk };
        const res = await fetchImpl(url, {
          redirect: 'manual',
          headers: {
            // 搜索引擎对非浏览器 UA 会给"投毒"结果页（看着正常，内容全不对），
            // 所以搜索这类请求由调用方指定一个真实浏览器 UA。
            'User-Agent': opts.userAgent || 'FatFishBot/2.0 (+local)',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6',
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5'
          },
          signal: AbortSignal.timeout(timeoutMs)
        });
        if ([301, 302, 303, 307, 308].includes(res.status)) {
          const loc = res.headers.get('location');
          if (!loc || hops >= maxHops) return { ok: false, error: '跳转太多' };
          hops += 1;
          url = new URL(loc, url).toString();
          continue;
        }
        if (!res.ok) { stats.failed += 1; return { ok: false, error: `对方返回 ${res.status}` }; }
        const type = String(res.headers.get('content-type') || '');
        const buf = await readLimited(res, maxBytes);
        stats.bytes += buf.length;
        const raw = buf.toString('utf8');
        const text = (!opts.__wantHtml && /html|xml/i.test(type)) ? htmlToText(raw) : raw;
        const value = { ok: true, finalUrl: url, status: res.status, contentType: type, bytes: buf.length, text: text.slice(0, Number(opts.maxChars || cfg.netTextChars || 8000)) };
        cache.set(ckey, { at: Date.now(), value });
        stats.fetched += 1;
        log?.event('net', `抓取 ${url} → ${buf.length} 字节`);
        return value;
      }
    } catch (e) {
      stats.failed += 1;
      const msg = /abort|timeout/i.test(e.message) ? '抓取超时' : e.message;
      log?.event('net', `抓取失败 ${rawUrl}：${msg}`);
      return { ok: false, error: msg };
    }
  }

  return { fetchText, fetchHtml, checkUrl, stats, htmlToText };
}
