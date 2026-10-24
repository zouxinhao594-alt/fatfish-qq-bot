// 读 DSH 的模型配置，把它的「渠道 + 模型清单」接进大肥鱼。
//
// 为什么要读 DSH：模型/接口/密钥在 DSH 里已经配好一份了，再让用户在控制台手抄一遍
// 既容易错也没必要。这里只做「发现」，不改 DSH 的任何文件。
//
// 数据来源（按优先级合并）：
//   1. $DSH_HOME/compositions/*.yml —— Cherry Studio 启动时生成的组合，里面有完整的
//      providers[{baseURL, api, models[{id,name,contextWindow,maxTokens,input}]}]
//   2. $DSH_HOME/settings.yaml     —— 用户手改过的 providers + agent-default-model
//   3. $DSH_HOME/.credentials.yaml —— refs 里存着 apiKeyEnv 对应的真实密钥
//   4. $DSH_HOME/secrets/<name>.txt —— 早期版本把密钥单独放这儿
//
// 注意：这里带一个「极简 YAML 子集解析器」，只处理缩进映射 / 列表（含对象列表）/
// 块标量 / 行内 [a, b] / 引号。因为整台机器上没有 YAML 依赖，而 DSH 这两个文件恰好只用这些。

import fs from 'node:fs';
import path from 'node:path';

/** 极简 YAML 子集解析。看不懂的行直接跳过，绝不抛异常把导入搞崩。 */
export function parseYamlSubset(text) {
  const root = { indent: -1, value: {} };
  const stack = [root];
  const top = () => stack[stack.length - 1];

  const stripComment = (s) => {
    let inS = null;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (inS) { if (c === inS) inS = null; continue; }
      if (c === '"' || c === "'") { inS = c; continue; }
      if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i);
    }
    return s;
  };

  const coerce = (v) => {
    const s = String(v).trim();
    if (!s) return null;
    if (/^\[(.*)\]$/.test(s)) {
      const inner = s.slice(1, -1).trim();
      return inner ? inner.split(',').map((x) => coerce(x)) : [];
    }
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
    if (s === 'true') return true;
    if (s === 'false') return false;
    if (s === 'null' || s === '~') return null;
    if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
    return s;
  };

  /**
   * 取当前缩进层的容器。
   * 栈顶若是「待定」（value === null，说明上一行是 "key:" 后面没值），
   * 就按这一行是不是以 "- " 开头决定建数组还是对象，挂回父节点。
   */
  function ensureContainer(lineText, indent) {
    while (stack.length > 1 && top().indent >= indent && top().value !== null) stack.pop();
    let t = top();
    if (t.value === null) {
      const isList = lineText.trimStart().startsWith('- ');
      const container = isList ? [] : {};
      if (t.parent && t.key !== undefined) t.parent[t.key] = container;
      t.value = container;
      return container;
    }
    return t.value;
  }

  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim() || /^\s*#/.test(raw) || raw.trim() === '---') continue;
    const indent = raw.length - raw.replace(/^\s+/, '').length;
    // 注意：这里必须 trim 掉行首空格 —— 缩进已经单独算过了，
    // 否则后面的 `key: value` 正则匹配不到（第一版就栽在这）。
    const body = stripComment(raw).trim();
    if (!body.trim()) continue;

    // 块标量：key: | 或 key: |-
    const block = body.match(/^([^\s:][^:]*):\s+([|>])([+-]?)\s*$/);
    if (block) {
      const key = block[1].trim();
      const collected = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const l = lines[j];
        if (!l.trim()) { collected.push(''); continue; }
        const ind = l.length - l.replace(/^\s+/, '').length;
        if (ind <= indent) break;
        collected.push(l.slice(Math.min(ind, indent + 2)));
      }
      i = j - 1;
      const holder = ensureContainer('x: y', indent);
      if (holder && !Array.isArray(holder)) holder[key] = collected.join('\n');
      continue;
    }

    // 列表项
    if (body.startsWith('- ') || body.trim() === '-') {
      let holder = ensureContainer(body, indent);
      if (!Array.isArray(holder)) {
        // 顶层直接是列表（DSH 的 compositions 就是这种）——把根对象换成数组
        if (holder === root.value && Object.keys(holder).length === 0) {
          const arr = [];
          stack[0].value = arr;
          holder = arr;
        } else continue; // 结构不对就跳过
      }
      const rest = body.slice(1).trim();
      if (!rest) { stack.push({ indent, value: {} }); holder.push(stack[stack.length - 1].value); continue; }
      const kv = rest.match(/^([^\s:][^:]*):\s*(.*)$/);
      if (!kv) { holder.push(coerce(rest)); continue; }
      const obj = {};
      holder.push(obj);
      const entry = { indent, value: obj };
      stack.push(entry);
      const k = kv[1].trim();
      const v = kv[2].trim();
      if (v) obj[k] = coerce(v);
      else { obj[k] = null; entry.value = null; entry.parent = obj; entry.key = k; }
      continue;
    }

    // key: value / key:
    const kv = body.match(/^([^\s:][^:]*):\s*(.*)$/);
    if (!kv) continue;
    const holder = ensureContainer(body, indent);
    if (!holder || Array.isArray(holder)) continue;
    const k = kv[1].trim();
    const v = kv[2].trim();
    if (v) holder[k] = coerce(v);
    else {
      holder[k] = null;
      stack.push({ indent, value: null, parent: holder, key: k });
    }
  }
  return root.value;
}

/** 找所有 DSH 组合文件里的 llm 插件，抽出 providers。 */
export function providersFromCompositions(dshHome) {
  const out = [];
  const dir = path.join(dshHome, 'compositions');
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir).filter((n) => /\.ya?ml$/i.test(n))) {
    let text;
    try { text = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
    const doc = parseYamlSubset(text);
    const rows = Array.isArray(doc) ? doc : [];
    for (const row of rows) {
      const providers = row && row.id === 'llm' && row.config && row.config.providers;
      if (providers && typeof providers === 'object' && !Array.isArray(providers)) {
        for (const [id, p] of Object.entries(providers)) out.push({ id, source: `compositions/${f}`, ...(p || {}) });
      }
    }
  }
  return out;
}

/** settings.yaml 里的 providers（用户手改过的那份）与默认模型。 */
export function providerFromSettings(dshHome) {
  const file = path.join(dshHome, 'settings.yaml');
  if (!fs.existsSync(file)) return { providers: [], defaultModel: null };
  let doc;
  try { doc = parseYamlSubset(fs.readFileSync(file, 'utf8')); } catch { return { providers: [], defaultModel: null }; }
  const raw = doc && doc['llm-pi-ai'] && doc['llm-pi-ai'].providers;
  const providers = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? Object.entries(raw).map(([id, p]) => ({ id, source: 'settings.yaml', ...(p || {}) }))
    : [];
  const dm = doc && doc['agent-default-model'];
  return { providers, defaultModel: dm && dm.model ? { provider: dm.provider, model: dm.model } : null };
}

/** 解析 apiKey：环境变量 → .credentials.yaml 的 refs → secrets/<name>.txt */
export function resolveApiKey(dshHome, apiKeyEnv, env = process.env) {
  if (!apiKeyEnv) return { key: '', from: '' };
  if (env[apiKeyEnv]) return { key: env[apiKeyEnv], from: `环境变量 ${apiKeyEnv}` };
  const cred = path.join(dshHome, '.credentials.yaml');
  if (fs.existsSync(cred)) {
    try {
      const doc = parseYamlSubset(fs.readFileSync(cred, 'utf8'));
      const refs = (doc && doc.refs) || {};
      if (refs[apiKeyEnv]) return { key: String(refs[apiKeyEnv]), from: '.credentials.yaml' };
    } catch { /* 忽略 */ }
  }
  const base = String(apiKeyEnv).toLowerCase();
  const candidates = [`${base}.txt`, `${base.replace(/_api_key$/, '')}_api_key.txt`];
  for (const name of candidates) {
    const p = path.join(dshHome, 'secrets', name);
    if (fs.existsSync(p)) {
      try {
        const k = fs.readFileSync(p, 'utf8').trim();
        if (k) return { key: k, from: `secrets/${name}` };
      } catch { /* 忽略 */ }
    }
  }
  return { key: '', from: '' };
}

/** 把 DSH 的 provider 归一化成大肥鱼的「渠道」。 */
export function normalizeChannel(p, dshHome, env = process.env) {
  if (!p || !p.id) return null;
  const models = [];
  for (const m of Array.isArray(p.models) ? p.models : []) {
    if (!m) continue;
    const id = typeof m === 'string' ? m : m.id;
    if (!id) continue;
    models.push({
      id: String(id),
      name: String(m.name || id),
      contextWindow: Number(m.contextWindow || 0) || 0,
      maxTokens: Number(m.maxTokens || 0) || 0,
      input: Array.isArray(m.input) ? m.input.map(String) : ['text']
    });
  }
  const apiBase = String(p.baseURL || p.apiBase || (p.id === 'deepseek' || p.id === 'deepseek-official' ? 'https://api.deepseek.com/v1' : ''));
  const keyEnv = p.apiKeyEnv || '';
  const { key, from } = resolveApiKey(dshHome, keyEnv, env);
  return {
    id: String(p.id),
    name: String(p.name || p.id),
    apiBase: apiBase.replace(/\/+$/, ''),
    apiKey: key,
    apiKeyFrom: from || (keyEnv ? `（没找到 ${keyEnv}）` : ''),
    api: String(p.api || 'openai-completions'),
    models,
    source: p.source || 'dsh'
  };
}

/**
 * 发现 DSH 里所有渠道。
 * 合并顺序：compositions 里的（最全）→ settings.yaml 里补默认模型/覆盖 key。
 */
export function discover({ dshHome = process.env.DSH_HOME || '', env = process.env } = {}) {
  const result = { dshHome, channels: [], defaultModel: null, warnings: [] };
  if (!dshHome || !fs.existsSync(dshHome)) {
    result.warnings.push('没设置 DSH_HOME 或目录不存在，跳过导入');
    return result;
  }
  const fromComp = providersFromCompositions(dshHome).map((p) => normalizeChannel(p, dshHome, env)).filter(Boolean);
  const { providers: fromSettings, defaultModel } = providerFromSettings(dshHome);
  const byId = new Map();
  for (const c of fromComp) byId.set(c.id, c);
  for (const p of fromSettings) {
    const c = normalizeChannel(p, dshHome, env);
    if (!c) continue;
    const old = byId.get(c.id);
    if (!old) { byId.set(c.id, c); continue; }
    byId.set(c.id, {
      ...old,
      ...c,
      apiBase: c.apiBase || old.apiBase,
      apiKey: c.apiKey || old.apiKey,
      models: old.models.length ? old.models : c.models,
      source: `${old.source} + settings.yaml`
    });
  }
  result.channels = [...byId.values()];
  result.defaultModel = defaultModel;
  if (!result.channels.length) result.warnings.push('DSH 里没找到任何 provider 定义');
  for (const c of result.channels) {
    if (!c.models.length) c.models.push({ id: '', name: '（DSH 没列出模型，可用「刷新清单」问接口）', input: ['text'], contextWindow: 0, maxTokens: 0 });
    if (!c.apiKey) result.warnings.push(`渠道 ${c.id} 没解出密钥（${c.apiKeyFrom || '未知来源'}）`);
  }
  return result;
}
