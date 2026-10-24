// 从本机浏览器里把 QQ音乐的登录 cookie 捡出来（这样不用手贴）。
//
// 原理：Chromium 系（Edge / Chrome）把 cookie 存在 SQLite 里，值用 AES-256-GCM 加密，
// 而 AES 密钥本身又被 Windows DPAPI 保护（CurrentUser）。所以：
//   1) 读 Local State 里的 os_crypt.encrypted_key → 去掉 "DPAPI" 前缀 → DPAPI 解密 → 32 字节密钥
//   2) 读 Cookies 库里 host_key 含 qq.com 的 MUSIC_U → v10/v11 前缀后面是 nonce+密文+tag → AES-GCM 解
// 浏览器在跑的时候库被锁着（EBUSY），这时只能提示"关一下浏览器"或者手贴。
//
// 只用在本机，只取 qq.com 的 MUSIC_U / uin，别的一概不碰。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createDecipheriv } from 'node:crypto';

const BROWSERS = {
  edge: () => path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'User Data'),
  chrome: () => path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data')
};

function copyLocked(src, dst) {
  // 先试普通复制；被占用就退回 .NET 的共享读（浏览器允许读、只是不许独占）
  try { fs.copyFileSync(src, dst); return true; } catch { /* 继续试 */ }
  return new Promise((resolve) => {
    const ps = `$in=[System.IO.File]::Open('${src.replace(/'/g, "''")}','Open','Read','ReadWrite');$out=[System.IO.File]::Create('${dst.replace(/'/g, "''")}');$in.CopyTo($out);$out.Close();$in.Close();'ok'`;
    execFile('powershell', ['-NoProfile', '-Command', ps], { timeout: 20000, windowsHide: true }, (err) => resolve(!err));
  });
}

function dpapiUnprotect(b64) {
  // 用脚本文件而不是 -Command：base64 里有 + / = 和长度，直接拼命令行会被引号/解析吃掉
  return new Promise((resolve, reject) => {
    const inFile = path.join(os.tmpdir(), `dpapi-in-${Date.now()}.txt`);
    const outFile = path.join(os.tmpdir(), `dpapi-out-${Date.now()}.txt`);
    fs.writeFileSync(inFile, String(b64), 'utf8');
    const script = [
      // PowerShell 5.1 默认不加载 System.Security，ProtectedData 会 "Unable to find type"
      'Add-Type -AssemblyName System.Security',
      '$b64 = (Get-Content -Raw -LiteralPath ' + JSON.stringify(inFile) + ').Trim()',
      '$bytes = [Convert]::FromBase64String($b64)',
      '$plain = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
      '[System.IO.File]::WriteAllText(' + JSON.stringify(outFile) + ', [Convert]::ToBase64String($plain))'
    ].join('\r\n');
    const psFile = path.join(os.tmpdir(), `dpapi-${Date.now()}.ps1`);
    fs.writeFileSync(psFile, script, 'utf8');
    execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psFile], { timeout: 30000, windowsHide: true }, (err, stdout, stderr) => {
      try { fs.rmSync(psFile, { force: true }); } catch { /* ignore */ }
      try { fs.rmSync(inFile, { force: true }); } catch { /* ignore */ }
      if (err) {
        try { fs.rmSync(outFile, { force: true }); } catch { /* ignore */ }
        return reject(new Error(String(stderr || err.message).slice(0, 200)));
      }
      try {
        const out = fs.readFileSync(outFile, 'utf8').trim();
        fs.rmSync(outFile, { force: true });
        if (!out) return reject(new Error('DPAPI 解出来是空的'));
        resolve(out);
      } catch (e) { reject(new Error('读 DPAPI 结果失败：' + e.message.slice(0, 100))); }
    });
  });
}

async function aesKey(baseDir) {
  const raw = JSON.parse(fs.readFileSync(path.join(baseDir, 'Local State'), 'utf8'));
  const encB64 = raw?.os_crypt?.encrypted_key;
  if (!encB64) throw new Error('Local State 里没有 os_crypt.encrypted_key');
  const buf = Buffer.from(encB64, 'base64');
  const body = buf.subarray(0, 5).toString() === 'DPAPI' ? buf.subarray(5) : buf;
  const keyB64 = await dpapiUnprotect(body.toString('base64'));
  return Buffer.from(keyB64, 'base64');
}

function decryptValue(key, blob) {
  if (!blob || blob.length < 3) return '';
  const prefix = blob.subarray(0, 3).toString();
  if (prefix !== 'v10' && prefix !== 'v11') {
    // 老格式：整个就是 DPAPI 保护的密文
    return null;
  }
  const nonce = blob.subarray(3, 15);
  const payload = blob.subarray(15, blob.length - 16);
  const tag = blob.subarray(blob.length - 16);
  const d = createDecipheriv('aes-256-gcm', key, nonce);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(payload), d.final()]).toString('utf8');
}

/**
 * 扫一遍两个浏览器，找出能用的 MUSIC_U。
 * 返回 { ok, cookie, uin, from, note } 或 { ok:false, note }
 */
export async function pickQqMusicCookie({ DatabaseSync = null, dirs = null } = {}) {
  let SQLite = DatabaseSync;
  if (!SQLite) {
    try { ({ DatabaseSync: SQLite } = await import('node:sqlite')); }
    catch { return { ok: false, note: '本机 Node 没有 node:sqlite（需要 22.5+），只能手贴 cookie' }; }
  }
  const tried = [];
  const bases = dirs || Object.fromEntries(Object.entries(BROWSERS).map(([k, f]) => [k, f()]));
  for (const [name, base] of Object.entries(bases)) {
    if (!base || !fs.existsSync(base)) { tried.push(`${name}: 没装`); continue; }
    let profiles = [];
    try {
      profiles = fs.readdirSync(base).filter((d) => d === 'Default' || /^Profile \d+$/.test(d));
    } catch { /* ignore */ }
    for (const prof of profiles) {
      const dbFile = path.join(base, prof, 'Network', 'Cookies');
      if (!fs.existsSync(dbFile)) { tried.push(`${name}/${prof}: 没有 Cookies 库`); continue; }
      const tmp = path.join(os.tmpdir(), `ck-${name}-${prof.replace(/\s/g, '')}-${Date.now()}.db`);
      const ok = await copyLocked(dbFile, tmp);
      if (!ok) { tried.push(`${name}/${prof}: 库被浏览器占着（关掉浏览器再试）`); continue; }
      let db = null;
      try {
        db = new SQLite(tmp, { readOnly: true });
        const rows = db.prepare("select host_key, name, encrypted_value from cookies where host_key like '%qq.com%' and name in ('MUSIC_U','uin','p_uin')").all();
        if (!rows.length) { tried.push(`${name}/${prof}: 没有 qq.com 登录 cookie`); continue; }
        const key = await aesKey(base).catch((e) => { throw new Error('取密钥失败：' + e.message); });
        let musicU = '';
        let uin = '';
        for (const r of rows) {
          let v = '';
          try { v = decryptValue(key, r.encrypted_value) || ''; } catch { v = ''; }
          if (r.name === 'MUSIC_U' && v) musicU = v;
          if ((r.name === 'uin' || r.name === 'p_uin') && v) uin = v.replace(/^o/, '').replace(/\D/g, '');
        }
        if (!musicU) { tried.push(`${name}/${prof}: 有 qq.com 的 cookie 但解不出 MUSIC_U`); continue; }
        return { ok: true, cookie: `MUSIC_U=${musicU}${uin ? `; uin=${uin}` : ''}`, uin, from: `${name}/${prof}`, note: '从浏览器里读到的' };
      } catch (e) {
        tried.push(`${name}/${prof}: ${e.message.slice(0, 60)}`);
      } finally {
        try { db?.close(); } catch { /* ignore */ }
        try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
      }
    }
  }
  return { ok: false, note: tried.join('；') || '没找到可用的登录 cookie' };
}
