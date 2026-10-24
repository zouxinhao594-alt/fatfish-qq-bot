// 人格：角色卡热加载（改完保存即生效，不用重启）。
//
// 两种放法都认：
//   1) data/persona.md          老的单文件人格（默认，没选角色时就用它）
//   2) data/roles/<角色>.md     角色卡；选哪个由 data/state/current-role.json 决定
// 换角色是"下一条消息立刻变"：每条消息都会重新读一遍角色文件名，文件变了才重读内容。

import { createPlasticity } from './plasticity.mjs';
import path from 'node:path';
import fs from 'node:fs';
import { readTextSafe, writeTextAtomic } from './store.mjs';

const LEGACY_ID = 'persona';

export function createPersona({ cfg, dataDir, log }) {
  const growth = createPlasticity({ cfg, dataDir, log });
  const legacyFile = path.join(dataDir, cfg.personaFile || 'persona.md');
  const rolesDir = path.join(dataDir, cfg.personaRolesDir || 'roles');
  const stateFile = path.join(dataDir, 'state', 'current-role.json');
  let cache = { key: '', mtime: -1, text: '' };

  function ensureRoles() {
    try { fs.mkdirSync(rolesDir, { recursive: true }); } catch { /* 建不出来就当没有角色目录 */ }
  }

  /** 当前选中的角色 id（空字符串 = 用 data/persona.md） */
  function current() {
    try {
      const j = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (j && typeof j.id === 'string') return j.id.trim();
    } catch { /* 没这个文件 = 没选角色 */ }
    return '';
  }

  function roleFiles() {
    ensureRoles();
    let names = [];
    try { names = fs.readdirSync(rolesDir); } catch { names = []; }
    return names
      .filter((f) => f.toLowerCase().endsWith('.md'))
      .map((f) => ({ id: f.replace(/\.md$/i, ''), file: path.join(rolesDir, f) }));
  }

  /** 角色 id → 文件名（不认识的 id 一律退回老的单文件人格，绝不让人格变空） */
  function fileOf(id) {
    if (!id || id === LEGACY_ID) return legacyFile;
    const hit = roleFiles().find((r) => r.id === id);
    return hit ? hit.file : legacyFile;
  }

  /** 可选角色列表（控制台下拉用）：老的单文件人格 × 角色目录里的每个 .md */
  function list() {
    const picked = current();
    const out = [];
    const stat = (file) => { try { const st = fs.statSync(file); return { chars: readTextSafe(file, '').length, mtime: Math.round(st.mtimeMs) }; } catch { return null; } };
    const legacy = stat(legacyFile);
    out.push({ id: LEGACY_ID, name: 'persona.md（默认）', ...(legacy || { chars: 0, mtime: 0 }), missing: !legacy, current: !picked });
    for (const { id, file } of roleFiles()) {
      const s = stat(file);
      out.push({ id, name: id, ...(s || { chars: 0, mtime: 0 }), missing: !s, current: picked === id });
    }
    return out;
  }

  function load() {
    const id = current();
    const file = fileOf(id);
    const key = id + '|' + file;
    try {
      const st = fs.statSync(file);
      if (st.mtimeMs !== cache.mtime || key !== cache.key) {
        cache = { key, mtime: st.mtimeMs, text: readTextSafe(file, '').replace(/^\uFEFF/, '') };
        log?.event('persona', `人格已加载：${id && id !== LEGACY_ID ? `角色「${id}」` : 'persona.md'}（${cache.text.length} 字）`);
      }
      return cache.text;
    } catch {
      // 选中的角色文件被删了：退回 persona.md，人格不能变空
      if (file !== legacyFile) {
        try {
          const st = fs.statSync(legacyFile);
          if (st.mtimeMs !== cache.mtime || cache.key !== legacyFile) {
            cache = { key: legacyFile, mtime: st.mtimeMs, text: readTextSafe(legacyFile, '').replace(/^\uFEFF/, '') };
            log?.event('persona', `角色文件不见了，退回 persona.md（${cache.text.length} 字）`);
          }
          return cache.text;
        } catch { /* 老文件也没有，只能空着 */ }
      }
      cache = { key: '', mtime: -1, text: '' };
      return '';
    }
  }

  /** 切角色：立刻写 state，下一条消息就生效 */
  function switchTo(id) {
    const want = String(id || '').trim();
    if (!want) throw new Error('角色 id 不能为空');
    // 严格校验：不认识的 id 直接拒绝。load() 才有"退回默认"的兜底，
    // 但那是"文件被删了"的应急，不是让切错名字也能成功。
    if (want !== LEGACY_ID && !roleFiles().some((r) => r.id === want)) throw new Error(`没有这个角色：${want}`);
    const file = fileOf(want);
    if (!fs.existsSync(file)) throw new Error(`没有这个角色：${want}`);
    try { fs.mkdirSync(path.dirname(stateFile), { recursive: true }); } catch { /* ignore */ }
    writeTextAtomic(stateFile, JSON.stringify({ id: want === LEGACY_ID ? '' : want, at: new Date().toISOString() }, null, 2));
    cache = { key: '', mtime: -1, text: '' };
    load();
    log?.event('persona', `切换角色：${want === LEGACY_ID ? 'persona.md' : want}（${cache.text.length} 字）`);
    return { id: want, chars: cache.text.length };
  }

  /** 存回"当前用的那张卡"：这样控制台编辑的就是正在生效的人格 */
  function save(text) {
    const file = fileOf(current());
    writeTextAtomic(file, String(text ?? ''));
    cache = { key: '', mtime: -1, text: '' };
    load();
    log?.event('persona', `人格已保存：${cache.text.length} 字`);
    return cache.text.length;
  }

  /** 新建/覆盖一张角色卡（控制台"存成角色卡"用） */
  function saveAs(id, text) {
    const want = String(id || '').trim();
    if (!want || want === LEGACY_ID) throw new Error('角色名不能为空，也不能叫 persona');
    if (!/^[\w\u4e00-\u9fa5. -]{1,40}$/.test(want)) throw new Error('角色名只能是中文、字母、数字、点、横线');
    ensureRoles();
    const file = path.join(rolesDir, `${want}.md`);
    writeTextAtomic(file, String(text ?? ''));
    log?.event('persona', `角色卡已写入：${want}（${String(text ?? '').length} 字）`);
    return { id: want, chars: String(text ?? '').length, file };
  }

  return {
    file: legacyFile, rolesDir, stateFile,
    list, current, switchTo, saveAs, load, save,
    growth, growthRole: () => fileOf(current()) === legacyFile ? '' : current(),
    get text() { return load(); }
  };
}
