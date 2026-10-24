// 渠道与模型路由：一个渠道 = 一套 {接口地址, 密钥, 模型清单}。
//
// 为什么要「渠道」而不是只有一个 apiBase：
//   1. DSH 里可能同时配了 deepseek 官方、第三方中转、别的厂商；
//   2. 不同用途要用不同模型（聊天用好的，把关用便宜的）；
//   3. 想切模型时不希望改密钥、改地址 —— 只改一个字符串就够了。
//
// 路由写法：`渠道id/模型名`，例如 `deepseek/deepseek-flash`。
//   不带斜杠（例如只写 `deepseek-chat`）= 用默认渠道（配置里的 apiBase + apiKey）。

import { modelFor } from './config.mjs';

export const PURPOSES = [
  { id: 'chat', key: 'routeChat', label: '聊天', hint: '真正回话的那一次调用，最影响体验' },
  { id: 'gate', key: 'routeGate', label: '把关', hint: '判断"值不值得接话"，每条非 @ 消息一次，建议用便宜的' },
  { id: 'memory', key: 'routeMemory', label: '记忆', hint: '整理长期记忆时用（目前还没有调用点，先留位）' },
  { id: 'vision', key: 'visionModel', label: '识图', hint: '必须选支持图片输入的模型，否则看图会失败' }
];

/** 把 "渠道/模型" 拆开；只有模型名时渠道为空（用默认渠道）。 */
export function parseRoute(route) {
  const raw = String(route || '').trim();
  if (!raw) return { channelId: '', model: '' };
  const i = raw.indexOf('/');
  if (i <= 0) return { channelId: '', model: raw };
  return { channelId: raw.slice(0, i), model: raw.slice(i + 1) };
}

/** 拼回去。没有渠道时只返回模型名，保持老配置可读。 */
export function formatRoute(channelId, model) {
  const m = String(model || '').trim();
  if (!m) return '';
  const c = String(channelId || '').trim();
  return c ? `${c}/${m}` : m;
}

/** 默认渠道：配置里那套 apiBase/apiKey。 */
export function defaultChannel(cfg) {
  return { id: '', name: '默认渠道', apiBase: cfg.apiBase, apiKey: cfg.apiKey, api: 'openai-completions', models: [] };
}

export function channelsOf(cfg) {
  const list = Array.isArray(cfg.channels) ? cfg.channels.filter((c) => c && c.id) : [];
  return [...list, defaultChannel(cfg)];
}

/** 按渠道 id 找渠道；找不到就给默认渠道（并标记 fallback）。 */
export function resolveChannel(cfg, channelId) {
  const all = channelsOf(cfg);
  const hit = all.find((c) => String(c.id) === String(channelId || ''));
  if (hit) return { channel: hit, fallback: false };
  return { channel: defaultChannel(cfg), fallback: true };
}

/** 某个用途现在实际用哪个渠道 + 哪个模型。 */
export function resolvePurpose(cfg, purpose) {
  const route = purpose === 'vision' ? cfg.visionModel : modelFor(cfg, purpose);
  const { channelId, model } = parseRoute(route);
  const { channel, fallback } = resolveChannel(cfg, channelId);
  return { route, channelId: channel.id, channelName: channel.name, model: model || cfg.model, fallback, hasKey: !!channel.apiKey };
}

/** 所有可用模型的扁平清单（给控制台下拉用，按渠道分组）。 */
export function allModels(cfg) {
  const out = [];
  for (const ch of channelsOf(cfg)) {
    for (const m of ch.models || []) {
      if (!m || !m.id) continue;
      out.push({
        channelId: ch.id,
        channelName: ch.name,
        route: formatRoute(ch.id, m.id),
        id: m.id,
        name: m.name || m.id,
        input: m.input || ['text'],
        contextWindow: m.contextWindow || 0,
        maxTokens: m.maxTokens || 0
      });
    }
  }
  return out;
}

/** 从 DSH 发现结果合并进配置：同 id 的渠道覆盖地址/密钥，模型清单取并集。 */
export function mergeDiscovered(cfg, discovered) {
  const existing = Array.isArray(cfg.channels) ? cfg.channels.filter((c) => c && c.id) : [];
  const byId = new Map(existing.map((c) => [String(c.id), { ...c }]));
  const summary = { added: 0, updated: 0, models: 0 };
  for (const ch of discovered.channels || []) {
    const old = byId.get(ch.id);
    const models = new Map();
    for (const m of (old && old.models) || []) if (m && m.id) models.set(m.id, m);
    for (const m of ch.models || []) if (m && m.id) models.set(m.id, { ...(models.get(m.id) || {}), ...m });
    const merged = {
      ...(old || {}),
      id: ch.id,
      name: old?.name || ch.name || ch.id,
      apiBase: ch.apiBase || old?.apiBase || '',
      apiKey: ch.apiKey || old?.apiKey || '',
      api: ch.api || old?.api || 'openai-completions',
      models: [...models.values()]
    };
    if (old) summary.updated += 1; else summary.added += 1;
    summary.models += merged.models.length;
    byId.set(ch.id, merged);
  }
  cfg.channels = [...byId.values()];
  return summary;
}

/** 问每个渠道的 /models，把返回的清单并进配置（探到的模型保留原有元信息）。 */
export async function refreshModels(cfg, { fetchImpl = globalThis.fetch, timeoutMs = 8000, log } = {}) {
  const report = [];
  for (const ch of channelsOf(cfg)) {
    if (!ch.apiKey || !ch.apiBase) {
      report.push({ channelId: ch.id, channelName: ch.name, ok: false, error: '缺地址或密钥', models: 0 });
      continue;
    }
    try {
      const res = await fetchImpl(`${String(ch.apiBase).replace(/\/+$/, '')}/models`, {
        headers: { Authorization: `Bearer ${ch.apiKey}` },
        signal: AbortSignal.timeout(timeoutMs)
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 120)}`);
      const data = JSON.parse(text);
      const ids = (data.data || data.models || []).map((m) => String(m.id || m.name || '')).filter(Boolean);
      const target = ch.id ? (cfg.channels || []).find((c) => String(c.id) === String(ch.id)) : null;
      const known = new Map((ch.models || []).map((m) => [m.id, m]));
      if (target) {
        target.models = ids.map((id) => known.get(id) || { id, name: id, input: ['text'], contextWindow: 0, maxTokens: 0 });
        target.modelsUpdatedAt = Date.now();
      }
      report.push({ channelId: ch.id, channelName: ch.name, ok: true, models: ids.length, ids });
      log?.event('models', `渠道 ${ch.name || ch.id} 刷新到 ${ids.length} 个模型`);
    } catch (e) {
      // 失败保留原清单，绝不因为一次失败把用户的选择清空
      report.push({ channelId: ch.id, channelName: ch.name, ok: false, error: e.message, models: (ch.models || []).length });
      log?.event('models', `渠道 ${ch.name || ch.id} 刷新失败（清单保留）：${e.message}`);
    }
  }
  return report;
}

/** 改某个用途用哪个模型；返回改后的路由字符串。 */
export function setPurpose(cfg, purpose, route) {
  const p = PURPOSES.find((x) => x.id === purpose);
  if (!p) throw new Error(`未知用途：${purpose}`);
  const value = String(route || '').trim();
  cfg[p.key] = value;
  return value;
}

/** 一句话说清当前路由（控制台与日志共用）。 */
export function describeRoutes(cfg) {
  return PURPOSES.map((p) => {
    const r = resolvePurpose(cfg, p.id);
    return { purpose: p.id, label: p.label, route: r.route || r.model, channelId: r.channelId, channelName: r.channelName, model: r.model, fallback: r.fallback, hasKey: r.hasKey };
  });
}
