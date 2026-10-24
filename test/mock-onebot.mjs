// 假 NapCat：一个最小 OneBot11 WS 服务端，用来在没有 QQ 的机器上跑通整条链路。
// 支持：握手、收 action（get_login_info / send_group_msg / send_private_msg / delete_msg）、
//       往客户端推事件（push）。
// 纯手写 WS 帧，零依赖：只处理文本帧 + 掩码 + ping/pong/close 的最小集。

import http from 'node:http';
import crypto from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function encodeFrame(str) {
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length;
  let head;
  if (len < 126) { head = Buffer.alloc(2); head[1] = len; }
  else if (len < 65536) { head = Buffer.alloc(4); head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  head[0] = 0x81; // FIN + text
  return Buffer.concat([head, payload]);
}

function decodeFrames(state, chunk) {
  state.buf = Buffer.concat([state.buf, chunk]);
  const out = [];
  for (;;) {
    const b = state.buf;
    if (b.length < 2) break;
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let off = 2;
    if (len === 126) { if (b.length < 4) break; len = b.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (b.length < 10) break; len = Number(b.readBigUInt64BE(2)); off = 10; }
    const maskLen = masked ? 4 : 0;
    if (b.length < off + maskLen + len) break;
    const mask = masked ? b.subarray(off, off + 4) : null;
    const data = Buffer.from(b.subarray(off + maskLen, off + maskLen + len));
    if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
    state.buf = b.subarray(off + maskLen + len);
    out.push({ opcode, data });
  }
  return out;
}

export function createMockOneBot({ port = 0, selfId = '999', nickname = '测试号' } = {}) {
  const state = { sock: null, buf: Buffer.alloc(0) };
  const calls = [];        // 收到的 action
  const sends = [];        // 发出去的消息（已解析）
  const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });

  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '', ''
    ].join('\r\n'));
    state.sock = socket;
    state.buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      for (const f of decodeFrames(state, chunk)) {
        if (f.opcode === 0x8) { try { socket.end(); } catch { /* ignore */ } continue; }
        if (f.opcode === 0x9) { try { socket.write(Buffer.from([0x8a, 0x00])); } catch { /* ignore */ } continue; }
        if (f.opcode !== 0x1) continue;
        let msg;
        try { msg = JSON.parse(f.data.toString('utf8')); } catch { continue; }
        calls.push(msg);
        handleAction(msg, socket);
      }
    });
    socket.on('close', () => { if (state.sock === socket) state.sock = null; });
    socket.on('error', () => { /* ignore */ });
  });

  function handleAction(msg, socket) {
    const { action, echo } = msg;
    const ok = (data) => socket.write(encodeFrame(JSON.stringify({ status: 'ok', retcode: 0, data, echo })));
    if (action === 'get_login_info') { ok({ user_id: Number(selfId), nickname }); return; }
    if (action === 'send_group_msg' || action === 'send_private_msg') {
      const rec = { action, groupId: msg.params?.group_id ?? '', userId: msg.params?.user_id ?? '', message: msg.params?.message ?? [] };
      sends.push(rec);
      ok({ message_id: sends.length + 1000 });
      // 自己发的消息也会作为事件回推（和真 NapCat 一致），用来验证"过滤自己"的逻辑
      push(rawMessage({ selfId, messageId: 9000 + sends.length, userId: selfId, groupId: rec.groupId, text: '（我自己发的）' }));
      return;
    }
    ok({ ok: true });
  }

  function push(event) {
    if (!state.sock) return false;
    try { state.sock.write(encodeFrame(JSON.stringify(event))); return true; } catch { return false; }
  }

  function rawMessage({ selfId: sid = selfId, messageId, userId, nickname: nick = '小明', groupId = '123', text = '', images = [], mentions = [] } = {}) {
    const message = [];
    for (const q of mentions) message.push({ type: 'at', data: { qq: String(q) } });
    if (text) message.push({ type: 'text', data: { text: ` ${text}` } });
    for (const u of images) message.push({ type: 'image', data: { url: u } });
    return {
      post_type: 'message', message_type: groupId ? 'group' : 'private', self_id: Number(sid),
      message_id: messageId, group_id: groupId ? Number(groupId) : undefined, user_id: Number(userId),
      sender: { card: nick, nickname: nick }, message, time: Math.floor(Date.now() / 1000)
    };
  }

  function start() {
    return new Promise((resolve) => {
      server.listen(port, '127.0.0.1', () => resolve(server.address().port));
    });
  }
  function close() { try { state.sock?.destroy(); } catch { /* ignore */ } server.close(); }

  return { server, start, close, push, rawMessage, calls, sends, get connected() { return !!state.sock; }, selfId };
}
