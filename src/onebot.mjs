// OneBot11 通道（正向 WS）。不依赖任何 npm 包：用 Node 20+ 自带的全局 WebSocket。
//
// 帧的两种方向：
//   收：{"post_type":"message", ...}  → normalizeEvent() 变成内部消息对象
//   发：{"action":"send_group_msg","params":{...},"echo":"ff-1"} → 等 NapCat 回同一个 echo
// 细节：
//   - self_id 是机器人自己的号，每条事件都带，**不能**拿它过滤"自己发的"（用 user_id 比）
//   - 收到字符串形态的 message（老实现）时，用 parseCqString 兜底解析，别静默丢消息
//   - 断线按 1s/2s/4s/8s/16s/30s 退避重连

const CQ_RE = /\[CQ:([a-z_]+)((?:,[^\]]*)?)\]/g;

/** 把 CQ 码字符串切成 OneBot 段（收到字符串形态时的兜底）。 */
export function parseCqString(text) {
  const segs = [];
  let last = 0;
  for (const m of String(text).matchAll(CQ_RE)) {
    if (m.index > last) segs.push({ type: 'text', data: { text: text.slice(last, m.index) } });
    const data = {};
    for (const kv of String(m[2] || '').split(',').filter(Boolean)) {
      const i = kv.indexOf('=');
      if (i > 0) data[kv.slice(0, i)] = kv.slice(i + 1).replace(/&#44;/g, ',').replace(/&#91;/g, '[').replace(/&#93;/g, ']');
    }
    segs.push({ type: m[1], data });
    last = m.index + m[0].length;
  }
  if (last < text.length) segs.push({ type: 'text', data: { text: text.slice(last) } });
  return segs;
}

/** 归一化一条 OneBot 事件 → 内部消息对象；非 message 事件返回 null。 */
export function normalizeEvent(raw, selfId) {
  if (!raw || raw.post_type !== 'message') return null;
  // 自己发的消息：OneBot 里体现为 user_id == self_id（self_id 是所有事件都带的机器人账号，不能拿来做过滤）
  if (raw.user_id && raw.self_id && String(raw.user_id) === String(raw.self_id)) return null;
  const isGroup = raw.message_type === 'group';
  const segments = Array.isArray(raw.message) ? raw.message : parseCqString(raw.message ?? '');
  const text = segments.filter((s) => s.type === 'text').map((s) => s.data?.text ?? '').join('').trim();
  // 注意：不给 url/file 也保留（用空串占位）——否则"有图但没地址"会被静默丢掉，
  // 模型就只能凭空猜"看不清"。留个空位，后面才知道"这条消息里有图"。
  const imageSegs = segments.filter((s) => s.type === 'image');
  const images = imageSegs.map((s) => String(s.data?.url || s.data?.file || ''));
  // 同一张图通常既有 url 又有 file（本地缓存）。一个拿不到就换另一个试。
  const imageAlternates = imageSegs.map((s) => [...new Set([String(s.data?.url || ''), String(s.data?.file || '')].filter(Boolean))]);
  // 每张图的原始元信息（summary 里常写「[动画表情]」，用来判断"像不像表情"）
  const imageMeta = imageSegs.map((s) => ({
    summary: String(s.data?.summary || '').slice(0, 60),
    subType: s.data?.sub_type ?? s.data?.subType ?? '',
    fileSize: Number(s.data?.file_size || 0) || 0
  }));
  // QQ 的商店表情是 mface（market face），没有 image 段；只能拿到名字/摘要
  const faces = segments.filter((s) => s.type === 'mface' || s.type === 'marketface')
    .map((s) => String(s.data?.summary || s.data?.name || '').trim()).filter(Boolean);
  const mentions = segments.filter((s) => s.type === 'at').map((s) => String(s.data?.qq ?? '')).filter(Boolean);
  return {
    id: String(raw.message_id ?? ''),
    selfId: String(raw.self_id ?? selfId ?? ''),
    groupId: isGroup ? String(raw.group_id ?? '') : '',
    userId: String(raw.user_id ?? ''),
    nickname: String(raw.sender?.card || raw.sender?.nickname || raw.user_id || ''),
    text,
    images,
    imageAlternates,
    imageMeta,
    faces,
    mentions,
    segments,
    ts: Number(raw.time ? raw.time * 1000 : Date.now()),
    raw
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createOneBot({ url, token = '', selfId = '', log, WebSocketImpl = globalThis.WebSocket, hbMs = 30_000, hbTimeoutMs = 8_000, reconnectBaseMs = 1000 }) {
  // 踩过的坑：TCP 半开（NapCat 那边还占着连接、其实已经死了）时，close 事件永远不来，
  // 于是既没有 onMessage 也没有重连 —— 表现就是"机器人卡住不回话，进程还活着"。
  // 所以必须有心跳：定期 ping 一次，连续失败就主动断开重连。
  const state = { connected: false, selfId, attempts: 0, lastError: '', closed: false, lastPongAt: 0, halfOpen: 0 };
  const handlers = new Set();
  const pending = new Map();
  let ws = null;
  let seq = 0;
  let reconnectTimer = null;
  let hbTimer = null;
  let hbFails = 0;
  let connecting = false;

  function emit(msg) { for (const fn of handlers) { try { fn(msg); } catch (e) { log?.event('error', `消息处理异常：${e.message}`); } } }

  function onOpen() {
    state.connected = true;
    state.attempts = 0;
    state.lastError = '';
    state.lastPongAt = Date.now();
    hbFails = 0;
    connecting = false;
    startHeartbeat();
    log?.event('conn', `已连上网关：${url}`);
    call('get_login_info', {}).then((r) => {
      if (r?.user_id) { state.selfId = String(r.user_id); log?.event('conn', `登录账号 ${r.user_id}（${r.nickname ?? ''}）`); }
    }).catch((e) => log?.event('conn', `get_login_info 失败：${e.message}`));
  }

  /** 安排一次重连（不会叠加多个定时器） */
  function scheduleReconnect(reason) {
    if (state.closed) return;
    if (reconnectTimer) return;
    state.connected = false;
    state.attempts += 1;
    const delay = Math.min(30_000, reconnectBaseMs * 2 ** Math.min(state.attempts, 5));
    log?.event('conn', `${reason}，${Math.round(delay / 1000)} 秒后重连（第 ${state.attempts} 次）`);
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, delay);
  }

  function stopHeartbeat() {
    if (hbTimer) { clearInterval(hbTimer); hbTimer = null; }
  }

  function startHeartbeat() {
    stopHeartbeat();
    hbTimer = setInterval(() => {
      if (!state.connected || state.closed) return;
      call('get_login_info', {}, hbTimeoutMs)
        .then(() => { state.lastPongAt = Date.now(); hbFails = 0; })
        .catch((e) => {
          hbFails += 1;
          state.lastError = '心跳失败：' + e.message;
          if (hbFails >= 2) {
            state.halfOpen += 1;
            log?.event('conn', `心跳连续失败 ${hbFails} 次（${e.message}），判定连接假死，主动重连`);
            stopHeartbeat();
            try { ws?.close(); } catch { /* ignore */ }
            ws = null;
            scheduleReconnect('连接假死');
          }
        });
    }, hbMs);
    if (hbTimer.unref) hbTimer.unref();
  }

  function attach(sock) {
    sock.addEventListener('open', onOpen);
    sock.addEventListener('close', () => {
      state.connected = false;
      stopHeartbeat();
      if (state.closed) return;
      scheduleReconnect('连接断开');
    });
    sock.addEventListener('error', (e) => {
      const msg = e?.message || '';
      // 握手失败最常见的原因不是网络，而是"令牌不对 / 网关那头挂的不是这个号"：
      // 早上就踩过一次 —— QQ 客户端被登录成了别的号，这里只报"连接出错"，看不出根因。
      state.lastError = token ? `WS 错误：${msg}（网关可能挂了别的 QQ 号，或 access token 变了）` : `WS 错误：${msg}`;
      // 有些实现只报 error 不报 close，这里也推动一次重连
      stopHeartbeat();
      scheduleReconnect('连接出错');
    });
    sock.addEventListener('message', (ev) => {
      let data;
      try { data = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString()); } catch { return; }
      if (data.echo && pending.has(data.echo)) {
        const { resolve, reject, timer } = pending.get(data.echo);
        clearTimeout(timer);
        pending.delete(data.echo);
        if (data.status === 'ok' || data.retcode === 0) resolve(data.data);
        else reject(new Error(`OneBot 返回失败：${data.retcode ?? '?'} ${data.wording || data.message || ''}`.trim()));
        return;
      }
      const msg = normalizeEvent(data, state.selfId);
      if (msg) emit(msg);
    });
  }

  function connect() {
    if (!WebSocketImpl) { log?.event('conn', '当前 Node 没有全局 WebSocket（需要 Node 20+）'); return; }
    if (state.closed) return;
    if (connecting) return;
    connecting = true;
    try {
      ws = token ? new WebSocketImpl(url, { headers: { Authorization: `Bearer ${token}` } }) : new WebSocketImpl(url);
    } catch (e) {
      connecting = false;
      state.lastError = e.message;
      log?.event('conn', `创建连接失败：${e.message}`);
      scheduleReconnect('创建连接失败');
      return;
    }
    attach(ws);
    // 连接超时：15 秒还没 open 就放弃这次
    setTimeout(() => {
      if (!state.connected && !state.closed) {
        connecting = false;
        try { ws?.close(); } catch { /* ignore */ }
        ws = null;
        scheduleReconnect('连接超时');
      }
    }, 15_000);
  }

  function call(action, params = {}, timeoutMs = 15_000) {
    return new Promise((resolve, reject) => {
      if (!ws || ws.readyState !== 1) { reject(new Error('通道未连接')); return; }
      const echo = `ff-${++seq}`;
      const timer = setTimeout(() => { pending.delete(echo); reject(new Error(`${action} 超时`)); }, timeoutMs);
      pending.set(echo, { resolve, reject, timer });
      try { ws.send(JSON.stringify({ action, params, echo })); }
      catch (e) { clearTimeout(timer); pending.delete(echo); reject(e); }
    });
  }

  /** 发送一条消息（segments 数组）。target = {groupId} | {userId} */
  async function send(segments, target) {
    const action = target.groupId ? 'send_group_msg' : 'send_private_msg';
    const params = target.groupId ? { group_id: target.groupId, message: segments } : { user_id: target.userId, message: segments };
    return call(action, params);
  }

  function close() {
    state.closed = true;
    state.connected = false;
    stopHeartbeat();
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    for (const [, w] of pending) { clearTimeout(w.timer); try { w.reject(new Error('通道已关闭')); } catch { /* ignore */ } }
    pending.clear();
    try { ws?.close(); } catch { /* ignore */ }
  }

  function onMessage(fn) { handlers.add(fn); return () => handlers.delete(fn); }

  return { connect, send, call, close, onMessage, state, get raw() { return ws; } };
}

export { sleep };
